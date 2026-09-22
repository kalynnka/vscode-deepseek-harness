import { randomUUID } from 'node:crypto'
import { DshAuthentication, type CredentialStore } from './auth'
import { DshEndpoint } from './endpoint'
import { DshRemoteClient, DshRemoteError } from './remote-client'
import { DshTransportError, transportFailure } from './transport-error'
import { isRecord, type ModelCatalog, type RemoteEventFrame, type RemoteEventResult,
  type SessionControlFrame, type SessionFollowFrame, type SessionSnapshot } from './remote-wire'
import type { HistoryEntry, ModelSelection, RemoteArgs, RemoteEndpoint, RemoteValue,
  RpcMethod, RpcPayload, RpcResult, RpcValue, SessionModels } from './wire'

/** Typed operations used by the UI. Dot names here are local operations, never wire endpoints. */
export class DshApiClient {
  readonly base: string
  private readonly auth: DshAuthentication
  private readonly transport: DshRemoteClient
  private clientId: string | undefined
  private readonly pendingEvents = new Set<string>()

  constructor(url: string, secrets: CredentialStore = memoryCredentials(), localHome?: string) {
    const endpoint = new DshEndpoint(url)
    this.base = endpoint.base
    this.auth = new DshAuthentication(endpoint, secrets, 10_000, localHome)
    this.transport = new DshRemoteClient(this.auth)
  }

  static missingGlobal(): string | undefined {
    return typeof globalThis.fetch === 'function' ? undefined : 'fetch'
  }

  /** Throws classified failures so a 401 can never be mistaken for an empty port. */
  async authenticate(): Promise<void> { await this.auth.headers() }

  async call<M extends RpcMethod>(method: M, payload: RpcPayload<M>, signal?: AbortSignal): Promise<RpcResult<RpcValue<M>>> {
    try {
      return await this.operation(method, payload, signal) as RpcResult<RpcValue<M>>
    } catch (error) { return failure(error) }
  }

  private async operation(method: RpcMethod, payload: unknown, signal?: AbortSignal): Promise<RpcResult<unknown>> {
    switch (method) {
      case 'session.list': return this.transport.call('session/list', { _request: payload }, signal)
      case 'session.create':
      case 'session.selectModel':
      case 'session.rename':
      case 'session.fork':
      case 'session.cancel':
        return this.transport.call(method.replace('.', '/'), { request: payload }, signal)
      case 'session.prompt':
        return this.transport.call('session/prompt', { request: { ...payload as object, requestId: randomUUID() } }, signal)
      case 'llm.models': return this.transport.call('session/modelCatalog', {}, signal)
      case 'settings.describe': return this.transport.call('settings/describe', {}, signal)
      case 'agentPreset.list': return this.transport.call('agentPresets/list', {}, signal)
      case 'agentPreset.select': {
        const request = payload as RpcPayload<'agentPreset.select'>
        const result = await this.transport.call<string>('agentPresets/select', {
          agentId: request.sessionId, agentPreset: request.agentPreset,
        }, signal)
        return result.ok ? { ok: true, value: { agentPreset: result.value } } : result
      }
      case 'session.models': return this.models((payload as { sessionId: string }).sessionId, signal)
      case 'session.history': return this.history(payload as RpcPayload<'session.history'>, signal)
      default: throw new DshTransportError('protocol', `The extension operation ${method} has no current dsh mapping.`)
    }
  }

  async remote<E extends RemoteEndpoint>(endpoint: E, args: RemoteArgs<E>, signal?: AbortSignal): Promise<RpcResult<RemoteValue<E>>> {
    try {
      return await this.transport.call(endpoint, endpoint === 'commands/execute'
        ? { ...args, submittedAttachments: [] } : args, signal)
    } catch (error) { return failure(error) }
  }

  private async models(sessionId: string, signal?: AbortSignal): Promise<RpcResult<SessionModels>> {
    const catalog = await this.transport.call<ModelCatalog>('session/modelCatalog', {}, signal)
    if (!catalog.ok) return catalog
    const snapshot = await this.snapshot(sessionId, 1, signal)
    const selection = snapshot.projections.values.modelSelection
    const next = isRecord(selection) ? selection.next : undefined
    const current: ModelSelection = isRecord(next) && typeof next.provider === 'string' && typeof next.model === 'string'
      ? next as unknown as ModelSelection : catalog.value.default
    return { ok: true, value: { current, groups: catalog.value.groups, failures: catalog.value.failures,
      routable: catalog.value.routableProviders.includes(current.provider) } }
  }

