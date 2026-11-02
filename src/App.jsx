import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { api } from './api.js'
import { n0, pct, dateLabel, graderColor } from './format.js'
import { GemRateBars, GradeBars, HistoryChart, Legend } from './charts.jsx'

// ---------- small hooks ----------
function useStreamMode() {
  const [stream, setStream] = useState(() => new URLSearchParams(location.search).get('stream') === '1')
  const toggle = useCallback(() => {
    setStream(on => {
      const p = new URLSearchParams(location.search)
      if (on) p.delete('stream')
      else p.set('stream', '1')
      const qs = p.toString()
      history.replaceState(null, '', location.pathname + (qs ? '?' + qs : '') + location.hash)
      return !on
    })
  }, [])
  return [stream, toggle]
}

const cardFromHash = () => {
  const m = /^#card\/(\d+)$/.exec(location.hash)
  return m ? Number(m[1]) : null
}

function useOpenCard() {
  const [open, setOpen] = useState(cardFromHash)
  useEffect(() => {
    const sync = () => setOpen(cardFromHash())
    window.addEventListener('hashchange', sync)
    window.addEventListener('popstate', sync)
    return () => {
      window.removeEventListener('hashchange', sync)
      window.removeEventListener('popstate', sync)
    }
  }, [])
  const openCard = useCallback(id => {
    history.pushState(null, '', '#card/' + id)
    setOpen(id)
  }, [])
  const closeCard = useCallback(() => {
    if (location.hash) history.pushState(null, '', location.pathname + location.search)
    setOpen(null)
  }, [])
  return [open, openCard, closeCard]
}

// ---------- building blocks ----------
function Section({ title, hint, children, right, className }) {
  return (
    <section className={'card' + (className ? ' ' + className : '')}>
      <div className="card-head">
        <h2>{title}</h2>
        {right}
      </div>
      {hint && <p className="hint">{hint}</p>}
      {children}
    </section>
  )
}

function Hero({ label, value, sub, extra }) {
  return (
    <div className="hero-stat">
      <div className="hero-label">{label}</div>
      <div className="hero-value">{value}</div>
      <div className="hero-sub">{sub}</div>
      {extra && <div className="hero-extra">{extra}</div>}
    </div>
  )
}

function Tile({ g }) {
  return (
    <div className="tile">
      <div className="tile-label"><i style={{ background: graderColor(g.grader) }} />{g.grader}</div>
      <div className="tile-value">{n0(g.total_graded)}</div>
      <div className="tile-sub">
        {pct(g.gem_rate)} gem rate
        {g.authentic ? <span className="tile-au"> · {n0(g.authentic)} authentic-only {g.authentic === 1 ? 'slab' : 'slabs'} excluded</span> : null}
      </div>
    </div>
  )
}

/** Column count that fills every row evenly (6 tiles: 6 wide, 3 medium, 2 narrow). */
function tileCols(n) {
  for (let c = Math.min(n, 6); c >= 3; c--) if (n % c === 0) return c
  return Math.min(Math.ceil(n / 2), 6)
}

function SourceLinks({ summary }) {
  const all = [...summary.graders.map(g => ({ code: g.grader, url: g.url, as_of: g.as_of, text: `${g.grader}` })),
    ...summary.no_data.map(g => ({ code: g.grader, url: g.url, as_of: g.as_of, text: `${g.grader}: 0 graded` }))]
  return (
    <p className="sources">
      <span>Pop reports:</span>
      {all.map(s => (
        <a key={s.code} href={s.url} target="_blank" rel="noopener noreferrer" title={`${s.code} public pop report (pulled ${dateLabel(s.as_of)})`}>{s.text}</a>
      ))}
    </p>
  )
}

