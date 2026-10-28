import React, { useEffect, useMemo, useState } from 'react'
import { api } from './api.js'
import { n0, pct, dateLabel, graderColor } from './format.js'
import { SetBars, GradeBars, HistoryChart, Legend } from './charts.jsx'

function useDebounced(value, ms) {
  const [v, setV] = useState(value)
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms)
    return () => clearTimeout(t)
  }, [value, ms])
  return v
}

function Tile({ label, value, sub, color }) {
  return (
    <div className="tile">
      <div className="tile-label">{color && <i style={{ background: color }} />}{label}</div>
      <div className="tile-value">{value}</div>
      {sub && <div className="tile-sub">{sub}</div>}
    </div>
  )
}

function Section({ title, hint, children, right }) {
  return (
    <section className="card">
      <div className="card-head">
        <h2>{title}</h2>
        {right}
      </div>
      {hint && <p className="hint">{hint}</p>}
      {children}
    </section>
  )
}

function CardDetail({ id, onClose }) {
  const [data, setData] = useState(null)
  const [err, setErr] = useState(null)
  useEffect(() => {
    setData(null)
    api.card(id).then(setData).catch(e => setErr(e.message))
  }, [id])
  useEffect(() => {
    const onKey = e => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const byGrader = useMemo(() => {
    const m = {}
    for (const r of data?.distribution || []) (m[r.grader] ||= []).push(r)
    return m
  }, [data])

  return (
    <div className="overlay" onClick={onClose}>
      <aside className="panel" role="dialog" aria-modal="true" aria-label="Card detail" onClick={e => e.stopPropagation()}>
        <button className="close" onClick={onClose} aria-label="Close">×</button>
        {err && <p className="error">{err}</p>}
        {!data && !err && <p className="note">Loading...</p>}
        {data && (
          <>
            <p className="eyebrow">{data.card.set_name}</p>
            <h2 className="panel-title">{data.card.name}</h2>
            <p className="hint">#{data.card.number || 'n/a'} · {data.card.variant}</p>
            {data.mine.length > 0 && (
              <div className="mine-box">
                <strong>Taclaco submitted {data.mine.reduce((a, m) => a + m.count, 0)} of these to TAG</strong>
                <span> ({data.mine.map(m => `${m.count} at ${m.label}`).join(', ')})</span>
              </div>
            )}
            {Object.keys(byGrader).length === 0 && <p className="note">No graded copies on record.</p>}
            {Object.entries(byGrader).map(([g, rows]) => (
              <div key={g} className="panel-grader">
                <h3><i style={{ background: graderColor(g) }} />{g}<span> {n0(rows.reduce((a, r) => a + r.count, 0))} graded</span></h3>
                <GradeBars grader={g} rows={rows} compact />
              </div>
            ))}
            <h3 className="panel-sub">History</h3>
            <table className="mini">
              <thead><tr><th>Date</th><th>Grader</th><th className="num">Graded</th><th className="num">Gems</th><th className="num">Gem rate</th></tr></thead>
              <tbody>
                {data.history.map(h => (
                  <tr key={h.snapshot_date + h.grader}><td>{dateLabel(h.snapshot_date)}</td><td>{h.grader}</td><td className="num">{h.total}</td><td className="num">{h.gems}</td><td className="num">{pct(h.gem_rate)}</td></tr>
                ))}
              </tbody>
            </table>
          </>
        )}
      </aside>
    </div>
  )
}

const COLS = (graders) => [
  { key: 'set_name', label: 'Set', type: 'text' },
  { key: 'number', label: '#', type: 'num' },
  { key: 'name', label: 'Card', type: 'text' },
  { key: 'variant', label: 'Variant', type: 'text' },
  ...graders.map(g => ({ key: 'g:' + g, label: g, type: 'count', grader: g })),
  { key: 'total', label: 'Total', type: 'count' },
  { key: 'gems', label: 'Gems', type: 'count' },
  { key: 'mine', label: 'Taclaco', type: 'count' },
]

function CardTable({ sets, graders, onOpen }) {
  const [setId, setSetId] = useState('')
  const [grader, setGrader] = useState('')
  const [q, setQ] = useState('')
  const dq = useDebounced(q, 250)
  const [rows, setRows] = useState([])
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState(null)
  const [sort, setSort] = useState({ key: 'total', dir: 'desc' })

  useEffect(() => {
    let live = true
    setLoading(true)
    api.cards({ set: setId, grader, q: dq.trim() })
      .then(r => { if (live) { setRows(r.cards); setErr(null) } })
      .catch(e => live && setErr(e.message))
      .finally(() => live && setLoading(false))
    return () => { live = false }
  }, [setId, grader, dq])

  const cols = COLS(graders)
  const sorted = useMemo(() => {
    const val = (r, k) => (k.startsWith('g:') ? r.counts[k.slice(2)]?.total || 0 : k === 'number' ? Number(r.number || -1) : r[k])
    const out = [...rows]
    out.sort((a, b) => {
      const x = val(a, sort.key), y = val(b, sort.key)
      const c = typeof x === 'string' ? x.localeCompare(y) : x - y
      return (sort.dir === 'asc' ? c : -c) || a.name.localeCompare(b.name)
    })
    return out
  }, [rows, sort])

  const clickSort = c => setSort(s => (s.key === c.key ? { key: c.key, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { key: c.key, dir: c.type === 'count' ? 'desc' : 'asc' }))

  return (
    <Section title="Cards" hint="Click a row for the grade breakdown. Counts are the latest snapshot from each grader.">
      <div className="filters">
        <input type="search" placeholder="Search card, number or variant" value={q} onChange={e => setQ(e.target.value)} aria-label="Search cards" />
        <select value={setId} onChange={e => setSetId(e.target.value)} aria-label="Filter by set">
          <option value="">All sets</option>
          {sets.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
        <select value={grader} onChange={e => setGrader(e.target.value)} aria-label="Filter by grader">
          <option value="">All graders</option>
          {graders.map(g => <option key={g} value={g}>{g}</option>)}
        </select>
        <span className="count">{loading ? 'Loading...' : `${n0(rows.length)} cards`}</span>
      </div>
      {err && <p className="error">{err}</p>}
      <div className="table-wrap">
        <table className="cards">
          <thead>
            <tr>
              {cols.map(c => (
                <th key={c.key} className={c.type === 'count' || c.key === 'number' ? 'num' : ''} aria-sort={sort.key === c.key ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}>
                  <button onClick={() => clickSort(c)} style={c.grader ? { '--dot': graderColor(c.grader) } : undefined}>
                    {c.grader && <i style={{ background: graderColor(c.grader) }} />}
                    {c.label}
                    <span className="arrow">{sort.key === c.key ? (sort.dir === 'asc' ? '▲' : '▼') : ''}</span>
                  </button>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {sorted.map(r => (
              <tr key={r.id} tabIndex={0} onClick={() => onOpen(r.id)} onKeyDown={e => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), onOpen(r.id))}>
                <td className="muted">{r.set_name}</td>
                <td className="num">{r.number}</td>
                <td className="strong">{r.name}</td>
                <td>{r.variant}</td>
                {graders.map(g => <td key={g} className="num">{r.counts[g]?.total ? r.counts[g].total : <span className="dash">·</span>}</td>)}
                <td className="num strong">{r.total}</td>
                <td className="num" title={r.gem_rate == null ? 'No numeric grades' : `${pct(r.gem_rate)} gem rate (authentic slabs excluded)`}>{r.gems || <span className="dash">·</span>}</td>
                <td className="num">{r.mine ? <span className="badge">{r.mine}</span> : <span className="dash">·</span>}</td>
              </tr>
            ))}
            {!loading && sorted.length === 0 && <tr><td colSpan={cols.length} className="empty">No cards match.</td></tr>}
          </tbody>
        </table>
      </div>
    </Section>
  )
}

export default function App() {
  const [summary, setSummary] = useState(null)
  const [sets, setSets] = useState(null)
  const [history, setHistory] = useState(null)
  const [err, setErr] = useState(null)
  const [open, setOpen] = useState(null)

  useEffect(() => {
    Promise.all([api.summary(), api.sets(), api.history()])
      .then(([s, st, h]) => { setSummary(s); setSets(st.sets); setHistory(h.history) })
      .catch(e => setErr(e.message))
  }, [])

  const graderCodes = summary ? summary.graders.map(g => g.grader) : []
  const distBy = useMemo(() => {
    const m = {}
    for (const r of summary?.distribution || []) (m[r.grader] ||= []).push(r)
    return m
  }, [summary])

  return (
    <>
      <header className="top">
        <div className="wrap">
          <h1>LIFE TCG Graded Population</h1>
          <p className="sub">
            {summary ? <>As of {dateLabel(summary.as_of)}</> : 'Loading...'}
            <span className="dot"> · </span>
            Data: CGC, TAG, AGS, BGS, ACE public pop reports
            <span className="dot"> · </span>
            Built by Taclaco
          </p>
        </div>
      </header>

      <main className="wrap">
        {err && <p className="error">Could not load data: {err}</p>}
        {summary && sets && history && (
          <>
            <div className="tiles">
              <Tile label="Total graded" value={n0(summary.total_graded)} sub={`${n0(summary.cards_graded)} distinct cards`} />
              {summary.graders.map(g => (
                <Tile key={g.grader} label={g.grader} color={graderColor(g.grader)} value={n0(g.total_graded)} sub={`${pct(g.gem_rate)} gem rate${g.authentic ? ` · ${n0(g.authentic)} AU excluded` : ''}`} />
              ))}
              <Tile label="Overall gem rate" value={pct(summary.gem_rate)} sub={`${n0(summary.gems)} gems of ${n0(summary.numeric_graded)} numerically graded${summary.authentic ? ` · ${n0(summary.authentic)} AU excluded` : ''}`} />
              <Tile
                label="Taclaco share of TAG"
                value={pct(summary.taclaco.share)}
                sub={`${summary.taclaco.certs} of ${n0(summary.taclaco.tag_total)} TAG-graded copies`}
              />
            </div>

            <Section title="Graded by set" hint="Each bar is scaled to the largest set and split by grader." right={<Legend graders={graderCodes} />}>
              <SetBars sets={sets} graders={graderCodes} />
              <p className="note">TAG files all Mammals 1st Edition copies together, so its Kickstarter copies are counted under Mammals 1st Edition. AGS publishes no variant, so its copies are matched to the closest card.</p>
            </Section>

            <Section title="Grade distribution" hint="Solid bars are 10 and above (gem tier). Lighter bars are below 10.">
              <div className="dist-grid">
                {summary.graders.map(g => (
                  <div key={g.grader} className="dist-col">
                    <h3><i style={{ background: graderColor(g.grader) }} />{g.grader}<span> {n0(g.total_graded)} graded · {pct(g.gem_rate)} gems</span></h3>
                    <GradeBars grader={g.grader} rows={distBy[g.grader] || []} />
                  </div>
                ))}
              </div>
            </Section>

            <CardTable sets={sets} graders={graderCodes} onOpen={setOpen} />

            <Section title="History" hint="Total graded at each monthly snapshot." right={<Legend graders={graderCodes} />}>
              <HistoryChart history={history} graders={graderCodes} />
            </Section>

            <footer className="foot">
              <p>
                Counts come from the public population reports of each grader, refreshed monthly. Gem means a grade of 10 or above on that grader's scale
                (CGC Gem Mint, Pristine and Perfect 10; TAG 10 and 10P; AGS Gem-MT and Legend 10; Beckett 9.5 and up). Gem rate is gems divided by numerically graded copies:
                authentic-only slabs (AU, AA, CC, VA) count as graded but are excluded from the rate. PSA and SGC block automated access and appear only once manual data is loaded.
              </p>
            </footer>
          </>
        )}
      </main>
      {open != null && <CardDetail id={open} onClose={() => setOpen(null)} />}
    </>
  )
}
