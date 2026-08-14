import { randomUUID } from 'node:crypto'
import type {
  ClientRequest, ClientResponse, Envelope, HostFrame, MuxFrame, RemoteArgs,
  RemoteEndpoint, RemoteValue, RpcId, RpcMethod, RpcPayload, RpcReceipt, RpcResult, RpcValue,
  ServerRequest, ServerResponse,
} from './wire'

const MUX_PATH = '/api/events.mux'
const HOST_PATH = '/api/events.host'

/** Folds a transport exception into the error branch, so callers never see a throw. */
function transportError<T>(error: unknown): RpcResult<T> {
  return {
    ok: false,
    error: { code: 'internal', message: error instanceof Error ? error.message : String(error) },
  }
}

/**
 * The `/api` carrier for Node.
 *
 * dsh's own browser client is the reference: unary calls and `respond` go over
 * `fetch`, and each downstream stream is one downlink-only WebSocket. There is
 * no SSE fallback to reach for — the dsh web server answers a plain GET on the
 * event paths with `426 upgrade required`.
 *
 * Both `fetch` and `WebSocket` are taken from the platform. The extension host
 * has supplied them globally since Node 22, which keeps this file free of
 * dependencies; {@link assertTransportAvailable} turns their absence into one
 * clear sentence instead of a `ReferenceError` from inside a generator.
 */
export class DshApiClient {
  constructor(private readonly baseUrl: string) {}

  /** The loopback origin this client talks to, e.g. `http://127.0.0.1:51234`. */
  get base(): string {
    return this.baseUrl
  }

  /**
   * Reports whether the platform gives us the two globals the carrier needs.
   * @returns the missing global's name, or undefined when both are present.
   */
  static missingGlobal(): string | undefined {
    if (typeof globalThis.fetch !== 'function') return 'fetch'
    if (typeof globalThis.WebSocket !== 'function') return 'WebSocket'
    return undefined
  }

