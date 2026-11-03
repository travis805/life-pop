#!/usr/bin/env node
// Moderation CLI for the Sales tab, run by Travis through Claude. Talks to D1 with `wrangler d1 execute`.
// Default target is the LOCAL database; production needs an explicit --remote.
//
//   node scripts/sales_admin.mjs pending                       pending collector submissions
//   node scripts/sales_admin.mjs approve <id> [--verified]     publish a submission (verified = counts toward medians)
//   node scripts/sales_admin.mjs reject <id> "<reason>"
//   node scripts/sales_admin.mjs review                        eBay items the matcher could not place
//   node scripts/sales_admin.mjs resolve <item_id> <card_id> "<grade label>" [--grader PSA]
//   node scripts/sales_admin.mjs skip <item_id>
//   node scripts/sales_admin.mjs orphans                       sales whose card no longer exists after a rebuild
//   node scripts/sales_admin.mjs runs                          last 10 eBay job runs
import { execFileSync } from 'node:child_process'
import { GRADERS, GRADE_LABELS, gradeNumeric } from '../worker/sales_common.js'

const args = process.argv.slice(2)
const flag = name => { const i = args.indexOf(name); if (i < 0) return false; args.splice(i, 1); return true }
const option = name => { const i = args.indexOf(name); if (i < 0) return null; const [, v] = args.splice(i, 2); return v }
const remote = flag('--remote')
flag('--local')
const verified = flag('--verified')
const graderOpt = option('--grader')
const [cmd, ...rest] = args

