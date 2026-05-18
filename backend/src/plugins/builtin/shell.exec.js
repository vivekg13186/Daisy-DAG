// shell.exec — run a command on the worker host.
//
// Two modes:
//   • Default (shell=false) — `command` is the binary, `args` is an
//     array of arguments. Safe-by-default: no shell interpretation,
//     so ${expr} values from ctx never get re-parsed by sh.
//   • shell=true — `command` is a single line passed to /bin/sh -c.
//     Convenient for pipes and redirects but allows shell injection
//     if you build the command line by interpolating ctx values.
//     Use with intention.
//
// The plugin honours the engine's abort signal (workflow cancel /
// hard timeout) and a per-call `timeoutMs` ceiling — first one to
// fire wins. On either, the child is killed with SIGTERM and the
// node fails with the captured signal name.
//
// Output is captured in memory. We cap each stream at 1 MB; further
// writes after that are dropped and the stream's tail carries a
// "…[stdout truncated]" marker so the workflow author can tell.

import { spawn } from "node:child_process";

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS     = 30 * 60 * 1000;          // 30 minutes
const MAX_OUTPUT_BYTES   = 1024 * 1024;             // 1 MB per stream

export default {
  name: "shell.exec",
  description:
    "Run a command on the worker host and capture stdout/stderr/exitCode. " +
    "Pass the binary in `command` and arguments as an array; set `shell: true` " +
    "to interpret the line through /bin/sh -c. Captures up to 1 MB per stream, " +
    "honours the engine's abort signal, and fails the node when the process " +
    "exits non-zero (unless failOnExitCode is set false).",

  inputSchema: {
    type: "object",
    required: ["command"],
    properties: {
      command: {
        type: "string",
        description:
          "Binary to run (e.g. 'ls', '/usr/bin/python3'), or the full command " +
          "line when shell=true.",
      },
      args: {
        type: "array",
        items: { type: "string" },
        description:
          "Arguments passed as argv to the binary. Ignored when shell=true.",
      },
      cwd: {
        type: "string",
        description: "Working directory. Default: the worker's cwd.",
      },
      env: {
        type: "object",
        additionalProperties: { type: "string" },
        description:
          "Extra env vars merged onto the worker's environment. Use this for " +
          "secrets resolved from a stored config (e.g. \"API_TOKEN\": " +
          "\"${config.example.token}\").",
      },
      stdin: {
        type: "string",
        description: "Optional standard input piped into the child process.",
      },
      shell: {
        type: "boolean",
        default: false,
        description:
          "When true the command is run via /bin/sh -c. Enables pipes, " +
          "redirects, and globbing but lets shell metacharacters in any " +
          "${expr} interpolation escape — prefer false + an args array when " +
          "possible.",
      },
      timeoutMs: {
        type: "integer",
        minimum: 1,
        maximum: MAX_TIMEOUT_MS,
        default: DEFAULT_TIMEOUT_MS,
        description:
          "Hard ceiling. The child is SIGTERMed when reached and the node fails.",
      },
      failOnExitCode: {
        type: "boolean",
        default: true,
        description:
          "When true (default) a non-zero exit code fails the node. Set false " +
          "to capture the code as output without failing — useful for tools " +
          "like grep/diff where non-zero is a legitimate signal.",
      },
    },
  },

  // What ctx[outputVar] receives when the node-level outputVar is set.
  primaryOutput: "stdout",

  outputSchema: {
    type: "object",
    required: ["exitCode"],
    properties: {
      stdout:     { type: "string",  description: "Captured stdout, possibly truncated at 1 MB." },
      stderr:     { type: "string",  description: "Captured stderr, possibly truncated at 1 MB." },
      exitCode:   { type: "integer", description: "Process exit code. -1 if it never produced one." },
      signal:     { type: ["string", "null"], description: "POSIX signal name if the child was killed (e.g. 'SIGTERM' on timeout)." },
      durationMs: { type: "integer", description: "Wall-clock time the child ran for." },
    },
  },

  async execute(
    { command, args = [], cwd, env, stdin, shell = false,
      timeoutMs = DEFAULT_TIMEOUT_MS, failOnExitCode = true },
    _ctx, hooks, opts = {},
  ) {
    if (!command || typeof command !== "string") {
      throw new Error("`command` is required");
    }
    if (!shell && !Array.isArray(args)) {
      throw new Error("`args` must be an array of strings when shell=false");
    }

    // Convenience: when the author wrote `command: "npm pack"` (with
    // embedded whitespace) but didn't pass an `args` array, split it
    // for them. Without this, Node's spawn looks for a literal binary
    // named "npm pack" and fails with ENOENT, which is a frequent
    // first-time gotcha. The tokenizer respects single and double
    // quotes so simple quoted arguments survive — anything more
    // complex (escape sequences, nested quotes) should set shell=true.
    if (!shell && (!args || args.length === 0) && /\s/.test(command)) {
      const tokens = tokenize(command);
      if (tokens.length > 1) {
        command = tokens[0];
        args    = tokens.slice(1);
      }
    }

    // Merge the worker env with the optional `env` input. Keep PATH and
    // any other inherited vars unless the caller explicitly overrides them.
    const mergedEnv = (env && typeof env === "object")
      ? { ...process.env, ...env }
      : process.env;

    // Two abort sources merged into one local controller:
    //   1. timeoutMs — local per-call ceiling
    //   2. opts.signal — engine signals workflow cancel / hard timeout
    const ac = new AbortController();
    const timeoutTimer = setTimeout(
      () => ac.abort(new Error(`shell.exec timed out after ${timeoutMs}ms`)),
      timeoutMs,
    );
    const onUpstreamAbort = () => ac.abort(opts.signal?.reason);
    if (opts.signal) {
      if (opts.signal.aborted) ac.abort(opts.signal.reason);
      else opts.signal.addEventListener("abort", onUpstreamAbort, { once: true });
    }

    const started = Date.now();

    // Tell the execution log what's about to run. Useful when a failure
    // turns out to be a CWD or PATH issue and we want to see the exact
    // shape the spawn was invoked with.
    if (hooks?.stream?.log) {
      hooks.stream.log("info",
        `shell.exec: ${command}${args.length ? " " + args.join(" ") : ""}` +
        (cwd ? ` (cwd=${cwd})` : "") +
        (shell ? " [shell=true]" : ""),
      );
    }

    return new Promise((resolve, reject) => {
      let child;
      try {
        child = spawn(
          command,
          shell ? [] : args,
          {
            cwd:    cwd || undefined,
            env:    mergedEnv,
            shell:  Boolean(shell),
            signal: ac.signal,
            stdio:  ["pipe", "pipe", "pipe"],
          },
        );
      } catch (e) {
        clearTimeout(timeoutTimer);
        if (opts.signal) opts.signal.removeEventListener?.("abort", onUpstreamAbort);
        return reject(new Error(`shell.exec spawn failed: ${friendlySpawnError(e, command, shell)}`));
      }

      // Capture stdout/stderr with a hard cap. We keep buffering up to
      // MAX_OUTPUT_BYTES, then drop further writes — the kernel keeps
      // delivering them but we ignore. Marker is appended at close.
      let stdout = Buffer.alloc(0);
      let stderr = Buffer.alloc(0);
      let stdoutOverflow = false;
      let stderrOverflow = false;

      child.stdout.on("data", (chunk) => {
        // Stream the raw text live so it shows in the InstanceViewer
        // before the process exits — useful for long-running commands
        // (npm install / docker build / etc.) where waiting on exit to
        // surface output makes debugging painful.
        if (hooks?.stream?.text) {
          try { hooks.stream.text(chunk.toString("utf8")); } catch { /* fine */ }
        }
        const remaining = MAX_OUTPUT_BYTES - stdout.length;
        if (chunk.length <= remaining) {
          stdout = Buffer.concat([stdout, chunk]);
        } else if (remaining > 0) {
          stdout = Buffer.concat([stdout, chunk.subarray(0, remaining)]);
          stdoutOverflow = true;
        } else {
          stdoutOverflow = true;
        }
      });
      child.stderr.on("data", (chunk) => {
        // stderr lands in the log panel as "warn"-level entries so it's
        // visually distinct from stdout. Splitting per-line keeps each
        // log entry readable when a single chunk carries many lines.
        if (hooks?.stream?.log) {
          const text = chunk.toString("utf8");
          for (const line of text.split(/\r?\n/)) {
            if (line.length) {
              try { hooks.stream.log("warn", line); } catch { /* fine */ }
            }
          }
        }
        const remaining = MAX_OUTPUT_BYTES - stderr.length;
        if (chunk.length <= remaining) {
          stderr = Buffer.concat([stderr, chunk]);
        } else if (remaining > 0) {
          stderr = Buffer.concat([stderr, chunk.subarray(0, remaining)]);
          stderrOverflow = true;
        } else {
          stderrOverflow = true;
        }
      });

      // Optional stdin. End the stream either way so children blocked on
      // read() don't hang the worker forever.
      try {
        if (stdin != null && stdin !== "") child.stdin.write(String(stdin));
      } catch { /* child may already have exited; the close handler reports */ }
      try { child.stdin.end(); } catch { /* same */ }

      child.on("error", (err) => {
        clearTimeout(timeoutTimer);
        if (opts.signal) opts.signal.removeEventListener?.("abort", onUpstreamAbort);
        reject(new Error(`shell.exec process error: ${friendlySpawnError(err, command, shell)}`));
      });

      child.on("close", (code, signal) => {
        clearTimeout(timeoutTimer);
        if (opts.signal) opts.signal.removeEventListener?.("abort", onUpstreamAbort);

        const result = {
          stdout:     stdout.toString("utf8") + (stdoutOverflow ? "\n…[stdout truncated]" : ""),
          stderr:     stderr.toString("utf8") + (stderrOverflow ? "\n…[stderr truncated]" : ""),
          exitCode:   typeof code === "number" ? code : -1,
          signal:     signal || null,
          durationMs: Date.now() - started,
        };

        // Killed by signal (timeout / engine abort). Always fail so the
        // workflow surfaces the cancellation reason rather than silently
        // continuing with truncated output.
        if (signal) {
          const why = ac.signal.reason?.message || `killed by ${signal}`;
          const err = new Error(`shell.exec ${why}: ${tailForError(result.stderr)}`);
          err.result = result;
          return reject(err);
        }

        if (failOnExitCode && result.exitCode !== 0) {
          const err = new Error(
            `shell.exec exited with code ${result.exitCode}: ${tailForError(result.stderr)}`,
          );
          err.result = result;
          return reject(err);
        }

        resolve(result);
      });
    });
  },
};

