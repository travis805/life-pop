// Read-only queries against D1. "Latest" always means the most recent snapshot of each grader
// (the latest_pop view in schema.sql), so a grader that was refreshed later than the others still shows.

const all = async (db, sql, ...binds) => (await db.prepare(sql).bind(...binds).all()).results
const first = async (db, sql, ...binds) => (await db.prepare(sql).bind(...binds).first())

const rate = (n, d) => (d > 0 ? n / d : null)

async function latestSnapshots(db) {
  return all(db, `
    SELECT s.grader, g.name, g.method, g.url, s.snapshot_date AS as_of, s.total_graded, s.notes
    FROM snapshots s
    JOIN graders g ON g.code = s.grader
    WHERE s.snapshot_date = (SELECT MAX(snapshot_date) FROM snapshots x WHERE x.grader = s.grader)
    ORDER BY s.total_graded DESC, s.grader`)
}

export async function summary(db) {
  const allSnaps = await latestSnapshots(db)
  // Graders whose latest snapshot is 0 (checked, nothing graded) are listed separately, not charted.
  const snaps = allSnaps.filter(s => s.total_graded > 0)
  const noData = allSnaps.filter(s => s.total_graded === 0).map(s => ({ grader: s.grader, name: s.name, url: s.url, as_of: s.as_of, notes: s.notes }))
  const perGrader = await all(db, `
    SELECT grader, SUM(count) AS total,
           SUM(CASE WHEN is_top_grade = 1 THEN count ELSE 0 END) AS gems,
           SUM(CASE WHEN is_authentic = 1 THEN count ELSE 0 END) AS authentic,
           COUNT(DISTINCT card_id) AS cards
    FROM latest_pop GROUP BY grader`)
  const by = Object.fromEntries(perGrader.map(r => [r.grader, r]))
  const graders = snaps.map(s => {
    const p = by[s.grader] || { total: 0, gems: 0, authentic: 0, cards: 0 }
    // Gem rate = gems / numerically graded copies. Authentic-only slabs (AU etc.) count as graded but not here.
    return { ...s, gems: p.gems, authentic: p.authentic, numeric_graded: p.total - p.authentic, gem_rate: rate(p.gems, p.total - p.authentic), cards_graded: p.cards }
  })
  const total = graders.reduce((a, g) => a + g.total_graded, 0)
  const gems = graders.reduce((a, g) => a + g.gems, 0)
  const authentic = graders.reduce((a, g) => a + g.authentic, 0)
  const numericGraded = total - authentic
  const distinct = await first(db, 'SELECT COUNT(DISTINCT card_id) AS n FROM latest_pop')
  const dist = await all(db, `
    SELECT grader, grade_label AS label, grade_numeric AS num, is_authentic AS authentic, MAX(is_top_grade) AS top, SUM(count) AS count
    FROM latest_pop GROUP BY grader, grade_label, grade_numeric, is_authentic ORDER BY grader, grade_numeric DESC`)

  // Taclaco's own slabs: counts only (cert numbers never leave the database).
  const mineRows = await all(db, 'SELECT grader, COUNT(*) AS n, COUNT(DISTINCT card_id) AS cards FROM my_certs GROUP BY grader')
  const mineCards = await first(db, 'SELECT COUNT(DISTINCT card_id) AS n FROM my_certs')
  const mineBy = Object.fromEntries(mineRows.map(r => [r.grader, r]))
  for (const g of graders) {
    g.mine = mineBy[g.grader]?.n || 0
    g.mine_cards = mineBy[g.grader]?.cards || 0
    g.mine_share = rate(g.mine, g.total_graded)
  }
  const mineTotal = mineRows.reduce((a, r) => a + r.n, 0)
  return {
    as_of: graders.reduce((m, g) => (g.as_of > m ? g.as_of : m), ''),
    total_graded: total,
    gems,
    authentic,
    numeric_graded: numericGraded,
    gem_rate: rate(gems, numericGraded),
    cards_graded: distinct.n,
    graders,
    no_data: noData,
    distribution: dist,
    taclaco: {
      certs: mineTotal,
      cards: mineCards.n,
      share: rate(mineTotal, total),
      by_grader: Object.fromEntries(graders.filter(g => g.mine).map(g => [g.grader, { certs: g.mine, graded: g.total_graded, share: g.mine_share }])),
    },
  }
}

