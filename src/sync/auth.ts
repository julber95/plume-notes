// Microsoft account sign-in: OAuth 2.0 "authorization code + PKCE" flow, the
// standard flow for a web application without a server. No secret is stored
// in the application; tokens stay on the device.

import { MS_AUTHORITY, MS_CLIENT_ID, MS_SCOPES } from '../config'
import { AuthRequiredError, GraphError } from './graph'

interface Tokens {
  access: string
  /** Expiry time of the access token (ms). */
  expires: number
  refresh?: string
}

const STORE_KEY = 'plume.auth'
const FLOW_KEY = 'plume.auth.flow'
const SILENT_KEY = 'plume.auth.silentTried'

function b64url(bytes: Uint8Array): string {
  let s = ''
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function randomString(n = 48): string {
  return b64url(crypto.getRandomValues(new Uint8Array(n)))
}

export interface AuthDeps {
  storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>
  session: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>
  fetchFn: typeof fetch
  /** Redirect address registered with Microsoft (the application's address). */
  redirectUri: string
  navigate(url: string): void
  clientId: string
}

export class Auth {
  private tokens: Tokens | null = null
  private refreshing: Promise<string> | null = null
  onChange: () => void = () => {}

  constructor(private deps: AuthDeps) {
    try {
      this.tokens = JSON.parse(deps.storage.getItem(STORE_KEY) ?? 'null') as Tokens | null
    } catch {
      this.tokens = null
    }
  }

  get configured(): boolean {
    return !!this.deps.clientId
  }

  get state(): 'disabled' | 'signedOut' | 'ready' {
    if (!this.configured) return 'disabled'
    return this.tokens ? 'ready' : 'signedOut'
  }

  private save(t: Tokens | null): void {
    const was = this.state
    this.tokens = t
    if (t) this.deps.storage.setItem(STORE_KEY, JSON.stringify(t))
    else this.deps.storage.removeItem(STORE_KEY)
    if (was !== this.state) this.onChange()
  }

  /**
   * Redirects to the Microsoft sign-in page. With `silent`, Microsoft shows
   * nothing if the session is still open and comes straight back.
   */
  async login(silent = false): Promise<void> {
    const verifier = randomString(64)
    const state = randomString(16)
    const challenge = b64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))))
    this.deps.session.setItem(FLOW_KEY, JSON.stringify({ verifier, state }))
    const q = new URLSearchParams({
      client_id: this.deps.clientId,
      response_type: 'code',
      redirect_uri: this.deps.redirectUri,
      response_mode: 'query',
      scope: MS_SCOPES,
      state,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      prompt: silent ? 'none' : 'select_account',
    })
    this.deps.navigate(`${MS_AUTHORITY}/authorize?${q}`)
  }

  /**
   * To be called at startup with the address parameters: completes a sign-in
   * in progress. Returns an error message to display, if any.
   */
  async handleRedirect(params: URLSearchParams): Promise<{ handled: boolean; error?: string }> {
    const raw = this.deps.session.getItem(FLOW_KEY)
    if (!raw || (!params.has('code') && !params.has('error'))) return { handled: false }
    this.deps.session.removeItem(FLOW_KEY)
    const flow = JSON.parse(raw) as { verifier: string; state: string }
    if (params.get('state') !== flow.state) return { handled: true, error: 'Unexpected sign-in response. Please try again.' }
    const err = params.get('error')
    if (err) {
      // Silent sign-in impossible: the user will have to sign in themselves.
      if (['login_required', 'interaction_required', 'consent_required', 'account_selection_required'].includes(err)) return { handled: true }
      if (err === 'access_denied') return { handled: true, error: 'OneDrive sign-in cancelled.' }
      return { handled: true, error: `Sign-in refused by Microsoft: ${params.get('error_description') ?? err}` }
    }
    try {
      await this.tokenRequest({
        grant_type: 'authorization_code',
        code: params.get('code')!,
        redirect_uri: this.deps.redirectUri,
        code_verifier: flow.verifier,
      })
      this.deps.session.removeItem(SILENT_KEY)
      return { handled: true }
    } catch (e) {
      return { handled: true, error: `Could not sign in to OneDrive: ${e instanceof Error ? e.message : e}` }
    }
  }

  /**
   * Session expired (Microsoft limits a web application's session to 24 h):
   * tries once to sign in again without any interaction.
   */
  canTrySilentLogin(): boolean {
    if (this.state !== 'signedOut' || this.deps.session.getItem(SILENT_KEY)) return false
    return this.deps.storage.getItem(`${STORE_KEY}.known`) === '1'
  }

  async silentLogin(): Promise<void> {
    this.deps.session.setItem(SILENT_KEY, '1')
    await this.login(true)
  }

  logout(): void {
    this.deps.storage.removeItem(`${STORE_KEY}.known`)
    this.save(null)
  }

  private async tokenRequest(fields: Record<string, string>): Promise<string> {
    let res: Response
    try {
      res = await this.deps.fetchFn(`${MS_AUTHORITY}/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ client_id: this.deps.clientId, scope: MS_SCOPES, ...fields }).toString(),
      })
    } catch (e) {
      throw new GraphError(0, 'network', e instanceof Error ? e.message : 'Network unavailable')
    }
    const body = (await res.json().catch(() => ({}))) as {
      access_token?: string
      refresh_token?: string
      expires_in?: number
      error?: string
      error_description?: string
    }
    if (!res.ok || !body.access_token) {
      if (res.status >= 500) throw new GraphError(res.status, 'server', 'Microsoft service unavailable')
      throw new AuthRequiredError(body.error_description?.split('\n')[0] ?? body.error ?? `Error ${res.status}`)
    }
    this.deps.storage.setItem(`${STORE_KEY}.known`, '1')
    this.save({
      access: body.access_token,
      expires: Date.now() + (body.expires_in ?? 3600) * 1000,
      refresh: body.refresh_token ?? fields.refresh_token,
    })
    return body.access_token
  }

  /** Valid access token, renewed if necessary. */
  async getToken(): Promise<string> {
    const t = this.tokens
    if (!t) throw new AuthRequiredError('OneDrive sign-in required')
    if (t.expires - Date.now() > 120_000) return t.access
    if (!t.refresh) {
      this.save(null)
      throw new AuthRequiredError('OneDrive session expired')
    }
    this.refreshing ??= this.tokenRequest({ grant_type: 'refresh_token', refresh_token: t.refresh })
      .catch((e) => {
        if (e instanceof AuthRequiredError) this.save(null)
        throw e
      })
      .finally(() => {
        this.refreshing = null
      })
    return this.refreshing
  }
}

export function createAuth(): Auth {
  return new Auth({
    storage: localStorage,
    session: sessionStorage,
    fetchFn: (...a) => fetch(...a),
    redirectUri: new URL('.', location.href).href.split(/[?#]/)[0],
    navigate: (url) => location.assign(url),
    clientId: MS_CLIENT_ID,
  })
}
