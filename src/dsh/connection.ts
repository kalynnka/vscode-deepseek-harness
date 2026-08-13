import type { DshApiClient } from './client'
import type { Envelope, HostDescription, HostFrame, MuxFrame } from './wire'

/** Reconnect tunables. Deployment-varying, so they are parameters rather than constants in the loop. */
export interface ConnectionConfig {
  backoffBaseMs: number
  backoffFactor: number
  backoffMaxMs: number
  /**
   * Cap on waiting for both streams to open before declaring the generation
   * connected. A carrier that never fires `open` must not wedge the connection
   * forever; on timeout the generation proceeds and the resync covers stragglers.
   */
  streamOpenTimeoutMs: number
}

const DEFAULTS: ConnectionConfig = {
  backoffBaseMs: 500,
  backoffFactor: 2,
  backoffMaxMs: 10_000,
  streamOpenTimeoutMs: 3_000,
}

export type ConnectionState = 'connected' | 'reconnecting'

export interface ConnectionSinks {
  onMuxEnvelope?: (envelope: Envelope<MuxFrame>) => void
  onHostEnvelope?: (envelope: Envelope<HostFrame>) => void
  /** Fires after each generation's handshake settles, the first connect included. */
  onConnected?: (description: HostDescription) => void
  onStateChange?: (state: ConnectionState) => void
  onLog?: (message: string) => void
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms)
    signal.addEventListener('abort', done, { once: true })
    function done(): void {
      clearTimeout(timer)
      signal.removeEventListener('abort', done)
      resolve()
    }
  })
}

/**
 * Opens both streams and keeps them open, reconnecting with jittered
 * exponential backoff on loss.
 *
 * This is a port of dsh's own `ConnectionController`, kept faithful to it in
 * the one place that matters: the readiness handshake awaits `host.describe`
 * *and* both sockets opening before `onConnected` fires, so the resync that
 * callback triggers cannot outrun the subscribed baseline. Relaxing that is
 * what produces a first render that is silently missing its first events.
 *
 * A sink that throws is logged and swallowed — a broken rendering layer must
 * not take the connection down with it.
 */
export class ConnectionController {
  private generation = 0
  private attempt = 0
  private current: AbortController | undefined
  private running = false
  private lastState: ConnectionState | undefined
  private readonly config: ConnectionConfig

  constructor(
    private readonly api: DshApiClient,
    private readonly sinks: ConnectionSinks = {},
    config: Partial<ConnectionConfig> = {},
  ) {
    this.config = { ...DEFAULTS, ...config }
  }

  start(): void {
    if (this.running) return
    this.running = true
    void this.loop()
  }

  stop(): void {
    this.running = false
    this.current?.abort()
    this.current = undefined
  }

  private backoffDelay(attempt: number): number {
    const { backoffBaseMs, backoffFactor, backoffMaxMs } = this.config
    const cap = Math.min(backoffMaxMs, backoffBaseMs * backoffFactor ** Math.max(0, attempt - 1))
    return cap / 2 + Math.random() * (cap / 2)
  }

  /** Read through a method: `stop()` flips this across awaits, so narrowing must not stick. */
  private isRunning(): boolean {
    return this.running
  }

  private async loop(): Promise<void> {
    while (this.running) {
      const generation = ++this.generation
      const ac = new AbortController()
      this.current = ac

      let muxOpened = (): void => {}
      let hostOpened = (): void => {}
      const streamsOpen = Promise.all([
        new Promise<void>((resolve) => { muxOpened = resolve }),
        new Promise<void>((resolve) => { hostOpened = resolve }),
      ])

      const failed = new Promise<void>((resolve) => {
        const settle = (): void => {
          if (generation === this.generation && !ac.signal.aborted) ac.abort()
          resolve()
        }
        void this.pump(this.api.openMux(ac.signal, muxOpened), this.sinks.onMuxEnvelope, settle)
        void this.pump(this.api.openHost(ac.signal, hostOpened), this.sinks.onHostEnvelope, settle)
      })

      try {
        const timeout = new AbortController()
        const [described] = await Promise.all([
          this.api.call('host.describe', {}, ac.signal),
          Promise.race([streamsOpen, sleep(this.config.streamOpenTimeoutMs, timeout.signal)]),
        ])
        timeout.abort()
        if (!described.ok) {
          throw new Error(`host.describe failed: ${described.error.code}: ${described.error.message}`)
        }
        if (ac.signal.aborted) throw new Error('generation aborted during readiness handshake')
        this.attempt = 0
        this.emitState('connected')
        if (this.isRunning() && !ac.signal.aborted) {
          this.callSink(() => { this.sinks.onConnected?.(described.value) })
        }
      } catch (error) {
        this.sinks.onLog?.(`handshake failed: ${error instanceof Error ? error.message : String(error)}`)
        if (!ac.signal.aborted) ac.abort()
      }

      await failed
      if (!this.isRunning()) return
      this.emitState('reconnecting')
      this.attempt += 1
      this.sinks.onLog?.(`connection lost, retry #${this.attempt}`)
      await sleep(this.backoffDelay(this.attempt), new AbortController().signal)
    }
  }

  private emitState(state: ConnectionState): void {
    if (this.lastState === state) return
    this.lastState = state
    this.callSink(() => this.sinks.onStateChange?.(state))
  }

  private async pump<F extends { type: string }>(
    stream: AsyncIterable<Envelope<F>>,
    sink: ((envelope: Envelope<F>) => void) | undefined,
    onEnd: () => void,
  ): Promise<void> {
    try {
      for await (const envelope of stream) {
        if (envelope.payload.type === 'stream/error') break
        if (sink !== undefined) this.callSink(() => { sink(envelope) })
      }
    } catch {
      // Stream loss converges on onEnd, which drives the shared reconnect.
    }
    onEnd()
  }

  private callSink(fn: () => void): void {
    try {
      fn()
    } catch (error) {
      this.sinks.onLog?.(`connection sink threw: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
}
