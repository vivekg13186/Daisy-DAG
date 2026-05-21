// Plugin registry — DB-backed, transport-aware.
//
// Two transports:
//
//   in-process  — module is `import`-ed inside the worker. Same model
//                 as v0: zero network hops, full access to ctx + hooks.
//                 Used for core plugins (shipped in
//                 backend/src/plugins/builtin/) and operator-added
//                 plugins under plugins-extra/.
//
//   http        — plugin is a separate process / container exposing
//                 the four-endpoint contract:
//                   GET  /manifest      → JSON manifest
//                   GET  /healthz       → liveness
//                   GET  /readyz        → readiness
//                   POST /execute       → runs the plugin
//                 The worker POSTs `{ input, executionId, nodeName,
//                 workspaceId, config, deadlineMs }` to /execute and
//                 expects `{ output }` back.
//
// Boot sequence:
//   1. loadBuiltins() scans the filesystem for in-process plugins
//      (core + plugins-extra), imports them, UPSERTs each into the
//      plugins table tagged source='core' / 'local'.
//   2. loadAll() then reads every enabled row from the plugins table
//      and builds the in-memory registry. HTTP rows get a stub that
//      holds the manifest + endpoint; the actual remote module isn't
//      imported.
//   3. invoke() dispatches based on transport_kind on the row.
//
// Why DB-driven: operators install / disable / upgrade plugins at
// runtime through the admin UI or CLI, without redeploying the
// worker. The filesystem is still authoritative for `core` (so a
// `git pull` + restart adds new builtins automatically), but
// `marketplace:*` and `local` plugins live entirely in DB.

import Ajv from "ajv";
import addFormats from "ajv-formats";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { trace, SpanStatusCode } from "@opentelemetry/api";
import { log } from "../utils/logger.js";
import { pool } from "../db/pool.js";

const tracer = trace.getTracer("daisy-dag.plugins");

const ajv = new Ajv({ allErrors: true, coerceTypes: true, useDefaults: true, strict: false });
addFormats(ajv);

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ────────────────────────────────────────────────────────────────────
// Registry
// ────────────────────────────────────────────────────────────────────

class PluginRegistry {
  constructor() {
    /**
     * Two-level cache:
     *   byNV   Map<"name@version", entry>   strict (version pin) lookup
     *   byName Map<name, entry>             resolves to the default version
     *
     * An `entry` is the in-memory shape:
     *   {
     *     name, version, isDefault, source, transport,
     *     inputSchema, outputSchema, primaryOutput, description, configRefs,
     *     // in-process only:
     *     execute, validateInput, validateOutput,
     *   }
     */
    this.byNV   = new Map();
    this.byName = new Map();
    // Cache of imported in-process modules. Keyed by file path so
    // re-loads pick up edits during dev `node --watch` runs.
    this._modules = new Map();
  }

