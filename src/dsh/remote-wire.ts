/** Current Gateway carrier, mirrored from dsh c36a83f packages/api/gateway/src/stream-protocol.ts. */
import type { RpcError, RpcResult } from './wire'
import type { HistoryEntry, ModelProviderGroup, ModelSelection, ProjectionsBlock, SessionEvent } from './wire'

export interface ModelCatalog {
  default: ModelSelection
  routableProviders: string[]
  groups: ModelProviderGroup[]
  failures: { id: string; name: string; message: string }[]
}

export interface SessionSnapshot {
  type: 'snapshot'
  header: { id: string }
  cursor: number
  records: HistoryEntry[]
  hasMore: boolean
  projections: ProjectionsBlock
  assistantStream?: { activeAttempt?: { attemptId: string; nextIndex: number; stream: unknown[] } }
}

export type AssistantFrame =
  | { type: 'start'; attemptId: string }
  | { type: 'chunk'; attemptId: string; index: number; time: number; chunk: unknown }
  | { type: 'end'; attemptId: string; index: number; outcome: { kind: 'committed'; seq: number } | { kind: 'abandoned' } }

export type SessionFollowFrame = SessionSnapshot
  | { type: 'event'; event: SessionEvent }
  | { type: 'assistant-stream'; frame: AssistantFrame }

export type SessionControlFrame =
  | { type: 'baseline'; value: { projections: Record<string, ProjectionsBlock> } }
  | { type: 'projection'; sessionId: string; key: string; value: unknown; seq: number }

export type RemoteStreamFrame =
  | { type: 'item'; streamId: string; value?: unknown }
  | { type: 'end'; streamId: string }
  | { type: 'error'; streamId: string; error: RpcError }

export type RemoteEventFrame =
  | { type: 'ready'; clientId: string; host: { home: string } }
  | { type: 'emit'; event: string; args: unknown[] }
  | { type: 'waterfall'; event: string; eventId: string; agentId: string; request: Record<string, unknown> }
  | { type: 'cancel'; eventId: string }

export interface RemoteEventResult {
  clientId: string
  eventId: string
  outcome:
    | { kind: 'next' }
    | { kind: 'result'; value?: unknown }
    | { kind: 'rejected'; error: { name: string; message: string; code?: string; details?: unknown } }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

function isRpcError(value: unknown): value is RpcError {
  return isRecord(value) && typeof value.code === 'string' && typeof value.message === 'string'
    && isRecord(value.details)
}

export function rpcResult(body: unknown, rpcId: string): RpcResult<unknown> | undefined {
  if (!isRecord(body) || body.type !== 'server-response' || body.rpcId !== rpcId) return undefined
  const result = body.result
  if (!isRecord(result)) return undefined
  if (result.ok === true) return { ok: true, value: result.value }
  if (result.ok === false && isRpcError(result.error)) return { ok: false, error: result.error }
  return undefined
}

export function streamFrame(value: unknown): RemoteStreamFrame | undefined {
  if (!isRecord(value) || !isId(value.streamId)) return undefined
  if (value.type === 'item') return { type: 'item', streamId: value.streamId, value: value.value }
  if (value.type === 'end') return { type: 'end', streamId: value.streamId }
  if (value.type === 'error' && isRpcError(value.error)) {
    return { type: 'error', streamId: value.streamId, error: value.error }
  }
  return undefined
}

export function eventFrame(value: unknown): RemoteEventFrame | undefined {
  if (!isRecord(value)) return undefined
  if (value.type === 'ready' && isId(value.clientId) && isRecord(value.host) && typeof value.host.home === 'string') {
    return { type: 'ready', clientId: value.clientId, host: { home: value.host.home } }
  }
  if (value.type === 'emit' && isId(value.event) && Array.isArray(value.args)) {
    return { type: 'emit', event: value.event, args: value.args }
  }
  if (value.type === 'cancel' && isId(value.eventId)) return { type: 'cancel', eventId: value.eventId }
  if (value.type === 'waterfall' && isId(value.event) && isId(value.eventId)
    && isId(value.agentId) && isRecord(value.request)) {
    return { type: 'waterfall', event: value.event, eventId: value.eventId,
      agentId: value.agentId, request: value.request }
  }
  return undefined
}