// ---------- sets table ----------
function SetsTable({ sets, graders, summary }) {
  const rows = sets.filter(s => s.total > 0)
  const sum = (f) => rows.reduce((a, s) => a + f(s), 0)
  const totalAll = sum(s => s.total)
  const gemAll = sum(s => s.gems)
  const authAll = sum(s => s.authentic)
  const share = (n, d) => (d > 0 ? pct(n / d, 0) : pct(null))
  const cellTitle = (g, c, tot) => {
    const au = c.authentic ? `, ${c.authentic} authentic-only` : ''
    const rate = c.total - c.authentic > 0 ? pct(c.gem_rate) : 'n/a'
    return `${g}: ${c.total} of ${tot} graded in this set (${share(c.total, tot)}), gem rate ${rate}${au}`
  }
  const gcell = (c, tot) => (c && c.total
    ? <><span className="cell-main">{n0(c.total)}</span><span className="cell-sub">{share(c.total, tot)}</span></>
    : <span className="dash">·</span>)
  return (
    <div className="table-wrap">
      <table className="data sets">
        <thead>
          <tr>
            <th className="stickycol">Set</th>
            <th className="num">Total</th>
            <th className="num">Gem rate</th>
            {graders.map(g => <th key={g} className="num"><i className="dot-i" style={{ background: graderColor(g) }} />{g}</th>)}
            <th className="num">Taclaco</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(s => (
            <tr key={s.id}>
              <td className="stickycol strong">{s.name}</td>
              <td className="num strong">{n0(s.total)}</td>
              <td className="num">{pct(s.gem_rate)}</td>
              {graders.map(g => {
                const c = s.graders[g]
                return <td key={g} className="num stack" title={c && c.total ? cellTitle(g, c, s.total) : `${g}: none`}>{gcell(c, s.total)}</td>
              })}
              <td className="num" title={Object.entries(s.mine_by_grader).map(([g, n]) => `${g} ${n}`).join(', ') || 'None'}>
                {s.mine ? <span className="badge">{s.mine}</span> : <span className="dash">·</span>}
              </td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr>
            <td className="stickycol strong">All sets</td>
            <td className="num strong">{n0(totalAll)}</td>
            <td className="num">{pct(totalAll - authAll > 0 ? gemAll / (totalAll - authAll) : null)}</td>
            {graders.map(g => {
              const gs = summary.graders.find(x => x.grader === g)
              const gt = { total: rows.reduce((a, r) => a + (r.graders[g]?.total || 0), 0), authentic: rows.reduce((a, r) => a + (r.graders[g]?.authentic || 0), 0), gem_rate: gs?.gem_rate }
              return <td key={g} className="num stack" title={gt.total ? cellTitle(g, gt, totalAll) : undefined}><span className="cell-main">{n0(gs?.total_graded)}</span><span className="cell-sub">{share(gt.total, totalAll)}</span></td>
            })}
            <td className="num"><span className="badge">{summary.taclaco.certs}</span></td>
          </tr>
        </tfoot>
      </table>
    </div>
  )
}

// ---------- Taclaco section ----------
function TaclacoSection({ summary }) {
  const rows = summary.graders.filter(g => g.mine > 0).sort((a, b) => b.mine - a.mine)
  const t = summary.taclaco
  return (
    <Section title="Taclaco's own slabs" hint="Cards Taclaco submitted itself, as a share of every graded copy on each grader's pop report.">
      <div className="mine-rows">
        {rows.map(g => (
          <div className="mine-row" key={g.grader}>
            <span className="gr-name"><i style={{ background: graderColor(g.grader) }} />{g.grader}</span>
            <span className="gr-track" aria-hidden="true"><span className="gr-fill" style={{ width: `${Math.min(100, (g.mine_share || 0) * 100)}%`, background: graderColor(g.grader) }} /></span>
            <span className="mine-val"><strong>{g.mine}</strong> of {n0(g.total_graded)} <span className="muted">({pct(g.mine_share)})</span></span>
          </div>
        ))}
        <div className="mine-row total">
          <span className="gr-name">All graders</span>
          <span />
          <span className="mine-val"><strong>{t.certs}</strong> of {n0(summary.total_graded)} <span className="muted">({pct(t.share)}) · {t.cards} card variants</span></span>
        </div>
      </div>
    </Section>
  )
}

// ---------- rarest ----------
const EXCL_KEY = 'lifepop.rarest.excluded'
function loadExcluded() {
  try { const v = JSON.parse(localStorage.getItem(EXCL_KEY)); return Array.isArray(v) ? v : [] } catch { return [] }
}
function Rarest({ cards, onOpen }) {
  const [excluded, setExcluded] = useState(loadExcluded)
  const sets = useMemo(() => { const m = new Map(); for (const c of cards) if (!m.has(c.set_id)) m.set(c.set_id, c.set_name); return [...m] }, [cards])
  const toggle = (id) => setExcluded(prev => {
    const next = prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]
    try { localStorage.setItem(EXCL_KEY, JSON.stringify(next)) } catch { /* storage unavailable */ }
    return next
  })
  const pool = useMemo(() => cards.filter(c => !excluded.includes(c.set_id)), [cards, excluded])
  const topGems = useMemo(() => pool.filter(c => c.gems > 0).sort((a, b) => b.gems - a.gems || b.total - a.total || a.name.localeCompare(b.name)).slice(0, 10), [pool])
  const lowRate = useMemo(() => pool.filter(c => c.total - c.authentic >= 10 && c.gem_rate != null)
    .sort((a, b) => a.gem_rate - b.gem_rate || (b.total - b.authentic) - (a.total - a.authentic) || a.name.localeCompare(b.name)).slice(0, 10), [pool])
  const item = (c, right) => (
    <li key={c.id}>
      <button className="linkish" onClick={() => onOpen(c.id)}>
        <span className="strong">{c.name}</span>
        <span className="muted"> #{c.number} {c.variant} · {c.set_name}</span>
      </button>
      <span className="rare-right">{right}</span>
    </li>
  )
  const empty = <li className="muted">No cards match.</li>
  return (
    <Section title="Rarest" hint="Across all graders combined. A low gem rate on a widely graded card marks where a gem copy is scarcest relative to demand.">
      <div className="set-filter" role="group" aria-label="Filter sets">
        <span className="muted">Sets (click to exclude):</span>
        {sets.map(([id, name]) => {
          const off = excluded.includes(id)
          return <button key={id} className={`setchip${off ? ' off' : ''}`} aria-pressed={!off} onClick={() => toggle(id)}>{name}</button>
        })}
      </div>
      <div className="rare-grid">
        <div>
          <h3>Most gems<span> highest gem population</span></h3>
          <ul className="rare-list">
            {topGems.length ? topGems.map(c => item(c, <span className="tabnum">{n0(c.gems)} gems</span>)) : empty}
          </ul>
        </div>
        <div>
          <h3>Lowest gem rate<span> 10+ numerically graded copies</span></h3>
          <ul className="rare-list">
            {lowRate.length ? lowRate.map(c => item(c, <span className="tabnum">{pct(c.gem_rate, 0)} · {c.gems} of {c.total - c.authentic}</span>)) : empty}
          </ul>
        </div>
      </div>
    </Section>
  )
}

// ---------- card detail ----------
function CardDetail({ id, onClose }) {
  const [data, setData] = useState(null)
  const [err, setErr] = useState(null)
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    setData(null)
    setErr(null)
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
  const copy = () => {
    try {
      navigator.clipboard.writeText(location.href).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500) })
    } catch { /* clipboard unavailable */ }
  }

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
            <div className="panel-stats">
              <div><span className="ps-v">{n0(data.total)}</span><span className="ps-l">graded</span></div>
              <div><span className="ps-v">{pct(data.gem_rate)}</span><span className="ps-l">gem rate</span></div>
              <div><span className="ps-v">{data.rank ? `#${data.rank.position}` : 'n/a'}</span><span className="ps-l">{data.rank ? `of ${data.rank.of} in set by pop` : 'pop rank in set'}</span></div>
            </div>
            {data.mine_total > 0 && (
              <div className="mine-box">
                <strong>Taclaco holds {data.mine_total} of these</strong>
                <span> ({data.graders.filter(g => g.mine).map(g => `${g.grader} ${g.mine}`).join(', ')}; {data.mine.map(m => `${m.count} ${m.grader} ${m.label}`).join(', ')})</span>
              </div>
            )}
            {Object.keys(byGrader).length === 0 && <p className="note">No graded copies on record.</p>}
            {data.graders.map(g => (
              <div key={g.grader} className="panel-grader">
                <h3>
                  <i style={{ background: graderColor(g.grader) }} />{g.grader}
                  <span> {n0(g.total)} graded · {pct(g.gem_rate)} gems{g.mine ? ` · Taclaco ${g.mine}` : ''}</span>
                </h3>
                <GradeBars grader={g.grader} rows={byGrader[g.grader] || []} compact />
              </div>
            ))}
            {new Set(data.history.map(h => h.snapshot_date)).size > 1 && (
              <>
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
            <button className="more" onClick={copy}>{copied ? 'Link copied' : 'Copy link to this card'}</button>
          </>
        )}
      </aside>
    </div>
  )
}

