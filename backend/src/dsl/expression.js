// Resolves ${expr} placeholders in DSL values.
//
// Inside the braces we evaluate the expression with **FEEL** (via the
// `feelin` library — https://github.com/nikku/feelin). FEEL is the
// Friendly Enough Expression Language standardised in DMN, with proper
// list filters, quantifiers, conditionals, big-decimal arithmetic, and
// a documented spec the AI knows well.
//
// We keep the `${...}` template syntax (rather than going full FEEL
// per-input) so existing flows migrate quietly:
//
//   • A "pure path" like  data.users.0.email  takes a fast path and uses
//     our own 0-indexed walker. FEEL is 1-indexed, so without this
//     existing path expressions that drill into arrays would silently
//     return null after the swap.
//
//   • A compound expression (anything that isn't a bare path) goes
//     through FEEL. Common JS-isms (&&, ||, ==) are translated to their
//     FEEL equivalents (and, or, =) on the way in so old expressions
//     keep parsing.
//
// String interpolation behaviour is unchanged:
//   • `"${v}"` (single placeholder filling the whole string) → the
//     original typed value is returned.
//   • Strings containing multiple placeholders / surrounding text →
//     each placeholder is evaluated and stringified into the template.

import { evaluate as feelEvaluate } from "feelin";

// Helper functions injected into every FEEL evaluation context. FEEL has
// no JSON built-ins, so we surface JSON.stringify / JSON.parse as proper
// FEEL-callable functions: `toJson(payload)` and `parseJson(text)`.
//
// They live under names that don't clash with FEEL keywords or user vars
// (FEEL identifiers are lowercase-camel-friendly), so they shouldn't
// shadow ctx keys in practice.
// Exported so other call-sites that hand strings to feelin directly
// (notably the `transform` plugin) can splice the same helper functions
// into their scope — keeps the FEEL dialect identical everywhere.
export const FEEL_HELPERS = Object.freeze({
  toJson: (v) => {
    try { return JSON.stringify(v); }
    catch { return null; }
  },
  toJsonPretty: (v) => {
    try { return JSON.stringify(v, null, 2); }
    catch { return null; }
  },
  parseJson: (s) => {
    if (typeof s !== "string") return null;
    try { return JSON.parse(s); }
    catch { return null; }
  },
});

const PLACEHOLDER = /\$\{([^}]+)\}/g;

// Strict identifier path — letters/digits/_, dots and hyphens are allowed
// so legacy expressions like `data.users.0.email` and
// `nodes.fetch.output.body-id` keep working through the fast path.
const PURE_PATH_RE = /^[A-Za-z_][A-Za-z0-9_.-]*$/;

function getPath(obj, path) {
  const parts = path.split(".");
  let cur = obj;
  for (const p of parts) {
    if (cur == null) return undefined;
    cur = cur[p];
  }
  return cur;
}

/**
 * Translate JS-style logical/comparison operators that don't exist in
 * FEEL into the FEEL equivalents:
 *   &&  →  and
 *   ||  →  or
 *   ==  →  =
 *   !=  →  !=    (already valid FEEL, no change)
 *
 * The replacement skips quoted-string regions so a literal like
 * `"a && b"` inside an expression isn't corrupted.
 */
function jsToFeel(expr) {
  const segments = [];
  const stringRe = /"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g;
  let last = 0;
  let m;
  while ((m = stringRe.exec(expr)) !== null) {
    if (m.index > last) segments.push(translateCode(expr.slice(last, m.index)));
    segments.push(m[0]);
    last = stringRe.lastIndex;
  }
  if (last < expr.length) segments.push(translateCode(expr.slice(last)));
  return segments.join("");
}

function translateCode(s) {
  return s
    .replace(/&&/g, " and ")
    .replace(/\|\|/g, " or ")
    // Treat `==` as FEEL `=`, but leave `!=` and `<=`/`>=` alone.
    .replace(/(?<![!<>])==/g, "=");
}

function evalSingle(expr, ctx) {
  const trimmed = expr.trim();

  // Fast path — bare dotted/identifier reference. Same 0-indexed
  // walker the engine has always used, no FEEL involvement.
  if (PURE_PATH_RE.test(trimmed)) {
    return getPath(ctx, trimmed);
  }

  // Compound expression — hand to FEEL with our helpers spliced into
  // the scope so callers can use toJson()/parseJson()/toJsonPretty()
  // alongside everything FEEL already provides.
  const feelExpr = jsToFeel(trimmed);
  try {
    return feelEvaluate(feelExpr, { ...FEEL_HELPERS, ...ctx });
  } catch (e) {
    throw new Error(`Failed to evaluate expression "${trimmed}": ${e.message}`);
  }
}

/**
 * Resolve any ${...} placeholders inside a value.
 *
 *   • Strings with no placeholders are returned unchanged.
 *   • A string that IS a single full-width placeholder returns the
 *     evaluator's typed result (numbers/booleans/objects keep their type).
 *   • Mixed strings — each placeholder is stringified and pasted back in.
 *   • Objects and arrays recurse.
 */
export function resolve(value, ctx) {
  if (value == null) return value;
  if (typeof value === "string") {
    const matches = [...value.matchAll(PLACEHOLDER)];
    if (matches.length === 0) return value;
    if (matches.length === 1 && matches[0][0] === value) {
      return evalSingle(matches[0][1], ctx);
    }
    return value.replace(PLACEHOLDER, (_, expr) => {
      const v = evalSingle(expr, ctx);
      return v == null ? "" : String(v);
    });
  }
  if (Array.isArray(value)) return value.map(v => resolve(v, ctx));
  if (typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = resolve(v, ctx);
    return out;
  }
  return value;
}

/** Evaluate a boolean expression like  ${nodes.fetch.output.count > 0}. */
export function evalCondition(expr, ctx) {
  if (!expr) return true;
  const resolved = resolve(expr, ctx);
  return Boolean(resolved);
}
