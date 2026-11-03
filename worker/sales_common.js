// Shared by the Worker, the title matcher, the moderation CLI and the SPA: grader grade labels,
// numeric grades and the stable card key that sales are stored under.

export const GRADERS = ['PSA', 'CGC', 'TAG', 'BGS', 'ACE', 'AGS', 'SGC']

// Each grader's own labels (the same strings pop.grade_label uses), best grade first. The top tiers
// that are not in any pop report yet (CGC Perfect 10, BGS 10 and Black Label 10) are included so sales can be recorded.
export const GRADE_LABELS = {
  PSA: ['10', '9', '8', '7', '6', '5', '4', '3', '2', '1'],
  CGC: ['Perfect 10', 'Pristine 10', 'Gem Mint 10', '9.5', '9', '8.5', '8', '7.5', '7', '6', '5', 'AU'],
  TAG: ['10P', '10', '9', '8.5', '8', '7', '6', '5'],
  BGS: ['Black Label 10', '10', '9.5', '9', '8.5', '8', '7.5', '7'],
  ACE: ['10', '9', '8', '7', '6', '5'],
  AGS: ['Gem-MT 10', '9+', '9', '8+', '8', '7+', '7', '6', '5'],
  SGC: ['10', '9.5', '9', '8.5', '8', '7', '6', '5'],
}

// Same rules as grade_numeric() in scripts/build_db.py.
export function gradeNumeric(label) {
  const l = String(label).toLowerCase()
  if (l.includes('perfect')) return 10.75
  if (['pristine', 'legend', '10p', 'black label'].some(k => l.includes(k))) return 10.5
  const m = /(\d+(?:\.\d+)?)/.exec(l)
  if (!m) return 0
  return parseFloat(m[1]) + (l.endsWith('+') ? 0.5 : 0) // AU etc. have no number: 0
}

// Same rule as is_gem() in scripts/build_db.py: 10 and above, except BGS where 9.5 counts.
export const isGem = (grader, numeric) => numeric >= (grader === 'BGS' ? 9.5 : 10)

export const SALE_SOURCES = ['ebay', 'taclaco', 'collector']
// Sale types a collector can pick on the form.
export const SUBMIT_TYPES = ['ebay', 'private', 'show', 'other_marketplace']

/** "<set name>|<number>|<name>|<variant>", e.g. "Mammals 1st Edition|25|Snow Leopard|Holo". */
export const cardKey = c => `${c.set_name}|${c.number}|${c.name}|${c.variant}`
