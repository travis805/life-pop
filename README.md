# LIFE TCG Graded Population

How many LIFE TCG cards each grading company has graded, by set, card and grade, refreshed monthly,
plus how much of each grader's population Taclaco submitted itself. A Python pipeline builds a SQLite/D1
database from public pop reports. A Cloudflare Worker serves a read-only API and a single-page app
(Vite and React) from that database. Live and PUBLIC at https://lifepop.tacla.co (Worker `life-pop`,
D1 `life-pop` 7e94b13e-0754-406c-8773-887f2fbac06b, no Cloudflare Access by Travis's choice).

## Status (2026-10-28)

First full snapshot is live: 1,287 graded, 41.4% gem rate (authentic-only excluded).

| Grader | Graded | Gem rate | Method |
|---|---|---|---|
| PSA | 753 | 37.7% | Chrome (login) |
| CGC | 209 | 47.2% (46 AU excluded) | scrape |
| ACE | 153 | 53.6% | Chrome |
| TAG | 74 | 52.7% | in-app browser |
| AGS | 66 | 25.8% | scrape |
| BGS | 32 | 46.9% | Chrome |
| SGC | 0 | n/a | Chrome (reCAPTCHA) |

Taclaco's own slabs: 67 of 1,287 graded (5.2%): TAG 42 of 74 (56.8%), CGC 25 of 209 (12.0%), across 39 card variants. All 67 certs match a card in that grader's pop data and none exceed the pop.

Monthly refresh: local scheduled task `life-pop-monthly-refresh` (Claude desktop app, 9am on the 1st;
prompt at `~/.claude/scheduled-tasks/life-pop-monthly-refresh/SKILL.md`). It pulls every grader, loads D1 and
writes a recap artifact with talking points. Chrome steps need Travis's Chrome (not Arc) with the Claude
extension connected, PSA signed in, and Travis to tick SGC's reCAPTCHA if it appears.

Open items: 37 ambiguous and 45 fuzzy card matches in `data/alias_report.txt` (mostly blank variants);
ACE spells "Racoon", so Cozumel Raccoon is split into two canonical cards until an alias fix.

## Sources and method

| Grader | Method | How |
|---|---|---|
| CGC | scrape | `scripts/scrape_cgc.py` reads CGC's own public JSON API (`production.api.aws.ccg-ops.com`, the one the pop page calls). Eras, sets and cards are discovered, and each set total is asserted against the published count. |
| AGS | scrape | `scripts/scrape_ags.py` parses the server-rendered pages at `app.agscard.com/pop/categories/102` (series, sets, cards). Set totals are asserted against the page totals. |
| TAG | browser | TAG's API returns 403 to direct fetches, so `scripts/tag_extract.js` is pasted into a browser tab on `my.taggrading.com/pop-report/Nature` (TAG files LIFE under Nature). Claude does this in the in-app browser. |
| BGS (Beckett) | browser | Claude pulls it in Travis's Chrome (Claude in Chrome extension). Search "LIFE TCG" on Beckett's pop report, then read each set page at `/grading/pop-report/list-of-cards?type=set&query=<set>&sports=Gaming`. Saved as `data/raw/bgs-<date>.json`. |
| ACE | browser | Same Chrome route: `https://acegrading.com/pop?q=Mammals` and `?q=Birds`, paging with `&page=N` (25 rows per page) and keeping only LIFE rows (set "Mammals" or "Birds"). The pasted source text is kept in `data/raw/source/ace-<date>.txt` and converted to `data/raw/ace-<date>.json`. |
| PSA | browser | PSA's pop report needs a login, so Claude reads it in Travis's logged-in Chrome. `data/psa_sets.json` lists the set URLs (2023 Mammals, 2024 and 2025 1st Edition Promos, 2025 Birds, 2026 Special Edition, Photography, Kickstarter). Open each URL, parse the table rows (each grade cell holds three values: grade, "+" half grade, "Q" qualified), and save `data/raw/psa-<date>.json`. Labels: `9`, `9+` (9.5), `9Q` (qualified, never gem), `Auth` (authentic, excluded from gem rate). Gem is 10. The pasted text is kept in `data/raw/source/psa-<date>-*.txt`. |
| SGC | checked, zero | No LIFE TCG results in SGC's pop report search (checked 2026-10-28). Recorded as a zero snapshot (`data/raw/sgc-<date>.json` is `[]` plus a `.meta.json` note). Re-check monthly; zero-snapshot graders show only as "SGC: 0 graded" in the page header and footer, not as tiles or charts. |

