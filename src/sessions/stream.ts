import * as vscode from 'vscode'
import type { Harness } from '../dsh/harness'
import type { Log } from '../log'
import type { Envelope, MuxFrame, RpcId, SessionId } from '../dsh/wire'
import { chunkDelta, toolCallOf, toolResultOf, usageOf, type TokenUsage } from '../dsh/events'
import { askApproval, askQuestions, respondToApproval, respondToQuestions } from './interaction'
import type { PendingKind } from './items'

/** Told when this session starts or stops blocking on the user. */
export type PendingReporter = (kind: PendingKind, pending: boolean) => void

/**
 * Renders one live turn of a session into a chat response stream.
 *
 * The renderer reads deltas, not committed messages: `assistant/chunk` is what
 * makes text appear as it is produced, and the `assistant/message` that follows
 * carries the same text again. So chunks drive the prose, and the committed
 * message is read only for the one thing chunks do not reliably carry — the
 * step's token accounting.
 *
 * It resolves on `turn/end`. A turn that ends because the user cancelled ends
 * the same way, which is why cancellation needs no separate path here.
 */
export class TurnRenderer {
  private readonly subscription: vscode.Disposable
  private readonly done: Promise<void>
  private finish: (() => void) | undefined
  /** Tool calls begun on the stream, so a result can complete the right card. */
  private readonly openCalls = new Map<string, { name: string; args: string }>()
  /** Interaction rpcIds already being answered, so a mux replay cannot ask twice. */
  private readonly answering = new Set<RpcId>()
  private usage: TokenUsage | undefined
  private settled = false
  /** Frames routed to this turn, so a silent turn can be told from an unrouted one. */
  private seen = 0

  constructor(
    private readonly harness: Harness,
    private readonly sessionId: SessionId,
    private readonly stream: vscode.ChatResponseStream,
    private readonly log: Log,
    token: vscode.CancellationToken,
    private readonly reportPending?: PendingReporter,
  ) {
    this.done = new Promise<void>(resolve => { this.finish = resolve })
    this.subscription = this.harness.onMuxFrame(envelope => this.onEnvelope(envelope))
    token.onCancellationRequested(() => { this.settle() })
  }

  /** Resolves when the turn closes, or when the caller's token is cancelled. */
  async wait(): Promise<void> {
    await this.done
  }

  dispose(): void {
    this.subscription.dispose()
  }

  private settle(): void {
    if (this.settled) return
    this.settled = true
    this.log.info(`turn settled for ${this.sessionId} after ${String(this.seen)} frames`)
    this.flushUsage()
    this.subscription.dispose()
    this.finish?.()
  }

  /**
   * Token accounting is reported once, at the end.
   *
   * dsh reports usage per step and a turn is many steps, so emitting each one
   * would make the figure jump around while reading as a total. Summing and
   * reporting once is the honest rendering of what the turn cost.
   */
  private flushUsage(): void {
    if (this.usage === undefined) return
    const cacheRead = this.usage.cacheReadTokens ?? 0
    const cacheWrite = this.usage.cacheWriteTokens ?? 0
    // dsh's buckets are disjoint: `inputTokens` is uncached input only, so the
    // billed prompt is the sum of the three.
    const promptTokens = this.usage.inputTokens + cacheRead + cacheWrite
    // The breakdown is a percentage, so it means nothing without a prompt to
    // take a percentage of.
    const details = promptTokens > 0 && cacheRead + cacheWrite > 0
      ? [
        { category: 'Cache', label: 'Cache read', percentageOfPrompt: (cacheRead / promptTokens) * 100 },
        { category: 'Cache', label: 'Cache write', percentageOfPrompt: (cacheWrite / promptTokens) * 100 },
      ]
      : undefined
    this.stream.usage({ promptTokens, completionTokens: this.usage.outputTokens, promptTokenDetails: details })
    this.usage = undefined
  }

  private addUsage(usage: TokenUsage): void {
    const total = this.usage
    this.usage = total === undefined ? { ...usage } : {
      inputTokens: total.inputTokens + usage.inputTokens,
      outputTokens: total.outputTokens + usage.outputTokens,
      cacheReadTokens: (total.cacheReadTokens ?? 0) + (usage.cacheReadTokens ?? 0),
      cacheWriteTokens: (total.cacheWriteTokens ?? 0) + (usage.cacheWriteTokens ?? 0),
      reasoningTokens: (total.reasoningTokens ?? 0) + (usage.reasoningTokens ?? 0),
    }
  }