  /**
   * Calls one unary method: POST /api/<method>.
   *
   * Business failures come back in the result's error branch exactly as dsh
   * sent them; only carrier failures are folded in locally. Nothing throws.
   */
  async call<M extends RpcMethod>(
    method: M,
    payload: RpcPayload<M>,
    signal?: AbortSignal,
  ): Promise<RpcResult<RpcValue<M>>> {
    const message: ClientRequest = { type: 'client-request', rpcId: randomUUID(), method, payload }
    try {
      const response = await globalThis.fetch(new URL(`/api/${method}`, this.baseUrl), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(message),
        signal,
      })
      if (!response.ok) {
        return { ok: false, error: { code: 'internal', message: `HTTP ${response.status} from /api/${method}` } }
      }
      const body = await response.json() as ServerResponse
      return body.result as RpcResult<RpcValue<M>>
    } catch (error) {
      return transportError(error)
    }
  }

  /**
   * Calls one method on dsh's *other* RPC plane: POST /api/<namespace>/<method>.
   *
   * `/api` carries two planes on the same transport. The 47-method
   * `RpcMethodMap` is the one with a flat payload; the typert **remotes** plane
   * is addressed as `<namespace>/<method>` and wraps its arguments in `args`.
   * Nothing announces the second one — it is not in the method map — and it is
   * where the commands live, so `/permission`, `/compact` and `/plan` are
   * reachable only through here. See docs/gaps.md §11.
   */
  async remote<E extends RemoteEndpoint>(
    endpoint: E,
    args: RemoteArgs<E>,
    signal?: AbortSignal,
  ): Promise<RpcResult<RemoteValue<E>>> {
    const message: ClientRequest = {
      type: 'client-request',
      rpcId: randomUUID(),
      method: endpoint,
      payload: { args },
    }
    try {
      const response = await globalThis.fetch(new URL(`/api/${endpoint}`, this.baseUrl), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(message),
        signal,
      })
      if (!response.ok) {
        return { ok: false, error: { code: 'internal', message: `HTTP ${response.status} from /api/${endpoint}` } }
      }
      const body = await response.json() as ServerResponse
      return body.result as RpcResult<RemoteValue<E>>
    } catch (error) {
      return transportError(error)
    }
  }

  /**
   * Answers an answerable server-request by echoing its rpcId to
   * POST /api/respond.
   *
   * The receipt belongs to the carrier, not to the RPC model: `not-pending`
   * means the request was already settled (a second editor answered it, or the
   * turn was cancelled), which is a normal race and not an error.
   */
  async respond(rpcId: RpcId, result: RpcResult<unknown>, signal?: AbortSignal): Promise<RpcReceipt> {
    const message: ClientResponse = { type: 'client-response', rpcId, result }
    try {
      const response = await globalThis.fetch(new URL('/api/respond', this.baseUrl), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(message),
        signal,
      })
      if (!response.ok) return { accepted: false, reason: `HTTP ${response.status}` }
      return await response.json() as RpcReceipt
    } catch (error) {
      return { accepted: false, reason: error instanceof Error ? error.message : String(error) }
    }
  }

  openMux(signal: AbortSignal, onOpen?: () => void): AsyncIterable<Envelope<MuxFrame>> {
    return this.readStream<MuxFrame>(MUX_PATH, signal, onOpen)
  }

  openHost(signal: AbortSignal, onOpen?: () => void): AsyncIterable<Envelope<HostFrame>> {
    return this.readStream<HostFrame>(HOST_PATH, signal, onOpen)
  }

  /**
   * One downlink WebSocket, surfaced as an async iterable.
   *
   * Frames are buffered rather than dropped while nobody is awaiting: the
   * socket delivers on its own schedule and a consumer that is one `await`
   * behind must not lose the frames in between.
   */
  private async *readStream<F>(
    path: string,
    signal: AbortSignal,
    onOpen?: () => void,
  ): AsyncGenerator<Envelope<F>> {
    const url = new URL(path, this.baseUrl)
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
    const socket = new globalThis.WebSocket(url)

    type Item = { kind: 'frame'; envelope: Envelope<F> } | { kind: 'end' }
    const inbox: Item[] = []
    let wake: (() => void) | undefined
    const enqueue = (item: Item): void => {
      inbox.push(item)
      wake?.()
      wake = undefined
    }

    const handleOpen = (): void => { onOpen?.() }
    const handleMessage = (event: { data: unknown }): void => {
      if (typeof event.data !== 'string') return
      let full: ServerRequest
      try {
        full = JSON.parse(event.data) as ServerRequest
      } catch {
        // A frame we cannot even parse as JSON is the carrier's problem, not
        // the session's: drop it and keep the stream alive.
        return
      }
      enqueue({ kind: 'frame', envelope: { rpcId: full.rpcId, payload: full.payload as F } })
    }
    const handleClose = (): void => { enqueue({ kind: 'end' }) }
    const handleError = (): void => { enqueue({ kind: 'end' }) }
    const handleAbort = (): void => {
      if (socket.readyState === 0 || socket.readyState === 1) socket.close()
    }

    socket.addEventListener('open', handleOpen)
    socket.addEventListener('message', handleMessage)
    socket.addEventListener('close', handleClose, { once: true })
    socket.addEventListener('error', handleError, { once: true })
    signal.addEventListener('abort', handleAbort, { once: true })
    if (signal.aborted) handleAbort()

    try {
      for (;;) {
        while (inbox.length > 0) {
          const item = inbox.shift() as Item
          if (item.kind === 'end') return
          yield item.envelope
        }
        await new Promise<void>((resolve) => { wake = resolve })
      }
    } finally {
      signal.removeEventListener('abort', handleAbort)
      socket.removeEventListener('open', handleOpen)
      socket.removeEventListener('message', handleMessage)
      socket.removeEventListener('close', handleClose)
      socket.removeEventListener('error', handleError)
      handleAbort()
    }
  }
}
