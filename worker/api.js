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
  const snaps = await latestSnapshots(db)
  const perGrader = await all(db, `
    SELECT grader, SUM(count) AS total,
           SUM(CASE WHEN is_top_grade = 1 THEN count ELSE 0 END) AS gems,
           COUNT(DISTINCT card_id) AS cards
    FROM latest_pop GROUP BY grader`)
  const by = Object.fromEntries(perGrader.map(r => [r.grader, r]))
  const graders = snaps.map(s => {
    const p = by[s.grader] || { total: 0, gems: 0, cards: 0 }
    return { ...s, gems: p.gems, gem_rate: rate(p.gems, p.total), cards_graded: p.cards }
  })
  const total = graders.reduce((a, g) => a + g.total_graded, 0)
  const gems = graders.reduce((a, g) => a + g.gems, 0)
  const distinct = await first(db, 'SELECT COUNT(DISTINCT card_id) AS n FROM latest_pop')
  const dist = await all(db, `
    SELECT grader, grade_label AS label, grade_numeric AS num, SUM(count) AS count
    FROM latest_pop GROUP BY grader, grade_label, grade_numeric ORDER BY grader, grade_numeric DESC`)

  const mine = await first(db, "SELECT COUNT(*) AS n, COUNT(DISTINCT card_id) AS cards FROM my_certs WHERE grader = 'TAG'")
  const tag = graders.find(g => g.grader === 'TAG')
  return {
    as_of: graders.reduce((m, g) => (g.as_of > m ? g.as_of : m), ''),
    total_graded: total,
    gems,
    gem_rate: rate(gems, total),
    cards_graded: distinct.n,
    graders,
    distribution: dist,
    taclaco: {
      grader: 'TAG',
      certs: mine.n,
      cards: mine.cards,
      tag_total: tag ? tag.total_graded : 0,
      share: tag ? rate(mine.n, tag.total_graded) : null,
    },
  }
}

export async function sets(db) {
  const setRows = await all(db, 'SELECT id, name, year, sort_order FROM sets ORDER BY sort_order')
  const cells = await all(db, `
    SELECT c.set_id, p.grader, SUM(p.count) AS total,
           SUM(CASE WHEN p.is_top_grade = 1 THEN p.count ELSE 0 END) AS gems,
           COUNT(DISTINCT p.card_id) AS cards
    FROM latest_pop p JOIN cards c ON c.id = p.card_id
    GROUP BY c.set_id, p.grader`)
  const mine = await all(db, `
    SELECT c.set_id, COUNT(*) AS n FROM my_certs m JOIN cards c ON c.id = m.card_id GROUP BY c.set_id`)
  const mineBy = Object.fromEntries(mine.map(r => [r.set_id, r.n]))
  return {
    sets: setRows.map(s => {
      const byGrader = {}
      let total = 0
      for (const c of cells) if (c.set_id === s.id) { byGrader[c.grader] = c; total += c.total }
      return { ...s, total, mine: mineBy[s.id] || 0, graders: byGrader }
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
           SUM(CASE WHEN is_top_grade = 1 THEN count ELSE 0 END) AS gems
    FROM latest_pop GROUP BY card_id, grader`)
  const mine = await all(db, 'SELECT card_id, COUNT(*) AS n FROM my_certs GROUP BY card_id')
  const popBy = new Map()
  for (const p of pops) {
    if (!popBy.has(p.card_id)) popBy.set(p.card_id, {})
    popBy.get(p.card_id)[p.grader] = { total: p.total, gems: p.gems }
  }
  const mineBy = new Map(mine.map(m => [m.card_id, m.n]))
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
      mine: mineBy.get(c.id) || 0,
    })
  }
  const graders = (await all(db, 'SELECT DISTINCT grader FROM snapshots ORDER BY grader')).map(r => r.grader)
  return { graders, cards: out }
}

export async function card(db, id) {
  const c = await first(db, `
    SELECT c.id, c.set_id, s.name AS set_name, c.number, c.name, c.variant
    FROM cards c JOIN sets s ON s.id = c.set_id WHERE c.id = ?`, id)
  if (!c) return null
  const distribution = await all(db, `
    SELECT grader, grade_label AS label, grade_numeric AS num, is_top_grade AS top, count
    FROM latest_pop WHERE card_id = ? ORDER BY grader, grade_numeric DESC`, id)
  const hist = await all(db, `
    SELECT snapshot_date, grader, SUM(count) AS total,
           SUM(CASE WHEN is_top_grade = 1 THEN count ELSE 0 END) AS gems
    FROM pop WHERE card_id = ? GROUP BY snapshot_date, grader ORDER BY snapshot_date, grader`, id)
  const mine = await all(db, `
    SELECT grader, grade_label AS label, COUNT(*) AS count FROM my_certs WHERE card_id = ? GROUP BY grader, grade_label`, id)
  return { card: c, distribution, history: hist, mine }
}

export async function history(db) {
  const rows = await all(db, `
    SELECT s.snapshot_date, s.grader, s.total_graded,
           (SELECT COALESCE(SUM(p.count), 0) FROM pop p
             WHERE p.snapshot_date = s.snapshot_date AND p.grader = s.grader AND p.is_top_grade = 1) AS gems
    FROM snapshots s ORDER BY s.snapshot_date, s.grader`)
  return { history: rows }
}
