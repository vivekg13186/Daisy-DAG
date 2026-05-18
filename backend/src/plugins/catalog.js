// Marketplace catalog — fetches + caches the plugin index Daisy
// admins browse from the Plugins page.
//
// Source order:
//   1. process.env.PLUGIN_CATALOG_URL  — explicit override (remote HTTPS)
//   2. process.env.PLUGIN_CATALOG_FILE — explicit override (local file)
//   3. DEFAULT_CATALOG_URL             — hosted default, used when no
//                                        env vars are set
//   4. deploy/plugin-catalog.example.json
//      — last-resort local fallback if (3) is unreachable. Useful for
//      air-gapped deployments and CI / tests.
//
// Cached in memory for CATALOG_TTL_MS (default 5 min). `?refresh=1`
// on the endpoint bypasses the cache.
//
// Catalog schema (single JSON object):
//
//   {
//     "name":    "Daisy-workflow Official",
//     "version": "1",
//     "plugins": [
//       {
//         "name":           "reddit.search",       // matches plugin manifest.name
//         "version":        "0.1.0",                // matches plugin manifest.version
//         "summary":        "Search Reddit posts.",
//         "category":       "social",
//         "tags":           ["reddit", "search"],
//         "homepage":       "https://github.com/.../reddit-plugin",
//         "manifestUrl":    "https://.../manifest.json",
//         "manifestSha256": "<hex>",                // verified at install time
//         "containerImage": "ghcr.io/.../reddit:0.1.0",
//         "containerPort":  8080
//       }
//     ]
//   }

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { log } from "../utils/logger.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CATALOG_TTL_MS = 5 * 60_000;

// Default hosted catalog. Used when neither PLUGIN_CATALOG_URL nor
// PLUGIN_CATALOG_FILE is set. Falls back to the bundled local catalog
// if this URL is unreachable so air-gapped / offline setups still work.
const DEFAULT_CATALOG_URL = "https://daisy-workflow.web.app/plugin-catalog.json";

let _cache = null;        // { data, fetchedAt, source }
let _cachedAt = 0;

/**
 * Return the marketplace catalog. Cached for CATALOG_TTL_MS; pass
 * `{ refresh: true }` to force re-fetch.
 *
 * Throws on unreachable / malformed catalog so the admin UI can
 * surface a clear error instead of silently rendering an empty list.
 */
export async function loadCatalog({ refresh = false } = {}) {
  if (!refresh && _cache && Date.now() - _cachedAt < CATALOG_TTL_MS) {
    return _cache;
  }

  // Resolution: explicit URL env → explicit FILE env → hosted default
  // (with a bundled-file safety net if the hosted catalog is offline).
  const explicitUrl  = process.env.PLUGIN_CATALOG_URL  || null;
  const explicitFile = process.env.PLUGIN_CATALOG_FILE || null;
  const bundledFile  = path.resolve(__dirname, "../../../deploy/plugin-catalog.example.json");

  let raw;
  let source;
  if (explicitUrl) {
    const r = await fetchWithTimeout(explicitUrl, 5000);
    raw = await r.text();
    source = explicitUrl;
  } else if (explicitFile) {
    raw = fs.readFileSync(explicitFile, "utf8");
    source = explicitFile;
  } else {
    // Default path: try the hosted catalog, fall back to the bundled
    // local file if the network call fails. This keeps fresh installs
    // working out-of-the-box while still allowing air-gapped operation.
    try {
      const r = await fetchWithTimeout(DEFAULT_CATALOG_URL, 5000);
      raw = await r.text();
      source = DEFAULT_CATALOG_URL;
    } catch (netErr) {
      log.warn("default plugin catalog unreachable, falling back to bundled file", {
        url: DEFAULT_CATALOG_URL, error: netErr.message,
      });
      try {
        raw = fs.readFileSync(bundledFile, "utf8");
        source = bundledFile;
      } catch (fileErr) {
        throw new Error(
          `Plugin catalog unavailable: hosted default ${DEFAULT_CATALOG_URL} failed ` +
          `(${netErr.message}) and bundled fallback ${bundledFile} also failed (${fileErr.message}). ` +
          `Set PLUGIN_CATALOG_URL or PLUGIN_CATALOG_FILE to override.`,
        );
      }
    }
  }

  let parsed;
  try { parsed = JSON.parse(raw); }
  catch (e) { throw new Error(`catalog ${source} is not JSON: ${e.message}`); }

  validate(parsed, source);

  const out = { data: parsed, fetchedAt: Date.now(), source };
  _cache    = out;
  _cachedAt = out.fetchedAt;
  log.info("plugin catalog loaded", {
    source, count: parsed.plugins?.length || 0,
  });
  return out;
}

function validate(c, source) {
  if (!c || typeof c !== "object") throw new Error(`${source}: catalog is not an object`);
  if (!Array.isArray(c.plugins))   throw new Error(`${source}: catalog.plugins must be an array`);
  for (const p of c.plugins) {
    if (typeof p.name        !== "string") throw new Error(`${source}: plugin.name missing`);
    if (typeof p.version     !== "string") throw new Error(`${source}: ${p.name} missing version`);
    if (typeof p.manifestUrl !== "string") throw new Error(`${source}: ${p.name}@${p.version} missing manifestUrl`);
  }
}

async function fetchWithTimeout(url, timeoutMs) {
  const ac = new AbortController();
  const t  = setTimeout(() => ac.abort(), timeoutMs);
  if (typeof t.unref === "function") t.unref();
  try {
    const r = await fetch(url, { signal: ac.signal });
    if (!r.ok) throw new Error(`${url} returned HTTP ${r.status}`);
    return r;
  } catch (e) {
    if (e.name === "AbortError") throw new Error(`${url} timed out after ${timeoutMs}ms`);
    throw e;
  } finally {
    clearTimeout(t);
  }
}
