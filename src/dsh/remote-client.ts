import { randomUUID } from 'node:crypto'
import WebSocket from 'ws'
import { DshAuthentication } from './auth'
import { eventFrame, rpcResult, streamFrame, type RemoteEventFrame, type RemoteEventResult,
  type RemoteStreamFrame } from './remote-wire'
import { abortFailure, DshTransportError, httpFailure, transportFailure, waitWithSignal } from './transport-error'
import type { RpcResult } from './wire'

/** Current Remote API. Callers supply wire argument names, not positional arguments. */
export class DshRemoteClient {
  private readonly lifetime = new AbortController()
  private socket: WebSocket | undefined
  private connecting: Promise<WebSocket> | undefined
  private readonly streams = new Map<string, Inbox>()

  constructor(private readonly auth: DshAuthentication, private readonly timeoutMs = 10_000) {}

  /** Unary business failures remain results; carrier failures throw a classified, safe error. */
  async call<T>(method: string, args: Record<string, unknown>, caller?: AbortSignal): Promise<RpcResult<T>> {
    const signal = AbortSignal.any([this.lifetime.signal, AbortSignal.timeout(this.timeoutMs),
      ...(caller === undefined ? [] : [caller])])
    try {
      const headers = await this.auth.headers(signal)
      const rpcId = randomUUID()
      const response = await fetch(this.auth.endpoint.api(method), {
        method: 'POST', redirect: 'manual', signal,
        headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'client-request', rpcId, method, payload: { args } }),
      })
      if (!response.ok) {
        await response.body?.cancel()
        if (response.status === 401) await this.auth.invalidate()
        throw httpFailure(response.status)
      }
      const result = rpcResult(await response.json(), rpcId)
      if (result === undefined) throw new DshTransportError('protocol', 'Invalid dsh Remote RPC response.')
      return result as RpcResult<T>
    } catch (error) {
      if (signal.aborted) throw abortFailure(signal)
      if (error instanceof SyntaxError) throw new DshTransportError('protocol', 'dsh returned a non-JSON RPC response.')
      throw transportFailure(error)
    }
  }

  respond(result: RemoteEventResult, signal?: AbortSignal): Promise<RpcResult<unknown>> {
    // Gateway expects the correlation fields directly in args, without a request wrapper.
    return this.call('$events/result', { ...result }, signal)
  }

  /** Every generation must start with one ready frame; socket open alone is not readiness. */
  async *events(signal: AbortSignal): AsyncGenerator<RemoteEventFrame> {
    let ready = false
    for await (const value of this.open('$events', {}, signal)) {
      const frame = eventFrame(value)
      if (frame === undefined || (!ready && frame.type !== 'ready') || (ready && frame.type === 'ready')) {
        throw new DshTransportError('protocol', 'Invalid dsh event stream readiness or frame.')
      }
      ready = true
      yield frame
    }
    throw new DshTransportError('protocol', ready ? 'The dsh event stream ended.' : 'dsh ended before reporting readiness.')
  }

  /** One logical stream on the shared socket; abort and iterator return cancel only this stream. */
  async *open(method: string, args: Record<string, unknown>, caller: AbortSignal): AsyncGenerator<unknown> {
    this.auth.endpoint.api(method) // Validate the endpoint before sending it on the socket.
    const signal = AbortSignal.any([caller, this.lifetime.signal])
    if (signal.aborted) throw new DshTransportError('cancelled', 'dsh stream cancelled.')
    const inbox = new Inbox()
    const streamId = randomUUID()
    let socket: WebSocket | undefined
    let terminal = false
    let openingTimer: ReturnType<typeof setTimeout> | undefined
    const cancelStream = (): void => {
      if (this.streams.delete(streamId) && !terminal && socket?.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: 'cancel', streamId }))
      }
    }
    const cancelled = (): void => {
      inbox.fail(new DshTransportError('cancelled', 'dsh stream cancelled.'))
      cancelStream()
    }
    signal.addEventListener('abort', cancelled, { once: true })
    try {
      // The physical handshake belongs to the client, not to any one logical stream.
      socket = await waitWithSignal(this.connection(), signal)
      if (signal.aborted) throw new DshTransportError('cancelled', 'dsh stream cancelled.')
      this.streams.set(streamId, inbox)
      openingTimer = setTimeout(() => {
        inbox.fail(new DshTransportError('timeout', 'dsh stream did not send its opening frame in time.'))
      }, this.timeoutMs)
      socket.send(JSON.stringify({ type: 'open', streamId, endpoint: method, payload: { args } }))
      for (;;) {
        const frame = await inbox.next()
        clearTimeout(openingTimer)
        if (frame.type === 'item') yield frame.value
        else {
          terminal = true
          if (frame.type === 'error') {
            throw new DshRemoteError(frame.error.code, frame.error.message, frame.error.details)
          }
          return
        }
      }
    } finally {
      clearTimeout(openingTimer)
      signal.removeEventListener('abort', cancelled)
      cancelStream()
    }
  }

  /** The manager owns retries. Closing this instance cancels every pending call and stream. */
  close(): void {
    this.lifetime.abort()
    this.fail(new DshTransportError('cancelled', 'dsh connection closed.'))
  }

  private connection(): Promise<WebSocket> {
    if (this.socket?.readyState === WebSocket.OPEN) return Promise.resolve(this.socket)
    this.connecting ??= this.connect().finally(() => { this.connecting = undefined })
    return this.connecting
  }

  private async connect(): Promise<WebSocket> {
    const headers = await this.auth.headers(this.lifetime.signal)
    if (this.lifetime.signal.aborted) throw new DshTransportError('cancelled', 'dsh connection closed.')
    const url = this.auth.endpoint.api('remote.mux')
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
    return await new Promise<WebSocket>((resolve, reject) => {
      const socket = new WebSocket(url, { headers, followRedirects: false })
      this.socket = socket
      const timer = setTimeout(() => {
        const error = new DshTransportError('timeout', 'dsh WebSocket handshake timed out.')
        reject(error)
        if (this.socket === socket) this.fail(error)
      }, this.timeoutMs)
      const aborted = (): void => {
        reject(new DshTransportError('cancelled', 'dsh connection closed.'))
        socket.terminate()
      }
      this.lifetime.signal.addEventListener('abort', aborted, { once: true })
      socket.once('open', () => { clearTimeout(timer); resolve(socket) })
      socket.on('message', (data, binary) => {
        if (this.socket !== socket) return
        let frame: RemoteStreamFrame | undefined
        try { if (!binary) frame = streamFrame(JSON.parse(data.toString())) } catch { /* invalid frame */ }
        if (frame === undefined) {
          this.fail(new DshTransportError('protocol', 'Invalid dsh Remote stream frame.'))
          return
        }
        this.streams.get(frame.streamId)?.push(frame)
      })
      socket.once('unexpected-response', (_request, response) => {
        clearTimeout(timer)
        const error = httpFailure(response.statusCode ?? 0)
        response.resume()
        reject(error)
        if (this.socket === socket) this.fail(error)
        if (error.kind === 'authentication') void this.auth.invalidate().catch(() => {})
      })
      socket.on('error', error => {
        clearTimeout(timer)
        const safe = transportFailure(error)
        reject(safe)
        if (this.socket === socket) this.fail(safe)
      })
      socket.once('close', () => {
        clearTimeout(timer)
        this.lifetime.signal.removeEventListener('abort', aborted)
        const error = new DshTransportError('transport', 'The dsh WebSocket closed.')
        reject(error)
        if (this.socket === socket) this.fail(error)
      })
    })
  }

  private fail(error: DshTransportError): void {
    const socket = this.socket
    this.socket = undefined
    for (const inbox of this.streams.values()) inbox.fail(error)
    this.streams.clear()
    if (socket !== undefined && socket.readyState !== WebSocket.CLOSED) socket.terminate()
  }
}

/** A logical stream failed in dsh; distinct from a failed physical connection. */
export class DshRemoteError extends Error {
  constructor(readonly code: string, message: string, readonly details?: unknown) {
    super(message)
    this.name = 'DshRemoteError'
  }
}

class Inbox {
  private readonly frames: RemoteStreamFrame[] = []
  private error: Error | undefined
  private wake: (() => void) | undefined

  push(frame: RemoteStreamFrame): void { this.frames.push(frame); this.wake?.() }
  fail(error: Error): void { this.error ??= error; this.wake?.() }

  async next(): Promise<RemoteStreamFrame> {
    for (;;) {
      if (this.error !== undefined) throw this.error
      const frame = this.frames.shift()
      if (frame !== undefined) return frame
      await new Promise<void>(resolve => { this.wake = resolve })
      this.wake = undefined
    }
  }
}
