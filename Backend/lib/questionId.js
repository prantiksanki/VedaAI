const ROMAN = { i: 1, ii: 2, iii: 3, iv: 4, v: 5, vi: 6, vii: 7, viii: 8, ix: 9, x: 10, xi: 11, xii: 12 }

/**
 * Turns a printed question label into a stable, canonical id.
 *   "Q11"      -> "q-11"
 *   "QQ11"     -> "q-11"
 *   "11 (a)"   -> "q-11a"
 *   "Q5b"      -> "q-5b"
 *   "3(ii)"    -> "q-3-ii"
 *   "Section B Q2" -> "q-2"
 * Falls back to a slug of the whole label when there is no number.
 */
export function labelToId(displayNumber) {
  const raw = String(displayNumber ?? '').trim().toLowerCase()
  if (!raw) return null

  // number + optional sub-part (letter, or roman numeral in parens/after a dot)
  const m = raw.match(/(\d+)\s*[.\-\s]*\(?\s*([a-z]{1,4}|\d{1,2})?\s*\)?/)
  if (m && m[1]) {
    const num = m[1]
    let sub = m[2] || ''
    if (sub && ROMAN[sub] != null) return `q-${num}-${sub}` // roman -> hyphenated
    if (sub && /^\d+$/.test(sub)) return `q-${num}-${sub}` // numeric sub-part
    if (sub && sub.length <= 2) return `q-${num}${sub}` // letter -> appended
    return `q-${num}`
  }

  const slug = raw.replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '')
  return slug ? `q-${slug}` : null
}

/**
 * Assigns each question a unique id from its label, disambiguating collisions
 * with a -2, -3 … suffix. Mutates nothing; returns a new array.
 */
export function assignIds(questions) {
  const seen = new Map()
  return questions.map((q, i) => {
    let id = labelToId(q.displayNumber) || `q-${i + 1}`
    if (seen.has(id)) {
      const n = seen.get(id) + 1
      seen.set(id, n)
      id = `${id}-${n}`
    } else {
      seen.set(id, 1)
    }
    return { ...q, id }
  })
}