  private onEnvelope(envelope: Envelope<MuxFrame>): void {
    if (this.settled) return
    const frame = envelope.payload
    const sessionId = (frame as { sessionId?: unknown }).sessionId
    if (sessionId !== this.sessionId) return
    this.seen += 1
    if (frame.type === 'session/event') {
      this.log.debug(`frame ${String(this.seen)}: ${(frame as Extract<MuxFrame, { type: 'session/event' }>).event.type}`)
    } else {
      this.log.debug(`frame ${String(this.seen)}: ${frame.type}`)
    }

    if (frame.type === 'question/requested' || frame.type === 'approval/requested') {
      if (this.answering.has(envelope.rpcId)) return
      this.answering.add(envelope.rpcId)
      void this.onInteraction(frame, envelope.rpcId)
      return
    }

    if (frame.type === 'session/event') {
      this.onSessionEvent(frame as Extract<MuxFrame, { type: 'session/event' }>)
    }
  }

  private onSessionEvent(frame: Extract<MuxFrame, { type: 'session/event' }>): void {
    const event = frame.event
    switch (event.type) {
      case 'assistant/chunk': {
        const delta = chunkDelta(event)
        if (delta === undefined) break
        switch (delta.kind) {
          case 'text':
            this.stream.markdown(delta.text)
            break
          case 'reasoning':
            this.stream.thinkingProgress({ text: delta.text, id: `${this.sessionId}:${String(event.seq)}` })
            break
          case 'tool-arguments': {
            // The card appears as soon as the model names the call, so a slow
            // tool is visible while its arguments are still streaming.
            const open = this.openCalls.get(delta.callId)
            if (open === undefined) {
              if (delta.name === undefined) break
              this.openCalls.set(delta.callId, { name: delta.name, args: delta.delta })
              this.stream.beginToolInvocation(delta.callId, delta.name, { partialInput: delta.delta })
            } else {
              open.args += delta.delta
              this.stream.updateToolInvocation(delta.callId, { partialInput: open.args })
            }
            break
          }
          case 'usage':
            this.addUsage(delta.usage)
            break
        }
        break
      }

      case 'assistant/message': {
        const usage = usageOf(event)
        if (usage !== undefined) this.addUsage(usage)
        break
      }

      case 'tool/call': {
        const call = toolCallOf(event)
        if (call === undefined) break
        if (this.openCalls.has(call.callId)) break
        this.openCalls.set(call.callId, { name: call.name, args: call.arguments })
        this.stream.beginToolInvocation(call.callId, call.name, { partialInput: call.arguments })
        break
      }

      case 'tool/result': {
        const result = toolResultOf(event)
        if (result === undefined) break
        const open = this.openCalls.get(result.callId)
        if (open === undefined) break
        this.openCalls.delete(result.callId)
        const part = new vscode.ChatToolInvocationPart(open.name, result.callId)
        part.isConfirmed = true
        part.isComplete = true
        part.isError = result.isError
        if (result.text.trim() !== '') {
          part.pastTenseMessage = new vscode.MarkdownString(truncateForCard(result.text))
        }
        this.stream.push(part)
        break
      }

      case 'llm/retry-started':
        this.stream.warning('The model call failed; retrying.')
        break

      case 'turn/end':
        this.settle()
        break

      default:
        // Boundary markers, todos, compaction records, plan mode and anything a
        // newer dsh adds have no live rendering of their own.
        break
    }
  }

  /**
   * Answers a question or approval the agent is blocked on.
   *
   * These are answerable server-requests whose rpcId must be echoed verbatim.
   * The mux replays still-pending ones whenever a stream reopens, so the same
   * request can arrive twice; `answering` keeps the second delivery from
   * putting a duplicate prompt in front of the user.
   */
  private async onInteraction(frame: MuxFrame, rpcId: RpcId): Promise<void> {
    const client = this.harness.client
    if (client === undefined) return

    try {
      if (frame.type === 'question/requested') {
        const request = frame as Extract<MuxFrame, { type: 'question/requested' }>
        this.reportPending?.('question', true)
        try {
          const answers = await askQuestions(this.stream, request.questions)
          await respondToQuestions(client, rpcId, this.sessionId, answers)
        } finally {
          this.reportPending?.('question', false)
        }
        return
      }

      const request = frame as Extract<MuxFrame, { type: 'approval/requested' }>
      this.reportPending?.('approval', true)
      try {
        const outcome = await askApproval(this.stream, request.toolName, request.reason)
        await respondToApproval(client, rpcId, this.sessionId, request.approvalId, outcome)
      } finally {
        this.reportPending?.('approval', false)
      }
    } catch (error) {
      // A failed prompt must not leave the agent blocked forever with no sign
      // of why, so it is logged and the turn carries on.
      this.log.error(`interaction failed in ${this.sessionId}: ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      this.answering.delete(rpcId)
    }
  }
}

/** Tool output can be a whole file; the card shows the head of it. */
function truncateForCard(text: string): string {
  const limit = 2000
  return text.length <= limit ? text : `${text.slice(0, limit)}\n\n…(${text.length - limit} more characters)`
}
