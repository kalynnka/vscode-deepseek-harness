import * as vscode from 'vscode'
import {
  messageContent, messageSourceKind, provenanceOf, requestRouteOf, textOf, toolCallOf, toolResultOf, usageOf,
  type ContentBlock, type ModelRoute, type TokenUsage,
} from '../dsh/events'
import type { HistoryEntry, SessionEvent } from '../dsh/wire'
import { stripEditorContext } from './references'
import { SESSION_TYPE } from './resource'
import { describeTurn, sumUsage } from './stream'

/**
 * The participant id, which must equal the chat session type.
 *
 * When a session contribution sets `canDelegate`, VS Code's main thread
 * registers an agent whose id *is* the session type and then calls
 * `updateAgent` on it. That throws `No activated agent with id …` unless the
 * extension host has registered a participant under exactly that id to supply
 * the implementation. Naming this anything else — `deepseek-harness.agent` was
 * the first attempt — leaves the agent half-registered and every request fails.
 *
 * Matching the type also removes the need for a `contributes.chatParticipants`
 * entry: `$registerAgent` accepts an id that names a known session type.
 */
export const PARTICIPANT = SESSION_TYPE

type ResponsePart = ConstructorParameters<typeof vscode.ChatResponseTurn2>[0][number]

/**
 * Whether one log entry is a human prompt — exactly the entries
 * {@link foldHistory} opens a request turn for.
 *
 * The history pager needs the same judgement: the editor silently drops every
 * response turn that precedes the first request turn it is given, so a window
 * with no entry passing this predicate renders as an empty transcript, and
 * paging must continue until one is in. Sharing the predicate is what keeps
 * "worth stopping for" and "renders as a request" from drifting apart.
 */
export function isHumanPrompt(entry: HistoryEntry): boolean {
  const event = entry.event
  if (event.type !== 'user/message') return false
  if (messageSourceKind(event) !== 'user') return false
  return textOf(messageContent(event)).trim() !== ''
}

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
 *   duplicate every token. The reader drops them page by page before the fold
 *   ever sees them (`SessionContent.pageHistory`), so this holds whether or not
 *   any reach here.
 * - Reasoning blocks are dropped from history. `ChatResponseTurn2.response`
 *   accepts no thinking part; live turns render reasoning through
 *   `thinkingProgress`, which has no historical counterpart.
 * - Non-human `user/message` events — dsh injecting skills, file-change
 *   notices, AGENTS.md — are not turned into prompts, because attributing them
 *   to the user would misrepresent the conversation.
 *
 * `modelName` renders the route a turn ran on for its footer. It is the
 * session's own model catalog, which this module has no way to reach, so it
 * arrives as a function; without it the footer still carries the counts.
 */
export function foldHistory(
  entries: readonly HistoryEntry[],
  modelName?: (route: ModelRoute) => string | undefined,
): (vscode.ChatRequestTurn | vscode.ChatResponseTurn2)[] {
  const turns: (vscode.ChatRequestTurn | vscode.ChatResponseTurn2)[] = []
  let response: ResponsePart[] = []
  /** Tool invocations awaiting their result, so a result can complete its card. */
  const pending = new Map<string, vscode.ChatToolInvocationPart>()
  /** What the open response turn will say about itself in its footer. */
  let route: ModelRoute | undefined
  let usage: TokenUsage | undefined
  let completedAt: number | undefined

  const flush = (): void => {
    if (response.length > 0) {
      const details = describeTurn(route === undefined ? undefined : modelName?.(route), usage, completedAt)
      turns.push(new vscode.ChatResponseTurn2(response, details === undefined ? {} : { details }, PARTICIPANT))
      response = []
      pending.clear()
    }
    // Cleared even when nothing was pushed: a prompt whose answer this window
    // has not read yet must not inherit the previous turn's accounting.
    route = undefined
    usage = undefined
    completedAt = undefined
  }

  for (const entry of entries) {
    const event = entry.event
    switch (event.type) {
      case 'user/message': {
        if (!isHumanPrompt(entry)) break
        flush()
        turns.push(requestTurn(promptText(event), event.seq))
        break
      }

      case 'assistant/message': {
        const stepUsage = usageOf(event)
        if (stepUsage !== undefined) usage = sumUsage(usage, stepUsage)
        route = provenanceOf(event) ?? route
        for (const part of assistantParts(messageContent(event), pending)) response.push(part)
        break
      }

      // Named before the step runs, so a turn that failed or was cancelled
      // without committing a message is still attributed to a model — the same
      // reason the live renderer reads it.
      case 'request/context':
        route = requestRouteOf(event) ?? route
        break

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

    // Every event of a turn is a moment that turn was still running, so the
    // last one before the next prompt is the closest the log comes to saying
    // when it finished — `turn/end` is usually that event, and needs no case
    // of its own. Recorded after the switch so the prompt that *opens* a turn
    // cannot stamp the turn it closes.
    if (turns.length > 0) completedAt = event.time
  }

  flush()
  return turns
}

/**
 * One human prompt as the user wrote it, rather than as it was sent.
 *
 * dsh's prompt content has no attachment slot (docs/gaps.md §10), so the
 * composer's chips travel as prose inside an `<editor-context>` envelope that
 * the live turn never rendered — the editor shows the typed prompt and the
 * chips beside it. Rebuilding the turn from the raw text is what made a
 * reopened session display markup the same conversation had not displayed
 * while it ran.
 *
 * A prompt that was nothing but attachments keeps its raw text: history
 * cannot rebuild the chips either, so an empty bubble would say less about
 * what was sent than the prose does. {@link isHumanPrompt} judges the raw
 * text for the same reason — such an entry is still a human prompt, and the
 * pager must stop for it.
 */
function promptText(event: SessionEvent): string {
  const raw = textOf(messageContent(event))
  const typed = stripEditorContext(raw)
  return typed.trim() === '' ? raw : typed
}

/**
 * `ChatRequestTurn`'s own constructor is private, but the editor exports one
 * class under both names, so the `ChatRequestTurn2` declaration is the way to
 * build the instance the history array wants.
 *
 * The turn's id carries the event seq that produced it. That is what makes
 * "fork from here" exact: the fork handler is given a request turn and has to
 * turn it back into a position in dsh's log, and nothing else in the turn
 * survives the round trip.
 */
function requestTurn(prompt: string, seq: number): vscode.ChatRequestTurn {
  return new vscode.ChatRequestTurn2(
    prompt, undefined, [], PARTICIPANT, [], undefined, turnId(seq), undefined, undefined,
  ) as unknown as vscode.ChatRequestTurn
}

/** Encodes a log position into a turn id. */
export function turnId(seq: number): string {
  return `dsh-seq:${String(seq)}`
}

/** Reads a log position back out of a turn id; undefined when it is not one of ours. */
export function seqOfTurnId(id: string | undefined): number | undefined {
  if (id === undefined) return undefined
  const match = /^dsh-seq:(\d+)$/.exec(id)
  if (match === null) return undefined
  return Number(match[1])
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
