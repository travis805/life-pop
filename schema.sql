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

-- ---------------------------------------------------------------------------------------------
-- Sales. NOT part of the monthly d1_load.sql reload (card ids are renumbered on every rebuild), so
-- every row stores a stable card_key = "<set name>|<number>|<name>|<variant>" that is joined to
-- cards at query time by the sales_v view (card_id is NULL when the card no longer exists).
-- Prices are integer USD cents.
CREATE TABLE IF NOT EXISTS sales (
  id             INTEGER PRIMARY KEY,
  source         TEXT NOT NULL CHECK (source IN ('ebay', 'taclaco', 'collector')),
  source_ref     TEXT NOT NULL,            -- eBay itemId / submission id / order id
  card_key       TEXT NOT NULL,
  grader         TEXT NOT NULL,
  grade_label    TEXT NOT NULL,            -- grader's own label, same as pop.grade_label
  grade_numeric  REAL,
  price_cents    INTEGER NOT NULL,
  shipping_cents INTEGER,
  best_offer     INTEGER NOT NULL DEFAULT 0, -- 1 = accepted best offer (price is the accepted price when known)
  sale_date      TEXT NOT NULL,            -- YYYY-MM-DD
  sale_type      TEXT,                     -- auction, buy_it_now, best_offer, private, show, ebay, other_marketplace
  url            TEXT,                     -- eBay listing or collector proof link (https only)
  title          TEXT,
  verified       INTEGER NOT NULL DEFAULT 0, -- 1 = trusted for medians (eBay rows, or collector rows Taclaco checked)
  created_at     TEXT,
  UNIQUE (source, source_ref)
);
CREATE INDEX IF NOT EXISTS idx_sales_card ON sales(card_key);
CREATE INDEX IF NOT EXISTS idx_sales_date ON sales(sale_date);

-- eBay items the matcher could not place confidently, waiting for a human (scripts/sales_admin.mjs review).
CREATE TABLE IF NOT EXISTS sales_review (
  item_id        TEXT PRIMARY KEY,
  title          TEXT,
  price_cents    INTEGER,
  shipping_cents INTEGER,
  best_offer     INTEGER,
  sale_date      TEXT,
  sale_type      TEXT,
  url            TEXT,
  guess_card_key TEXT,
  guess_grader   TEXT,
  guess_grade    TEXT,
  reason         TEXT,
  status         TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved', 'skipped')),
  decided_at     TEXT
);

-- Collector-submitted sales, moderated: pending until approved (copied into sales) or rejected.
-- ip_hash is SHA-256(salt + ip), only used for rate limits, and is nulled after 30 days.
CREATE TABLE IF NOT EXISTS sale_submissions (
  id          INTEGER PRIMARY KEY,
  created_at  TEXT NOT NULL,
  card_key    TEXT NOT NULL,
  grader      TEXT NOT NULL,
  grade_label TEXT NOT NULL,
  price_cents INTEGER NOT NULL,
  sale_date   TEXT NOT NULL,
  sale_type   TEXT NOT NULL,
  cert        TEXT,                        -- never shown publicly
  proof_url   TEXT,
  note        TEXT,                        -- never shown publicly
  ip_hash     TEXT,
  status      TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  reviewed_at TEXT,
  reason      TEXT
);
CREATE INDEX IF NOT EXISTS idx_submissions_status ON sale_submissions(status);
CREATE INDEX IF NOT EXISTS idx_submissions_ip ON sale_submissions(ip_hash, created_at);

-- One row per weekly eBay job run.
CREATE TABLE IF NOT EXISTS sales_runs (
  id        INTEGER PRIMARY KEY,
  run_at    TEXT NOT NULL,
  requests  INTEGER,                       -- scrape calls made this run
  remaining INTEGER,                       -- SoldComps X-Usage-Remaining after the run
  fetched   INTEGER,                       -- sold items returned
  inserted  INTEGER,                       -- exact matches added to sales
  reviewed  INTEGER,                       -- items sent to sales_review
  dropped   INTEGER,                       -- clear rejects (lots, raw cards...) skipped silently
  error     TEXT
);

-- sales joined to cards by card_key. card_id / set_id are NULL for orphans (card renamed or removed).
DROP VIEW IF EXISTS sales_v;
CREATE VIEW sales_v AS
  SELECT sa.*, k.card_id, k.set_id
  FROM sales sa
  LEFT JOIN (
    SELECT c.id AS card_id, c.set_id, s.name || '|' || c.number || '|' || c.name || '|' || c.variant AS card_key
    FROM cards c JOIN sets s ON s.id = c.set_id
  ) k ON k.card_key = sa.card_key;
