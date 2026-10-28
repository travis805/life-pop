// Cloudflare Access JWT verification (RS256), ported from taclaco-graded-lister/src/access.ts and retrospecs-tracker/worker/access.js.
// Hand-rolled to keep Worker CPU low (Workers Free plan, 10 ms): the JWKS is fetched once per
// hour and each key imported once, and a token that already verified is remembered until it
// expires, so most requests do a Map lookup only.

const KEY_TTL_MS = 60 * 60 * 1000
const REFETCH_MIN_MS = 60 * 1000
const SKEW_S = 60
const TOKEN_CACHE_MAX = 100
const TOKEN_CACHE_MAX_AGE_S = 60 * 60

let keyCache = null
const tokenCache = new Map() // token -> expiry (epoch seconds), insertion order = age
let tokenCacheFor = ''

/** Test hook: clear all module-level caches. */
export function _resetAccessCaches() {
  keyCache = null
  tokenCache.clear()
  tokenCacheFor = ''
}

function b64urlToBytes(s) {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/')
  const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4))
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

const parseJson = s => JSON.parse(new TextDecoder().decode(b64urlToBytes(s)))

async function fetchJwks(issuer, fetchFn) {
  const res = await fetchFn(issuer + '/cdn-cgi/access/certs')
  if (!res.ok) throw new Error('jwks fetch ' + res.status)
  const body = await res.json()
  const jwks = new Map()
  for (const jwk of body.keys ?? []) if (jwk.kid && jwk.kty === 'RSA') jwks.set(jwk.kid, jwk)
  return jwks
}

/** Look up a key by kid. Refetches the JWKS when stale (1 h) or on an unknown kid (at most once a minute). */
async function getKey(issuer, kid, fetchFn, now) {
  if (!keyCache || keyCache.issuer !== issuer) {
    keyCache = { issuer, jwks: new Map(), keys: new Map(), fetchedAt: 0, inflight: null }
  }
  const kc = keyCache
  const stale = now - kc.fetchedAt > KEY_TTL_MS
  const recent = now - kc.fetchedAt < REFETCH_MIN_MS
  if (stale || (!kc.jwks.has(kid) && !recent)) {
    if (!kc.inflight) {
      kc.inflight = (async () => {
        try {
          kc.jwks = await fetchJwks(issuer, fetchFn)
          kc.keys = new Map()
        } catch (e) {
          console.warn('Access JWKS fetch failed: ' + (e instanceof Error ? e.message : String(e)))
        } finally {
          kc.fetchedAt = now // also rate-limits retries after a failure
          kc.inflight = null
        }
      })()
    }
    await kc.inflight
  }
  const cached = kc.keys.get(kid)
  if (cached) return cached
  const jwk = kc.jwks.get(kid)
  if (!jwk) return null
  try {
    // Imported lazily, only for the kid a token actually uses.
    const key = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify'])
    kc.keys.set(kid, key)
    return key
  } catch {
    return null
  }
}

/** Verify an Access JWT (RS256). Returns true only when signature and claims all check out. */
export async function verifyAccessJwt(token, team, aud, opts = {}) {
  const issuer = team.replace(/\/+$/, '')
  const nowMs = (opts.now ?? Date.now)()
  const nowS = Math.floor(nowMs / 1000)

  const sig = issuer + '\n' + aud
  if (tokenCacheFor !== sig) {
    tokenCache.clear()
    tokenCacheFor = sig
  }
  const cachedExp = tokenCache.get(token)
  if (cachedExp !== undefined) {
    if (cachedExp + SKEW_S > nowS) return true
    tokenCache.delete(token)
  }

  try {
    const parts = token.split('.')
    if (parts.length !== 3 || token.length > 8192) return false
    const [h, p, s] = parts
    const header = parseJson(h)
    if (header.alg !== 'RS256' || typeof header.kid !== 'string') return false
    const key = await getKey(issuer, header.kid, opts.fetch ?? fetch, nowMs)
    if (!key) return false
    const ok = await crypto.subtle.verify(
      'RSASSA-PKCS1-v1_5',
      key,
      b64urlToBytes(s),
      new TextEncoder().encode(h + '.' + p),
    )
    if (!ok) return false

    const claims = parseJson(p)
    if (claims.iss !== issuer) return false
    const auds = Array.isArray(claims.aud) ? claims.aud : [claims.aud]
    if (!auds.includes(aud)) return false
    if (typeof claims.exp !== 'number' || claims.exp + SKEW_S <= nowS) return false
    if (claims.nbf !== undefined && (typeof claims.nbf !== 'number' || claims.nbf - SKEW_S > nowS)) return false

    tokenCache.set(token, Math.min(claims.exp, nowS + TOKEN_CACHE_MAX_AGE_S))
    while (tokenCache.size > TOKEN_CACHE_MAX) tokenCache.delete(tokenCache.keys().next().value)
    return true
  } catch {
    return false
  }
}

/**
 * Optional gate. ACCESS_AUD unset: the API is public (true). ACCESS_AUD set: fail closed, true only
 * for a verified Cloudflare Access JWT (a missing ACCESS_TEAM_DOMAIN or token is false).
 */
export async function accessAllowed(request, env) {
  const aud = env.ACCESS_AUD
  if (!aud) return true
  const team = env.ACCESS_TEAM_DOMAIN
  if (!team) return false
  const token = request.headers.get('Cf-Access-Jwt-Assertion')
  if (!token) return false
  return verifyAccessJwt(token, team, aud)
}
