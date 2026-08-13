import * as vscode from 'vscode'
import type { Harness } from '../dsh/harness'
import type { Log } from '../log'
import type { HistoryEntry, PromptContentPart, SessionId } from '../dsh/wire'
import { foldHistory } from './history'
import type { ProjectionStore } from './projections'
import type { SessionItems } from './items'
import { isUntitled, sessionIdOf } from './resource'
import { TurnRenderer } from './stream'
import { applySelection, buildGroups } from './options'
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
  /** Placeholder resource id to the dsh session its first prompt created. */
  private readonly adopted = new Map<string, SessionId>()

  constructor(
    private readonly harness: Harness,
    private readonly projections: ProjectionStore,
    private readonly items: SessionItems,
    private readonly log: Log,
  ) {}

  async provideChatSessionContent(
    resource: vscode.Uri,
    token: vscode.CancellationToken,
    context: { readonly inputState: vscode.ChatSessionInputState },
  ): Promise<vscode.ChatSession> {
    const sessionId = sessionIdOf(resource)
    if (sessionId === undefined) {
      throw new Error(`not a DeepSeek Harness session resource: ${resource.toString()}`)
    }
    this.log.info(`provideChatSessionContent ${resource.toString()} (untitled=${String(isUntitled(sessionId))})`)

    // The editor opens a new chat against a placeholder resource before any
    // session exists. There is nothing to read and nothing to configure yet —
    // the real dsh session is created by the first prompt.
    if (isUntitled(sessionId)) {
      return { history: [], requestHandler: this.newSessionHandlerFor(sessionId) }
    }

    const entries = await this.readHistory(sessionId, token)
    const reachable = this.harness.client !== undefined
    const options = await this.wirePickers(sessionId, context.inputState)

    return {
      title: this.projections.title(sessionId),
      history: foldHistory(entries),
      options,
      // An unreachable harness renders the transcript read-only rather than
      // offering a composer whose every send would fail.
      requestHandler: reachable ? this.handlerFor(sessionId) : undefined,
      activeResponseCallback: this.items.isRunning(sessionId)
        ? (stream, callbackToken) => this.attach(sessionId, stream, callbackToken)
        : undefined,
    }
  }

  /**
   * Fills the session header's pickers and keeps dsh in step with them.
   *
   * The catalog is read per session rather than once per window: `session.models`
   * is documented as a *fresh* advisory lookup, and which routes are live can
   * change under us while the editor is open.
   */
  private async wirePickers(
    sessionId: SessionId,
    inputState: vscode.ChatSessionInputState,
  ): Promise<Record<string, string> | undefined> {
    const client = this.harness.client
    if (client === undefined) return undefined

    const result = await client.call('session.models', { sessionId })
    if (!result.ok) {
      // `agent-busy` is the expected answer for a subagent-backed session, not
      // a failure worth putting in front of the user.
      this.log.info(`session.models unavailable for ${sessionId}: ${result.error.code}`)
      return undefined
    }
    let models = result.value
    if (!models.routable) {
      this.log.warn(`no adapter serves ${models.current.provider}; this session cannot start a turn`)
    }

    inputState.groups = buildGroups(models)
    const subscription = inputState.onDidChange(() => {
      void (async () => {
        const selected = await applySelection(client, sessionId, models, inputState.groups, this.log)
        if (selected === undefined) return
        // Re-read so the effort group follows the model that was just picked.
        const refreshed = await client.call('session.models', { sessionId })
        if (!refreshed.ok) return
        models = refreshed.value
        inputState.groups = buildGroups(models)
      })()
    })
    inputState.onDidDispose(() => { subscription.dispose() })

    const options: Record<string, string> = {}
    for (const group of inputState.groups) {
      if (group.selected !== undefined) options[group.id] = group.selected.id
    }
    return options
  }

  /**
   * Handles the first prompt of a brand-new chat.
   *
   * dsh has no session yet, so one is created here and then driven exactly
   * like any other. The placeholder resource is remembered against the real
   * id, so a second prompt in the same untitled editor continues the same
   * conversation instead of starting another one.
   */
  private newSessionHandlerFor(placeholder: string): vscode.ChatRequestHandler {
    return async (request, context, stream, token) => {
      const existing = this.adopted.get(placeholder)
      if (existing !== undefined) {
        return await this.handlerFor(existing)(request, context, stream, token)
      }

      const client = this.harness.client
      if (client === undefined) {
        stream.warning('The harness is not running. Try "DeepSeek Harness: Restart Harness Process".')
        return {}
      }

      const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
      const created = await client.call('session.create', cwd === undefined ? {} : { cwd })
      if (!created.ok) {
        return this.failure(stream, created.error.code, created.error.message)
      }
      const sessionId = created.value.sessionId
      this.adopted.set(placeholder, sessionId)
      this.log.info(`created session ${sessionId} for ${placeholder}`)
      void this.items.refresh()

      return await this.handlerFor(sessionId)(request, context, stream, token)
    }
  }

  /**
   * Handles a request that arrived through the chat **agent** rather than
   * through a session's own `requestHandler`.
   *
   * Both routes exist and either can fire. A session opened as an editor calls
   * the `requestHandler` returned by `provideChatSessionContent`; a request
   * routed to the registered agent — which is what `canDelegate` creates —
   * lands here instead, carrying the session it belongs to in
   * `context.chatSessionContext`. A participant that assumes the other route
   * will always win renders an empty bubble and logs nothing.
   */
  async handleAgentRequest(
    request: vscode.ChatRequest,
    context: vscode.ChatContext,
    stream: vscode.ChatResponseStream,
    token: vscode.CancellationToken,
  ): Promise<vscode.ChatResult> {
    const resource = context.chatSessionContext?.chatSessionItem.resource
    const sessionId = resource === undefined ? undefined : sessionIdOf(resource)
    this.log.info(`agent request routed for ${sessionId ?? 'no session context'}`)

    if (sessionId === undefined) {
      // No session context: the user invoked the agent from ordinary chat.
      // Starting a dsh session per stray mention would litter their history.
      stream.warning('Open a DeepSeek Harness session first — Command Palette: "New DeepSeek Harness Session".')
      return {}
    }
    const handler = isUntitled(sessionId) ? this.newSessionHandlerFor(sessionId) : this.handlerFor(sessionId)
    return await handler(request, context, stream, token) ?? {}
  }

  /** Sends a prompt, then renders the turn it starts. */
  private handlerFor(sessionId: SessionId): vscode.ChatRequestHandler {
    return async (request, _context, stream, token): Promise<vscode.ChatResult> => {
      this.log.info(`request for ${sessionId}: ${JSON.stringify(request.prompt.slice(0, 60))}`)
      const client = this.harness.client
      if (client === undefined) {
        this.log.error('request arrived with no harness client')
        stream.warning('The harness is not running. Try "DeepSeek Harness: Restart Harness Process".')
        return {}
      }

      // Subscribe before sending: the first events can land before the POST
      // returns, and a renderer created afterwards would miss them.
      const renderer = new TurnRenderer(this.harness, sessionId, stream, this.log, token,
        (kind, pending) => this.items.markPending(sessionId, kind, pending))
      // The editor's stop button cancels this token. It must reach dsh, or the
      // agent keeps working while the UI says it stopped. dsh's cancel aborts
      // only the active turn and preserves pending inbox work.
      token.onCancellationRequested(() => { void this.cancel(sessionId) })
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
        this.log.info(`prompt accepted for ${sessionId}; awaiting turn`)
        await renderer.wait()
        this.log.info(`turn finished for ${sessionId}`)
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
    token.onCancellationRequested(() => { void this.cancel(sessionId) })
    try {
      await renderer.wait()
    } finally {
      renderer.dispose()
    }
  }

  /** Stops the session's active turn. */
  private async cancel(sessionId: SessionId): Promise<void> {
    const client = this.harness.client
    if (client === undefined) return
    const result = await client.call('session.cancel', { sessionId })
    if (!result.ok) this.log.error(`session.cancel failed: ${result.error.code}: ${result.error.message}`)
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