// ---------- cards table ----------
const csvCell = v => {
  const s = v == null ? '' : String(v)
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s
}

function CardTable({ sets, graders, allCards, asOf, onOpen }) {
  const [setId, setSetId] = useState('')
  const [grader, setGrader] = useState('')
  const [minPop, setMinPop] = useState(1)
  const [q, setQ] = useState('')
  const [sort, setSort] = useState({ key: 'total', dir: 'desc' })

  // Derive each row for the active grader filter (or all graders combined).
  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase()
    const out = []
    for (const c of allCards) {
      if (setId && String(c.set_id) !== setId) continue
      if (needle && !(`${c.name} ${c.number} ${c.variant}`.toLowerCase().includes(needle))) continue
      const use = grader ? [c.counts[grader]].filter(Boolean) : Object.values(c.counts)
      if (grader && !use.length) continue
      const total = use.reduce((a, x) => a + x.total, 0)
      const gems = use.reduce((a, x) => a + x.gems, 0)
      const auth = use.reduce((a, x) => a + x.authentic, 0)
      if (total < minPop) continue
      out.push({ ...c, total, gems, gem_rate: total - auth > 0 ? gems / (total - auth) : null, mine_shown: c.mine })
    }
    return out
  }, [allCards, setId, grader, q, minPop])

  const showSet = !setId
  const cols = useMemo(() => {
    const gl = grader ? grader + ' ' : ''
    const list = [
      { key: 'name', label: 'Card', type: 'text', cls: 'stickycol' },
      { key: 'total', label: gl + 'total', type: 'count' },
      { key: 'gems', label: gl + 'gems', type: 'count' },
      { key: 'gem_rate', label: gl + 'gem %', type: 'count' },
      { key: 'number', label: '#', type: 'num' },
      { key: 'variant', label: 'Variant', type: 'text' },
    ]
    if (showSet) list.push({ key: 'set_name', label: 'Set', type: 'text' })
    if (!grader) for (const g of graders) list.push({ key: 'g:' + g, label: g, type: 'count', grader: g })
    list.push({ key: 'mine', label: 'Taclaco', type: 'count' })
    return list
  }, [graders, grader, showSet])

  const sorted = useMemo(() => {
    const val = (r, k) => (k.startsWith('g:') ? r.counts[k.slice(2)]?.total || 0 : k === 'number' ? Number(r.number || -1) : k === 'gem_rate' ? (r.gem_rate ?? -1) : r[k])
    const out = [...rows]
    out.sort((a, b) => {
      const x = val(a, sort.key), y = val(b, sort.key)
      const c = typeof x === 'string' ? x.localeCompare(y) : x - y
      return (sort.dir === 'asc' ? c : -c) || a.name.localeCompare(b.name) || a.id - b.id
    })
    return out
  }, [rows, sort])

  const clickSort = c => setSort(s => (s.key === c.key ? { key: c.key, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { key: c.key, dir: c.type === 'count' ? 'desc' : 'asc' }))

  const download = () => {
    const head = ['Set', 'Number', 'Card', 'Variant', ...graders.map(g => g + ' graded'), `${grader || 'All graders'} total`, `${grader || 'All graders'} gems`, `${grader || 'All graders'} gem rate`, 'Taclaco total', ...graders.map(g => 'Taclaco ' + g)]
    const lines = [head.map(csvCell).join(',')]
    for (const r of sorted) {
      lines.push([r.set_name, r.number, r.name, r.variant, ...graders.map(g => r.counts[g]?.total || 0), r.total, r.gems, r.gem_rate == null ? '' : (r.gem_rate * 100).toFixed(1) + '%', r.mine, ...graders.map(g => r.mine_by_grader[g] || 0)].map(csvCell).join(','))
    }
    const blob = new Blob([lines.join('\r\n') + '\r\n'], { type: 'text/csv;charset=utf-8' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `life-tcg-graded-pop-${asOf || 'latest'}.csv`
    document.body.appendChild(a)
    a.click()
    a.remove()
    setTimeout(() => URL.revokeObjectURL(a.href), 1000)
  }

  const cell = (r, c) => {
    switch (c.key) {
      case 'name': return <td key={c.key} className="stickycol card-cell"><span className="strong">{r.name}</span></td>
      case 'total': return <td key={c.key} className="num strong">{r.total}</td>
      case 'gems': return <td key={c.key} className="num">{r.gems || <span className="dash">·</span>}</td>
      case 'gem_rate': return <td key={c.key} className="num" title={r.gem_rate == null ? 'No numeric grades' : 'Authentic-only slabs excluded'}>{r.gem_rate == null ? <span className="dash">·</span> : pct(r.gem_rate, 0)}</td>
      case 'number': return <td key={c.key} className="num">{r.number}</td>
      case 'variant': return <td key={c.key}>{r.variant}</td>
      case 'set_name': return <td key={c.key} className="muted">{r.set_name}</td>
      case 'mine': return (
        <td key={c.key} className="num" title={Object.entries(r.mine_by_grader).map(([g, n]) => `${g} ${n}`).join(', ') || 'None'}>
          {r.mine ? <span className="badge">{r.mine}</span> : <span className="dash">·</span>}
        </td>
      )
      default: { // per-grader count
        const g = c.key.slice(2)
        const n = r.counts[g]?.total
        return <td key={c.key} className="num">{n ? n : <span className="dash">·</span>}</td>
      }
    }
  }

  return (
    <Section title="Cards" hint="Click a row for the grade breakdown. Counts are the latest snapshot from each grader. Raise Min pop so Gem % sorts meaningfully (a card with 1 copy is 0% or 100%).">
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
        <select value={minPop} onChange={e => setMinPop(Number(e.target.value))} aria-label="Minimum population">
          <option value={1}>Min pop: any</option>
          <option value={5}>Min pop: 5+</option>
          <option value={10}>Min pop: 10+</option>
        </select>
        <span className="count">{n0(sorted.length)} cards</span>
        <button className="more inline" onClick={download} disabled={!sorted.length}>Download CSV</button>
      </div>
      <div className="table-wrap">
        <table className="data cards">
          <thead>
            <tr>
              {cols.map(c => (
                <th key={c.key} className={(c.type === 'count' || c.key === 'number' ? 'num ' : '') + (c.cls || '')} aria-sort={sort.key === c.key ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}>
                  <button onClick={() => clickSort(c)}>
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
                {cols.map(c => cell(r, c))}
              </tr>
            ))}
            {sorted.length === 0 && <tr><td colSpan={cols.length} className="empty">No cards match.</td></tr>}
          </tbody>
        </table>
      </div>
    </Section>
  )
}

// ---------- history ----------
function History({ history, graders }) {
  const dates = [...new Set(history.map(h => h.snapshot_date))].sort()
  if (dates.length < 2) return null
  const last = dates[dates.length - 1]
  const prev = dates[dates.length - 2]
  const at = (g, d) => history.find(h => h.grader === g && h.snapshot_date === d)
  const rows = graders.map(g => {
    const a = at(g, last), b = at(g, prev)
    return { g, now: a?.total_graded || 0, delta: b ? (a?.total_graded || 0) - b.total_graded : null, gemDelta: b && a ? (a.gem_rate ?? 0) - (b.gem_rate ?? 0) : null }
  })
  const sumNow = rows.reduce((a, r) => a + r.now, 0)
  const sumDelta = rows.reduce((a, r) => a + (r.delta || 0), 0)
  return (
    <Section title="History" hint={`Change from ${dateLabel(prev)} to ${dateLabel(last)}.`} right={<Legend graders={graders} />}>
      <p className="mom">+{n0(sumDelta)} graded <span className="muted">since {dateLabel(prev)} ({n0(sumNow)} total)</span></p>
      <div className="table-wrap">
        <table className="data">
          <thead><tr><th>Grader</th><th className="num">Graded</th><th className="num">Change</th><th className="num">Gem rate change</th></tr></thead>
          <tbody>
            {rows.map(r => (
              <tr key={r.g}>
                <td><i className="dot-i" style={{ background: graderColor(r.g) }} />{r.g}</td>
                <td className="num">{n0(r.now)}</td>
                <td className="num">{r.delta == null ? 'new' : (r.delta >= 0 ? '+' : '') + n0(r.delta)}</td>
                <td className="num">{r.gemDelta == null ? 'n/a' : (r.gemDelta >= 0 ? '+' : '') + (r.gemDelta * 100).toFixed(1) + ' pts'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <HistoryChart history={history} graders={graders} />
    </Section>
  )
}

// ---------- app ----------
export default function App() {
  const [summary, setSummary] = useState(null)
  const [sets, setSets] = useState(null)
  const [history, setHistory] = useState(null)
  const [allCards, setAllCards] = useState(null)
  const [err, setErr] = useState(null)
  const [open, openCard, closeCard] = useOpenCard()
  const [stream, toggleStream] = useStreamMode()

  useEffect(() => {
    Promise.all([api.summary(), api.sets(), api.history(), api.cards({})])
      .then(([s, st, h, c]) => { setSummary(s); setSets(st.sets); setHistory(h.history); setAllCards(c.cards) })
      .catch(e => setErr(e.message))
  }, [])

  useEffect(() => {
    document.body.classList.toggle('stream', stream)
  }, [stream])

  const graderCodes = summary ? summary.graders.map(g => g.grader) : []
  const distBy = useMemo(() => {
    const m = {}
    for (const r of summary?.distribution || []) (m[r.grader] ||= []).push(r)
    return m
  }, [summary])
  const ready = summary && sets && history && allCards
  const asOf = summary ? dateLabel(summary.as_of) : ''
  const cols = summary ? tileCols(summary.graders.length) : 6
  const taclaco = summary?.taclaco
  const perGraderMine = summary ? summary.graders.filter(g => g.mine).map(g => `${g.grader} ${g.mine} of ${n0(g.total_graded)} (${pct(g.mine_share)})`).join(' · ') : ''

  return (
    <>
      <header className="top">
        <div className="wrap top-row">
          <div>
            <h1>LIFE TCG Graded Population</h1>
            <p className="sub">
              <strong className="asof">{summary ? `Data as of ${asOf}` : 'Loading...'}</strong>
              <span className="dot"> · </span>
              Built by <a className="plain" href="https://taclaco.com" target="_blank" rel="noopener noreferrer">Taclaco.com</a>
            </p>
          </div>
          <button className="more inline" onClick={toggleStream} aria-pressed={stream}>{stream ? 'Exit stream view' : 'Stream view'}</button>
        </div>
      </header>

      <main className="wrap">
        {err && <p className="error">Could not load data: {err}</p>}
        {!ready && !err && <p className="note">Loading...</p>}
        {ready && (
          <>
            <div className="hero">
              <Hero label="Total graded" value={n0(summary.total_graded)} sub={`across ${n0(summary.cards_graded)} card variants`} />
              <Hero
                label="Overall gem rate"
                value={pct(summary.gem_rate)}
                sub={`${n0(summary.gems)} gems of ${n0(summary.numeric_graded)} numerically graded`}
                extra={summary.authentic ? `${n0(summary.authentic)} authentic-only slabs excluded` : null}
              />
              <Hero label="Taclaco share" value={pct(taclaco.share)} sub={`${n0(taclaco.certs)} of ${n0(summary.total_graded)} graded copies`} extra={perGraderMine} />
            </div>

            {!stream && (
              <>
                <div className="tiles" style={{ '--cols': cols }}>
                  {summary.graders.map(g => <Tile key={g.grader} g={g} />)}
                </div>
                <SourceLinks summary={summary} />
              </>
            )}

            <Section title="Gem rate by grader" hint="Gems divided by numerically graded copies. n is the number of copies behind each rate.">
              <GemRateBars graders={summary.graders} />
              {!stream && (
                <details className="dist">
                  <summary>Grade distribution by grader</summary>
                  <p className="hint">Highlighted rows are the gem tier (10 and above; BGS 9.5 and up). Lighter bars are below the gem bar.</p>
                  <div className="dist-grid">
                    {summary.graders.map(g => (
                      <div key={g.grader} className="dist-col">
                        <h3><i style={{ background: graderColor(g.grader) }} />{g.grader}<span> {n0(g.total_graded)} graded · {pct(g.gem_rate)} gems</span></h3>
                        <GradeBars grader={g.grader} rows={distBy[g.grader] || []} />
                      </div>
                    ))}
                  </div>
                </details>
              )}
            </Section>

            <Section title="Sets" hint={stream ? null : 'Graded copies per set, with each grader\'s count and its share of the set beneath.'}>
              <SetsTable sets={sets} graders={graderCodes} summary={summary} />
              {!stream && <p className="note">TAG files Kickstarter copies under Mammals 1st Edition, so we check each TAG Mammals slab's scan for the Kickstarter K stamp and move any we find (none so far). AGS publishes no variant, so its copies are matched to the closest card. The figure under each count is that grader's share of the set's graded copies.</p>}
            </Section>

            <TaclacoSection summary={summary} />

            {!stream && (
              <>
                <Rarest cards={allCards} onOpen={openCard} />
                <CardTable sets={sets} graders={graderCodes} allCards={allCards} asOf={summary.as_of} onOpen={openCard} />
                <History history={history} graders={graderCodes} />
                <footer className="foot">
                  <p>
                    Counts come from the public population reports of each grader, refreshed monthly. Gem means a grade of 10 or above on that grader's scale
                    (CGC Gem Mint, Pristine and Perfect 10; TAG 10 and 10P; AGS Gem-MT and Legend 10; Beckett 9.5 and up; PSA and ACE 10; qualified PSA grades never count). Gem rate is gems divided by numerically graded copies:
                    authentic-only slabs (AU, AA, CC, VA) count as graded but are excluded from the rate. {summary.no_data.map(g => `${g.grader}: ${g.notes || '0 graded'}.`).join(' ')}
                    {new Set(history.map(h => h.snapshot_date)).size < 2 ? ' Month-over-month history appears after the next monthly refresh.' : ''}
                  </p>
                </footer>
              </>
            )}
          </>
        )}
      </main>
      {open != null && !stream && <CardDetail id={open} onClose={closeCard} />}
    </>
  )
}