const die = msg => { console.error(msg); process.exit(1) }
const esc = s => "'" + String(s).replace(/\0/g, '').replace(/'/g, "''") + "'" // SQL string literal
const int = v => { const n = Number(v); if (!Number.isInteger(n) || n < 0) die(`Not a valid id: ${v}`); return n }

/** Run SQL against D1 and return the rows of the last statement that returned any. */
function sql(command) {
  const out = execFileSync('npx', ['wrangler', 'd1', 'execute', 'life-pop', remote ? '--remote' : '--local', '--json', '--command', command],
    { encoding: 'utf8', maxBuffer: 1 << 25, stdio: ['ignore', 'pipe', 'inherit'] })
  const parsed = JSON.parse(out.slice(out.indexOf('[')))
  return parsed.flatMap(p => p.results || [])
}
const usd = c => (c == null ? '' : '$' + (c / 100).toFixed(2))
const show = rows => rows.length ? console.table(rows) : console.log('(none)')
const CARD_KEY = "s.name || '|' || c.number || '|' || c.name || '|' || c.variant"
console.error(`[${remote ? 'REMOTE' : 'local'} database]`)

switch (cmd) {
  case 'pending': {
    const rows = sql(`SELECT sub.id, sub.created_at, sub.card_key, sub.grader, sub.grade_label, sub.price_cents, sub.sale_date, sub.sale_type, sub.proof_url, sub.cert, sub.note,
        (SELECT COUNT(*) FROM cards c JOIN sets s ON s.id = c.set_id WHERE ${CARD_KEY} = sub.card_key) AS card_found
      FROM sale_submissions sub WHERE sub.status = 'pending' ORDER BY sub.id`)
    show(rows.map(r => ({ id: r.id, card: r.card_key, grade: `${r.grader} ${r.grade_label}`, price: usd(r.price_cents), date: r.sale_date, type: r.sale_type, proof: r.proof_url, cert: r.cert, note: r.note, card_found: Boolean(r.card_found) })))
    break
  }
  case 'approve': {
    const id = int(rest[0])
    const sub = sql(`SELECT * FROM sale_submissions WHERE id = ${id}`)[0]
    if (!sub) die(`No submission ${id}`)
    if (sub.status !== 'pending') die(`Submission ${id} is already ${sub.status}`)
    if (!GRADE_LABELS[sub.grader]?.includes(sub.grade_label)) die(`Unknown grade ${sub.grader} ${sub.grade_label}`)
    const now = new Date().toISOString()
    const url = sub.proof_url && sub.proof_url.startsWith('https://') ? esc(sub.proof_url) : 'NULL'
    sql(`INSERT INTO sales (source, source_ref, card_key, grader, grade_label, grade_numeric, price_cents, best_offer, sale_date, sale_type, url, verified, created_at)
         VALUES ('collector', ${esc(String(id))}, ${esc(sub.card_key)}, ${esc(sub.grader)}, ${esc(sub.grade_label)}, ${gradeNumeric(sub.grade_label)}, ${int(sub.price_cents)}, 0,
                 ${esc(sub.sale_date)}, ${esc(sub.sale_type)}, ${url}, ${verified ? 1 : 0}, ${esc(now)});
         UPDATE sale_submissions SET status = 'approved', reviewed_at = ${esc(now)} WHERE id = ${id}`)
    console.log(`Approved submission ${id} (${verified ? 'verified' : 'unverified, left out of medians'}).`)
    break
  }
  case 'reject': {
    const id = int(rest[0])
    const reason = rest.slice(1).join(' ').trim()
    if (!reason) die('Give a reason: reject <id> "<reason>"')
    const cur = sql(`SELECT status FROM sale_submissions WHERE id = ${id}`)[0]
    if (!cur) die(`No submission ${id}`)
    if (cur.status !== 'pending') die(`Submission ${id} is already ${cur.status}`)
    sql(`UPDATE sale_submissions SET status = 'rejected', reviewed_at = ${esc(new Date().toISOString())}, reason = ${esc(reason)} WHERE id = ${id} AND status = 'pending'`)
    console.log(`Rejected submission ${id}.`)
    break
  }
  case 'review': {
    const rows = sql("SELECT * FROM sales_review WHERE status = 'open' ORDER BY sale_date DESC")
    show(rows.map(r => ({ item_id: r.item_id, date: r.sale_date, price: usd(r.price_cents), title: r.title, guess: [r.guess_card_key, r.guess_grader, r.guess_grade].filter(Boolean).join(' / '), reason: r.reason, url: r.url })))
    break
  }
  case 'resolve': {
    const itemId = rest[0]
    const cardId = int(rest[1])
    const label = rest.slice(2).join(' ').trim()
    if (!itemId || !label) die('Usage: resolve <item_id> <card_id> "<grade label>" [--grader PSA]')
    const r = sql(`SELECT * FROM sales_review WHERE item_id = ${esc(itemId)}`)[0]
    if (!r) die(`No review item ${itemId}`)
    if (r.status !== 'open') die(`Item ${itemId} is already ${r.status}`)
    const grader = graderOpt || r.guess_grader
    if (!GRADERS.includes(grader)) die('The matcher found no grader for this item: add --grader PSA (or CGC, TAG, BGS, ACE, AGS, SGC)')
    if (!GRADE_LABELS[grader].includes(label)) die(`${grader} grades: ${GRADE_LABELS[grader].join(', ')}`)
    const card = sql(`SELECT ${CARD_KEY} AS card_key FROM cards c JOIN sets s ON s.id = c.set_id WHERE c.id = ${cardId}`)[0]
    if (!card) die(`No card ${cardId}`)
    const now = new Date().toISOString()
    sql(`INSERT OR IGNORE INTO sales (source, source_ref, card_key, grader, grade_label, grade_numeric, price_cents, shipping_cents, best_offer, sale_date, sale_type, url, title, verified, created_at)
         SELECT 'ebay', item_id, ${esc(card.card_key)}, ${esc(grader)}, ${esc(label)}, ${gradeNumeric(label)}, price_cents, shipping_cents, COALESCE(best_offer, 0), sale_date, sale_type, url, title, 1, ${esc(now)}
         FROM sales_review WHERE item_id = ${esc(itemId)};
         UPDATE sales_review SET status = 'resolved', decided_at = ${esc(now)} WHERE item_id = ${esc(itemId)}`)
    console.log(`Resolved ${itemId} as ${card.card_key} ${grader} ${label}.`)
    break
  }
  case 'skip': {
    if (!rest[0]) die('Usage: skip <item_id>')
    sql(`UPDATE sales_review SET status = 'skipped', decided_at = ${esc(new Date().toISOString())} WHERE item_id = ${esc(rest[0])} AND status = 'open'`)
    console.log(`Skipped ${rest[0]}.`)
    break
  }
  case 'orphans': {
    show(sql("SELECT card_key, grader, grade_label, COUNT(*) AS sales, MAX(sale_date) AS latest FROM sales_v WHERE card_id IS NULL GROUP BY card_key, grader, grade_label ORDER BY card_key"))
    break
  }
  case 'runs': {
    show(sql('SELECT * FROM sales_runs ORDER BY run_at DESC LIMIT 10'))
    break
  }
  default:
    die('Commands: pending | approve <id> [--verified] | reject <id> "<reason>" | review | resolve <item_id> <card_id> "<grade>" [--grader X] | skip <item_id> | orphans | runs   (add --remote for production)')
}
