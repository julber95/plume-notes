import { describe, expect, it } from 'vitest'
import { Auth, type AuthDeps } from '../src/sync/auth'
import { AuthRequiredError, GraphError } from '../src/sync/graph'

function memoryStorage(): Storage {
  const m = new Map<string, string>()
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k) } as Storage
}

function setup(over: Partial<AuthDeps> = {}) {
  const visited: string[] = []
  const requests: URLSearchParams[] = []
  let reply: () => Response = () => Response.json({ access_token: 'A1', refresh_token: 'R1', expires_in: 3600 })
  const deps: AuthDeps = {
    storage: memoryStorage(),
    session: memoryStorage(),
    clientId: 'client-123',
    redirectUri: 'https://example.github.io/plume/',
    navigate: (u) => void visited.push(u),
    fetchFn: async (_url, init) => {
      requests.push(new URLSearchParams(String(init?.body)))
      return reply()
    },
    ...over,
  }
  return { deps, visited, requests, setReply: (r: () => Response) => (reply = r), auth: new Auth(deps) }
}

async function sha256url(s: string): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)))
  return btoa(String.fromCharCode(...d)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

describe('Microsoft sign-in', () => {
  it('without a client ID, OneDrive is simply disabled', () => {
    expect(setup({ clientId: '' }).auth.state).toBe('disabled')
  })

  it('follows the authorization code + PKCE flow end to end', async () => {
    const t = setup()
    expect(t.auth.state).toBe('signedOut')
    await t.auth.login()
    const url = new URL(t.visited[0])
    expect(url.origin + url.pathname).toBe('https://login.microsoftonline.com/consumers/oauth2/v2.0/authorize')
    const q = url.searchParams
    expect([q.get('client_id'), q.get('response_type'), q.get('redirect_uri'), q.get('scope'), q.get('code_challenge_method')]).toEqual([
      'client-123',
      'code',
      'https://example.github.io/plume/',
      'Files.ReadWrite offline_access',
      'S256',
    ])
    const res = await t.auth.handleRedirect(new URLSearchParams({ code: 'CODE', state: q.get('state')! }))
    expect(res).toEqual({ handled: true })
    const sent = t.requests[0]
    expect([sent.get('grant_type'), sent.get('code'), sent.get('client_id'), sent.get('redirect_uri')]).toEqual(['authorization_code', 'CODE', 'client-123', 'https://example.github.io/plume/'])
    // The challenge sent at sign-in matches the verifier presented afterwards.
    expect(await sha256url(sent.get('code_verifier')!)).toBe(q.get('code_challenge'))
    expect(t.auth.state).toBe('ready')
    expect(await t.auth.getToken()).toBe('A1')
    // On restart, the session is found again.
    expect(new Auth(t.deps).state).toBe('ready')
  })

  it('rejects a response whose state does not match', async () => {
    const t = setup()
    await t.auth.login()
    const res = await t.auth.handleRedirect(new URLSearchParams({ code: 'CODE', state: 'other' }))
    expect(res.error).toBeTruthy()
    expect(t.auth.state).toBe('signedOut')
    expect(t.requests.length).toBe(0)
  })

  it('ignores a ?code= parameter that does not come from a sign-in in progress', async () => {
    const t = setup()
    expect(await t.auth.handleRedirect(new URLSearchParams({ code: 'X', state: 'Y' }))).toEqual({ handled: false })
  })

  it('renews the expired token, only once even if several calls arrive together', async () => {
    const t = setup()
    t.deps.storage.setItem('plume.auth', JSON.stringify({ access: 'OLD', expires: Date.now() - 1000, refresh: 'R0' }))
    const auth = new Auth(t.deps)
    t.setReply(() => Response.json({ access_token: 'A2', refresh_token: 'R2', expires_in: 3600 }))
    expect(await Promise.all([auth.getToken(), auth.getToken()])).toEqual(['A2', 'A2'])
    expect(t.requests.length).toBe(1)
    expect([t.requests[0].get('grant_type'), t.requests[0].get('refresh_token')]).toEqual(['refresh_token', 'R0'])
    expect(JSON.parse(t.deps.storage.getItem('plume.auth')!).refresh).toBe('R2')
  })

  it('expired session: asks to sign in again, without breaking anything offline', async () => {
    const t = setup()
    t.deps.storage.setItem('plume.auth', JSON.stringify({ access: 'OLD', expires: 0, refresh: 'R0' }))
    let auth = new Auth(t.deps)
    // Offline: the session is kept.
    auth = new Auth({ ...t.deps, fetchFn: async () => Promise.reject(new TypeError('Failed to fetch')) })
    await expect(auth.getToken()).rejects.toBeInstanceOf(GraphError)
    expect(auth.state).toBe('ready')
    // Refused by Microsoft: the user must sign in again.
    auth = new Auth(t.deps)
    t.setReply(() => Response.json({ error: 'invalid_grant', error_description: 'expired' }, { status: 400 }))
    await expect(auth.getToken()).rejects.toBeInstanceOf(AuthRequiredError)
    expect(auth.state).toBe('signedOut')
  })

  it('tries a silent sign-in only once', async () => {
    const t = setup()
    await t.auth.login()
    await t.auth.handleRedirect(new URLSearchParams({ code: 'C', state: new URL(t.visited[0]).searchParams.get('state')! }))
    t.deps.storage.removeItem('plume.auth')
    const auth = new Auth(t.deps)
    expect(auth.canTrySilentLogin()).toBe(true)
    await auth.silentLogin()
    const url = new URL(t.visited[1])
    expect(url.searchParams.get('prompt')).toBe('none')
    const res = await auth.handleRedirect(new URLSearchParams({ error: 'login_required', state: url.searchParams.get('state')! }))
    expect(res).toEqual({ handled: true })
    expect(auth.canTrySilentLogin()).toBe(false)
  })
})
