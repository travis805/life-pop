# LIFE TCG Graded Population

How many LIFE TCG cards each grading company has graded, by set, card and grade, refreshed monthly,
plus how much of the TAG population Taclaco submitted itself. A Python pipeline builds a SQLite/D1
database from public pop reports. A Cloudflare Worker serves a read-only API and a single-page app
(Vite and React) from that database. Target: `lifepop.tacla.co` (not deployed yet).

## Sources and method

| Grader | Method | How |
|---|---|---|
| CGC | scrape | `scripts/scrape_cgc.py` reads CGC's own public JSON API (`production.api.aws.ccg-ops.com`, the one the pop page calls). Eras, sets and cards are discovered, and each set total is asserted against the published count. |
| AGS | scrape | `scripts/scrape_ags.py` parses the server-rendered pages at `app.agscard.com/pop/categories/102` (series, sets, cards). Set totals are asserted against the page totals. |
| TAG | browser | TAG's API returns 403 to direct fetches, so `scripts/tag_extract.js` is pasted into a browser tab on `my.taggrading.com/pop-report/Nature` (TAG files LIFE under Nature). Claude does this in the in-app browser. |
| PSA, Beckett, SGC, ACE | manual | Blocked for automation (login or human checks). Fill `data/manual/<grader>.csv` by hand. |

Everything lands in `data/raw/<grader>-<date>.json` as `{year,set,num,name,variant,grades:{label:count,TOTAL}}`
(CGC and AGS also write a `.meta.json` with the published totals used for reconciliation).
Raw snapshots are public data and are committed. Every month's snapshot is kept, so growth over time works.

Known source quirks:
- AGS reports each grade cell as two numbers: the grade and its "+" half-grade (7+, 8+, 9+). Both are loaded (labels like "9+", grade_numeric n + 0.5, not gem), and the scraper asserts the total equals the page headline (66).
- AGS does not publish a variant, so its cards are matched to the closest card by set, number and name.
- TAG files Kickstarter copies under Mammals 1st Edition, so TAG counts for the two Mammals sets cannot be separated.

## Database

`schema.sql` works on SQLite and D1: `graders`, `sets`, `cards` (canonical identity), `card_aliases`
(grader label to canonical card), `pop` (one row per non-zero grade per snapshot), `my_certs`, `snapshots`,
and a `latest_pop` view (latest snapshot per grader).

`scripts/build_db.py` reads every raw snapshot, every manual CSV and `data/my_certs.csv`, then writes:
- `data/life_pop.sqlite` (local, gitignored)
- `data/d1_load.sql` (full reload: deletes then inserts, safe to re-run, gitignored because it holds cert numbers)
- `data/alias_report.txt` (fuzzy, ambiguous and newly created cards, so nothing is silently dropped)

Card matching: canonical set map, then normalized number (leading zeros and `/100` suffix removed), then
normalized name, then variant. Mammals numbers above 100 belong to Promos (that is how TAG files them).
Grade scale: `grade_numeric` is 10.75 for CGC Perfect 10, 10.5 for Pristine and Legend, 10 for Gem Mint,
0 for AU/AA/CC/VA. A "gem" is `grade_numeric >= 10`.

## Monthly refresh runbook

1. `pip install -r requirements.txt` (first time only), then `python3 scripts/scrape_cgc.py` and `python3 scripts/scrape_ags.py`.
2. Ask Claude to run `scripts/tag_extract.js` in the in-app browser on the TAG Nature pop page and save the result to `data/raw/tag-<YYYY-MM-DD>.json`.
3. Optional: add rows to `data/manual/psa.csv`, `beckett.csv`, `sgc.csv`, `ace.csv` with columns `snapshot_date,set,num,name,variant,grade,count` (one row per grade).
   When Travis sends new cards to TAG: `python3 scripts/export_my_certs.py` re-reads the Grading Batches workbook into `data/my_certs.csv`.
4. `python3 scripts/build_db.py` and read the reconciliation it prints plus `data/alias_report.txt`.
5. `npx wrangler d1 execute life-pop --remote --file data/d1_load.sql`
6. No redeploy needed. The Worker reads D1 live (API responses are cached for 5 minutes).

## Local development

```sh
npm install
npm run db:local        # applies schema.sql and data/d1_load.sql to the local D1 (.wrangler/)
npm run cf:dev          # builds the SPA and runs the Worker at http://localhost:8787 (API and site)
```
For hot reload of the UI, run `npm run cf:dev` in one terminal and `npm run dev` in another. Vite serves the app
and proxies `/api` to port 8787.
Check it: `npm run build`, then `curl localhost:8787/api/summary`.

## API (read-only, GET)

`/api/summary` (latest per grader: totals, gems, gem rate, cards graded, as-of date, grade distribution, Taclaco TAG share),
`/api/sets`, `/api/cards?set=<id>&grader=<code>&q=<text>`, `/api/card/:id`, `/api/history`.

## Deploy (not done yet)

1. `npx wrangler d1 create life-pop`, paste the id into `wrangler.jsonc` (replace the placeholder).
2. `npx wrangler d1 execute life-pop --remote --file schema.sql`, then the load file from step 5 above.
3. Optional gate: create a Cloudflare Access app for `lifepop.tacla.co` and set `ACCESS_TEAM_DOMAIN` and `ACCESS_AUD`
   in `wrangler.jsonc` vars. With `ACCESS_AUD` set the Worker verifies the Access JWT on `/api/*` and fails closed (401).
   With it unset the API is public.
4. `npm run cf:deploy`.

## Privacy

`data/my_certs.csv` and `data/d1_load.sql` contain Travis's TAG cert numbers and are gitignored. The API exposes only
counts of Taclaco copies per card, never cert numbers (cert numbers are loaded into D1 for the counts, so keep the D1 database private).
