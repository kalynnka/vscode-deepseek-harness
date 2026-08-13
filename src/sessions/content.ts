import * as vscode from 'vscode'
import type { Harness } from '../dsh/harness'
import type { Log } from '../log'
import type { HistoryEntry } from '../dsh/wire'
import { foldHistory } from './history'
import type { ProjectionStore } from './projections'
import { sessionIdOf } from './resource'
import { SECTION } from '../config'

/**
 * How many append-origin messages the first page asks for, when the setting
 * does not say.
 *
 * Deliberately small. `session.history` returns every raw event those messages
 * own, and on a real session ~100% of those are token-level `assistant/chunk`
 * records that the fold immediately discards — 20 messages measured at 10 MB
 * of JSON, 60 at 15 MB. There is no request flag to exclude them, so the page
 * size is the only lever. See docs/gaps.md §1.
 */
const DEFAULT_PAGE_MESSAGES = 10

/**
 * Serves one session's content to the native chat UI.
 *
 * At this milestone every session is read-only: `requestHandler` is undefined,
 * which the editor renders as a browsable transcript with no composer. That is
 * a genuinely useful state rather than a stub — it is also what a session
 * should degrade to when the harness is unreachable.
 */
export class SessionContent implements vscode.ChatSessionContentProvider {
  constructor(
    private readonly harness: Harness,
    private readonly projections: ProjectionStore,
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
    return {
      title: this.projections.title(sessionId),
      history: foldHistory(entries),
      requestHandler: undefined,
    }
  }

  /** Reads the tail page, which is also the page that carries the projection baseline. */
  private async readHistory(sessionId: string, token: vscode.CancellationToken): Promise<HistoryEntry[]> {
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
