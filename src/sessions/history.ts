import * as vscode from 'vscode'
import {
  messageContent, messageSourceKind, textOf, toolCallOf, toolResultOf,
  type ContentBlock,
} from '../dsh/events'
import type { HistoryEntry } from '../dsh/wire'

/** The participant id recorded on every response turn we synthesize. */
export const PARTICIPANT = 'deepseek-harness.agent'

type ResponsePart = ConstructorParameters<typeof vscode.ChatResponseTurn2>[0][number]

/**
 * Rebuilds a conversation from dsh's event log into the turn pair VS Code
 * renders.
 *
 * dsh's log is finer-grained than the chat model: one human prompt can be
 * followed by many assistant messages, tool calls and results across several
 * steps, all of which the editor shows as a single response turn. So the fold
 * opens a response on the first assistant-side event after a human prompt and
 * closes it at the next human prompt.
 *
 * Deliberate omissions, each because the target model has no slot for it:
 *
 * - `assistant/chunk` events are skipped entirely. The committed
 *   `assistant/message` carries the same text, and replaying deltas would
 *   duplicate every token.
 * - Reasoning blocks are dropped from history. `ChatResponseTurn2.response`
 *   accepts no thinking part; live turns render reasoning through
 *   `thinkingProgress`, which has no historical counterpart.
 * - Non-human `user/message` events — dsh injecting skills, file-change
 *   notices, AGENTS.md — are not turned into prompts, because attributing them
 *   to the user would misrepresent the conversation.
 */
export function foldHistory(entries: readonly HistoryEntry[]): (vscode.ChatRequestTurn | vscode.ChatResponseTurn2)[] {
  const turns: (vscode.ChatRequestTurn | vscode.ChatResponseTurn2)[] = []
  let response: ResponsePart[] = []
  /** Tool invocations awaiting their result, so a result can complete its card. */
  const pending = new Map<string, vscode.ChatToolInvocationPart>()

  const flush = (): void => {
    if (response.length === 0) return
    turns.push(new vscode.ChatResponseTurn2(response, {}, PARTICIPANT))
    response = []
    pending.clear()
  }

  for (const entry of entries) {
    const event = entry.event
    switch (event.type) {
      case 'user/message': {
        if (messageSourceKind(event) !== 'user') break
        const prompt = textOf(messageContent(event))
        if (prompt.trim() === '') break
        flush()
        turns.push(requestTurn(prompt))
        break
      }

      case 'assistant/message': {
        for (const part of assistantParts(messageContent(event), pending)) response.push(part)
        break
      }

      case 'tool/call': {
        const call = toolCallOf(event)
        if (call === undefined) break
        response.push(toolInvocation(call.callId, call.name, call.arguments, pending))
        break
      }

      case 'tool/result': {
        const result = toolResultOf(event)
        if (result === undefined) break
        const part = pending.get(result.callId)
        if (part === undefined) break
        part.isComplete = true
        part.isError = result.isError
        if (result.text.trim() !== '') {
          part.pastTenseMessage = new vscode.MarkdownString(truncateForCard(result.text))
        }
        pending.delete(result.callId)
        break
      }

      default:
        // Every other event type — turn/step boundaries, todos, compaction
        // records, plan mode, approvals already resolved — has no history
        // rendering. Ignoring them is correct, not a gap.
        break
    }
  }

  flush()
  return turns
}

/**
 * `ChatRequestTurn`'s own constructor is private, but the editor exports one
 * class under both names, so the `ChatRequestTurn2` declaration is the way to
 * build the instance the history array wants.
 */
function requestTurn(prompt: string): vscode.ChatRequestTurn {
  return new vscode.ChatRequestTurn2(
    prompt, undefined, [], PARTICIPANT, [], undefined, undefined, undefined, undefined,
  ) as unknown as vscode.ChatRequestTurn
}

/** Turns one assistant message's blocks into response parts. */
function* assistantParts(
  blocks: ContentBlock[] | undefined,
  pending: Map<string, vscode.ChatToolInvocationPart>,
): Generator<ResponsePart> {
  if (blocks === undefined) return
  for (const block of blocks) {
    switch (block.type) {
      case 'text': {
        const text = typeof (block as { text?: unknown }).text === 'string' ? (block as { text: string }).text : ''
        if (text.trim() !== '') yield new vscode.ChatResponseMarkdownPart(new vscode.MarkdownString(text))
        break
      }
      case 'tool-call': {
        const call = block as { id?: string; name?: string; arguments?: string }
        if (typeof call.id !== 'string' || typeof call.name !== 'string') break
        yield toolInvocation(call.id, call.name, call.arguments ?? '', pending)
        break
      }
      default:
        // reasoning, image and anything a newer dsh adds: no history slot.
        break
    }
  }
}

/** Builds a tool card and registers it so its result can complete it later. */
function toolInvocation(
  callId: string,
  name: string,
  rawArguments: string,
  pending: Map<string, vscode.ChatToolInvocationPart>,
): vscode.ChatToolInvocationPart {
  const part = new vscode.ChatToolInvocationPart(name, callId)
  part.isConfirmed = true
  part.isComplete = false
  const summary = summarizeArguments(rawArguments)
  if (summary !== undefined) part.invocationMessage = new vscode.MarkdownString(summary)
  pending.set(callId, part)
  return part
}

/**
 * A one-line account of a tool call's arguments for the collapsed card.
 *
 * The arguments are the model's raw JSON string, which dsh does not parse
 * either; a call whose JSON never finished streaming is normal, so failure to
 * parse means "say nothing", not "show a broken card".
 */
function summarizeArguments(raw: string): string | undefined {
  if (raw.trim() === '') return undefined
  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) return undefined
    const entries = Object.entries(parsed as Record<string, unknown>)
    if (entries.length === 0) return undefined
    const rendered = entries
      .slice(0, 3)
      .map(([key, value]) => `${key}: ${oneLine(value)}`)
      .join(', ')
    return '`' + rendered + '`'
  } catch {
    return undefined
  }
}

function oneLine(value: unknown): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value) ?? String(value)
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > 60 ? `${flat.slice(0, 59)}…` : flat
}

/** Tool output can be a whole file; the card shows the head of it. */
function truncateForCard(text: string): string {
  const limit = 2000
  return text.length <= limit ? text : `${text.slice(0, limit)}\n\n…(${text.length - limit} more characters)`
}
