import React from 'react'
import { graderColor, n0, dateLabel } from './format.js'

/** Horizontal stacked bars: one row per set, segments per grader. */
export function SetBars({ sets, graders }) {
  const max = Math.max(1, ...sets.map(s => s.total))
  return (
    <div className="setbars" role="list">
      {sets.map(s => (
        <div className="setbar-row" role="listitem" key={s.id}>
          <div className="setbar-label">
            <span className="setbar-name">{s.name}</span>
            <span className="setbar-total">{n0(s.total)}</span>
          </div>
          <div className="setbar-track" aria-label={`${s.name}: ${s.total} graded`}>
            {s.total === 0 ? null : (
              <div className="setbar-fill" style={{ width: `${(s.total / max) * 100}%` }}>
                {graders.map(g => {
                  const t = s.graders[g]?.total || 0
                  return t ? (
                    <div key={g} className="seg" style={{ flexGrow: t, background: graderColor(g) }} title={`${g}: ${t}`} />
                  ) : null
                })}
              </div>
            )}
          </div>
        </div>
      ))}
    </div>
  )
}

/** Count per grade for one grader. Gem tier (10 and above) is drawn solid, the rest lighter. */
export function GradeBars({ grader, rows, compact }) {
  const max = Math.max(1, ...rows.map(r => r.count))
  const total = rows.reduce((a, r) => a + r.count, 0)
  return (
    <div className={'gradebars' + (compact ? ' compact' : '')}>
      {rows.map(r => {
        const top = r.num >= 10
        return (
          <div className="gb-row" key={r.label} title={`${grader} ${r.label}: ${r.count} of ${total}`}>
            <span className={'gb-label' + (top ? ' top' : '')}>{r.label}</span>
            <span className="gb-track">
              <span className="gb-fill" style={{ width: `${(r.count / max) * 100}%`, background: graderColor(grader), opacity: top ? 1 : 0.55 }} />
            </span>
            <span className="gb-count">{n0(r.count)}</span>
          </div>
        )
      })}
    </div>
  )
}

/** Line chart of total graded per grader per snapshot date (plain SVG). One date renders as dots. */
export function HistoryChart({ history, graders }) {
  const dates = [...new Set(history.map(h => h.snapshot_date))].sort()
  const W = 640, H = 240, L = 44, R = 16, T = 14, B = 34
  const max = Math.max(1, ...history.map(h => h.total_graded))
  const niceMax = Math.ceil(max / 50) * 50 || 50
  const x = i => (dates.length === 1 ? (L + W - R) / 2 : L + (i * (W - L - R)) / (dates.length - 1))
  const y = v => T + (1 - v / niceMax) * (H - T - B)
  const ticks = [0, 0.25, 0.5, 0.75, 1].map(f => Math.round(niceMax * f))
  return (
    <div>
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
      {dates.length < 2 && <p className="note">One snapshot so far. The lines fill in after each monthly refresh.</p>}
    </div>
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
