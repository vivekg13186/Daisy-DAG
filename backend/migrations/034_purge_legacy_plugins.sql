-- Purge legacy plugin rows — Step 8.
--
-- Step 4 (migration 032) marked the local-host plugins as deprecated
-- and quarantined the source files into _deprecated/. Step 8 removes
-- the files entirely and this migration deletes the residual DB rows
-- so they stop showing up on the admin Plugins page.
--
-- We DELETE by name list rather than `WHERE deprecated = true` so the
-- migration is idempotent across operator-deprecated plugins — if an
-- admin marked their own marketplace plugin deprecated through the
-- UI, that row's category was set but it should NOT be auto-purged.
-- Only the core set the engine itself removed in Step 8 is touched.
--
-- The `deprecated` and `category` columns stay on the table — they
-- remain useful for future deprecations (and the admin Plugins page
-- still reads `category` to render the curated rails).

-- 1) Purge the plugin rows. Use a CTE so we can clean up the
--    per-project enablement grants in the same statement (cascade
--    behaviour isn't wired up — these tables are separate concerns).
WITH removed_names(name) AS (
  VALUES
    ('shell.exec'),
    ('ssh'), ('ftp'),
    ('file.read'), ('file.write'), ('file.list'),
    ('file.delete'), ('file.stat'),
    ('csv.read'), ('csv.write'),
    ('excel.read'), ('excel.write'),
    ('mqtt.publish'),
    ('web.scrape'),
    ('stream.demo')
)
DELETE FROM plugins
 WHERE source = 'core'
   AND name IN (SELECT name FROM removed_names);

-- 2) Drop any per-project enablement grants pinned to the removed
--    names. A grant referencing a non-existent plugin is harmless but
--    clutters the admin Project Plugins page with broken rows.
DELETE FROM project_plugin_grants
 WHERE plugin_name IN (
   'shell.exec',
   'ssh', 'ftp',
   'file.read', 'file.write', 'file.list', 'file.delete', 'file.stat',
   'csv.read', 'csv.write', 'excel.read', 'excel.write',
   'mqtt.publish',
   'web.scrape',
   'stream.demo'
 );

-- 3) Drop any stored `ssh` / `ftp` configs — the config types were
--    removed in Step 8 alongside their consumers. If an operator
--    still has rows for these types, they'll silently fail to load
--    on the next worker boot anyway (the type definition is gone),
--    so wiping them here keeps the Configurations page tidy. We
--    leave `mqtt` configs alone — the MQTT trigger still uses them.
DELETE FROM configs WHERE type IN ('ssh', 'ftp');
