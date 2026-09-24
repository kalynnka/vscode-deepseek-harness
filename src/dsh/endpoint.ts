import type { HarnessConfig } from '../config'
import { DshTransportError } from './transport-error'

/** Current transport address. The display URL and credential key never contain the launch token. */
export class DshEndpoint {
  readonly base: string
  #token: string | undefined

  constructor(input: string) {
    let url: URL
    try { url = new URL(input) } catch {
      throw new DshTransportError('protocol', 'deepseekHarness.url must be a valid HTTP(S) launch URL.')
    }
    if (!['http:', 'https:'].includes(url.protocol) || url.username !== '' || url.password !== '') {
      throw new DshTransportError('protocol', 'Use an HTTP(S) dsh URL without username/password credentials.')
    }
    const tokens = url.searchParams.getAll('token')
    if (tokens.length > 1 || tokens[0] === '') {
      throw new DshTransportError('authentication', 'The dsh launch URL must contain one nonempty token.')
    }
    this.#token = tokens[0]
    url.search = ''
    url.hash = ''
    if (!url.pathname.endsWith('/')) url.pathname += '/'
    this.base = url.href
  }

  launchUrl(): URL | undefined {
    if (this.#token === undefined) return undefined
    const url = new URL(this.base)
    url.searchParams.set('token', this.#token)
    return url
  }

  api(method: string): URL {
    if (!/^[$A-Za-z0-9_.-]+(?:\/[$A-Za-z0-9_.-]+)*$/.test(method)
      || method.split('/').some(part => part === '.' || part === '..')) {
      throw new DshTransportError('protocol', 'Invalid dsh Remote endpoint.')
    }
    return new URL(`api/${method}`, this.base)
  }
}

/**
 * Why this extension has no dsh to talk to at the configured endpoint.
 */
export class HarnessUnreachableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'HarnessUnreachableError'
  }
}

/** Preserve the launch token and reverse-proxy mount when resolving a configured URL. */
export function resolveEndpoint(config: HarnessConfig): string {
  const endpoint = new DshEndpoint(config.url)
  return endpoint.launchUrl()?.href ?? endpoint.base
}

/** Whether the endpoint is local, allowing authentication from the local dsh home. */
export function isLocal(endpoint: string): boolean {
  const host = new URL(endpoint).hostname
  return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]'
}

/**
 * What every surface says when there is no harness, in one place so the chat,
 * the pickers and the status bar all name the same fix.
 */
export function unreachableMessage(endpoint: string): string {
  return `No dsh connection at ${endpoint}. `
    + 'Start or check your dsh server, then run "DeepSeek Harness: Reconnect". '
    + 'See "DeepSeek Harness: Show Log" for details.'
}
