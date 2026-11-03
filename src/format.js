export const n0 = v => (v == null ? '' : Number(v).toLocaleString('en-US'))
export const pct = (v, digits = 1) => (v == null ? 'n/a' : (v * 100).toFixed(digits) + '%')
export const dateLabel = iso => {
  if (!iso) return ''
  const [y, m, d] = iso.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' })
}

// One consistent color per grader, defined as CSS variables (light and dark) in styles.css.
export const graderColor = code => `var(--g-${String(code).toLowerCase()}, var(--g-other))`

// Prices arrive as integer cents.
export const usd = c => (c == null ? '' : '$' + (c / 100).toLocaleString('en-US', { minimumFractionDigits: c % 100 ? 2 : 0, maximumFractionDigits: 2 }))
export const SALE_TYPE = {
  auction: 'Auction', buy_it_now: 'Buy it now', best_offer: 'Best offer', private: 'Private sale',
  show: 'Card show', ebay: 'eBay', other_marketplace: 'Other marketplace',
}
