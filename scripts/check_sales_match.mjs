// Runs the eBay title matcher (worker/sales_match.js) over scripts/fixtures/sales_titles.json against the cards in
// the local data/life_pop.sqlite and prints pass/fail per title. Exit code 1 if any fail.
// Usage: node scripts/check_sales_match.mjs
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { matchTitle } from '../worker/sales_match.js'
import { cardKey } from '../worker/sales_common.js'

const dbPath = fileURLToPath(new URL('../data/life_pop.sqlite', import.meta.url))
const sql = 'SELECT c.id, s.name AS set_name, c.number, c.name, c.variant FROM cards c JOIN sets s ON s.id = c.set_id'
const cards = JSON.parse(execFileSync('sqlite3', ['-json', dbPath, sql], { encoding: 'utf8', maxBuffer: 1 << 24 }))
const fixtures = JSON.parse(readFileSync(new URL('./fixtures/sales_titles.json', import.meta.url), 'utf8'))

let failed = 0
for (const f of fixtures) {
  const r = matchTitle(f.title, cards)
  const got = { confidence: r.confidence, card: r.card ? cardKey(r.card) : null, grader: r.grader, grade_label: r.grade_label, ...(f.reject ? { reject: Boolean(r.reject) } : {}) }
  const want = { confidence: f.confidence, card: f.card, grader: f.grader, grade_label: f.grade_label, ...(f.reject ? { reject: true } : {}) }
  // A fixture may leave grader/grade_label as null to mean "don't care" only when the expected confidence is none.
  const keys = Object.keys(want).filter(k => !(f.confidence === 'none' && want[k] == null && k !== 'confidence'))
  const bad = keys.filter(k => got[k] !== want[k])
  if (bad.length) failed++
  console.log(`${bad.length ? 'FAIL' : 'ok  '} ${f.title}${bad.length ? '\n       ' + bad.map(k => `${k}: wanted ${want[k]}, got ${got[k]} (${r.reason})`).join('\n       ') : ''}`)
}
console.log(`\n${fixtures.length - failed} of ${fixtures.length} passed`)
process.exit(failed ? 1 : 0)
