import React from 'react'
import { graderColor, n0, pct, dateLabel } from './format.js'

/** One horizontal bar per grader: gem rate, sorted high to low, with the sample size. */
export function GemRateBars({ graders }) {
  const rows = [...graders].sort((a, b) => (b.gem_rate ?? -1) - (a.gem_rate ?? -1))
  return (
    <div className="gemrate" role="list">
      {rows.map(g => (
        <div className="gr-row" role="listitem" key={g.grader} title={`${g.grader}: ${n0(g.gems)} gems of ${n0(g.numeric_graded)} numerically graded`}>
          <span className="gr-name"><i style={{ background: graderColor(g.grader) }} />{g.grader}</span>
          <span className="gr-track" aria-hidden="true">
            <span className="gr-fill" style={{ width: `${(g.gem_rate || 0) * 100}%`, background: graderColor(g.grader) }} />
          </span>
          <span className="gr-val">{pct(g.gem_rate)}</span>
          <span className="gr-n">n = {n0(g.numeric_graded)}</span>
        </div>
      ))}
    </div>
  )
}

/** Count per grade for one grader. Gem tier (10 and above) rows are highlighted and drawn solid, the rest lighter. */
export function GradeBars({ grader, rows, compact }) {
  const max = Math.max(1, ...rows.map(r => r.count))
  const total = rows.reduce((a, r) => a + r.count, 0)
  return (
    <div className={'gradebars' + (compact ? ' compact' : '')}>
      {rows.map(r => {
        const top = r.top != null ? r.top === 1 : r.num >= 10
        return (
          <div className={'gb-row' + (top ? ' gem' : '')} key={r.label} title={`${grader} ${r.label}: ${r.count} of ${total}${top ? ' (gem tier)' : ''}${r.authentic ? ' (authentic, excluded from gem rate)' : ''}`}>
            <span className={'gb-label' + (top ? ' gemtier' : '')}>{r.label}</span>
            <span className="gb-track">
              <span className="gb-fill" style={{ width: `${(r.count / max) * 100}%`, background: graderColor(grader), opacity: top ? 1 : 0.5 }} />
            </span>
            <span className="gb-count">{n0(r.count)}</span>
          </div>
        )
      })}
    </div>
  )
}

/** Line chart of total graded per grader per snapshot date (plain SVG). */
export function HistoryChart({ history, graders }) {
  const dates = [...new Set(history.map(h => h.snapshot_date))].sort()
  const W = 640, H = 240, L = 44, R = 16, T = 14, B = 34
  const max = Math.max(1, ...history.map(h => h.total_graded))
  const niceMax = Math.ceil(max / 50) * 50 || 50
  const x = i => (dates.length === 1 ? (L + W - R) / 2 : L + (i * (W - L - R)) / (dates.length - 1))
  const y = v => T + (1 - v / niceMax) * (H - T - B)
  const ticks = [0, 0.25, 0.5, 0.75, 1].map(f => Math.round(niceMax * f))
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="linechart" role="img" aria-label="Total graded per grader by snapshot date">
      {ticks.map(t => (
        <g key={t}>
          <line x1={L} x2={W - R} y1={y(t)} y2={y(t)} className="grid" />
          <text x={L - 8} y={y(t) + 4} textAnchor="end" className="axis">{t}</text>
        </g>
      ))}
      {dates.map((d, i) => (
        <text key={d} x={x(i)} y={H - 10} textAnchor="middle" className="axis">{dateLabel(d)}</text>
      ))}
      {graders.map(g => {
        const pts = dates.map((d, i) => {
          const h = history.find(r => r.grader === g && r.snapshot_date === d)
          return h ? { i, v: h.total_graded, d } : null
        }).filter(Boolean)
        if (!pts.length) return null
        return (
          <g key={g} color={graderColor(g)}>
            {pts.length > 1 && <polyline fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinejoin="round" points={pts.map(p => `${x(p.i)},${y(p.v)}`).join(' ')} />}
            {pts.map(p => (
              <circle key={p.d} cx={x(p.i)} cy={y(p.v)} r="5" fill="currentColor" stroke="var(--surface)" strokeWidth="2">
                <title>{`${g}, ${dateLabel(p.d)}: ${p.v} graded`}</title>
              </circle>
            ))}
          </g>
        )
      })}
    </svg>
  )
}

export function Legend({ graders }) {
  return (
    <div className="legend">
      {graders.map(g => (
        <span key={g} className="legend-item"><i style={{ background: graderColor(g) }} />{g}</span>
      ))}
    </div>
  )
}
