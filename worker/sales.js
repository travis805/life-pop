// Sales API: public reads of the `sales_v` view (sales joined to cards by card_key) and the one write route,
// POST /api/sales/submit (collector submissions, always stored as pending). Every row in `sales` is public;
// unmoderated submissions live in `sale_submissions` and never leave the database.
import { GRADERS, GRADE_LABELS, SUBMIT_TYPES, cardKey } from './sales_common.js'

const all = async (db, sql, ...binds) => (await db.prepare(sql).bind(...binds).all()).results
const first = async (db, sql, ...binds) => (await db.prepare(sql).bind(...binds).first())

// Medians and "top" lists only use rows we trust: eBay, Taclaco, and collector rows Taclaco checked.
const trusted = p => `(${p}source IN ('ebay', 'taclaco') OR (${p}source = 'collector' AND ${p}verified = 1))`
const TRUSTED = trusted('')
const daysAgo = n => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10)

const median = nums => {
  const s = [...nums].sort((a, b) => a - b)
  const m = s.length >> 1
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2)
}

// Public shape of a sale row. Never cert, note or ip_hash; links only if they are https.
const SALE_COLS = `v.id, v.card_id, c.name, c.number, c.variant, s.name AS set_name, v.grader, v.grade_label, v.price_cents, v.shipping_cents,
  v.best_offer, v.sale_date, v.sale_type, v.source, v.verified, v.url`
const publicSale = r => ({ ...r, url: r.url && r.url.startsWith('https://') ? r.url : null })
const FROM = 'FROM sales_v v JOIN cards c ON c.id = v.card_id JOIN sets s ON s.id = c.set_id'

function medians(rows) {
  const groups = new Map()
  for (const r of rows) {
    const k = `${r.card_id}|${r.grader}|${r.grade_label}`
    if (!groups.has(k)) groups.set(k, { card_id: r.card_id, grader: r.grader, grade_label: r.grade_label, prices: [] })
    groups.get(k).prices.push(r.price_cents)
  }
  return [...groups.values()].map(g => ({ card_id: g.card_id, grader: g.grader, grade_label: g.grade_label, n: g.prices.length, median_cents: median(g.prices) }))
}

const trustedYear = (db, extra = '', ...binds) => all(db, `
  SELECT card_id, grader, grade_label, price_cents FROM sales_v
  WHERE card_id IS NOT NULL AND sale_date >= ? AND ${TRUSTED} ${extra}`, daysAgo(365), ...binds)

export async function salesList(db, { card, grader, set, source, limit }) {
  const where = ['1 = 1']
  const binds = []
  if (card && /^\d+$/.test(card)) { where.push('v.card_id = ?'); binds.push(Number(card)) }
  if (grader && GRADERS.includes(grader)) { where.push('v.grader = ?'); binds.push(grader) }
  if (set && /^\d+$/.test(set)) { where.push('v.set_id = ?'); binds.push(Number(set)) }
  if (source && ['ebay', 'taclaco', 'collector'].includes(source)) { where.push('v.source = ?'); binds.push(source) }
  const lim = Math.min(Math.max(parseInt(limit, 10) || 200, 1), 1000)
  const rows = await all(db, `SELECT ${SALE_COLS} ${FROM} WHERE ${where.join(' AND ')} ORDER BY v.sale_date DESC, v.id DESC LIMIT ?`, ...binds, lim)

  const counts = await first(db, `
    SELECT COUNT(*) AS count,
           SUM(CASE WHEN sale_date >= ? THEN 1 ELSE 0 END) AS count_90,
           SUM(CASE WHEN ${TRUSTED} THEN 1 ELSE 0 END) AS trusted_count,
           SUM(CASE WHEN ${TRUSTED} AND sale_date >= ? THEN 1 ELSE 0 END) AS trusted_count_90
    FROM sales_v WHERE card_id IS NOT NULL`, daysAgo(90), daysAgo(90))
  const top = await all(db, `SELECT ${SALE_COLS} ${FROM} WHERE v.sale_date >= ? AND ${trusted('v.')}
    ORDER BY v.price_cents DESC, v.sale_date DESC LIMIT 10`, daysAgo(365))
  return {
    sales: rows.map(publicSale),
    summary: {
      count: counts.count || 0,
      count_90: counts.count_90 || 0,
      trusted_count: counts.trusted_count || 0,
      trusted_count_90: counts.trusted_count_90 || 0,
      top: top.map(publicSale),
      medians: medians(await trustedYear(db)),
    },
  }
}

