// Weekly eBay sold-listings job (Cloudflare Cron Trigger, see `scheduled` in worker/index.js).
// Pulls LIFE TCG sold listings from the SoldComps API, places each on a card with worker/sales_match.js,
// writes exact matches to `sales` and everything uncertain to `sales_review`. Takes (env, fetchImpl) so it
// can be tested with a mocked fetch (scripts/test_sales_ebay.mjs).
//
// SoldComps free tier is 100 requests a month, and hydrateBoa costs one more request whenever a best offer is found,
// so the job makes at most 4 scrape calls a run (2 graded-condition pages, 2 plain pages) and stops below MIN_REMAINING.
import { matchTitle } from './sales_match.js'
import { cardKey } from './sales_common.js'

const BASE = 'https://api.sold-comps.com'
const KEYWORD = 'life tcg'
const GRADED_CONDITION = '2750' // eBay "Graded" condition id
const MIN_REMAINING = 15
const FIRST_RUN_DAYS = 90
const OVERLAP_DAYS = 3
const MAX_RETRY_WAIT_MS = 20000

const day = d => d.toISOString().slice(0, 10)
const cents = v => (v == null || v === '' || Number.isNaN(Number(v)) ? null : Math.round(Number(v) * 100))

class Stop extends Error {}

function saleType(item) {
  if (item.bestOfferAccepted) return 'best_offer'
  return item.buyingFormat === 'buyItNow' ? 'buy_it_now' : 'auction'
}

/** One SoldComps call. Tracks usage from the response headers; throws Stop when the budget or quota says to quit. */
async function scrape(state, params) {
  if (state.remaining != null && state.remaining < MIN_REMAINING) throw new Stop(`only ${state.remaining} SoldComps requests left (minimum ${MIN_REMAINING})`)
  const url = `${state.base}/v1/scrape?` + new URLSearchParams(params)
  for (let attempt = 0; attempt < 2; attempt++) {
    state.requests++
    const res = await state.fetch(url, { headers: { authorization: `Bearer ${state.key}`, accept: 'application/json' } })
    const left = res.headers.get('x-usage-remaining')
    if (left != null && left !== '') state.remaining = Number(left)
    if (res.status === 429) {
      const body = await res.json().catch(() => ({}))
      const code = body.code || body.error?.code || body.error
      if (code === 'quota_exceeded') throw new Stop('SoldComps quota exceeded')
      const wait = Math.min(Number(res.headers.get('retry-after') || 5) * 1000, MAX_RETRY_WAIT_MS)
      if (attempt === 0) { await new Promise(r => setTimeout(r, wait)); continue }
      throw new Stop('SoldComps rate limited')
    }
    if (!res.ok) throw new Error(`SoldComps returned ${res.status}`)
    return res.json()
  }
}

/** Free usage lookup, so the first call is already checked against the monthly budget. Shape is read leniently. */
async function loadUsage(state) {
  try {
    const res = await state.fetch(`${state.base}/usage`, { headers: { authorization: `Bearer ${state.key}`, accept: 'application/json' } })
    if (!res.ok) return
    const u = await res.json()
    const rem = u.remaining ?? u.usageRemaining ?? u.usage?.remaining ?? (u.limit != null && u.used != null ? u.limit - u.used : null)
    if (rem != null && !Number.isNaN(Number(rem))) state.remaining = Number(rem)
  } catch { /* headers on the first scrape response will fill it in */ }
}

const oldest = items => items.reduce((m, i) => (i.endedAt && i.endedAt < m ? i.endedAt : m), '9999-99-99')

/** Query (a): graded-condition listings, hydrated for accepted best-offer prices. Query (b): everything, to catch slabs not listed as Graded. */
async function collect(state, soldAfter) {
  const common = { keyword: KEYWORD, ebaySite: 'ebay.com', count: '240', sortOrder: 'endedRecently', soldAfter }
  const byId = new Map()
  const add = (items, graded) => {
    for (const it of items) if (!byId.has(it.itemId)) byId.set(it.itemId, { ...it, graded })
  }
  // (a) first page; a second only if there is more and this one still reaches back to soldAfter.
  let page = await scrape(state, { ...common, conditionId: GRADED_CONDITION, hydrateBoa: 'true', page: '1' })
  add(page.items || [], true)
  if (page.hasNextPage && oldest(page.items || []) >= soldAfter) {
    page = await scrape(state, { ...common, conditionId: GRADED_CONDITION, hydrateBoa: 'true', page: '2' })
    add(page.items || [], true)
  }
  // (b) up to 2 pages, no hydration (best-offer price stays the listed price for these).
  for (let p = 1; p <= 2; p++) {
    page = await scrape(state, { ...common, hydrateBoa: 'false', page: String(p) })
    add(page.items || [], false)
    if (!page.hasNextPage || oldest(page.items || []) < soldAfter) break
  }
  return [...byId.values()]
}

async function loadCards(db) {
  return (await db.prepare(`
    SELECT c.id, s.name AS set_name, c.number, c.name, c.variant
    FROM cards c JOIN sets s ON s.id = c.set_id`).all()).results
}

