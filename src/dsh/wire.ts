/**
 * The `/api` wire contract, as much of it as this extension consumes.
 *
 * These types are hand-mirrored from dsh's own `api/` layer rather than
 * imported from `@deepseek-ai/dsh-host-apiproxy`, for two reasons that both
 * point the same way:
 *
 * - The extension drives *the user's* dsh, whose version we do not choose and
 *   cannot pin. Compiling against one published schema and parsing strictly
 *   with it would turn every version skew into an empty chat window. Every
 *   type here is therefore permissive: unknown frame types, unknown event
 *   types and unknown fields are carried, not rejected.
 * - Nothing of dsh may ship inside the VSIX. A zero-dependency wire layer is
 *   the enforcement of that, not just the intention.
 *
 * The upstream source of truth, for anyone re-syncing this file:
 * `packages/host/apiproxy/src/api/{rpc,events,sessions}.ts` and
 * `packages/core/session/src/types.ts`.
 */

/** Message correlation id. A response echoes its request's id, never mints one. */
export type RpcId = string

/** dsh's session identifier. */
export type SessionId = string

export interface RpcError {
  code: string
  message: string
  details?: unknown
}

export type RpcResult<T> = { ok: true; value: T } | { ok: false; error: RpcError }

/** POST /api/<method> body. */
export interface ClientRequest {
  type: 'client-request'
  rpcId: RpcId
  method: string
  payload: unknown
}

/** The body that POST answers with. */
export interface ServerResponse {
  type: 'server-response'
  rpcId: RpcId
  result: RpcResult<unknown>
}

/** One downstream WebSocket frame. `payload` is a MuxFrame or a HostFrame. */
export interface ServerRequest {
  type: 'server-request'
  rpcId: RpcId
  method: string
  payload: unknown
}

/** POST /api/respond body — answers an answerable ServerRequest by echoing its rpcId. */
export interface ClientResponse {
  type: 'client-response'
  rpcId: RpcId
  result: RpcResult<unknown>
}

/** The body POST /api/respond answers with. Belongs to the carrier, not the RPC model. */
export type RpcReceipt = { accepted: true } | { accepted: false; reason: string }

/** A downstream frame paired with the rpcId that identifies (and, when answerable, answers) it. */
export interface Envelope<F> {
  rpcId: RpcId
  payload: F
}

// ---------------------------------------------------------------------------
// Session log
// ---------------------------------------------------------------------------

/**
 * One entry in a session log.
 *
 * `type` is deliberately `string`: dsh's vocabulary grows, and an event this
 * build has never heard of must flow through to be ignored rather than crash
 * the fold. `data` is `unknown` for the same reason — each renderer narrows
 * only the shape it needs.
 */
export interface SessionEvent {
  type: string
  seq: number
  time: number
  data: unknown
  /** Set by dsh on events a reader may safely skip when it does not know `type`. */
  ignorable?: true
  surfaceOp?: 'append' | { op: 'replace'; start: number; end: number }
  sourceEventSeqs?: number[]
}

/** Host-computed render intent riding a `tool/call` or `tool/result`. */
export interface ToolEventView {
  for: 'call' | 'result'
  view: unknown
}

export interface HistoryEntry {
  event: SessionEvent
  view?: ToolEventView
}

/**
 * A synchronous cut over every registered projection unit. Keys are whatever
 * the deployment mounts — `tokenUsage`, `contextPressure`, `contextBreakdown`,
 * `sessionTitle`, … — so this stays an open record and the consumer asks for
 * the key it wants.
 */
export interface ProjectionsBlock {
  asOfSeq: number
  values: Record<string, unknown>
}

// ---------------------------------------------------------------------------
// Mux + host stream frames
// ---------------------------------------------------------------------------

/** One question inside an `ask()` batch. */
export interface AskUserQuestionItem {
  id: string
  question: string
  detail?: string
  header?: string
  options?: { label: string; description?: string }[]
  multiSelect?: boolean
  intent?: { kind: string; approve?: string }
}

export interface AskUserQuestionAnswerItem {
  id: string
  selected: string[]
  custom?: string
}

export interface AskUserQuestionAnswer {
  answers: AskUserQuestionAnswerItem[]
}

/**
 * A frame off the mux stream. Typed as an open union: the variants below are
 * the ones this extension acts on, and `type` stays `string` so an unknown
 * frame is data rather than a parse failure.
 */
export type MuxFrame =
  | { type: 'session/event'; sessionId: SessionId; event: SessionEvent; view?: ToolEventView }
  | { type: 'session/subscribed'; sessionId: SessionId; lastSeq: number }
  | { type: 'approval/requested'; sessionId: SessionId; approvalId: string; toolName: string; callId?: string; reason?: string }
  | { type: 'approval/resolved'; sessionId: SessionId; approvalId: string; outcome: string }
  | { type: 'question/requested'; sessionId: SessionId; questions: AskUserQuestionItem[] }
  | { type: 'question/resolved'; sessionId: SessionId; questionRpcId: RpcId; outcome: string }
  | { type: 'session/queue'; sessionId: SessionId; items: unknown[] }
  | { type: 'session/jobs'; sessionId: SessionId; jobs: unknown[] }
  | { type: 'session/projection'; sessionId: SessionId; key: string; value: unknown; seq: number }
  | { type: 'stream/error'; error: RpcError }
  | { type: string; sessionId?: SessionId; [key: string]: unknown }

