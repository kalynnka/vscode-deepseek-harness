import { DshEndpoint } from './endpoint'
import { localSessionCookie } from './local-auth'
import { DshTransportError, httpFailure, transportFailure, waitWithSignal } from './transport-error'

/** Structurally compatible with vscode.SecretStorage; tests use an in-memory store. */
export interface CredentialStore {
  get(key: string): PromiseLike<string | undefined>
  store(key: string, value: string): PromiseLike<void>
  delete(key: string): PromiseLike<void>
}

/** One endpoint's cookie. Authentication never follows redirects; local bootstrap only reads an explicitly supplied home. */
export class DshAuthentication {
  private cookie: string | undefined
  private pending: Promise<string> | undefined
  private readonly key: string

  constructor(
    readonly endpoint: DshEndpoint,
    private readonly secrets: CredentialStore,
    private readonly timeoutMs = 10_000,
    private readonly localHome?: string,
  ) {
    this.key = `deepseekHarness.cookie:${endpoint.base}`
  }

  async headers(signal?: AbortSignal): Promise<{ cookie: string }> {
    if (signal?.aborted) throw new DshTransportError('cancelled', 'dsh authentication cancelled.')
    if (this.cookie !== undefined) return { cookie: this.cookie }
    this.pending ??= this.login().finally(() => { this.pending = undefined })
    const cookie = await waitWithSignal(this.pending, signal)
    if (signal?.aborted) throw new DshTransportError('cancelled', 'dsh authentication cancelled.')
    return { cookie }
  }

  /** A server's 401 is definitive. Clear only the credential this client used. */
  async invalidate(): Promise<void> {
    const previous = this.cookie
    this.cookie = undefined
    if (previous !== undefined && await this.secrets.get(this.key) === previous) {
      await this.secrets.delete(this.key)
    }
  }

  private validCookie(value: string | undefined): value is string {
    // The server hashes the Host it receives, which a reverse proxy may rewrite.
    // Accept its generated name; credential forwarding is scoped by endpoint.base.
    return value !== undefined && /^dsh-auth-[A-Za-z0-9_-]{43}=v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(value)
  }

  private async login(): Promise<string> {
    const signal = AbortSignal.timeout(this.timeoutMs)
    try {
      const saved = await this.secrets.get(this.key)
      if (this.validCookie(saved)) {
        const status = await this.check(saved, signal)
        if (status === 200) return this.cookie = saved
        if (status !== 401) throw httpFailure(status)
        if (await this.secrets.get(this.key) === saved) await this.secrets.delete(this.key)
      }
      const launch = this.endpoint.launchUrl()
      if (launch === undefined) {
        // Probe even without credentials to distinguish an unavailable server from a 401.
        const status = await this.check(undefined, signal)
        if (status === 401 && this.localHome !== undefined) {
          const local = await localSessionCookie(this.endpoint, this.localHome)
          if (local !== undefined) {
            const verified = await this.check(local, signal)
            if (verified !== 200) throw httpFailure(verified)
            await this.secrets.store(this.key, local)
            return this.cookie = local
          }
        }
        if (status !== 200) throw httpFailure(status)
        throw new DshTransportError('protocol', 'This server does not implement current dsh authentication.')
      }
      const response = await fetch(launch, { redirect: 'manual', signal })
      await response.body?.cancel()
      if (response.status !== 303) throw httpFailure(response.status)
      const location = response.headers.get('location')
      let destination: string | undefined
      try { if (location !== null) destination = new URL(location, launch).href } catch { /* invalid redirect */ }
      if (destination !== this.endpoint.base) {
        throw new DshTransportError('protocol', 'dsh authentication redirected outside its clean application root.')
      }
      const cookies = response.headers.getSetCookie().map(value => value.split(';', 1)[0])
        .filter(value => this.validCookie(value))
      if (cookies.length !== 1) throw new DshTransportError('protocol', 'dsh did not return one valid authentication cookie.')
      const cookie = cookies[0]
      const status = await this.check(cookie, signal)
      if (status !== 200) throw httpFailure(status)
      await this.secrets.store(this.key, cookie)
      this.cookie = cookie
      return cookie
    } catch (error) {
      throw transportFailure(error)
    }
  }

  private async check(cookie: string | undefined, signal: AbortSignal): Promise<number> {
    const response = await fetch(this.endpoint.base, {
      redirect: 'manual', signal, headers: cookie === undefined ? {} : { cookie },
    })
    await response.body?.cancel()
    return response.status
  }
}