  /**
   * Build the in-memory cache from the plugins table. Call after
   * loadBuiltins so core plugins are already upserted.
   */
  async loadAll() {
    let rows = [];
    let multiVersion = true;          // Phase 3 schema (PK = name, version)
    try {
      const r = await pool.query(
        `SELECT name, version, manifest, transport_kind, endpoint, source, status,
                COALESCE(is_default, true) AS is_default,
                category,
                COALESCE(deprecated, false) AS deprecated
           FROM plugins
          WHERE enabled = true
          ORDER BY name, version`,
      );
      rows = r.rows;
    } catch (e) {
      // Pre-migration scenarios → tolerate either missing table
      // (42P01) or missing column (42703) so dev can run pre-019.
      if (e.code === "42P01") {
        log.warn("plugins table missing; running with in-memory builtins only");
        return;
      }
      if (e.code === "42703") {
        // Fall back to the 018 shape (no is_default / category /
        // deprecated columns). category + deprecated default to
        // the values inside the manifest JSON, which the module
        // export populated at upsert time.
        multiVersion = false;
        const r2 = await pool.query(
          `SELECT name, version, manifest, transport_kind, endpoint, source, status
             FROM plugins
            WHERE enabled = true
            ORDER BY name`,
        );
        rows = r2.rows.map(r => ({
          ...r,
          is_default: true,
          category:   r.manifest?.category   || null,
          deprecated: r.manifest?.deprecated === true,
        }));
      } else throw e;
    }

    this.byNV.clear();
    this.byName.clear();
    for (const row of rows) {
      try {
        let entry;
        if (row.transport_kind === "in-process") {
          // For in-process, the manifest references the file path
          // inside __manifest.modulePath. Re-import the module so
          // the cached entry has its execute function.
          const modulePath = row.manifest?.__manifest?.modulePath;
          if (!modulePath) {
            log.warn("in-process plugin missing modulePath", { name: row.name });
            continue;
          }
          const mod = await this._loadModule(modulePath);
          entry = this._buildInProcessEntry(row, mod);
        } else if (row.transport_kind === "http") {
          entry = this._buildHttpEntry(row);
        } else {
          continue;
        }
        this.byNV.set(`${entry.name}@${entry.version}`, entry);
        // The is_default winner per name fills byName. If a single
        // version is installed, it's default by definition (the DB
        // partial unique index enforces "at most one default per
        // name", but doesn't force one to exist — so we also fall
        // back to "first version encountered" below).
        if (entry.isDefault) this.byName.set(entry.name, entry);
        else if (!this.byName.has(entry.name)) this.byName.set(entry.name, entry);
      } catch (e) {
        log.warn("plugin load failed", { name: row.name, version: row.version, error: e.message });
      }
    }
    log.info("plugin registry ready", {
      versions: this.byNV.size,
      names:    this.byName.size,
      multiVersion,
    });
  }

  async _loadModule(modulePath) {
    if (this._modules.has(modulePath)) return this._modules.get(modulePath);
    const mod = await import(pathToFileURL(modulePath).href);
    const plugin = mod.default || mod.plugin;
    this._modules.set(modulePath, plugin);
    return plugin;
  }

  _buildInProcessEntry(row, mod) {
    const validateInput  = row.manifest.inputSchema  ? ajv.compile(row.manifest.inputSchema)  : null;
    const validateOutput = row.manifest.outputSchema ? ajv.compile(row.manifest.outputSchema) : null;
    return {
      name:          row.name,
      version:       row.version,
      isDefault:     !!row.is_default,
      source:        row.source,
      description:   row.manifest.description,
      // Prefer the live column so operator overrides win; fall back
      // to the manifest field (so pre-032 DBs still render right).
      category:      row.category   ?? row.manifest.category   ?? null,
      deprecated:    row.deprecated ?? row.manifest.deprecated === true,
      inputSchema:   row.manifest.inputSchema,
      outputSchema:  row.manifest.outputSchema,
      primaryOutput: row.manifest.primaryOutput,
      configRefs:    row.manifest.configRefs || [],
      transport:     { kind: "in-process" },
      execute:       mod.execute,
      validateInput,
      validateOutput,
    };
  }

  _buildHttpEntry(row) {
    // No execute function — invoke() routes via invokeOverHttp.
    const validateInput  = row.manifest.inputSchema  ? ajv.compile(row.manifest.inputSchema)  : null;
    const validateOutput = row.manifest.outputSchema ? ajv.compile(row.manifest.outputSchema) : null;
    return {
      name:          row.name,
      version:       row.version,
      isDefault:     !!row.is_default,
      source:        row.source,
      description:   row.manifest.description,
      category:      row.category   ?? row.manifest.category   ?? null,
      deprecated:    row.deprecated ?? row.manifest.deprecated === true,
      inputSchema:   row.manifest.inputSchema,
      outputSchema:  row.manifest.outputSchema,
      primaryOutput: row.manifest.primaryOutput,
      configRefs:    row.manifest.configRefs || [],
      transport:     {
        kind:      "http",
        endpoint:  row.endpoint,
        streaming: row.manifest.transport?.streaming === true,
      },
      validateInput,
      validateOutput,
    };
  }

