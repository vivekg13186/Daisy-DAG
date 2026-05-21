// Workspace-level AI provider settings — stored encrypted in workspaces.ai_settings.
//
// Priority: DB-stored key > env vars (config.ai.*).
// Callers: api/ai.js uses getWorkspaceAiConfig() on every AI request so the key
// is picked up without a backend restart after a user saves it via the UI.
//
// Cache: each resolved config is held in memory for 30 s per workspace to avoid
// a DB round-trip on every chat message.

import { pool }   from "../db/pool.js";
import { config } from "../config.js";
import {
  encryptValueWithDek,
  decryptValueWithDek,
  readCryptoBlock,
  writeCryptoBlock,
  wipeBuffer,
} from "../configs/crypto.js";
import { getProvider } from "../secrets/kms.js";

// ── in-memory cache ───────────────────────────────────────────────────────────
const _cache      = new Map(); // workspaceId → { cfg, expiresAt }
const CACHE_TTL   = 30_000;   // ms

function _invalidate(workspaceId) { _cache.delete(workspaceId); }

// ── public API ────────────────────────────────────────────────────────────────

/**
 * Returns the effective AI config for a workspace.
 *
 * Result shape:
 *   { provider, apiKey, model, baseUrl, maxTokens, source: "db"|"env" }
 *
 * "source" tells callers (and the /status endpoint) where the key came from.
 */
export async function getWorkspaceAiConfig(workspaceId) {
  const hit = _cache.get(workspaceId);
  if (hit && hit.expiresAt > Date.now()) return hit.cfg;

  const row = await pool.query(
    "SELECT ai_settings, ai_kek_id FROM workspaces WHERE id = $1",
    [workspaceId],
  ).then(r => r.rows[0]);

  const stored  = row?.ai_settings || {};
  let   apiKey  = "";

  if (stored.api_key_enc) {
    try {
      const kms         = await getProvider();
      const cryptoBlock = readCryptoBlock(stored);
      if (cryptoBlock) {
        const dek = await kms.decrypt(cryptoBlock.wrappedDek, cryptoBlock.kekId);
        apiKey    = decryptValueWithDek(stored.api_key_enc, dek) || "";
        wipeBuffer(dek);
      }
    } catch {
      apiKey = ""; // decryption failure — fall back to env
    }
  }

  const source = apiKey ? "db" : "env";

  const cfg = {
    provider:  stored.provider || config.ai.provider,
    apiKey:    apiKey          || config.ai.apiKey,
    model:     stored.model    || config.ai.model,
    baseUrl:   stored.base_url || config.ai.baseUrl,
    maxTokens: config.ai.maxTokens,
    source,
  };

  _cache.set(workspaceId, { cfg, expiresAt: Date.now() + CACHE_TTL });
  return cfg;
}

/**
 * Save AI settings for a workspace. The apiKey is encrypted with a fresh DEK
 * before being written. Pass apiKey="" to update provider/model/baseUrl only.
 */
export async function setWorkspaceAiSettings(workspaceId, { provider, apiKey, model, baseUrl }) {
  const row = await pool.query(
    "SELECT ai_settings, ai_kek_id FROM workspaces WHERE id = $1",
    [workspaceId],
  ).then(r => r.rows[0]);

  // Clone existing settings so we only overwrite what was provided.
  const settings = { ...(row?.ai_settings || {}) };
  if (provider !== undefined) settings.provider  = provider  || undefined;
  if (model    !== undefined) settings.model     = model     || undefined;
  if (baseUrl  !== undefined) settings.base_url  = baseUrl   || undefined;

  // Remove undefined keys
  for (const k of Object.keys(settings)) {
    if (settings[k] === undefined) delete settings[k];
  }

  let kekId = row?.ai_kek_id || null;

  if (apiKey) {
    const kms = await getProvider();
    const { plaintextDek, wrappedDek, kekId: newKekId } = await kms.generateDataKey();
    kekId                 = newKekId;
    settings.api_key_enc  = encryptValueWithDek(apiKey, plaintextDek);
    writeCryptoBlock(settings, { wrappedDek, kekId });
    wipeBuffer(plaintextDek);
  }

  await pool.query(
    "UPDATE workspaces SET ai_settings = $1, ai_kek_id = $2, updated_at = NOW() WHERE id = $3",
    [settings, kekId, workspaceId],
  );

  _invalidate(workspaceId);
}

/**
 * Remove all DB-stored AI settings for a workspace (falls back to env vars).
 */
export async function clearWorkspaceAiSettings(workspaceId) {
  await pool.query(
    "UPDATE workspaces SET ai_settings = '{}', ai_kek_id = NULL, updated_at = NOW() WHERE id = $1",
    [workspaceId],
  );
  _invalidate(workspaceId);
}