/** Sales block of /api/card/:id: 12-month medians per grader and grade, plus the latest 5 sales. */
export async function cardSales(db, id) {
  const rows = await trustedYear(db, 'AND card_id = ?', id)
  const latest = await all(db, `SELECT ${SALE_COLS} ${FROM} WHERE v.card_id = ? ORDER BY v.sale_date DESC, v.id DESC LIMIT 5`, id)
  const count = await first(db, 'SELECT COUNT(*) AS n FROM sales_v WHERE card_id = ?', id)
  return {
    count: count.n,
    medians: medians(rows).map(({ card_id, ...m }) => m).sort((a, b) => a.grader.localeCompare(b.grader) || b.median_cents - a.median_cents),
    latest: latest.map(publicSale),
  }
}

/** { [card_id]: {price_cents, sale_date, grader, grade_label} } for the Cards table's Last sale column. */
export async function lastSales(db) {
  const rows = await all(db, `SELECT card_id, price_cents, sale_date, grader, grade_label FROM sales_v
    WHERE card_id IS NOT NULL AND ${TRUSTED} ORDER BY sale_date DESC, id DESC`)
  const out = new Map()
  for (const r of rows) if (!out.has(r.card_id)) out.set(r.card_id, { price_cents: r.price_cents, sale_date: r.sale_date, grader: r.grader, grade_label: r.grade_label })
  return out
}

export function salesConfig(request, env) {
  // The real site key is set as a var; the Cloudflare test key is only a fallback for localhost.
  // (`wrangler dev` rewrites the host to the custom domain route, so .dev.vars also sets TURNSTILE_SITE_KEY locally.)
  const local = new URL(request.url).hostname === 'localhost'
  return { turnstile_site_key: env.TURNSTILE_SITE_KEY || (local ? '1x00000000000000000000AA' : '') }
}

// ---------- POST /api/sales/submit ----------
const MAX_BODY = 2048
const LOCAL_SALT = 'life-pop-local-dev-salt'
const bad = (error, status = 400) => ({ status, body: { error } })

async function hashIp(env, ip) {
  if (!env.IP_SALT) console.warn('IP_SALT is not set; using the local dev salt (set it with `wrangler secret put IP_SALT`)')
  const data = new TextEncoder().encode((env.IP_SALT || LOCAL_SALT) + ip)
  const digest = await crypto.subtle.digest('SHA-256', data)
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('')
}

/** Dollars (number or "1,234.50", up to 2 decimals) -> integer cents, or null. */
export function parseDollars(v) {
  const s = String(v ?? '').trim().replace(/^\$/, '').replace(/,/g, '')
  if (!/^\d{1,6}(\.\d{1,2})?$/.test(s)) return null
  return Math.round(parseFloat(s) * 100)
}

async function verifyTurnstile(env, token, ip) {
  const form = new URLSearchParams({ secret: env.TURNSTILE_SECRET, response: token })
  if (ip) form.set('remoteip', ip)
  try {
    const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', { method: 'POST', body: form })
    return Boolean((await res.json()).success)
  } catch { return false }
}

const text = (v, max) => (typeof v === 'string' ? v.trim() : '').slice(0, max + 1)

