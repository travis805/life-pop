async function get(path) {
  const res = await fetch(path, { headers: { accept: 'application/json' } })
  if (!res.ok) throw new Error(`${path} returned ${res.status}`)
  return res.json()
}

export const api = {
  summary: () => get('/api/summary'),
  sets: () => get('/api/sets'),
  history: () => get('/api/history'),
  cards: ({ set, grader, q }) => {
    const p = new URLSearchParams()
    if (set) p.set('set', set)
    if (grader) p.set('grader', grader)
    if (q) p.set('q', q)
    return get('/api/cards' + (p.toString() ? '?' + p : ''))
  },
  card: id => get(`/api/card/${id}`),
}
