// Places an eBay listing title on one graded LIFE TCG card. Pure functions (no I/O), shared by the weekly job
// (worker/sales_ebay.js) and scripts/check_sales_match.mjs. Mirrors the set / number / name / variant rules of
// scripts/build_db.py. Only confidence 'exact' goes live automatically; 'fuzzy' and 'none' go to review.
import { GRADE_LABELS, gradeNumeric } from './sales_common.js'

const MAMMALS = 'Mammals 1st Edition'
const KICKSTARTER = 'Mammals 1st Edition (Kickstarter)'
const SPECIAL = 'Mammals Special Edition'
const PHOTO = 'Mammals Photography'
const BIRDS = 'Birds 1st Edition'
const PROMOS = 'Promos'
// When a title does not say which set, a fuzzy guess prefers these in order.
const SET_PREF = [MAMMALS, BIRDS, PROMOS, SPECIAL, PHOTO, KICKSTARTER]

// Listings that are not one graded card. Returned with reject:true so the job drops them silently.
const REJECTS = [
  [/\blots?\b/, 'lot'], [/\bbundle\b/, 'bundle'], [/\bset of\b|\bcomplete set\b/, 'set'],
  [/\b[2-9]x\b|\bx[2-9]\b/, 'multiple'], [/\braw\b/, 'raw'], [/\bungraded\b|\bnot graded\b/, 'ungraded'],
  [/\bproxy\b|\bproxies\b/, 'proxy'], [/\bcustom\b/, 'custom'], [/\bsealed\b/, 'sealed'], [/\bbooster\b/, 'booster'],
  [/\bbox\b/, 'box'], [/\bpacks?\b/, 'pack'], [/\bpick\b|\bchoose\b/, 'you pick'],
]

// Hard prefilter: the title must name the game ("Elixir of Life", "Circle of Life", "Life Herb" are other games).
export const isLifeTitle = title => /life[\s-]*tcg|lifetcg|life trading card game/i.test(String(title || ''))

const GRADER_RE = [['PSA', /\bpsa\b/], ['CGC', /\bcgc\b/], ['TAG', /\btag\b/], ['BGS', /\b(?:bgs|beckett)\b/], ['ACE', /\bace\b/], ['AGS', /\bags\b/], ['SGC', /\bsgc\b/]]
const GRADER_ALT = '(?:psa|cgc|tag|bgs|beckett|ace|ags|sgc)'
// "PSA 10", "CGC Pristine 10", "BGS Black Label 10", "PSA Gem Mint 10": grade number right after the grader name.
const AFTER_GRADER = new RegExp(`\\b${GRADER_ALT}\\b[\\s:#-]*(?:(?:gem|mint|mt|nm|pristine|perfect|black|label|grade|graded)[\\s-]*)*(\\d{1,2}(?:\\.\\d)?)(\\+)?(?![\\d/])`)
// Fallback when the number sits before the grader or after a descriptor: "Gem Mint 10 CGC".
const DESCRIBED = /\b(?:gem[\s-]*(?:mint|mt)|pristine|perfect|mint)\s*(\d{1,2}(?:\.\d)?)(\+)?(?![\d/])/

const norm = s => String(s).toLowerCase().replace(/[^a-z0-9]/g, '')
// ACE spells it "Racoon"; compare on the correct spelling.
const canon = s => norm(s).replace(/racoon/g, 'raccoon')

const none = (reason, extra = {}) => ({ card: null, grader: null, grade_label: null, grade_numeric: null, confidence: 'none', reason, ...extra })

function findGrader(t) {
  const found = GRADER_RE.filter(([, re]) => re.test(t)).map(([g]) => g)
  return found
}

function findGrade(grader, t) {
  const m = AFTER_GRADER.exec(t) || DESCRIBED.exec(t)
  const pristine = /\bpristine\b/.test(t), perfect = /\bperfect\b/.test(t), black = /black\s*label/.test(t)
  const authentic = /\bauthentic\b|\bau\b/.test(t)
  let label = null
  if (grader === 'CGC' && authentic && !m) label = 'AU'
  else if (m) {
    const n = m[1] + (m[2] || '')
    if (grader === 'CGC' && n === '10') label = perfect ? 'Perfect 10' : pristine ? 'Pristine 10' : 'Gem Mint 10'
    else if (grader === 'AGS' && n === '10') label = 'Gem-MT 10'
    else if (grader === 'BGS' && n === '10' && black) label = 'Black Label 10'
    else if (grader === 'TAG' && n === '10' && pristine) label = '10P'
    else label = n
  } else if (grader === 'BGS' && black) label = 'Black Label 10'
  if (!label || !GRADE_LABELS[grader].includes(label)) return null
  return label
}

function findSets(t) {
  if (/\bkickstarter\b|\bks\b/.test(t)) return [KICKSTARTER]
  if (/special edition|\bmse\b|\bse\b/.test(t)) return [SPECIAL]
  if (/photograph|\bphoto\b/.test(t)) return [PHOTO]
  if (/\bbirds?\b/.test(t)) return [BIRDS]
  if (/\bpromos?\b/.test(t)) return [PROMOS]
  if (/\b2022\b/.test(t)) return [KICKSTARTER] // only the Kickstarter run is dated 2022
  if (/\bmammals?\b/.test(t)) return [MAMMALS, PROMOS] // PROMOS only for numbers above 100 (see below)
  return null
}