  /**
   * Resolve a plugin entry.
   *
   *   get("reddit.search")          → default-version row
   *   get("reddit.search@1.2.0")    → exact version
   *
   * Throws with a clear message when the name (or pinned version)
   * doesn't resolve. The caller — the executor — surfaces this as
   * a node failure with the standard onError handling.
   */
  get(actionId) {
    const { name, version } = parsePluginRef(actionId);
    if (version) {
      const exact = this.byNV.get(`${name}@${version}`);
      if (exact) return exact;
      const fallback = this.byName.get(name);
      if (fallback) {
        throw new Error(
          `plugin "${name}@${version}" not installed (default version is ${fallback.version})`,
        );
      }
      throw new Error(`Unknown action "${actionId}"`);
    }
    const def = this.byName.get(name);
    if (!def) throw new Error(`Unknown action "${actionId}"`);
    return def;
  }

  list() {
    return [...this.byNV.values()].map(p => ({
      name:          p.name,
      version:       p.version,
      isDefault:     p.isDefault,
      source:        p.source,
      description:   p.description,
      category:      p.category,
      deprecated:    p.deprecated,
      inputSchema:   p.inputSchema,
      outputSchema:  p.outputSchema,
      primaryOutput: p.primaryOutput,
      transport:     p.transport.kind,
    }));
  }

  /**
   * Invoke a registered plugin.
   *
   * In-process plugins keep the legacy contract:
   *   execute(input, ctx, hooks, opts)
   *
   * HTTP plugins receive a JSON payload over the wire — see
   * invokeOverHttp for the shape.
   */
  async invoke(name, input, ctx, hooks, opts = {}) {
    return tracer.startActiveSpan(
      `plugin.${name}`,
      { attributes: { "plugin.name": name } },
      async (span) => {
        try {
          const p = this.get(name);
          span.setAttribute("plugin.transport", p.transport.kind);
          span.setAttribute("plugin.version",   p.version);

          if (p.validateInput && !p.validateInput(input)) {
            const errs = p.validateInput.errors.map(e => `${e.instancePath} ${e.message}`).join("; ");
            throw new Error(`Plugin "${name}" input invalid: ${errs}`);
          }
          const output = p.transport.kind === "http"
            ? await invokeOverHttp(p, input, ctx, opts)
            : await p.execute(input, ctx, hooks, opts);

          if (p.validateOutput && !p.validateOutput(output)) {
            const errs = p.validateOutput.errors.map(e => `${e.instancePath} ${e.message}`).join("; ");
            throw new Error(`Plugin "${name}" output invalid: ${errs}`);
          }
          span.setStatus({ code: SpanStatusCode.OK });
          return output;
        } catch (e) {
          span.recordException(e);
          span.setStatus({ code: SpanStatusCode.ERROR, message: e?.message || String(e) });
          throw e;
        } finally {
          span.end();
        }
      },
    );
  }
}

export const registry = new PluginRegistry();

/**
 * Parse a workflow DSL `action` field into name + optional pinned
 * version. The syntax is "name" or "name@version" (semver-ish).
 * Trailing whitespace is tolerated.
 */
export function parsePluginRef(actionId) {
  if (!actionId || typeof actionId !== "string") {
    throw new Error("plugin action must be a non-empty string");
  }
  const s = actionId.trim();
  const at = s.indexOf("@");
  if (at < 0) return { name: s, version: null };
  return { name: s.slice(0, at), version: s.slice(at + 1) || null };
}

// ────────────────────────────────────────────────────────────────────
// HTTP transport
// ────────────────────────────────────────────────────────────────────

/**
 * Translate the legacy in-process call into the standardised HTTP
 * payload. Streaming hooks are not yet forwarded over the wire
 * (Phase 2); HTTP plugins that need streaming should return a final
 * `output` after collecting their own state.
 *
 * `opts.signal` is the engine's per-invocation AbortSignal — wired
 * directly into fetch so a node timeout closes the socket cleanly.
 */
