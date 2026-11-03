#!/usr/bin/env node
// Taclaco's own graded LIFE sales, from the order exports the FY26 finance pipeline already pulls
// (~/code/taclaco-fy26/import-files: eBay-OrdersReport-api.csv and Shopify orders_export_api.csv).
// Matches each line with the eBay title matcher (store SKU as a fallback), then writes
// data/private/taclaco_sales.sql (source 'taclaco', verified) and prints a preview. Never prints buyer fields.
//
//   node scripts/import_taclaco_sales.mjs                 preview + write the SQL
//   npx wrangler d1 execute life-pop --remote --file data/private/taclaco_sales.sql
//
// Shopify orders whose Source is "ebay" are eBay orders synced into Shopify, so they are skipped (the eBay file has
// them). eBay items already in `sales` from the weekly pull are skipped too (pass --known=<item ids> or let the
// script ask D1 with --remote-check).
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'
import { matchTitle, isLifeTitle } from '../worker/sales_match.js'
import { cardKey, gradeNumeric } from '../worker/sales_common.js'
import { parseSku, matchCard } from '../worker/store.js'

const IMPORTS = `${homedir()}/code/taclaco-fy26/import-files`
const root = fileURLToPath(new URL('..', import.meta.url))
const cards = JSON.parse(execFileSync('sqlite3', ['-json', root + 'data/life_pop.sqlite',
  'SELECT c.id, s.name AS set_name, c.number, c.name, c.variant FROM cards c JOIN sets s ON s.id = c.set_id'], { encoding: 'utf8', maxBuffer: 1 << 24 }))

// Item numbers the weekly eBay pull already has (they stay as source 'ebay').
let known = new Set()
if (process.argv.includes('--remote-check')) {
  const out = execFileSync('npx', ['wrangler', 'd1', 'execute', 'life-pop', '--remote', '--json', '--command', "SELECT source_ref FROM sales WHERE source = 'ebay'"],
    { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
  known = new Set(JSON.parse(out).flatMap(r => r.results).map(r => String(r.source_ref)))
}

/** Minimal CSV parser (quoted fields, embedded commas and newlines). */
function parseCsv(text) {
  const rows = []
  let row = [], field = '', q = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (q) {
      if (ch === '"' && text[i + 1] === '"') { field += '"'; i++ } else if (ch === '"') q = false; else field += ch
    } else if (ch === '"') q = true
    else if (ch === ',') { row.push(field); field = '' }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++
      row.push(field); rows.push(row); row = []; field = ''
    } else field += ch
  }
  if (field || row.length) { row.push(field); rows.push(row) }
  return rows
}
function records(path, headerKey) {
  const rows = parseCsv(readFileSync(path, 'utf8').replace(/^﻿/, ''))
  const h = rows.findIndex(r => r.includes(headerKey))
  const head = rows[h]
  return rows.slice(h + 1).filter(r => r.length > 1).map(r => Object.fromEntries(head.map((k, i) => [k, r[i] ?? ''])))
}

const money = v => { const n = Number(String(v || '').replace(/[$,]/g, '')); return Number.isFinite(n) ? Math.round(n * 100) : null }
const MONTHS = { Jan: 1, Feb: 2, Mar: 3, Apr: 4, May: 5, Jun: 6, Jul: 7, Aug: 8, Sep: 9, Oct: 10, Nov: 11, Dec: 12 }
const ebayDate = s => { const m = /^([A-Z][a-z]{2})-(\d{2})-(\d{2})$/.exec(s || ''); return m ? `20${m[3]}-${String(MONTHS[m[1]]).padStart(2, '0')}-${m[2]}` : null }

/** Title match first; if that is not exact, a store SKU that names one card wins (grader and grade still from the title). */
function place(title, sku) {
  const m = matchTitle(title, cards)
  if (m.confidence === 'exact') return m
  // Only settle a variant/set ambiguity by SKU; a title naming two cards (a two-card listing) stays out.
  if (!/candidate/.test(m.reason || '')) return m
  const parsed = parseSku(sku)
  const card = parsed && matchCard(parsed, cards, title)
  if (card && m.grader && m.grade_label) return { ...m, card, confidence: 'exact', via: 'sku' }
  return m
}

