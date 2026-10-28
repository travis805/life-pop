// Cloudflare Worker entry. Static assets (dist/) are served by the ASSETS binding; only /api/*
// runs here (run_worker_first in wrangler.jsonc). Read-only JSON API over the D1 binding `DB`.
// Auth is optional Cloudflare Access: set ACCESS_AUD (and ACCESS_TEAM_DOMAIN) to require a valid
// Access JWT on every /api/* request (fail closed); leave it unset and the API is public.
import { accessAllowed } from './access.js'
import { summary, sets, cards, card, history } from './api.js'

const json = (status, obj, cache) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      ...(cache ? { 'cache-control': cache } : { 'cache-control': 'no-store' }),
    },
  })

export default {
  async fetch(request, env) {
    const url = new URL(request.url)
    if (url.pathname !== '/api' && !url.pathname.startsWith('/api/')) return env.ASSETS.fetch(request)

    try {
      // Fail closed before any routing, so unknown routes do not leak either.
      if (!(await accessAllowed(request, env))) return json(401, { error: 'Sign in required' })
      if (request.method !== 'GET' && request.method !== 'HEAD') return json(405, { error: 'Read-only API' })

      const path = url.pathname.replace(/^\/api\/?/, '').replace(/\/+$/, '')
      const q = url.searchParams
      let body
      if (path === 'summary') body = await summary(env.DB)
      else if (path === 'sets') body = await sets(env.DB)
      else if (path === 'cards') body = await cards(env.DB, { set: q.get('set'), grader: q.get('grader'), q: q.get('q') })
      else if (path === 'history') body = await history(env.DB)
      else if (/^card\/\d+$/.test(path)) {
        body = await card(env.DB, Number(path.split('/')[1]))
        if (!body) return json(404, { error: 'Card not found' })
      } else return json(404, { error: 'Not found' })

      // Data changes about monthly; keep it cheap. Gated deployments must not be shared-cached.
      return json(200, body, env.ACCESS_AUD ? 'private, max-age=60' : 'public, max-age=300')
    } catch (err) {
      console.error('Unhandled error in ' + url.pathname + ': ' + (err instanceof Error ? err.stack || err.message : String(err)))
      return json(500, { error: 'Internal error' })
    }
  },
}
