// Coverage check: fetch the live storefront and print, for every available LIFE single SKU, the matched
// card or UNMATCHED. Uses the same matcher as the Worker (worker/store.js) and the local data/life_pop.sqlite.
// Usage: node scripts/check_store_match.mjs
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { fetchProducts, matchProducts } from '../worker/store.js'

const dbPath = fileURLToPath(new URL('../data/life_pop.sqlite', import.meta.url))
const sql = `SELECT c.id, s.name AS set_name, c.number, c.name, c.variant FROM cards c JOIN sets s ON s.id = c.set_id WHERE s.name NOT LIKE '%Kickstarter%'`
const cards = JSON.parse(execFileSync('sqlite3', ['-json', dbPath, sql], { encoding: 'utf8', maxBuffer: 1 << 24 }))

const all = matchProducts(await fetchProducts(), cards)
// Only graded slabs get a Buy button; raw singles are just counted.
const rows = all.filter(r => r.graded)
const rawSkipped = all.length - rows.length
const unmatched = []
for (const r of rows) {
  const kind = r.graded ? 'graded' : 'raw'
  if (r.card) console.log(`${r.sku.padEnd(24)} ${kind.padEnd(6)} -> ${r.card.set_name} #${r.card.number} ${r.card.name} (${r.card.variant})`)
  else {
    const n = cards.filter(c => c.set_name === r.parsed.set && c.number === r.parsed.number).length
    const why = n ? `${n} cards at that number, variant not resolved` : 'no card at that number in pop data (never graded)'
    console.log(`${r.sku.padEnd(24)} ${kind.padEnd(6)} -> UNMATCHED [${r.parsed.set} #${r.parsed.number}${r.parsed.letter}] ${why}`)
    unmatched.push({ sku: r.sku, ambiguous: n > 0 })
  }
}
const amb = unmatched.filter(u => u.ambiguous).map(u => u.sku)
console.log(`\n${rawSkipped} raw singles skipped.\n${rows.length} available graded LIFE SKUs: ${rows.length - unmatched.length} matched, ${unmatched.length} unmatched (${unmatched.length - amb.length} not in pop data, ${amb.length} ambiguous)`)
if (amb.length) console.log('Ambiguous: ' + amb.join(', '))
