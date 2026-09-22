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
 * Why this extension has no dsh to talk to: neither the one that should have
 * been serving, nor one it could start.
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

export function redactLaunchTokens(text: string): string {
  return text.replace(/([?&]token=)[^&#\s]+/g, '$1[redacted]')
}

/**
 * The port to start a harness on when nothing is serving at the endpoint.
 *
 * Deliberately the endpoint's own port rather than an ephemeral one: a fixed
 * address is what lets the *next* window find this harness and attach to it
 * instead of starting a second writer of the same `$DSH_HOME`.
 */
export function portOf(endpoint: string): number {
  const parsed = new URL(endpoint)
  if (parsed.port !== '') return Number(parsed.port)
  return parsed.protocol === 'https:' ? 443 : 80
}

/**
 * Whether the endpoint names this machine.
 *
 * Only a local one may be started for: a child bound to `127.0.0.1` cannot
 * answer `https://dsh.example`, so starting one there would bind a port nobody
 * asked about (443, on that example) and then fail to reach the harness the
 * user actually meant.
 */
export function isLocal(endpoint: string): boolean {
  const host = new URL(endpoint).hostname
  return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]'
}

/**
 * What every surface says when there is no harness, in one place so the chat,
 * the pickers and the status bar all name the same fix.
 */
export function unreachableMessage(endpoint: string): string {
  return `No dsh at ${endpoint}, and starting one failed. `
    + 'Run `dsh web` yourself, or see the log for why the start failed, '
    + 'then run "DeepSeek Harness: Reconnect".'
}

/**
 * The hazard the user takes on the moment this extension starts a harness.
 *
 * dsh assumes one host process per `$DSH_HOME` — its own storage backend says
 * so ("no cross-process write locking … single-host-process deployments are
 * the current consumer") — and session logs are appended through a plain
 * `open(path, 'a')` with no lock of any kind. Two harnesses over one home
 * interleave their appends, and the reader rejects the result permanently:
 * a `seq gap in committed region`, or a `complete frame contains a torn JSONL
 * record`. Measured, with the sessions it cost, in docs/gaps.md §23.
 */
export const SHARED_HOME_WARNING =
  'DeepSeek Harness started a dsh for this window. dsh has no cross-process lock on session logs, '
  + 'so running a second one — `dsh web` in a terminal, or another editor — against the same $DSH_HOME '
  + 'can corrupt the logs of sessions both have open. Other windows attach to this one; a harness you '
  + 'start yourself is attached to rather than duplicated.'