async function invokeOverHttp(plugin, input, ctx, opts) {
  const base = plugin.transport.endpoint.replace(/\/$/, "");
  const url  = `${base}/execute`;

  // Resolve the configs the plugin declared it needs from ctx.config.
  // We pass plaintext values (the worker has already decrypted them)
  // so the plugin doesn't need an auth path back to the core for
  // secret retrieval. The plugin gets only what it declared.
  const resolvedConfig = {};
  for (const ref of plugin.configRefs || []) {
    const v = ctx?.config?.[ref.name];
    if (v != null) {
      resolvedConfig[ref.name] = v;
    } else if (ref.required) {
      throw new Error(
        `plugin "${plugin.name}": required config "${ref.name}" (${ref.type || "any"}) not configured in this workspace`,
      );
    }
  }

  const body = {
    input,
    executionId: ctx?.execution?.id,
    workspaceId: ctx?.execution?.workspaceId,
    nodeName:    ctx?._currentNode || null,
    config:      resolvedConfig,
    deadlineMs:  Number.isFinite(opts.deadlineMs) ? opts.deadlineMs : null,
  };

  const r = await fetch(url, {
    method:  "POST",
    headers: { "content-type": "application/json" },
    body:    JSON.stringify(body),
    signal:  opts.signal,
  });
  if (!r.ok) {
    const text = (await r.text().catch(() => "")).slice(0, 1000);
    throw new Error(`plugin "${plugin.name}" returned HTTP ${r.status}: ${text}`);
  }
  const parsed = await r.json().catch(() => null);
  if (!parsed || typeof parsed !== "object") {
    throw new Error(`plugin "${plugin.name}" returned non-JSON response`);
  }
  // Two response shapes accepted:
  //   { output: ... }            — recommended
  //   { ...primary fields ... }  — back-compat: assume the whole
  //                                 body IS the output
  return Object.prototype.hasOwnProperty.call(parsed, "output")
    ? parsed.output
    : parsed;
}

// ────────────────────────────────────────────────────────────────────
// loadBuiltins — discover filesystem plugins + write their manifests
// to DB so the runtime cache (loadAll) can find them next.
// ────────────────────────────────────────────────────────────────────

export async function loadBuiltins() {
  // Two source trees:
  //   builtin/         — core plugins shipped with the engine
  //   plugins-extra/   — operator-added in-process plugins (drop a .js
  //                      file in the folder, restart, it's registered)
  //
  // The historic `_deprecated/` folder (shell.exec, ssh, ftp, file.*,
  // csv.read/write, excel.read/write, mqtt.publish, web.scrape,
  // stream-demo) has been removed in Step 8. Migration 034 purges any
  // residual DB rows. Workflows that still reference those names now
  // fail with "Unknown action" at parse time — `reportDeprecatedUsage`
  // below scans every graph at boot and logs the offenders.
  const dirs = [
    { dir: path.resolve(__dirname, "builtin"),               source: "core"  },
    { dir: path.resolve(__dirname, "../../plugins-extra"),   source: "local" },
  ];
  for (const { dir, source } of dirs) {
    let files;
    try { files = await readdir(dir); }
    catch { continue; }
    for (const f of files) {
      if (!f.endsWith(".js")) continue;
      const fullPath = path.join(dir, f);
      try {
        const mod = await import(pathToFileURL(fullPath).href);
        const plugin = mod.default || mod.plugin;
        if (!plugin?.name) {
          log.warn("plugin module has no name", { file: fullPath });
          continue;
        }
        await upsertBuiltin(plugin, fullPath, source);
      } catch (e) {
        log.warn("plugin import failed", { file: fullPath, error: e.message });
      }
    }
  }
  log.info("plugin builtins synced", {});
}

