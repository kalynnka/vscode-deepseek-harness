import type { HarnessConfig } from '../config'

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

/**
 * The origin to speak `/api` to, from the setting or dsh's own default.
 *
 * Only the origin survives: a path, query or fragment in the setting is
 * dropped rather than silently prefixed onto every `/api/...` call, where it
 * would fail one request at a time instead of once, here, with a reason.
 */
export function resolveEndpoint(config: HarnessConfig): string {
  let parsed: URL
  try {
    parsed = new URL(config.url)
  } catch {
    throw new HarnessUnreachableError(
      `deepseekHarness.url is ${JSON.stringify(config.url)}, which is not a URL. `
      + 'It wants the origin of a running dsh, like http://127.0.0.1:3080.',
    )
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new HarnessUnreachableError(
      `deepseekHarness.url is ${JSON.stringify(config.url)}, and dsh's \`/api\` is an HTTP surface. `
      + 'Use an http:// or https:// origin.',
    )
  }
  return parsed.origin
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
