-- One-time migration for a D1 database created from the first schema.sql (no authentic flag).
-- Run once BEFORE d1_load.sql: wrangler d1 execute life-pop --remote --file data/d1_migrate.sql
-- (fails with 'duplicate column name' if already applied, which is harmless.)
ALTER TABLE pop ADD COLUMN is_authentic INTEGER NOT NULL DEFAULT 0;