export async function submitSale(request, env) {
  const db = env.DB
  if (!env.TURNSTILE_SECRET) return bad('Submissions are not open yet.', 503)
  if (Number(request.headers.get('content-length') || 0) > MAX_BODY) return bad('That request is too large.', 413)
  const raw = await request.text()
  if (new TextEncoder().encode(raw).length > MAX_BODY) return bad('That request is too large.', 413)
  let b
  try { b = JSON.parse(raw) } catch { return bad('Could not read that form.') }
  if (!b || typeof b !== 'object' || Array.isArray(b)) return bad('Could not read that form.')

  const ip = request.headers.get('cf-connecting-ip') || '127.0.0.1'
  const ipHash = await hashIp(env, ip)
  if (env.SUBMIT_LIMIT) {
    const { success } = await env.SUBMIT_LIMIT.limit({ key: ipHash })
    if (!success) return bad('Too many submissions. Please wait a minute and try again.', 429)
  }

  // Field checks come before Turnstile so a typo does not burn the single-use token.
  const cardId = Number(b.card_id)
  const card = Number.isInteger(cardId) && cardId > 0
    ? await first(db, 'SELECT c.id, s.name AS set_name, c.number, c.name, c.variant FROM cards c JOIN sets s ON s.id = c.set_id WHERE c.id = ?', cardId)
    : null
  if (!card) return bad('Pick a card from the list.')
  if (!GRADERS.includes(b.grader)) return bad('Pick a grading company.')
  if (!GRADE_LABELS[b.grader].includes(b.grade_label)) return bad('Pick a grade that ' + b.grader + ' uses.')
  const price = parseDollars(b.price)
  if (price == null || price < 100 || price > 5000000) return bad('Enter a price between $1 and $50,000, with at most 2 decimals.')
  const date = String(b.sale_date || '')
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(date + 'T00:00:00Z'))) return bad('Enter the sale date as YYYY-MM-DD.')
  const today = new Date()
  // One day of slack for people ahead of UTC.
  if (date > new Date(today.getTime() + 86400000).toISOString().slice(0, 10)) return bad('The sale date cannot be in the future.')
  const limit = new Date(today); limit.setUTCFullYear(limit.getUTCFullYear() - 3)
  if (date < limit.toISOString().slice(0, 10)) return bad('We only take sales from the last 3 years.')
  if (!SUBMIT_TYPES.includes(b.sale_type)) return bad('Pick where the card sold.')
  const cert = text(b.cert, 12).replace(/\s+/g, '')
  if (cert && !/^\d{5,12}$/.test(cert)) return bad('A cert number is 5 to 12 digits.')
  const proof = text(b.proof_url, 300)
  if (proof && (proof.length > 300 || !/^https:\/\/[^\s]+$/.test(proof))) return bad('The proof link must start with https:// and be under 300 characters.')
  const note = text(b.note, 200)
  if (note.length > 200) return bad('Keep the note under 200 characters.')

  const token = typeof b.turnstile_token === 'string' ? b.turnstile_token : ''
  if (!token || token.length > 2048 || !(await verifyTurnstile(env, token, request.headers.get('cf-connecting-ip')))) return bad('The human check failed. Please try again.')

  const dayAgo = new Date(Date.now() - 86400000).toISOString()
  const used = await first(db, 'SELECT COUNT(*) AS n FROM sale_submissions WHERE ip_hash = ? AND created_at >= ?', ipHash, dayAgo)
  if (used.n >= 20) return bad('Daily limit reached. Please try again tomorrow.', 429)

  const now = new Date().toISOString()
  const res = await db.prepare(`INSERT INTO sale_submissions
    (created_at, card_key, grader, grade_label, price_cents, sale_date, sale_type, cert, proof_url, note, ip_hash, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')`)
    .bind(now, cardKey(card), b.grader, b.grade_label, price, date, b.sale_type, cert || null, proof || null, note || null, ipHash).run()
  // Opportunistic privacy purge: IP hashes are only needed for the 24 hour cap.
  await db.prepare('UPDATE sale_submissions SET ip_hash = NULL WHERE ip_hash IS NOT NULL AND created_at < ?')
    .bind(new Date(Date.now() - 30 * 86400000).toISOString()).run()
  return { status: 200, body: { ok: true, id: res.meta?.last_row_id ?? null } }
}
