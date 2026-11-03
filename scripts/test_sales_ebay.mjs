// Offline test of the weekly eBay job (worker/sales_ebay.js): mocked SoldComps fetch serving the real
// responses in scripts/fixtures/, and an in-memory SQLite database wrapped to look like D1.
// Needs Node 22+ (node:sqlite). Usage: node scripts/test_sales_ebay.mjs
import { DatabaseSync } from 'node:sqlite'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { runEbayJob } from '../worker/sales_ebay.js'

const here = p => fileURLToPath(new URL(p, import.meta.url))
const fixture = f => JSON.parse(readFileSync(here('./fixtures/' + f), 'utf8'))

// Minimal D1 look-alike: prepare().bind().all()/first()/run() and batch().
const sqlite = new DatabaseSync(':memory:')
sqlite.exec(readFileSync(here('../schema.sql'), 'utf8'))
sqlite.exec(`ATTACH '${here('../data/life_pop.sqlite')}' AS src; INSERT INTO sets SELECT * FROM src.sets; INSERT INTO cards SELECT * FROM src.cards; DETACH src;`)
const stmt = (sql, args = []) => ({
  bind: (...a) => stmt(sql, a),
  all: async () => ({ results: sqlite.prepare(sql).all(...args) }),
  first: async () => sqlite.prepare(sql).get(...args) ?? null,
  run: async () => { sqlite.prepare(sql).run(...args) },
  _run: () => sqlite.prepare(sql).run(...args),
})
const db = { prepare: sql => stmt(sql), batch: async list => { for (const s of list) s._run() } }

let calls = []
const mockFetch = async (url, init) => {
  const u = new URL(url)
  calls.push(u.pathname + u.search)
  if (init.headers.authorization !== 'Bearer test-key') return new Response('{}', { status: 401 })
  if (u.pathname === '/usage') return Response.json({ limit: 100, used: 2, remaining: 98 })
  const page = u.searchParams.get('page')
  const graded = u.searchParams.get('conditionId') === '2750'
  const body = page === '1' ? fixture(graded ? 'real_graded.json' : 'real_plain.json') : { items: [], hasNextPage: false }
  return Response.json(body, { headers: { 'x-usage-remaining': String(97 - calls.length) } })
}

const now = new Date('2026-11-02T15:00:00Z')
const run = await runEbayJob({ DB: db, SOLDCOMPS_KEY: 'test-key' }, mockFetch, now)
console.log('run', run)
console.log('calls', calls.map(c => c.replace(/&?(keyword|ebaySite|count|sortOrder)=[^&]*/g, '')))

const fail = []
const check = (ok, msg) => { if (!ok) fail.push(msg) }
const sales = sqlite.prepare('SELECT * FROM sales ORDER BY sale_date').all()
const review = sqlite.prepare('SELECT * FROM sales_review').all()
console.log('\nsales:'); for (const s of sales) console.log(`  ${s.sale_date} $${s.price_cents / 100} ${s.grader} ${s.grade_label} ${s.card_key}`)
console.log('review:'); for (const r of review) console.log(`  ${r.item_id} [${r.reason}] guess=${r.guess_card_key} ${r.guess_grader} ${r.guess_grade} | ${r.title}`)

check(!run.error, 'run logged an error: ' + run.error)
check(calls.length === 4 + 0 || calls.length <= 5, 'unexpected number of calls ' + calls.length)
check(calls.some(c => c.includes('conditionId=2750') && c.includes('hydrateBoa=true')), 'graded query missing')
check(calls.filter(c => !c.includes('conditionId') && c.includes('hydrateBoa=false')).length >= 1, 'plain query missing hydrateBoa=false')
check(sales.some(s => s.title.includes('Humpback Whale 53/100') && s.grader === 'CGC' && s.grade_label === 'Gem Mint 10' && s.price_cents === 4500), 'Humpback Whale CGC 10 sale missing')
check(sales.some(s => s.title.includes('Kickstarter') && s.card_key === 'Mammals 1st Edition (Kickstarter)|39|African Lion|Holo'), 'Kickstarter African Lion missing')
check(review.some(r => r.reason === 'graded, grader not in title' && r.title.includes('RETICULATED GIRAFFE')), 'giraffe not in review')
check(!review.some(r => /Elixir|Circle of Life|Life Herb|One Piece/.test(r.title)) && !sales.some(s => /Elixir|Circle of Life|Life Herb|One Piece/.test(s.title)), 'other-game noise leaked')
check(!review.some(r => !r.title.toLowerCase().includes('life tcg')), 'non LIFE title in review')

// A second run must not duplicate anything and should look back only 3 days.
calls = []
const before = [sales.length, review.length]
const run2 = await runEbayJob({ DB: db, SOLDCOMPS_KEY: 'test-key' }, mockFetch, new Date('2026-11-09T15:00:00Z'))
check(run2.inserted === 0 && run2.reviewed === 0, 'second run added rows')
check(calls.some(c => c.includes('soldAfter=2026-10-30')), 'second run soldAfter should be 2026-10-30: ' + calls[0])
check(sqlite.prepare('SELECT COUNT(*) n FROM sales').get().n === before[0] && sqlite.prepare('SELECT COUNT(*) n FROM sales_review').get().n === before[1], 'row counts changed')

// No key: logs a row and returns without calling the API.
calls = []
const run3 = await runEbayJob({ DB: db }, mockFetch, now)
check(run3.error && calls.length === 0, 'no-key run should skip')

// Low budget: stops before scraping.
calls = []
const low = await runEbayJob({ DB: db, SOLDCOMPS_KEY: 'test-key' }, async (url, init) => (new URL(url).pathname === '/usage' ? Response.json({ remaining: 10 }) : mockFetch(url, init)), new Date('2026-11-16T15:00:00Z'))
check(low.error?.includes('minimum') && !calls.some(c => c.startsWith('/v1/scrape')), 'low budget should stop: ' + low.error)

console.log('\nsales_runs:', sqlite.prepare('SELECT run_at, requests, remaining, fetched, inserted, reviewed, dropped, error FROM sales_runs').all())
if (fail.length) { console.log('\nFAILED:\n - ' + fail.join('\n - ')); process.exit(1) }
console.log('\nall checks passed')