/** A frame off the host stream. Same open-union posture as {@link MuxFrame}. */
export type HostFrame =
  | { type: 'host/session-added'; sessionId: SessionId; blank: boolean; parentSessionId?: SessionId; origin?: string; cwd?: string; agentPreset?: string }
  | { type: 'host/session-removed'; sessionId: SessionId }
  | { type: 'host/session-status'; sessionId: SessionId; running: boolean }
  | { type: 'host/agent-error'; sessionId: SessionId; message: string }
  | { type: 'stream/error'; error: RpcError }
  | { type: string; sessionId?: SessionId; [key: string]: unknown }

// ---------------------------------------------------------------------------
// Unary method payloads and results
// ---------------------------------------------------------------------------

export interface SessionSummary {
  sessionId: SessionId
  updatedAt: number
  running: boolean
  blank: boolean
  parentSessionId?: SessionId
  origin?: string
  cwd?: string
  agentPreset?: string
  projections?: ProjectionsBlock
}

export interface ModelSelection {
  provider: string
  model: string
  reasoningEffort?: string
}

export interface ModelReasoningEffort {
  id: string
  name: string
  description?: string
}

export interface ModelCatalogModel {
  id: string
  name: string
  description?: string
  reasoning?: {
    efforts: ModelReasoningEffort[]
    defaultEffort?: string
  }
}

export interface ModelProviderGroup {
  id: string
  name: string
  models: ModelCatalogModel[]
}

export interface SessionModels {
  current: ModelSelection
  /**
   * Whether an adapter currently serves `current.provider`. Not derivable from
   * `groups`: catalog membership is advisory, so a route serving a model it
   * stopped advertising is absent from the groups yet perfectly usable. A
   * surface that blocks input reads this.
   */
  routable: boolean
  groups: ModelProviderGroup[]
  failures: { id: string; name: string; message: string }[]
}

export type PromptContentPart =
  | { type: 'text'; text: string }
  | { type: 'image'; mediaType: string; data: string; name?: string }

export interface HostDescription {
  [key: string]: unknown
}

/**
 * One settings namespace as `settings.describe` returns it.
 *
 * `schema` is a serialized schemastery envelope — `{ uid, refs }`, a graph of
 * numbered nodes rather than a plain JSON Schema — and it is where a
 * namespace's *allowed* values live. The resolved `value` only says what is
 * currently set, so an enum has to be read out of the schema. See
 * `enumChoicesAt` in `src/sessions/defaults.ts`.
 */
export interface SettingsNamespaceView {
  ns: string
  schema?: unknown
  value?: unknown
  applies?: string
  revision?: number
}

/** The subset of `/api` this extension calls, as method name to payload/value pair. */
export interface RpcMethods {
  'host.describe': { payload: {}; value: HostDescription }
  'session.list': { payload: { cursor?: string }; value: { items: SessionSummary[] } }
  'session.create': { payload: { cwd?: string; workspaceId?: string; sessionId?: SessionId; agentPreset?: string }; value: { sessionId: SessionId; agentPreset?: string } }
  'session.history': { payload: { sessionId: SessionId; beforeSeq?: number; maxMessages?: number }; value: { events: HistoryEntry[]; hasMore: boolean; projections?: ProjectionsBlock } }
  'session.models': { payload: { sessionId: SessionId }; value: SessionModels }
  'session.selectModel': { payload: { sessionId: SessionId; provider: string; model: string; reasoningEffort?: string }; value: { selected: ModelSelection } }
  'session.rename': { payload: { sessionId: SessionId; title: string }; value: { title: string; seq: number } }
  'session.fork': { payload: { sessionId: SessionId; atSeq?: number }; value: { sessionId: SessionId } }
  'session.prompt': { payload: { sessionId: SessionId; mode: 'queue' | 'steer'; content: PromptContentPart[]; clientTimeZone?: string }; value: { accepted: true; command?: { kind: string; text?: string } } }
  'session.cancel': { payload: { sessionId: SessionId }; value: { accepted: true } }
  'llm.models': { payload: {}; value: { groups: ModelProviderGroup[]; failures?: unknown[] } }
  'settings.describe': { payload: {}; value: { writable?: boolean; namespaces: SettingsNamespaceView[] } }
  'agentPreset.list': { payload: {}; value: unknown }
  'agentPreset.select': { payload: { sessionId: SessionId; agentPreset: string }; value: unknown }
  'skill.list': { payload: {}; value: unknown }
}

export type RpcMethod = keyof RpcMethods
export type RpcPayload<M extends RpcMethod> = RpcMethods[M]['payload']
export type RpcValue<M extends RpcMethod> = RpcMethods[M]['value']

/** One command dsh offers on a session, as `commands/list` describes it. */
export interface CommandDescriptor {
  name: string
  description?: string
  input?: { hint?: string }
}

/** What executing a command produced; `undefined` value means no command matched the line. */
export interface CommandExecution {
  commandId: string
  result?: { kind: string; text?: string }
}

/**
 * The typert **remotes** plane: `<namespace>/<method>` endpoints whose
 * arguments ride in `args`, on the same POST /api transport as the method map
 * above.
 *
 * This is not a documented part of `/api` — it does not appear in dsh's
 * `RpcMethodMap` — but it is how dsh's own web client runs slash commands, and
 * the only way to reach them from outside. Argument names are the wire names
 * from the generated remote contract.
 */
export interface RemoteEndpoints {
  'commands/list': { args: { agentId: SessionId }; value: CommandDescriptor[] }
  'commands/execute': { args: { agentId: SessionId; line: string }; value: CommandExecution | undefined }
}

export type RemoteEndpoint = keyof RemoteEndpoints
export type RemoteArgs<E extends RemoteEndpoint> = RemoteEndpoints[E]['args']
export type RemoteValue<E extends RemoteEndpoint> = RemoteEndpoints[E]['value']
