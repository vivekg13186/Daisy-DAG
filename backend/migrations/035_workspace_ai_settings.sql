-- 035_workspace_ai_settings.sql
-- Per-workspace AI provider settings stored encrypted in the workspaces table.
-- Env vars (ANTHROPIC_API_KEY / OPENAI_API_KEY / AI_MODEL / AI_BASE_URL) remain
-- the fallback when these columns are empty / null.

ALTER TABLE workspaces
  ADD COLUMN IF NOT EXISTS ai_settings  JSONB NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS ai_kek_id    TEXT;

COMMENT ON COLUMN workspaces.ai_settings IS
  'Encrypted AI provider settings: { provider, model, base_url, api_key_enc, __crypto }';
COMMENT ON COLUMN workspaces.ai_kek_id IS
  'KEK identifier for the wrapped DEK stored in ai_settings.__crypto.dek';