// The names removed in Step 8. We hard-code them so the boot scan
// still surfaces broken workflows AFTER migration 034 has wiped the
// `deprecated=true` DB rows — there's nothing left in the registry
// or the DB to enumerate. If you deprecate a NEW plugin later, add
// its name here and tag the module deprecated:true so the runtime
// keeps a parallel path.
const REMOVED_PLUGIN_NAMES = new Set([
  "shell.exec",
  "ssh", "ftp",
  "file.read", "file.write", "file.list", "file.delete", "file.stat",
  "csv.read", "csv.write", "excel.read", "excel.write",
  "mqtt.publish",
  "web.scrape",
  "stream.demo",
]);

/**
 * Scan all stored graphs for references to plugins that have been
 * removed and emit one warning per (workspace, plugin) pair. Called
 * from the worker / API boot AFTER loadBuiltins + loadAll. Fire-and-
 * forget so a slow query never gates startup.
 *
 * Walks `dsl` JSONB on each graph row, picks out node `action` values,
 * strips the optional `@version`, and matches against
 * REMOVED_PLUGIN_NAMES + any plugin row still tagged deprecated=true
 * (catches operator-deprecated plugins beyond the core set).
 *
 * Workflows that reference these names will fail at parse time with
 * "Unknown action" — this log line tells admins WHICH workflows to
 * rewrite.
 */
export async function reportDeprecatedUsage() {
  const deprecatedNames = new Set(REMOVED_PLUGIN_NAMES);
  // Also pick up anything still tagged deprecated=true in the DB —
  // covers future deprecations done via the admin UI without a code
  // change here.
  try {
    const r = await pool.query(`SELECT DISTINCT name FROM plugins WHERE deprecated = true`);
    for (const row of r.rows) deprecatedNames.add(row.name);
  } catch (e) {
    // 42703 = column missing (pre-032). Fall back to the hard-coded
    // set — best effort.
    if (e.code !== "42703" && e.code !== "42P01") throw e;
  }
  if (deprecatedNames.size === 0) return;
  let rows;
  try {
    const r = await pool.query(`SELECT id, workspace_id, name, dsl FROM graphs WHERE dsl IS NOT NULL`);
    rows = r.rows;
  } catch (e) {
    if (e.code === "42P01" || e.code === "42703") return;   // pre-migration
    throw e;
  }
  const offenders = new Map();    // key: workspace_id|plugin → { graphs:Set<id>, count:n }
  for (const row of rows) {
    const nodes = Array.isArray(row.dsl?.nodes) ? row.dsl.nodes : [];
    for (const n of nodes) {
      const raw = typeof n?.action === "string" ? n.action : "";
      const name = raw.split("@")[0].trim();
      if (!deprecatedNames.has(name)) continue;
      const key = `${row.workspace_id || ""}|${name}`;
      const slot = offenders.get(key) || { workspaceId: row.workspace_id, plugin: name, graphs: new Set(), count: 0 };
      slot.graphs.add(row.name || row.id);
      slot.count += 1;
      offenders.set(key, slot);
    }
  }
  if (offenders.size === 0) return;
  for (const { workspaceId, plugin, graphs, count } of offenders.values()) {
    log.warn("removed plugin still referenced — workflows will fail at parse", {
      workspaceId: workspaceId || null,
      plugin,
      nodeOccurrences: count,
      graphCount:      graphs.size,
      // Cap the sample so a workspace with hundreds of offending
      // graphs doesn't flood the log line. The operator can SELECT
      // from graphs directly to enumerate the rest.
      graphs:          [...graphs].slice(0, 10),
    });
  }
}

