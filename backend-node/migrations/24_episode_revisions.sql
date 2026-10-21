-- Optimistic episode/content collection versions. Defaults initialize existing rows.
ALTER TABLE dramas ADD COLUMN episodes_revision INTEGER NOT NULL DEFAULT 0;
ALTER TABLE episodes ADD COLUMN revision INTEGER NOT NULL DEFAULT 1;
-- migrate.js checks existing active duplicates before creating the partial unique index.
-- Historical/deleted episodes are preserved and are never automatically reactivated.