export async function sets(db) {
  const setRows = await all(db, 'SELECT id, name, year, sort_order FROM sets ORDER BY sort_order')
  const cells = await all(db, `
    SELECT c.set_id, p.grader, SUM(p.count) AS total,
           SUM(CASE WHEN p.is_top_grade = 1 THEN p.count ELSE 0 END) AS gems,
           SUM(CASE WHEN p.is_authentic = 1 THEN p.count ELSE 0 END) AS authentic,
           COUNT(DISTINCT p.card_id) AS cards
    FROM latest_pop p JOIN cards c ON c.id = p.card_id
    GROUP BY c.set_id, p.grader`)
  const mine = await all(db, `
    SELECT c.set_id, m.grader, COUNT(*) AS n FROM my_certs m JOIN cards c ON c.id = m.card_id GROUP BY c.set_id, m.grader`)
  return {
    sets: setRows.map(s => {
      const byGrader = {}
      let total = 0
      let gems = 0, authentic = 0
      for (const c of cells) if (c.set_id === s.id) {
        byGrader[c.grader] = { ...c, gem_rate: rate(c.gems, c.total - c.authentic) }
        total += c.total; gems += c.gems; authentic += c.authentic
      }
      const mineByGrader = {}
      for (const m of mine) if (m.set_id === s.id) mineByGrader[m.grader] = m.n
      const mineTotal = Object.values(mineByGrader).reduce((a, n) => a + n, 0)
      return { ...s, total, gems, authentic, gem_rate: rate(gems, total - authentic), mine: mineTotal, mine_by_grader: mineByGrader, graders: byGrader }
    }),
  }
}

export async function cards(db, { set, grader, q }) {
  const where = []
  const binds = []
  if (set && /^\d+$/.test(set)) { where.push('c.set_id = ?'); binds.push(Number(set)) }
  if (q && q.trim()) {
    const like = `%${q.trim().replace(/[%_\\]/g, m => '\\' + m)}%`
    where.push("(c.name LIKE ? ESCAPE '\\' OR c.number LIKE ? ESCAPE '\\' OR c.variant LIKE ? ESCAPE '\\')")
    binds.push(like, like, like)
  }
  const cardRows = await all(db, `
    SELECT c.id, c.set_id, s.name AS set_name, c.number, c.name, c.variant
    FROM cards c JOIN sets s ON s.id = c.set_id
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY s.sort_order, CAST(c.number AS INTEGER), c.name, c.variant`, ...binds)
  const pops = await all(db, `
    SELECT card_id, grader, SUM(count) AS total,
           SUM(CASE WHEN is_top_grade = 1 THEN count ELSE 0 END) AS gems,
           SUM(CASE WHEN is_authentic = 1 THEN count ELSE 0 END) AS authentic
    FROM latest_pop GROUP BY card_id, grader`)
  const mine = await all(db, 'SELECT card_id, grader, COUNT(*) AS n FROM my_certs GROUP BY card_id, grader')
  const popBy = new Map()
  for (const p of pops) {
    if (!popBy.has(p.card_id)) popBy.set(p.card_id, {})
    popBy.get(p.card_id)[p.grader] = { total: p.total, gems: p.gems, authentic: p.authentic, gem_rate: rate(p.gems, p.total - p.authentic) }
  }
  const mineBy = new Map()
  for (const m of mine) {
    if (!mineBy.has(m.card_id)) mineBy.set(m.card_id, {})
    mineBy.get(m.card_id)[m.grader] = m.n
  }
  const out = []
  for (const c of cardRows) {
    const counts = popBy.get(c.id) || {}
    if (grader && !counts[grader]) continue
    const use = grader ? [counts[grader]] : Object.values(counts)
    out.push({
      ...c,
      counts,
      total: use.reduce((a, x) => a + x.total, 0),
      gems: use.reduce((a, x) => a + x.gems, 0),
      authentic: use.reduce((a, x) => a + x.authentic, 0),
      gem_rate: rate(use.reduce((a, x) => a + x.gems, 0), use.reduce((a, x) => a + x.total - x.authentic, 0)),
      mine_by_grader: mineBy.get(c.id) || {},
      mine: Object.values(mineBy.get(c.id) || {}).reduce((a, n) => a + n, 0),
    })
  }
  const graders = (await all(db, 'SELECT DISTINCT grader FROM snapshots WHERE total_graded > 0 ORDER BY grader')).map(r => r.grader)
  return { graders, cards: out }
}