const sales = [], skipped = []
// eBay orders report
for (const r of records(`${IMPORTS}/eBay/eBay-OrdersReport-api.csv`, 'Order Number')) {
  const title = r['Item Title']
  if (!title || !isLifeTitle(title)) continue
  if (known.has(String(r['Item Number']))) { skipped.push(['already in eBay pull', title]); continue }
  const m = place(title, r['Custom Label'])
  const date = ebayDate(r['Sale Date'])
  const price = money(r['Sold For'])
  if (m.confidence !== 'exact' || !date || price == null) { if (!m.reject || m.grader) skipped.push([m.reason || 'no date/price', title]); continue }
  sales.push({ ref: `ebay:${r['Order Number']}:${r['Item Number']}`, m, price, date, type: 'ebay', url: `https://www.ebay.com/itm/${r['Item Number']}`, title, via: 'eBay' })
}
// Shopify orders export (order-level fields are only on an order's first line)
const order = {}
for (const r of records(`${IMPORTS}/Shopify/orders_export_api.csv`, 'Lineitem name')) {
  if (r['Financial Status'] || r['Source']) order[r.Name] = { status: r['Financial Status'], source: r.Source, cancelled: r['Cancelled at'] }
  const o = order[r.Name] || {}
  const title = r['Lineitem name']
  if (!title || !isLifeTitle(title)) continue
  if (o.source === 'ebay') continue // synced eBay order, counted from the eBay file
  if (o.cancelled || o.status === 'refunded') { skipped.push([`order ${o.status || 'cancelled'}`, title]); continue }
  const m = place(title, r['Lineitem sku'])
  const qty = Number(r['Lineitem quantity']) || 1
  const price = money(r['Lineitem price']) - Math.round((money(r['Lineitem discount']) || 0) / qty)
  const date = (r['Created at'] || '').slice(0, 10)
  if (m.confidence !== 'exact' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) { if (!m.reject || m.grader) skipped.push([m.reason, title]); continue }
  sales.push({ ref: `shopify:${r.Name}:${r['Lineitem sku'] || title}`, m, price, date, type: 'store', url: null, title, via: 'Shopify' + (o.status === 'partially_refunded' ? ' (order partially refunded)' : '') })
}

const esc = v => (v == null ? 'NULL' : typeof v === 'number' ? String(v) : "'" + String(v).replace(/'/g, "''") + "'")
const now = new Date().toISOString()
const sql = sales.map(s => `INSERT OR IGNORE INTO sales (source, source_ref, card_key, grader, grade_label, grade_numeric, price_cents, best_offer, sale_date, sale_type, url, title, verified, created_at) VALUES ('taclaco', ${esc(s.ref)}, ${esc(cardKey(s.m.card))}, ${esc(s.m.grader)}, ${esc(s.m.grade_label)}, ${gradeNumeric(s.m.grade_label)}, ${s.price}, 0, ${esc(s.date)}, ${esc(s.type)}, ${esc(s.url)}, ${esc(s.title)}, 1, ${esc(now)});`)
mkdirSync(root + 'data/private', { recursive: true })
writeFileSync(root + 'data/private/taclaco_sales.sql', sql.join('\n') + '\n')

for (const s of sales.sort((a, b) => b.date.localeCompare(a.date)))
  console.log(`${s.date}  $${(s.price / 100).toFixed(2).padStart(8)}  ${s.m.grader} ${s.m.grade_label.padEnd(11)} ${cardKey(s.m.card)}  [${s.via}${s.m.via ? ', by SKU' : ''}]`)
console.log(`\n${sales.length} sales written to data/private/taclaco_sales.sql`)
if (skipped.length) {
  console.log(`\nNot loaded (${skipped.length}):`)
  for (const [why, t] of skipped) console.log(`  ${why}: ${t}`)
}
