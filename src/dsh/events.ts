/**
 * Tolerant readers over session-event payloads.
 *
 * Every accessor here answers "is this the shape I need?" and returns
 * undefined when it is not. That posture is the point: dsh's event vocabulary
 * grows, the user's dsh version is not ours to pin, and an unrecognised event
 * must degrade to "not rendered" rather than to a thrown exception inside a
 * fold that is halfway through rebuilding a conversation.
 */

import type { SessionEvent } from './wire'

/** dsh's content blocks, as much of each as a renderer reads. */
export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'reasoning'; text: string }
  | { type: 'image'; attachment?: unknown }
  | { type: 'tool-call'; id: string; name: string; arguments: string }
  | { type: 'tool-result'; toolCallId: string; content: ContentBlock[]; isError?: boolean }
  | { type: string; [key: string]: unknown }

export interface TokenUsage {
  inputTokens: number
  outputTokens: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
  reasoningTokens?: number
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

/** The content blocks of a `user/message` or `assistant/message` event. */
export function messageContent(event: SessionEvent): ContentBlock[] | undefined {
  if (!isRecord(event.data)) return undefined
  const message = event.data.message ?? event.data
  if (!isRecord(message)) return undefined
  const content = message.content
  return Array.isArray(content) ? content as ContentBlock[] : undefined
}

/**
 * How a `user/message` came about.
 *
 * `user` is a human prompt. Everything else — `plugin`, `tool`, `model` — is
 * dsh injecting context into the model's view (file-change notices, skill
 * bodies, AGENTS.md, cron notifications). Those are real messages to the
 * model, but rendering them as if the human had typed them would be a lie, so
 * callers separate on this.
 */
export function messageSourceKind(event: SessionEvent): string | undefined {
  if (!isRecord(event.data)) return undefined
  const message = event.data.message ?? event.data
  if (!isRecord(message)) return undefined
  const source = message.source
  return isRecord(source) ? asString(source.kind) : undefined
}

/** Concatenated plain text of a block list, ignoring non-text blocks. */
export function textOf(blocks: ContentBlock[] | undefined): string {
  if (blocks === undefined) return ''
  return blocks
    .filter((block): block is { type: 'text'; text: string } => block.type === 'text' && typeof (block as { text?: unknown }).text === 'string')
    .map(block => block.text)
    .join('')
}

/** The `usage` slot dsh attaches to an `assistant/message` when the adapter reported one. */
export function usageOf(event: SessionEvent): TokenUsage | undefined {
  if (!isRecord(event.data)) return undefined
  const usage = event.data.usage
  if (!isRecord(usage)) return undefined
  const input = usage.inputTokens
  const output = usage.outputTokens
  if (typeof input !== 'number' || typeof output !== 'number') return undefined
  return {
    inputTokens: input,
    outputTokens: output,
    cacheReadTokens: typeof usage.cacheReadTokens === 'number' ? usage.cacheReadTokens : undefined,
    cacheWriteTokens: typeof usage.cacheWriteTokens === 'number' ? usage.cacheWriteTokens : undefined,
    reasoningTokens: typeof usage.reasoningTokens === 'number' ? usage.reasoningTokens : undefined,
  }
}

export interface ToolCall {
  callId: string
  name: string
  /** The raw JSON string the model produced, unparsed — dsh does not parse it either. */
  arguments: string
}

/** A `tool/call` event's identity and raw arguments. */
export function toolCallOf(event: SessionEvent): ToolCall | undefined {
  if (!isRecord(event.data)) return undefined
  const callId = asString(event.data.callId)
  const name = asString(event.data.name)
  if (callId === undefined || name === undefined) return undefined
  return { callId, name, arguments: asString(event.data.arguments) ?? '' }
}

export interface ToolResult {
  callId: string
  /** The model-facing result text. */
  text: string
  isError: boolean
}

/** A `tool/result` event, reduced to what a card shows. */
export function toolResultOf(event: SessionEvent): ToolResult | undefined {
  if (!isRecord(event.data)) return undefined
  const message = event.data.message
  if (!isRecord(message)) return undefined
  const content = message.content
  if (!Array.isArray(content) || content.length === 0) return undefined
  const block = content[0] as { toolCallId?: unknown; content?: unknown; isError?: unknown }
  const callId = asString(block.toolCallId)
  if (callId === undefined) return undefined
  const inner = Array.isArray(block.content) ? block.content as ContentBlock[] : undefined
  return {
    callId,
    text: textOf(inner),
    isError: block.isError === true || isRecord(event.data.error),
  }
}

/** One `assistant/chunk` delta, already narrowed to the three kinds we render. */
export type StreamDelta =
  | { kind: 'text'; text: string }
  | { kind: 'reasoning'; text: string }
  | { kind: 'tool-arguments'; callId: string; name?: string; delta: string }
  | { kind: 'usage'; usage: TokenUsage }

/** Narrows an `assistant/chunk` event to a delta this extension renders, if any. */
export function chunkDelta(event: SessionEvent): StreamDelta | undefined {
  if (!isRecord(event.data)) return undefined
  const chunk = event.data.chunk
  if (!isRecord(chunk)) return undefined
  switch (chunk.type) {
    case 'text-delta': {
      const text = asString(chunk.text)
      return text === undefined ? undefined : { kind: 'text', text }
    }
    case 'reasoning-delta': {
      const text = asString(chunk.text)
      return text === undefined ? undefined : { kind: 'reasoning', text }
    }
    case 'tool-call-delta': {
      const callId = asString(chunk.id)
      if (callId === undefined) return undefined
      return {
        kind: 'tool-arguments',
        callId,
        name: asString(chunk.name),
        delta: asString(chunk.argumentsDelta) ?? '',
      }
    }
    case 'usage': {
      const usage = usageOf({ ...event, data: chunk })
      return usage === undefined ? undefined : { kind: 'usage', usage }
    }
    default:
      return undefined
  }
}
