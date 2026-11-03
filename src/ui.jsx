import React from 'react'

// Building blocks shared by the Population and Sales tabs.
export function Section({ title, hint, children, right, className }) {
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

export function Hero({ label, value, sub, extra }) {
  return (
    <div className="hero-stat">
      <div className="hero-label">{label}</div>
      <div className="hero-value">{value}</div>
      <div className="hero-sub">{sub}</div>
      {extra && <div className="hero-extra">{extra}</div>}
    </div>
  )
}

export const csvCell = v => {
  const s = v == null ? '' : String(v)
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s
}

/** Save rows (arrays of cells) as a CSV file. */
export function downloadCsv(filename, rows) {
  const blob = new Blob([rows.map(r => r.map(csvCell).join(',')).join('\r\n') + '\r\n'], { type: 'text/csv;charset=utf-8' })
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(a.href), 1000)
}
