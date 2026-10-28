-- LIFE TCG graded-population schema. Runs unchanged on SQLite and Cloudflare D1.
-- Re-runnable: everything is IF NOT EXISTS (the data itself is reloaded by data/d1_load.sql).

CREATE TABLE IF NOT EXISTS graders (
  code   TEXT PRIMARY KEY,                 -- CGC, TAG, AGS, PSA, BGS, SGC, ACE
  name   TEXT NOT NULL,
  url    TEXT,
  method TEXT NOT NULL CHECK (method IN ('scrape', 'browser', 'manual'))
);

CREATE TABLE IF NOT EXISTS sets (
  id         INTEGER PRIMARY KEY,
  name       TEXT NOT NULL UNIQUE,         -- canonical, e.g. "Mammals 1st Edition (Kickstarter)"
  year       INTEGER,
  sort_order INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS cards (
  id      INTEGER PRIMARY KEY,
  set_id  INTEGER NOT NULL REFERENCES sets(id),
  number  TEXT NOT NULL,                   -- normalized: no leading zeros, no "/100" suffix
  name    TEXT NOT NULL,
  variant TEXT NOT NULL DEFAULT 'Base',    -- Base, Holo, Full Art, Uncommon, ...
  UNIQUE (set_id, number, name, variant)
);
CREATE INDEX IF NOT EXISTS idx_cards_set ON cards(set_id);

CREATE TABLE IF NOT EXISTS card_aliases (
  grader      TEXT NOT NULL,
  raw_set     TEXT NOT NULL,
  raw_num     TEXT NOT NULL,
  raw_name    TEXT NOT NULL,
  raw_variant TEXT NOT NULL,
  card_id     INTEGER NOT NULL REFERENCES cards(id),
  match_kind  TEXT NOT NULL DEFAULT 'exact',  -- exact | fuzzy | created
  PRIMARY KEY (grader, raw_set, raw_num, raw_name, raw_variant)
);

CREATE TABLE IF NOT EXISTS pop (
  snapshot_date TEXT NOT NULL,             -- YYYY-MM-DD
  grader        TEXT NOT NULL REFERENCES graders(code),
  card_id       INTEGER NOT NULL REFERENCES cards(id),
  grade_label   TEXT NOT NULL,             -- grader's own label: "Gem Mint 10", "10P", "9.5", "AU"
  grade_numeric REAL NOT NULL,             -- for sorting / gem math. 10.5 = Pristine/Legend, 10.75 = CGC Perfect 10, 0 = Authentic etc.
  is_top_grade  INTEGER NOT NULL,          -- 1 for the grader's gem tier and above (10+; BGS 9.5+)
  is_authentic  INTEGER NOT NULL DEFAULT 0, -- 1 for authentic-only slabs (AU, AA, CC, VA, PSA Auth...): graded, but no numeric grade, excluded from gem rate
  count         INTEGER NOT NULL,
  PRIMARY KEY (snapshot_date, grader, card_id, grade_label)
);
CREATE INDEX IF NOT EXISTS idx_pop_card ON pop(card_id);
CREATE INDEX IF NOT EXISTS idx_pop_grader_date ON pop(grader, snapshot_date);

CREATE TABLE IF NOT EXISTS my_certs (
  cert        TEXT PRIMARY KEY,
  grader      TEXT NOT NULL REFERENCES graders(code),
  card_id     INTEGER NOT NULL REFERENCES cards(id),
  grade_label TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_my_certs_card ON my_certs(card_id);

CREATE TABLE IF NOT EXISTS snapshots (
  snapshot_date TEXT NOT NULL,
  grader        TEXT NOT NULL REFERENCES graders(code),
  source_url    TEXT,
  total_graded  INTEGER NOT NULL,
  notes         TEXT,
  PRIMARY KEY (snapshot_date, grader)
);

-- Latest snapshot per grader (what the app shows by default).
DROP VIEW IF EXISTS latest_pop;
CREATE VIEW latest_pop AS
  SELECT p.* FROM pop p
  JOIN (SELECT grader, MAX(snapshot_date) AS d FROM snapshots GROUP BY grader) l
    ON l.grader = p.grader AND l.d = p.snapshot_date;
