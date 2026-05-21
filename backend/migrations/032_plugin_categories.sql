-- Plugin categorization — cloud-only reorganization (Step 1).
--
-- Two things in this migration:
--
--   1. New `deprecated` column on plugins. Rows tagged `deprecated=true`
--      are still resolvable (existing workflows keep running) but the
--      Plugins page surfaces them in a "Deprecated — will be removed"
--      bucket, and `ALLOW_LEGACY_PLUGINS=0` (future) will skip them at
--      registry boot.
--
--   2. Backfill `category` and `deprecated` for every in-tree builtin
--      so the admin UI doesn't show a giant uncategorised list on first
--      boot after the migration. Subsequent boots overwrite from each
--      plugin module's exported `category` / `deprecated` fields — the
--      module is the source of truth, this is just a one-shot backfill
--      so the columns aren't empty.
--
-- Categories:
--   engine       — DSL primitives (transform, delay, log, user,
--                  workflow.fire, memory.*, http.request). Always loaded.
--   ai           — AI / RAG actions (agent, model.route, image.generate,
--                  rag.ingest, rag.retrieve).
--   enterprise   — Enterprise data plane + connectors (sql.*, email.send).
--   deprecated   — Local-host plugins slated for removal in favour of
--                  cloud-native equivalents (object.store.*, etc.).

ALTER TABLE plugins
  ADD COLUMN IF NOT EXISTS deprecated BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN plugins.deprecated IS
  'True when the plugin is scheduled for removal. Still resolvable for back-compat; flagged in the admin UI.';

CREATE INDEX IF NOT EXISTS idx_plugins_deprecated
  ON plugins (deprecated) WHERE deprecated = true;

-- ─── Engine primitives ──────────────────────────────────────────────
UPDATE plugins SET category = 'engine', deprecated = false
 WHERE name IN (
   'transform', 'delay', 'log', 'user', 'workflow.fire', 'http.request',
   'memory.get', 'memory.set', 'memory.append', 'memory.delete',
   'memory.history.load', 'memory.history.append'
 ) AND (category IS DISTINCT FROM 'engine' OR deprecated <> false);

-- ─── AI / RAG ───────────────────────────────────────────────────────
UPDATE plugins SET category = 'ai', deprecated = false
 WHERE name IN (
   'agent', 'model.route', 'image.generate',
   'rag.ingest', 'rag.retrieve'
 ) AND (category IS DISTINCT FROM 'ai' OR deprecated <> false);

-- ─── Enterprise data plane ──────────────────────────────────────────
UPDATE plugins SET category = 'enterprise', deprecated = false
 WHERE name IN (
   'sql.select', 'sql.insert', 'sql.update', 'sql.delete', 'sql.execute',
   'email.send'
 ) AND (category IS DISTINCT FROM 'enterprise' OR deprecated <> false);

-- ─── Deprecated (local-host / cloud-unsafe) ─────────────────────────
-- Kept resolvable for back-compat; the Plugins page should show these
-- in a separate "Deprecated" panel with a "won't be in next release"
-- banner. Cloud-native replacements ship under category='enterprise'
-- in Step 3 (object.store.*).
UPDATE plugins SET category = 'deprecated', deprecated = true
 WHERE name IN (
   'shell.exec',
   'ssh', 'ftp',
   'file.read', 'file.write', 'file.list', 'file.delete', 'file.stat',
   'csv.read', 'csv.write', 'excel.read', 'excel.write',
   'mqtt.publish',
   'web.scrape',
   'stream.demo'
 ) AND (category IS DISTINCT FROM 'deprecated' OR deprecated <> true);