export async function card(db, id) {
  const c = await first(db, `
    SELECT c.id, c.set_id, s.name AS set_name, c.number, c.name, c.variant
    FROM cards c JOIN sets s ON s.id = c.set_id WHERE c.id = ?`, id)
  if (!c) return null
  const distribution = await all(db, `
    SELECT grader, grade_label AS label, grade_numeric AS num, is_top_grade AS top, is_authentic AS authentic, count
    FROM latest_pop WHERE card_id = ? ORDER BY grader, grade_numeric DESC`, id)
  const hist = await all(db, `
    SELECT snapshot_date, grader, SUM(count) AS total,
           SUM(CASE WHEN is_top_grade = 1 THEN count ELSE 0 END) AS gems,
           SUM(CASE WHEN is_authentic = 1 THEN count ELSE 0 END) AS authentic
    FROM pop WHERE card_id = ? GROUP BY snapshot_date, grader ORDER BY snapshot_date, grader`, id)
  const mine = await all(db, `
    SELECT grader, grade_label AS label, COUNT(*) AS count FROM my_certs WHERE card_id = ? GROUP BY grader, grade_label`, id)
  const mineBy = {}
  for (const m of mine) mineBy[m.grader] = (mineBy[m.grader] || 0) + m.count
  // Per-grader summary for the latest snapshots, plus the card's pop rank within its set (by total graded, all graders).
  const perGrader = {}
  for (const d of distribution) {
    const p = (perGrader[d.grader] ||= { grader: d.grader, total: 0, gems: 0, authentic: 0 })
    p.total += d.count
    if (d.top) p.gems += d.count
    if (d.authentic) p.authentic += d.count
  }
  const graders = Object.values(perGrader).map(p => ({ ...p, gem_rate: rate(p.gems, p.total - p.authentic), mine: mineBy[p.grader] || 0 }))
  const total = graders.reduce((a, g) => a + g.total, 0)
  const gems = graders.reduce((a, g) => a + g.gems, 0)
  const authentic = graders.reduce((a, g) => a + g.authentic, 0)
  const setTotals = await all(db, `
    SELECT p.card_id, SUM(p.count) AS total FROM latest_pop p JOIN cards x ON x.id = p.card_id
    WHERE x.set_id = ? GROUP BY p.card_id`, c.set_id)
  const setCards = await first(db, 'SELECT COUNT(*) AS n FROM cards WHERE set_id = ?', c.set_id)
  const rank = total > 0 ? 1 + setTotals.filter(r => r.total > total).length : null
  return {
    card: c,
    distribution,
    history: hist.map(h => ({ ...h, gem_rate: rate(h.gems, h.total - h.authentic) })),
    mine,
    mine_by_grader: mineBy,
    mine_total: Object.values(mineBy).reduce((a, n) => a + n, 0),
    graders,
    total,
    gems,
    gem_rate: rate(gems, total - authentic),
    rank: rank && { position: rank, of: setTotals.length, set_cards: setCards.n },
  }
}

export async function history(db) {
  const rows = await all(db, `
    SELECT s.snapshot_date, s.grader, s.total_graded,
           (SELECT COALESCE(SUM(p.count), 0) FROM pop p
             WHERE p.snapshot_date = s.snapshot_date AND p.grader = s.grader AND p.is_top_grade = 1) AS gems,
           (SELECT COALESCE(SUM(p.count), 0) FROM pop p
             WHERE p.snapshot_date = s.snapshot_date AND p.grader = s.grader AND p.is_authentic = 1) AS authentic
    FROM snapshots s WHERE s.total_graded > 0 ORDER BY s.snapshot_date, s.grader`)
  return { history: rows.map(r => ({ ...r, gem_rate: rate(r.gems, r.total_graded - r.authentic) })) }
}
