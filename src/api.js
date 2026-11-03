async function get(path) {
  const res = await fetch(path, { headers: { accept: 'application/json' } })
  if (!res.ok) throw new Error(`${path} returned ${res.status}`)
  return res.json()
}

async function post(path, body) {
  const res = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.error || `${path} returned ${res.status}`)
  return data
}

export const api = {
  sales: (limit = 1000) => get(`/api/sales?limit=${limit}`),
  salesConfig: () => get('/api/sales/config'),
  submitSale: body => post('/api/sales/submit', body),
  summary: () => get('/api/summary'),
  sets: () => get('/api/sets'),
  history: () => get('/api/history'),
  store: () => get('/api/store'),
  changes: () => get('/api/changes'),
  cards: ({ set, grader, q }) => {
    const p = new URLSearchParams()
    if (set) p.set('set', set)
    if (grader) p.set('grader', grader)
    if (q) p.set('q', q)
    return get('/api/cards' + (p.toString() ? '?' + p : ''))
  },
  card: id => get(`/api/card/${id}`),
}
