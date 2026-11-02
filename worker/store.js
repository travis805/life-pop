// Live Taclaco store inventory matched to graded-pop cards. Pure functions (parseSku, matchCard,
// buildListings) are shared with scripts/check_store_match.mjs; only `storeListings` touches the network.

const STORE = 'https://taclaco.com'
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'

const MAMMALS = 'Mammals 1st Edition'
const SPECIAL = 'Mammals Special Edition'
const BIRDS = 'Birds 1st Edition'
const PHOTO = 'Mammals Photography'
const PROMOS = 'Promos'
const MAMMALS_DATES = ['250302', '260203'] // date prefixes that allow a bare number (choose-your-card, topper)
const SKIP = /LOT|NHSET|ACRYLIC/ // lots, sets, accessories
const LETTER_VARIANT = { H: 'holo', F: 'full art', R: 'base', E: 'extended', P: 'photo' }

/**
 * "250302-M25H-H5335779" -> { set, number, letter, cert }. Returns null for anything that is not a single card.
 * Shape: <date>[-MSE|-BIRD]-<[M|B]number[letter]>[-<cert>]. A trailing segment after the card code is a slab cert.
 */
export function parseSku(raw) {
  const sku = String(raw || '').trim().toUpperCase()
  if (!sku || SKIP.test(sku)) return null
  const seg = sku.split('-')
  if (!/^\d{6}$/.test(seg[0])) return null
  const rest = seg.slice(1)
  const tag = rest[0] === 'MSE' || rest[0] === 'BIRD' ? rest.shift() : null
  const m = /^([MB]?)(\d{1,3})([A-Z]?)$/.exec(rest[0] || '')
  if (!m) return null
  const [, pre, num, letter] = m
  let set
  if (tag === 'MSE') set = SPECIAL
  else if (tag === 'BIRD' || pre === 'B') set = BIRDS
  else if (letter === 'P' && !pre) set = PHOTO
  else if (pre === 'M' || MAMMALS_DATES.includes(seg[0])) set = MAMMALS
  else return null
  return { set, number: String(Number(num)), letter, cert: rest.slice(1).join('-') || null }
}

/** Pick the one card for a parsed SKU, or null when none or ambiguous. `cards`: [{id, set_name, number, name, variant}]. */
export function matchCard(parsed, cards, hint = '') {
  const inSet = (set) => cards.filter(c => c.set_name === set && c.number === parsed.number)
  let found = inSet(parsed.set)
  // Mammals numbers above 100 are filed under Promos (box toppers, Giant Panda, Albino Giant Panda...).
  if (!found.length && parsed.set === MAMMALS && Number(parsed.number) > 100) found = inSet(PROMOS)
  // A lone card is taken as is, unless the SKU letter names a different print (the store sells the Full Art, we only know the Holo).
  const fits = c => ['R', ''].includes(parsed.letter) || !LETTER_VARIANT[parsed.letter] || c.variant.toLowerCase().startsWith(LETTER_VARIANT[parsed.letter])
  if (found.length <= 1) return found[0] && fits(found[0]) ? found[0] : null
  const text = hint.toLowerCase()
  const byHint = text ? found.filter(c => c.variant !== 'Base' && text.includes(c.variant.toLowerCase())) : []
  if (byHint.length === 1) return byHint[0]
  const want = LETTER_VARIANT[parsed.letter]
  if (!want) return null
  const exact = found.filter(c => c.variant.toLowerCase() === want)
  const pick = exact.length ? exact : found.filter(c => c.variant.toLowerCase().startsWith(want))
  return pick.length === 1 ? pick[0] : null
}

const isGraded = (parsed, p) =>
  Boolean(parsed.cert) || /graded/i.test(p.product_type || '') || (p.tags || []).some(t => /graded$/i.test(t) && !/^(un|non|not)[ -]?graded$/i.test(t))

/** All available LIFE single variants with their match: [{sku, product, variant, parsed, graded, card}]. */
export function matchProducts(products, cards) {
  const out = []
  for (const p of products) {
    for (const v of p.variants || []) {
      if (v.available !== true) continue
      const parsed = parseSku(v.sku)
      if (!parsed) continue
      const hint = p.variants.length === 1 ? p.title : ''
      out.push({ sku: v.sku, product: p, variant: v, parsed, graded: isGraded(parsed, p), card: matchCard(parsed, cards, hint) })
    }
  }
  return out
}

/** { [card_id]: { url, kind: 'graded', title, price } }. Graded slabs only (raw singles are skipped); lowest price wins. */
export function buildListings(products, cards) {
  const listings = {}
  for (const { product: p, variant: v, graded, card } of matchProducts(products, cards)) {
    if (!card || !graded) continue
    const next = {
      url: `${STORE}/products/${p.handle}` + (p.variants.length > 1 ? `?variant=${v.id}` : ''),
      kind: 'graded',
      title: p.variants.length > 1 ? v.title : p.title,
      price: v.price,
    }
    const cur = listings[card.id]
    if (!cur || Number(next.price) < Number(cur.price)) listings[card.id] = next
  }
  return listings
}

/** Every product on the storefront (paged, capped at 5 pages of 250). */
export async function fetchProducts(fetchFn = fetch) {
  const products = []
  for (let page = 1; page <= 5; page++) {
    const res = await fetchFn(`${STORE}/products.json?limit=250&page=${page}`, {
      headers: { 'user-agent': UA, accept: 'application/json' },
      signal: AbortSignal.timeout(8000),
    })
    if (!res.ok) throw new Error(`products.json page ${page} returned ${res.status}`)
    const batch = (await res.json()).products || []
    if (!batch.length) break
    products.push(...batch)
  }
  return products
}

/** Cards the store can be matched against (Kickstarter copies are never mapped). */
export async function loadCards(db) {
  return (await db.prepare(`
    SELECT c.id, s.name AS set_name, c.number, c.name, c.variant
    FROM cards c JOIN sets s ON s.id = c.set_id
    WHERE s.name NOT LIKE '%Kickstarter%'`).all()).results
}

export async function storeListings(db) {
  const [products, cards] = await Promise.all([fetchProducts(), loadCards(db)])
  return { listings: buildListings(products, cards), fetched_at: new Date().toISOString() }
}