Everything lands in `data/raw/<grader>-<date>.json` as `{year,set,num,name,variant,grades:{label:count,TOTAL}}`
(CGC and AGS also write a `.meta.json` with the published totals used for reconciliation).
Raw snapshots are public data and are committed. Every month's snapshot is kept, so growth over time works.

Known source quirks:
- AGS reports each grade cell as two numbers: the grade and its "+" half-grade (7+, 8+, 9+). Both are loaded (labels like "9+", grade_numeric n + 0.5, not gem), and the scraper asserts the total equals the page headline (66).
- AGS does not publish a variant, so its cards are matched to the closest card by set, number and name.
- TAG files Kickstarter copies under Mammals 1st Edition, so the pop table cannot split them. Instead each TAG Mammals 1st Edition slab is reviewed by cert: the front scan of a Kickstarter copy reads "(c)LIFE TCG 2022" with a small K stamp at the bottom center, a 1st Edition copy reads 2023 with no K. Results live in `data/tag_mammals_review.csv` (`cert,card,grade,edition,evidence,reviewed`, edition `1st` or `KS`). Taclaco never submitted Kickstarter cards, so its own certs (`data/my_certs.csv`) count as 1st Edition with no review. `build_db.py` moves each `KS` slab (one count of that grade, latest TAG snapshot) to the Kickstarter set and prints "TAG Kickstarter reclass: N slabs moved". As of 2026-11-01 all 36 slabs are reviewed (26 Taclaco, 10 reviewed) and none is Kickstarter.

## Database

`schema.sql` works on SQLite and D1: `graders`, `sets`, `cards` (canonical identity), `card_aliases`
(grader label to canonical card), `pop` (one row per non-zero grade per snapshot), `my_certs`, `snapshots`,
and a `latest_pop` view (latest snapshot per grader).

`scripts/build_db.py` reads every raw snapshot, every manual CSV and `data/my_certs.csv`, then writes:
- `data/life_pop.sqlite` (local, gitignored)
- `data/d1_load.sql` (full reload: deletes then inserts, safe to re-run, gitignored because it holds cert numbers)
- `data/alias_report.txt` (fuzzy, ambiguous and newly created cards, so nothing is silently dropped)
- `data/card_ids.csv` (committed): the id of every card ever built. Ids never change between rebuilds, so `#card/<id>` links and responses cached across a reload stay right; a new card gets the next free id.

