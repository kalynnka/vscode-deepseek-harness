import * as vscode from 'vscode'
import type { Harness } from '../dsh/harness'
import type { Log } from '../log'
import type { HistoryEntry, PromptContentPart, SessionId } from '../dsh/wire'
import { foldHistory } from './history'
import type { ProjectionStore } from './projections'
import type { SessionItems } from './items'
import { sessionIdOf } from './resource'
import { TurnRenderer } from './stream'
import { SECTION } from '../config'

/**
 * How many past messages the first page asks for, when the setting does not say.
 *
 * Deliberately small. `session.history` returns every raw event those messages
 * own, and on a real session ~100% of those are token-level `assistant/chunk`
 * records that the fold immediately discards — 20 messages measured at 10 MB
 * of JSON, 60 at 15 MB. There is no request flag to exclude them, so the page
 * size is the only lever. See docs/gaps.md §1.
 */
const DEFAULT_PAGE_MESSAGES = 10

/**
 * Serves one session's content to the native chat UI: its past turns, its live
 * turn, and the handler that starts a new one.
 */
export class SessionContent implements vscode.ChatSessionContentProvider {
  constructor(
    private readonly harness: Harness,
    private readonly projections: ProjectionStore,
    private readonly items: SessionItems,
    private readonly log: Log,
  ) {}

  async provideChatSessionContent(
    resource: vscode.Uri,
    token: vscode.CancellationToken,
  ): Promise<vscode.ChatSession> {
    const sessionId = sessionIdOf(resource)
    if (sessionId === undefined) {
      throw new Error(`not a DeepSeek Harness session resource: ${resource.toString()}`)
    }

    const entries = await this.readHistory(sessionId, token)
    const reachable = this.harness.client !== undefined

    return {
      title: this.projections.title(sessionId),
      history: foldHistory(entries),
      // An unreachable harness renders the transcript read-only rather than
      // offering a composer whose every send would fail.
      requestHandler: reachable ? this.handlerFor(sessionId) : undefined,
      activeResponseCallback: this.items.isRunning(sessionId)
        ? (stream, callbackToken) => this.attach(sessionId, stream, callbackToken)
        : undefined,
    }
  }

  /** Sends a prompt, then renders the turn it starts. */
  private handlerFor(sessionId: SessionId): vscode.ChatRequestHandler {
    return async (request, _context, stream, token): Promise<vscode.ChatResult> => {
      const client = this.harness.client
      if (client === undefined) {
        stream.warning('The harness is not running. Try "DeepSeek Harness: Restart Harness Process".')
        return {}
      }

      // Subscribe before sending: the first events can land before the POST
      // returns, and a renderer created afterwards would miss them.
      const renderer = new TurnRenderer(this.harness, sessionId, stream, this.log, token,
        (kind, pending) => this.items.markPending(sessionId, kind, pending))
      try {
        const content: PromptContentPart[] = [{ type: 'text', text: request.prompt }]
        const sent = await client.call('session.prompt', {
          sessionId,
          mode: 'queue',
          content,
          clientTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        })
        if (!sent.ok) {
          renderer.dispose()
          return this.failure(stream, sent.error.code, sent.error.message)
        }
        // A slash command is executed by the host and never reaches the model,
        // so it produces no turn to wait for.
        if (sent.value.command !== undefined) {
          renderer.dispose()
          const text = sent.value.command.text
          if (text !== undefined && text.trim() !== '') stream.markdown(text)
          return {}
        }
        await renderer.wait()
        return {}
      } finally {
        renderer.dispose()
      }
    }
  }

  /**
   * Renders a turn this window did not start.
   *
   * dsh sessions are shared: another editor window, the web UI, or a scheduled
   * job can be mid-turn when this session is opened. The editor calls this so
   * that turn streams in rather than appearing only once it has finished.
   */
  private async attach(
    sessionId: SessionId,
    stream: vscode.ChatResponseStream,
    token: vscode.CancellationToken,
  ): Promise<void> {
    const renderer = new TurnRenderer(this.harness, sessionId, stream, this.log, token,
        (kind, pending) => this.items.markPending(sessionId, kind, pending))
    try {
      await renderer.wait()
    } finally {
      renderer.dispose()
    }
  }

  private failure(stream: vscode.ChatResponseStream, code: string, message: string): vscode.ChatResult {
    this.log.error(`session.prompt failed: ${code}: ${message}`)
    stream.warning(message)
    return { errorDetails: { message } }
  }

  /** Reads the tail page, which is also the page that carries the projection baseline. */
  private async readHistory(sessionId: SessionId, token: vscode.CancellationToken): Promise<HistoryEntry[]> {
    let client
    try {
      client = await this.harness.ensureStarted()
    } catch {
      return []
    }
    if (token.isCancellationRequested) return []

    const maxMessages = vscode.workspace
      .getConfiguration(SECTION)
      .get<number>('historyPageMessages', DEFAULT_PAGE_MESSAGES)
    const result = await client.call('session.history', { sessionId, maxMessages })
    if (!result.ok) {
      this.log.error(`session.history failed for ${sessionId}: ${result.error.code}: ${result.error.message}`)
      return []
    }
    this.projections.seed(sessionId, result.value.projections)
    return result.value.events
  }
}
