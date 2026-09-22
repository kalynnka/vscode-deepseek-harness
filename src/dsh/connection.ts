import type { DshApiClient } from './client'
import { DshTransportError } from './transport-error'
import type { RemoteEventFrame, SessionControlFrame } from './remote-wire'
import type { AskUserQuestionItem, Envelope, HostDescription, HostFrame, MuxFrame } from './wire'

export type ConnectionState = 'connected' | 'reconnecting'
export interface ConnectionSinks {
  onMuxEnvelope?: (envelope: Envelope<MuxFrame>) => void
  onHostEnvelope?: (envelope: Envelope<HostFrame>) => void
  onConnected?: (description: HostDescription) => void
  onStateChange?: (state: ConnectionState) => void
  onLog?: (message: string) => void
  onFailure?: (error: Error) => void
  canAnswer?: (sessionId: string) => boolean
}

/** Owns the event and control subscriptions. Readiness means both opening baselines arrived. */
export class ConnectionController {
  private readonly lifetime = new AbortController()
  private starting: Promise<void> | undefined
  private connected = false
  private readonly pending = new Map<string, { sessionId: string; kind: 'question' | 'approval' }>()

  constructor(private readonly api: DshApiClient, private readonly sinks: ConnectionSinks = {}) {}

  start(): Promise<void> {
    this.starting ??= this.open()
    return this.starting
  }

  stop(): void {
    this.lifetime.abort()
    this.pending.clear()
    this.api.close()
  }

  private async open(): Promise<void> {
    let host: HostDescription = {}
    const eventReady = this.pump(this.api.events(this.lifetime.signal), frame => {
      if (frame.type === 'ready') { host = frame.host; return }
      this.event(frame)
    })
    const controlReady = this.pump(this.api.control(this.lifetime.signal), frame => this.control(frame))
    try {
      await Promise.all([eventReady, controlReady])
      if (this.lifetime.signal.aborted) throw new DshTransportError('cancelled', 'dsh connection cancelled.')
      this.connected = true
      this.sinks.onStateChange?.('connected')
      this.sinks.onConnected?.(host)
    } catch (error) { this.stop(); throw error }
  }

  private pump<F>(stream: AsyncIterable<F>, accept: (frame: F) => void): Promise<void> {
    return new Promise((resolve, reject) => {
      void (async () => {
        let opened = false
        try {
          for await (const frame of stream) {
            accept(frame)
            if (!opened) { opened = true; resolve() }
          }
          throw new DshTransportError('transport', 'A required dsh stream ended.')
        } catch (error) {
          reject(error)
          if (!this.lifetime.signal.aborted) {
            this.stop()
            if (this.connected) this.sinks.onFailure?.(error instanceof Error ? error : new Error('dsh connection failed.'))
          }
        }
      })()
    })
  }

  private mux(payload: MuxFrame, rpcId = ''): void { this.sinks.onMuxEnvelope?.({ rpcId, payload }) }
  private host(payload: HostFrame): void { this.sinks.onHostEnvelope?.({ rpcId: '', payload }) }

  private control(frame: SessionControlFrame): void {
    if (frame.type === 'baseline') {
      this.mux({ type: 'session/baseline', projections: frame.value.projections })
    } else if (frame.type === 'projection') {
      this.mux({ ...frame, type: 'session/projection' })
    }
  }

  private event(frame: Exclude<RemoteEventFrame, { type: 'ready' }>): void {
    if (frame.type === 'emit') {
      const [sessionId, value] = frame.args
      switch (frame.event) {
        case 'api-session/added':
          if (typeof sessionId === 'object' && sessionId !== null) {
            this.host({ ...sessionId, type: 'host/session-added' } as HostFrame)
          }
          break
        case 'api-session/removed':
          if (typeof sessionId === 'string') this.host({ type: 'host/session-removed', sessionId })
          break
        case 'api-session/status':
          if (typeof sessionId === 'string' && typeof value === 'boolean') {
            this.host({ type: 'host/session-status', sessionId, running: value })
          }
          break
        case 'api-session/error':
          if (typeof sessionId === 'string' && typeof value === 'string') {
            this.host({ type: 'host/agent-error', sessionId, message: value })
          }
          break
      }
      return
    }
    if (frame.type === 'cancel') {
      const pending = this.pending.get(frame.eventId)
      if (pending !== undefined) {
        this.mux({ type: `${pending.kind}/resolved`, sessionId: pending.sessionId, outcome: 'cancelled' }, frame.eventId)
        this.pending.delete(frame.eventId)
      }
      return
    }
    if (this.sinks.canAnswer?.(frame.agentId) === true) {
      if (frame.event === 'user-questions/request' && Array.isArray(frame.request.questions)) {
        this.pending.set(frame.eventId, { sessionId: frame.agentId, kind: 'question' })
        this.mux({ type: 'question/requested', sessionId: frame.agentId,
          questions: frame.request.questions as AskUserQuestionItem[] }, frame.eventId)
        return
      }
      if (frame.event === 'approval/request' && typeof frame.request.toolName === 'string') {
        this.pending.set(frame.eventId, { sessionId: frame.agentId, kind: 'approval' })
        this.mux({ type: 'approval/requested', sessionId: frame.agentId, approvalId: frame.eventId,
          toolName: frame.request.toolName,
          reason: typeof frame.request.reason === 'string' ? frame.request.reason : undefined }, frame.eventId)
        return
      }
    }
    void this.api.respondToEvent(frame.eventId, { kind: 'next' }).catch(error => {
      this.sinks.onLog?.(`Could not delegate dsh interaction: ${String(error)}`)
    })
  }
}