`data/variant_overrides.csv` fixes the variant of a pop row whose grader states none when the closest-card guess is wrong (for example PSA's Birds #63 Macaw is the Base print, not the Full Art).

Card matching: canonical set map, then normalized number (leading zeros and `/100` suffix removed), then
normalized name, then variant. Mammals numbers above 100 belong to Promos (that is how TAG files them).
Grade scale: `grade_numeric` is 10.75 for CGC Perfect 10, 10.5 for Pristine and Legend, 10 for Gem Mint,
0 for AU/AA/CC/VA. A "gem" is 10 or above (BGS: 9.5 or above). Authentic-only slabs (AU, AA, CC, VA, PSA Auth, ...) have `is_authentic = 1`: they stay in the graded totals but are excluded from gem rate (gem rate = gems / numerically graded copies).

## Taclaco sources (private)

Travis's own slabs come from files in `data/private/` (gitignored, hold cert numbers):
- `tag-orders-<date>.txt`: TAG order history, pipe-delimited `cert|name|grade|year|set|num|variant|order` with `#` comment lines. Refresh: in Chrome, open the order history on my.taggrading.com, set 200 rows per page and tick Show All Grades, then copy each order's cards into the file.
- `cgc-<invoice>.csv`: CGC invoice export (My Submissions, open the invoice, export). One file per invoice; new invoices are new files.

`python3 scripts/export_my_certs.py` reads every `tag-*.txt` and `cgc-*.csv` there (other graders: add a parser), asserts no duplicate certs and writes `data/my_certs.csv` (`cert,grader,set,num,name,variant,grade`, in each grader's own labels). `build_db.py` matches each cert through that grader's own card labels, prints any unmatched cert and any sanity violation (Taclaco count above that grader's pop for the card or grade), and loads `my_certs` for the counts.

## Monthly refresh runbook

1. `pip install -r requirements.txt` (first time only), then `python3 scripts/scrape_cgc.py` and `python3 scripts/scrape_ags.py`.
2. Ask Claude to run `scripts/tag_extract.js` in the in-app browser on the TAG Nature pop page and save the result to `data/raw/tag-<YYYY-MM-DD>.json`.
2b. TAG Kickstarter check: Claude runs `scripts/tag_certs.js` in the in-app browser on `https://my.taggrading.com/pop-report/Nature/2023/Life%20TCG?setName=Mammals+1st+Edition` (it works in the background; poll `window.__tagCerts`, then read the rendered `<article><pre>` with get_page_text) and saves the lines to `data/private/tag-mammals-certs-<date>.txt`. Run `python3 scripts/check_tag_kickstarter.py` (warns if the cert list is stale, exits 1 if any non-Taclaco cert is unreviewed). For each unreviewed cert, open its report, zoom on the bottom center of the front scan (helper mode in `tag_certs.js` lists scan URLs), and record `1st` or `KS` with evidence in `data/tag_mammals_review.csv`. Unsure ones go to Travis. Taclaco certs need no review.
3. Ask Claude to pull PSA, BGS, ACE and SGC in Travis's Chrome (Claude in Chrome; routes in the Sources table).
   Long JS output truncates near 1,000 characters, so render rows into the page as `<article><pre>` and read it
   with get_page_text. Never solve a captcha or enter a password: Travis does those.
   Optional: if a grader ever has to be entered by hand, add `data/manual/<grader>.csv` (grader code in the file name) with columns `snapshot_date,set,num,name,variant,grade,count` (one row per grade).
   When Travis grades more cards, refresh the Taclaco sources (see Taclaco sources below), then `python3 scripts/export_my_certs.py`.
4. `python3 scripts/build_db.py` and read the reconciliation it prints plus `data/alias_report.txt`.
5. `npx wrangler d1 execute life-pop --remote --file data/d1_load.sql`
6. No redeploy needed. The Worker reads D1 live (API responses are cached for 5 minutes).

## Local development

```sh
npm install
npm run db:local        # (after a schema change, first delete .wrangler/state) applies schema.sql and data/d1_load.sql to the local D1 (.wrangler/)
npm run cf:dev          # builds the SPA and runs the Worker at http://localhost:8787 (API and site)
```
For hot reload of the UI, run `npm run cf:dev` in one terminal and `npm run dev` in another. Vite serves the app
and proxies `/api` to port 8787.
Check it: `npm run build`, then `curl localhost:8787/api/summary`.

## Sales tab (graded sale prices)

A second tab (`?tab=sales`) lists what graded LIFE TCG cards actually sold for. Prices are integer USD cents. Three sources:
- **eBay** (`source = 'ebay'`): a weekly Cloudflare Cron Trigger (`0 15 * * 1`, Mondays) runs `worker/sales_ebay.js`, which reads sold listings from the SoldComps API. `worker/sales_match.js` places each title on a card, grader and grade. Only exact matches (set, number, name and variant agree) go live; uncertain ones wait in `sales_review`. Lots, raw cards, sealed product and any title that does not say "LIFE TCG" (Elixir of Life, Circle of Life, Life Herb...) are dropped silently and counted in `sales_runs.dropped`. Listings in eBay's Graded condition with no grader in the title go to review.
- **Collectors** (`source = 'collector'`): the Submit a sale form posts to `POST /api/sales/submit` (the only non-GET route). Submissions are stored as `pending` in `sale_submissions` and never shown until approved. No name or email is collected; cert numbers and notes are never exposed. Protection: Turnstile, a Workers rate limit (5 per minute) and 20 submissions per 24 hours per hashed IP (SHA-256 of `IP_SALT` plus the IP, nulled after 30 days).
- **Taclaco** (`source = 'taclaco'`, verified): `node scripts/import_taclaco_sales.mjs --remote-check` reads the order exports the FY26 finance pipeline already pulls (`~/code/taclaco-fy26/import-files/eBay/eBay-OrdersReport-api.csv` and `Shopify/orders_export_api.csv`), matches each LIFE graded line (title matcher, store SKU only to settle a variant), skips Shopify orders synced from eBay, refunded or cancelled orders and eBay items the weekly pull already has, and writes `data/private/taclaco_sales.sql` (gitignored) plus a preview. Load it with `npx wrangler d1 execute life-pop --remote --file data/private/taclaco_sales.sql`; re-running is safe (`INSERT OR IGNORE`). First load 2026-11-03: 27 sales, Dec 2025 to Oct 2026.

Unverified collector sales are shown and labeled but left out of every median, the Last sale column, Top sales and the stream view. Medians are over the last 12 months per card, grader and grade.

Sales are NOT in `d1_load.sql`. Each row stores a stable `card_key` = `<set>|<number>|<name>|<variant>` and the `sales_v` view joins it to `cards` at read time. A card renamed by a rebuild leaves its sales orphaned (`card_id` NULL, hidden): list them with `orphans` and fix by hand.

**SoldComps quota.** The free tier is 100 requests a month. A run makes at most 4 scrape calls: keyword `life tcg` with `conditionId=2750` (eBay Graded, `hydrateBoa=true`, page 1, page 2 only if more exist and page 1 still reaches back to `soldAfter`), then the same keyword with no condition filter (2 pages max, no hydration). `hydrateBoa` costs one more request per best-offer item it resolves. `soldAfter` is 3 days before the last clean run (90 days on the first run). Before each call the job checks the remaining quota (`/usage` is free, then the `X-Usage-Remaining` header) and stops under 15. Every run logs a row in `sales_runs`. Accepted best-offer prices only come from the graded query (`hydrateBoa`). A sale flagged as an accepted best offer without a hydrated price goes to `sales_review` instead of going live: open the listing (eBay shows the accepted price next to the struck-through asking price; no strikethrough means it sold at the asking price, as SoldComps' flag is unreliable for "or Best Offer" listings) and `resolve ... --price <accepted>` or `--no-offer`.

**Secrets and vars** (production): `npx wrangler secret put SOLDCOMPS_KEY`, `TURNSTILE_SECRET`, `IP_SALT`. Plain vars in `wrangler.jsonc`: the public `TURNSTILE_SITE_KEY` and `TURNSTILE_HOSTNAMES` (`lifepop.tacla.co`). The Worker accepts a Turnstile token only if siteverify reports success, action `submit_sale` and an allowed hostname (403 otherwise). Locally they live in `.dev.vars` (gitignored): the Turnstile test keys `1x00000000000000000000AA` (site) and `1x0000000000000000000000000000000AA` (secret) accept any token, such as `XXXX.DUMMY.TOKEN.XXXX`; the test secret reports hostname `example.com` and no action, so `.dev.vars` also sets `TURNSTILE_HOSTNAMES=example.com` and `TURNSTILE_ALLOW_TEST=1`. Without a site key the form says submissions are not open.

**Live since 2026-11-03.** First pull plus a one-off `life tcg <grader>` backfill gave 10 eBay sales. **Production setup, once, before deploying:** `npx wrangler d1 execute life-pop --remote --file data/d1_migrate_sales.sql`. The pop pages keep working even if the sales tables are missing.

**Moderation** (Travis asks Claude; no admin page). `node scripts/sales_admin.mjs <command>` targets the local D1 unless you add `--remote`:
`pending`, `approve <id> [--verified]`, `reject <id> "<reason>"`, `review`, `resolve <item_id> <card_id> "<grade label>" [--grader PSA]`, `skip <item_id>`, `orphans`, `runs`. Approve with `--verified` once the proof or cert checks out; without it the sale shows as unverified.

**Testing locally.** `node scripts/check_sales_match.mjs` runs the title matcher over `scripts/fixtures/sales_titles.json` (real eBay titles plus synthetic ones) against the cards in `data/life_pop.sqlite`. `node scripts/test_sales_ebay.mjs` runs the whole weekly job with a mocked SoldComps fetch serving the real responses in `scripts/fixtures/real_graded.json` and `real_plain.json`, against an in-memory SQLite database (Node 22+), and checks the dedupe, lookback and quota guards. Neither calls the real API. The form and routes: `npm run cf:dev`, then POST to `/api/sales/submit` with the test token. After a schema change run `npx wrangler d1 execute life-pop --local --file schema.sql` (or `npm run db:local`).

## API (read-only GET, plus one POST)

`/api/summary` (latest per grader: totals, gems, gem rate, cards graded, as-of date, source url, grade distribution, Taclaco count and share per grader and overall),
`/api/sets` (includes Taclaco count per set and grader), `/api/cards?set=<id>&grader=<code>&q=<text>` (Taclaco count per card and grader),
`/api/store` (live graded listings by card id), `/api/changes` (month over month), `/api/card/:id` (per-grader totals, gem rate, pop rank within the set, Taclaco counts), `/api/history`, `/api/sales?card=&grader=&set=&source=&limit=` (recent sales plus summary, top sales and medians), `/api/sales/config` (Turnstile site key), and `POST /api/sales/submit`. `/api/card/:id` carries a `sales` block and `/api/cards` a `last_sale` per card. Counts only, never cert numbers.

## UI

Two tabs, Population and Sales (`?tab=sales`; `#card/<id>` works on both). Light and dark. Hero numbers (total graded, overall gem rate, Taclaco share), grader tiles,
"Data as of" date and links to each grader's pop page, Gem rate by grader bars (grade distributions collapsed below), Sets table, Taclaco section, Rarest
(Most gems and Lowest gem rate among cards with 10+ numerically graded copies, with per-set toggle chips remembered in localStorage), Cards table, History. Cards table: sticky Card column, Gem % and a Min pop filter, grader filter relabels the columns,
Download CSV of the current view. Click a row for the card detail (shareable `#card/<id>` link).
New: a Taclaco.com call-to-action box after Rarest (no email capture; a cross-site Shopify newsletter post never reached the store); a Buy button per Cards row (and in the detail panel) for graded slabs currently listed on taclaco.com, from `GET /api/store` (`worker/store.js` matches variant SKUs to cards, cached 7 days in the Cache API; check coverage with `node scripts/check_store_match.mjs`); and a What changed section at the bottom, free to all, fed by `GET /api/changes` (each grader's latest snapshot vs its previous: grader deltas, biggest movers, new gems, newly graded; empty until a second monthly snapshot exists). History shows once there are 2+ snapshots (month-over-month change).
Sets table sub-lines show each grader's share of that set's graded copies (the All sets row uses the all-sets total); the tooltip adds the grader's gem rate and authentic-only count.
Stream view: the toggle in the header or `?stream=1` gives bigger type and only the headline views (hero numbers, gem rate by grader, sets, Taclaco share).

## Deploy (done 2026-10-28)

- D1 created and wired in `wrangler.jsonc`; remote migration `data/d1_migrate.sql` (adds `pop.is_authentic`) already applied.
  Future schema changes need their own ALTER file, since `schema.sql` is `CREATE TABLE IF NOT EXISTS`.
- Code changes: `npm run cf:deploy` (if Cloudflare returns "Internal authentication error 10500", just retry `npx wrangler deploy`).
- Data-only changes: load `data/d1_load.sql` to remote; no redeploy.
- Access gate is available but off: set `ACCESS_TEAM_DOMAIN` and `ACCESS_AUD` vars to require Cloudflare Access on `/api/*`.

## Privacy

`data/private/`, `data/my_certs.csv` and `data/d1_load.sql` contain Travis's cert numbers and are gitignored. The API exposes only
counts of Taclaco copies per card, never cert numbers (cert numbers are loaded into D1 for the counts, so keep the D1 database private).