  private async history(request: RpcPayload<'session.history'>, signal?: AbortSignal): Promise<RpcResult<RpcValue<'session.history'>>> {
    if (request.beforeSeq === undefined) {
      const snapshot = await this.snapshot(request.sessionId, request.maxMessages, signal)
      return { ok: true, value: { events: snapshot.records, hasMore: snapshot.hasMore,
        projections: snapshot.projections, throughSeq: snapshot.cursor } }
    }
    if (request.throughSeq === undefined) throw new DshTransportError('protocol', 'History pagination needs its opening cursor.')
    const result = await this.transport.call<{ records: HistoryEntry[]; hasMore: boolean }>('session/page', {
      request: { address: { kind: 'session', sessionId: request.sessionId }, throughSeq: request.throughSeq,
        beforeSeq: request.beforeSeq, maxMessages: request.maxMessages },
    }, signal)
    return result.ok ? { ok: true, value: { events: result.value.records, hasMore: result.value.hasMore,
      throughSeq: request.throughSeq } } : result
  }

  private async snapshot(sessionId: string, maxMessages = 50, signal?: AbortSignal): Promise<SessionSnapshot> {
    const lifetime = new AbortController()
    try {
      for await (const frame of this.follow(sessionId, signal === undefined ? lifetime.signal
        : AbortSignal.any([signal, lifetime.signal]), maxMessages)) {
        if (frame.type !== 'snapshot') throw new DshTransportError('protocol', 'dsh history did not start with a snapshot.')
        return frame
      }
      throw new DshTransportError('protocol', 'dsh ended before sending session history.')
    } finally { lifetime.abort() }
  }

  async *follow(sessionId: string, signal: AbortSignal, maxMessages = 50): AsyncGenerator<SessionFollowFrame> {
    let opened = false
    for await (const value of this.transport.open('session/follow', {
      request: { address: { kind: 'session', sessionId }, maxMessages, assistantStream: true },
    }, signal)) {
      if (!isRecord(value) || (!opened && (value.type !== 'snapshot' || !Array.isArray(value.records)
        || typeof value.cursor !== 'number' || !isRecord(value.projections)))) {
        throw new DshTransportError('protocol', 'Invalid dsh session opening snapshot.')
      }
      opened = true
      yield value as unknown as SessionFollowFrame
    }
  }

  async *events(signal: AbortSignal): AsyncGenerator<RemoteEventFrame> {
    this.pendingEvents.clear()
    try {
      for await (const frame of this.transport.events(signal)) {
        if (frame.type === 'ready') this.clientId = frame.clientId
        if (frame.type === 'waterfall') this.pendingEvents.add(frame.eventId)
        if (frame.type === 'cancel') this.pendingEvents.delete(frame.eventId)
        yield frame
      }
    } finally { this.clientId = undefined; this.pendingEvents.clear() }
  }

  async *control(signal: AbortSignal): AsyncGenerator<SessionControlFrame> {
    let opened = false
    for await (const value of this.transport.open('session/control', {}, signal)) {
      if (!isRecord(value) || (!opened && (value.type !== 'baseline' || !isRecord(value.value)
        || !isRecord(value.value.projections)))) throw new DshTransportError('protocol', 'Invalid dsh control baseline.')
      opened = true
      yield value as unknown as SessionControlFrame
    }
  }

  async respondToEvent(eventId: string, outcome: RemoteEventResult['outcome']): Promise<void> {
    if (this.clientId === undefined || !this.pendingEvents.delete(eventId)) return
    const result = await this.transport.respond({ clientId: this.clientId, eventId, outcome })
    if (!result.ok) throw new DshRemoteError(result.error.code, result.error.message)
  }

  close(): void { this.pendingEvents.clear(); this.transport.close() }
}

function failure<T>(error: unknown): RpcResult<T> {
  if (error instanceof DshRemoteError) return { ok: false, error: { code: error.code, message: error.message } }
  const safe = transportFailure(error)
  return { ok: false, error: { code: safe.kind, message: safe.message } }
}

function memoryCredentials(): CredentialStore {
  const values = new Map<string, string>()
  return { get: async key => values.get(key), store: async (key, value) => { values.set(key, value) },
    delete: async key => { values.delete(key) } }
}