async function upsertBuiltin(plugin, modulePath, source) {
  const version = plugin.version || "1.0.0";
  // Category + deprecation flag are part of the module's default
  // export so the file on disk is the source of truth — operators
  // don't reach into the DB to flip these.
  //
  // Recognised categories: 'engine', 'ai', 'enterprise',
  // 'deprecated'. Anything else is accepted and surfaces as-is in
  // the admin UI but won't get the curated rail; please stick to
  // these four.
  const category   = typeof plugin.category === "string" ? plugin.category : null;
  const deprecated = plugin.deprecated === true;
  const manifest = {
    name:          plugin.name,
    version,
    description:   plugin.description || "",
    category,
    deprecated,
    inputSchema:   plugin.inputSchema  || null,
    outputSchema:  plugin.outputSchema || null,
    primaryOutput: plugin.primaryOutput || null,
    configRefs:    plugin.configRefs   || [],
    // Internal hint so loadAll() can re-import the module without
    // re-walking the filesystem.
    __manifest: { modulePath },
  };
  // Try the Phase-3 UPSERT first (PK = name, version). If the
  // database is still on the Phase-1 schema, fall back to the
  // single-version UPSERT path. This keeps `npm run dev` working
  // against a pre-019 DB so the operator can run migrations
  // afterwards without the worker crashing on boot.
  //
  // The 032 migration adds `deprecated` and backfills `category`,
  // but we still try the wider INSERT first so that a fresh DB
  // (with all migrations applied) gets the columns populated
  // straight from each plugin module's exported fields.
  const sqlV3 = `
    INSERT INTO plugins (
      name, version, manifest, transport_kind, endpoint,
      source, status, is_default,
      category, deprecated,
      updated_at
    )
    VALUES (
      $1, $2, $3::jsonb, 'in-process', NULL,
      $4, 'healthy', true,
      $5, $6,
      NOW()
    )
    ON CONFLICT (name, version) DO UPDATE
       SET manifest       = EXCLUDED.manifest,
           transport_kind = EXCLUDED.transport_kind,
           endpoint       = EXCLUDED.endpoint,
           -- Don't downgrade an http-marketplace row back to 'core'
           -- if the same name happens to ship in the builtins
           -- folder. Operator wins.
           source         = CASE
                              WHEN plugins.transport_kind = 'http'
                              THEN plugins.source
                              ELSE EXCLUDED.source
                            END,
           status         = 'healthy',
           is_default     = plugins.is_default,
           -- Category + deprecated come from the module on every
           -- boot (file is source of truth). If the module didn't
           -- export them, keep whatever was already in the row so
           -- operator overrides for marketplace plugins aren't lost.
           category       = COALESCE(EXCLUDED.category,   plugins.category),
           deprecated     = COALESCE(EXCLUDED.deprecated, plugins.deprecated),
           updated_at     = NOW()
     WHERE plugins.transport_kind = 'in-process'`;
  try {
    await pool.query(sqlV3, [
      plugin.name, version, JSON.stringify(manifest),
      source, category, deprecated,
    ]);
    return;
  } catch (e) {
    if (e.code === "42P01") return;             // pre-migration; skip silently
    if (e.code !== "42703") {                   // not "column missing"
      log.warn("plugin upsert failed", { name: plugin.name, error: e.message });
      return;
    }
  }
  // Fallback: pre-019 schema, PK = (name) only.
  try {
    await pool.query(
      `INSERT INTO plugins (name, version, manifest, transport_kind, endpoint, source, status, updated_at)
       VALUES ($1, $2, $3::jsonb, 'in-process', NULL, $4, 'healthy', NOW())
       ON CONFLICT (name) DO UPDATE
          SET version        = EXCLUDED.version,
              manifest       = EXCLUDED.manifest,
              transport_kind = EXCLUDED.transport_kind,
              endpoint       = EXCLUDED.endpoint,
              source         = CASE
                                 WHEN plugins.transport_kind = 'http'
                                 THEN plugins.source
                                 ELSE EXCLUDED.source
                               END,
              status         = 'healthy',
              updated_at     = NOW()
        WHERE plugins.transport_kind = 'in-process'`,
      [plugin.name, version, JSON.stringify(manifest), source],
    );
  } catch (e) {
    log.warn("plugin upsert failed (fallback)", { name: plugin.name, error: e.message });
  }
}
