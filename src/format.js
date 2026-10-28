export const n0 = v => (v == null ? '' : Number(v).toLocaleString('en-US'))
export const pct = (v, digits = 1) => (v == null ? 'n/a' : (v * 100).toFixed(digits) + '%')
export const dateLabel = iso => {
  if (!iso) return ''
  const [y, m, d] = iso.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' })
}

// One consistent color per grader, defined as CSS variables (light and dark) in styles.css.
export const graderColor = code => `var(--g-${String(code).toLowerCase()}, var(--g-other))`