// ── helpers ──────────────────────────────────────────────────────────

// Minimal whitespace splitter that respects single/double quotes.
// `git commit -m "first commit"` → ["git", "commit", "-m", "first commit"]
// Anything that needs escape sequences or nested quotes should set
// shell=true and let /bin/sh -c handle parsing.
function tokenize(line) {
  const tokens = [];
  // Three alternatives: bare run, double-quoted, single-quoted.
  const re = /"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|(\S+)/g;
  let m;
  while ((m = re.exec(line)) !== null) {
    if      (m[1] !== undefined) tokens.push(m[1].replace(/\\(.)/g, "$1"));
    else if (m[2] !== undefined) tokens.push(m[2].replace(/\\(.)/g, "$1"));
    else                          tokens.push(m[3]);
  }
  return tokens;
}

// Build the "what went wrong" snippet that lands in the error message.
// We used to slice to 200 chars — too aggressive: npm + docker errors
// routinely bury the actual cause 10 lines deep, behind warnings. 8 KB
// is generous enough to show the full failure for almost every CLI tool
// while still bounded (Postgres jsonb rows for executions stay sane).
// We trim from the END of stderr because most CLIs print the actionable
// error last.
const ERROR_TAIL_BYTES = 8 * 1024;
function tailForError(stderr) {
  const trimmed = (stderr || "").trim();
  if (!trimmed) return "no stderr";
  if (trimmed.length <= ERROR_TAIL_BYTES) return trimmed;
  return "…(showing last " + ERROR_TAIL_BYTES + " bytes)…\n" +
    trimmed.slice(-ERROR_TAIL_BYTES);
}

// Turn Node's terse spawn errors into messages that point at the fix.
// Most common case by far is ENOENT — usually a typo in the binary
// name, or a command-with-spaces passed without shell=true / args.
function friendlySpawnError(err, command, shell) {
  const msg = err?.message || String(err);
  if (err?.code === "ENOENT") {
    if (!shell && /\s/.test(command)) {
      return (
        `command not found "${command}". This looks like a multi-word ` +
        `command line — either split it into command + args, e.g. ` +
        `command="npm", args=["pack"], or set shell=true to run it ` +
        `through /bin/sh -c.`
      );
    }
    return (
      `command not found "${command}". Check the binary exists on the ` +
      `worker's PATH (you can verify with shell=true + "which ${command}").`
    );
  }
  if (err?.code === "EACCES") {
    return `permission denied executing "${command}" — file may not have the executable bit set.`;
  }
  return msg;
}