async function logRun(db, run) {
  await db.prepare(`INSERT INTO sales_runs (run_at, requests, remaining, fetched, inserted, reviewed, dropped, error) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(run.run_at, run.requests, run.remaining, run.fetched, run.inserted, run.reviewed, run.dropped, run.error).run()
}

/** Run the job once. Returns the sales_runs row it logged. */
export async function runEbayJob(env, fetchImpl = fetch, now = new Date()) {
  const db = env.DB
  const run = { run_at: now.toISOString(), requests: 0, remaining: null, fetched: 0, inserted: 0, reviewed: 0, dropped: 0, error: null }
  if (!env.SOLDCOMPS_KEY) {
    console.log('SOLDCOMPS_KEY is not set; skipping the eBay sales job')
    run.error = 'SOLDCOMPS_KEY not set'
    await logRun(db, run)
    return run
  }
  // Wrapped: calling the global fetch as a method of `state` throws "Illegal invocation" on Workers.
  const state = { base: env.SOLDCOMPS_BASE || BASE, key: env.SOLDCOMPS_KEY, fetch: (...a) => fetchImpl(...a), requests: 0, remaining: null }
  try {
    // Look back to 3 days before the last clean run (first run: 90 days); duplicates are skipped by (source, source_ref).
    const last = await db.prepare('SELECT MAX(run_at) AS d FROM sales_runs WHERE error IS NULL').first()
    const start = last?.d ? new Date(Date.parse(last.d) - OVERLAP_DAYS * 86400000) : new Date(now.getTime() - FIRST_RUN_DAYS * 86400000)
    const soldAfter = day(start)

    await loadUsage(state)
    const items = await collect(state, soldAfter)
    run.fetched = items.length

    const cards = await loadCards(db)
    const known = new Set([
      ...(await db.prepare("SELECT source_ref AS id FROM sales WHERE source = 'ebay'").all()).results.map(r => r.id),
      ...(await db.prepare('SELECT item_id AS id FROM sales_review').all()).results.map(r => r.id),
    ])
    const stamp = run.run_at
    const stmts = []
    for (const it of items) {
      if (it.listingType !== 'sold' || it.soldCurrency !== 'USD' || known.has(String(it.itemId))) continue
      const m = matchTitle(it.title, cards)
      const hydrated = it.bestOfferAccepted && it.boaHydrated && it.boaAcceptedPrice != null
      const price = cents(hydrated ? it.boaAcceptedPrice : it.soldPrice)
      if (price == null || !/^\d{4}-\d{2}-\d{2}/.test(it.endedAt || '')) continue
      const row = {
        id: String(it.itemId), title: it.title, price, shipping: cents(it.shippingPrice), best: it.bestOfferAccepted ? 1 : 0,
        date: it.endedAt.slice(0, 10), type: saleType(it), url: /^https:\/\//.test(it.url || '') ? it.url : null,
      }
      const review = (reason, guess) => {
        stmts.push(db.prepare(`INSERT OR IGNORE INTO sales_review
          (item_id, title, price_cents, shipping_cents, best_offer, sale_date, sale_type, url, guess_card_key, guess_grader, guess_grade, reason, status)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open')`)
          .bind(row.id, row.title, row.price, row.shipping, row.best, row.date, row.type, row.url,
            guess?.card ? cardKey(guess.card) : null, guess?.grader || null, guess?.grade_label || null, reason))
        run.reviewed++
      }
      if (m.reject) {
        // Slabs listed as Graded condition without a grader in the title are worth a look; everything else is noise.
        if (m.noGrader && it.graded) review('graded, grader not in title', null)
        else run.dropped++
      } else if (m.confidence === 'exact' && it.bestOfferAccepted && !hydrated) {
        // SoldComps flags "or Best Offer" listings unreliably and, without hydration, gives the asking price.
        // Read the listing (the struck-through asking price sits next to the real one) and resolve with --price.
        review('best offer, accepted price unknown (check the listing)', m)
      } else if (m.confidence === 'exact') {
        stmts.push(db.prepare(`INSERT OR IGNORE INTO sales
          (source, source_ref, card_key, grader, grade_label, grade_numeric, price_cents, shipping_cents, best_offer, sale_date, sale_type, url, title, verified, created_at)
          VALUES ('ebay', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`)
          .bind(row.id, cardKey(m.card), m.grader, m.grade_label, m.grade_numeric, row.price, row.shipping, row.best, row.date, row.type, row.url, row.title, stamp))
        run.inserted++
      } else review(m.reason, m)
    }
    // D1 batches are atomic and limited in size, so write in chunks.
    for (let i = 0; i < stmts.length; i += 50) await db.batch(stmts.slice(i, i + 50))
  } catch (err) {
    run.error = err instanceof Stop ? 'stopped: ' + err.message : String(err instanceof Error ? err.message : err)
    console.error('eBay sales job: ' + run.error)
  }
  run.requests = state.requests
  run.remaining = state.remaining
  await logRun(db, run)
  return run
}