function findNumber(t) {
  const m = /(?:#\s*|\bno\.?\s*)(\d{1,3})\b/.exec(t) || /\b(\d{1,3})\s*\/\s*\d{2,3}\b/.exec(t)
  return m ? String(parseInt(m[1], 10)) : null
}

// Stated variant, most specific first. Returns the canonical variant name(s) it can mean.
function findVariant(t, setNames) {
  if (/full[\s-]*art/.test(t)) return ['Full Art']
  if (/extended[\s-]*art/.test(t)) return ['Extended Art', 'Extended']
  if (/\bextended\b/.test(t)) return ['Extended Art', 'Extended']
  if (/box topper/.test(t)) return ['Box Topper']
  if (/photography/.test(t) && !(setNames && setNames[0] === PHOTO)) return ['Photography'] // in the Photography set the word names the set
  if (/\buncommon\b/.test(t)) return ['Uncommon']
  if (/\bcommon\b/.test(t)) return ['Common']
  if (/\bholo(?:graphic|foil)?\b/.test(t)) return ['Holo']
  if (/\bbase\b/.test(t)) return ['Base']
  return null
}

const variantRank = v => (v === 'Holo' ? 0 : v === 'Base' ? 1 : 2) // the pick build_db makes when a variant is unstated

/** cards: [{id, set_name, number, name, variant}]. Returns {card, grader, grade_label, grade_numeric, confidence, reason, reject?}. */
export function matchTitle(title, cards) {
  const raw = String(title || '')
  const t = raw.toLowerCase().replace(/[’`]/g, "'").replace(/\s+/g, ' ')
  // "Box Topper" and "Booster Box Exclusive" are card variants, not sealed product.
  const rejectText = t.replace(/box topper|booster box exclusive/g, ' ')
  if (!isLifeTitle(raw)) return none('not a LIFE TCG listing', { reject: true, notLife: true })
  for (const [re, why] of REJECTS) if (re.test(rejectText)) return none(`not a single graded card (${why})`, { reject: true })

  const graders = findGrader(t)
  if (!graders.length) return none('no grader in title', { reject: true, noGrader: true })
  if (graders.length > 1) return none(`several graders in title (${graders.join(', ')})`)
  const grader = graders[0]
  const grade_label = findGrade(grader, t)
  if (!grade_label) return none(`${grader} grade not recognized`, { grader })
  const base = { grader, grade_label, grade_numeric: gradeNumeric(grade_label) }

  // Set candidates.
  const number = findNumber(t)
  let setNames = findSets(t)
  if (setNames && setNames.length === 2) setNames = number && Number(number) > 100 ? [PROMOS] : [MAMMALS] // Mammals numbers above 100 are Promos
  const inSets = setNames ? cards.filter(c => setNames.includes(c.set_name)) : cards

  // Name: longest normalized card name contained in the normalized title.
  const nt = canon(t)
  const hits = inSets.filter(c => canon(c.name).length >= 3 && nt.includes(canon(c.name)))
  const longest = hits.reduce((m, c) => Math.max(m, canon(c.name).length), 0)
  const named = hits.filter(c => canon(c.name).length === longest)
  const byNumber = number ? inSets.filter(c => c.number === number) : []

  let pool = named.filter(c => !number || c.number === number)
  let capped = false // true when the evidence is weaker than set + number + name
  if (!pool.length && named.length) { pool = named; capped = Boolean(number) } // number disagrees with the name
  if (!pool.length && byNumber.length) {
    if (new Set(byNumber.map(c => canon(c.name))).size !== 1) return none('number matches several cards, no name found', base)
    pool = byNumber; capped = true // number only, no name
  }
  if (!pool.length) return none('no card name found', base)

  // The ACE duplicate (Racoon) and the correct spelling are one card: keep the correctly spelled one.
  const seen = new Map()
  for (const c of pool) {
    const k = `${c.set_name}|${c.number}|${canon(c.name)}|${c.variant}`
    if (!seen.has(k) || norm(c.name) === canon(c.name)) seen.set(k, c)
  }
  pool = [...seen.values()]

  const stated = findVariant(t, setNames)
  let exact = false
  if (stated) {
    const byVariant = pool.filter(c => stated.includes(c.variant))
    if (byVariant.length) {
      // Several sets can still be left (set not in title): that is a guess.
      exact = new Set(byVariant.map(c => c.set_name)).size === 1 && byVariant.length === 1
      pool = byVariant
    }
  } else exact = pool.length === 1
  if (capped) exact = false

  const pick = [...pool].sort((a, b) => SET_PREF.indexOf(a.set_name) - SET_PREF.indexOf(b.set_name) || variantRank(a.variant) - variantRank(b.variant))[0]
  if (exact) return { ...base, card: pick, confidence: 'exact', reason: 'set, number, name and variant agree' }
  const why = capped ? 'name and number disagree or only one was found'
    : pool.length > 1 ? `${pool.length} candidate cards (variant or set not stated)` : 'stated variant does not match the card'
  return { ...base, card: pick, confidence: 'fuzzy', reason: why }
}
