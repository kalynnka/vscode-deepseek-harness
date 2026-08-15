import * as vscode from 'vscode'
import type { Harness } from '../dsh/harness'
import type { Log } from '../log'
import type { HistoryEntry, PromptContentPart, SessionId } from '../dsh/wire'
import { foldHistory, isHumanPrompt } from './history'
import type { ProjectionStore } from './projections'
import type { SessionItems } from './items'
import { isUntitled, sessionIdOf, sessionResource } from './resource'
import { TurnRenderer } from './stream'
import {
  applyPermission, applySelection, buildBlankGroups, buildGroups, sameGroups,
  EFFORT_GROUP, MODEL_GROUP, PERMISSION_GROUP,
} from './options'
import { readBlankDefaults } from './defaults'
import { promptContentFor } from './references'
import type { DshApiClient } from '../dsh/client'
import { SECTION } from '../config'
import type { SlashProxy, CommandOutcome } from '../slash/proxy'

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
 * How many `session.history` pages one open will fetch while looking for a
 * human prompt.
 *
 * The bound exists for the pathological session whose final turn spans more
 * messages than this many pages hold: without it, opening that session would
 * pull the whole multi-hundred-megabyte log. Hitting the bound renders the
 * window mid-turn — the editor drops the leading response turns — which is the
 * lesser harm, and it is logged.
 */
const MAX_HISTORY_PAGES = 20

/**
 * Serves one session's content to the native chat UI: its past turns, its live
 * turn, and the handler that starts a new one.
 */
export class SessionContent implements vscode.ChatSessionContentProvider {
  /** Placeholder resource id to the dsh session its first prompt created. */
  private readonly adopted = new Map<string, SessionId>()
  /** What a blank composer chose before there was a session to apply it to. */
  private pending: { model?: string; effort?: string; preset?: string } | undefined
  /** Input states already carrying picker handlers, so none is wired twice. */
  private readonly wired = new WeakSet<vscode.ChatSessionInputState>()
  /** Live pickers by session, so a switch made elsewhere can pull them along. */
  private readonly refreshers = new Map<SessionId, Set<() => Promise<void>>>()
  /** The session most recently served or prompted in this window. */
  private lastActive: SessionId | undefined

  /**
   * Re-records this session's option selections as plain ids.
   *
   * The workbench keeps one recorded value per picker, and renders a recorded
   * *object* as-is — icon included or not — while a recorded *string* is
   * re-resolved against the current group's items on every paint. Several of
   * its own paths record objects (a click, a groups update), so this event
   * fires strings after every rebuild to keep the record in the form that
   * cannot go stale.
   */
  private readonly optionsChanged = new vscode.EventEmitter<vscode.ChatSessionOptionChangeEvent>()
  readonly onDidChangeChatSessionOptions = this.optionsChanged.event

  constructor(
    private readonly harness: Harness,
    private readonly projections: ProjectionStore,
    private readonly items: SessionItems,
    private readonly log: Log,
    private readonly slash: SlashProxy,
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

    // The editor opens a new chat against a placeholder resource. A dsh
    // session is bound to it now rather than on the first prompt, because
    // every control in the composer — model, reasoning effort, permissions —
    // is per-session state that has to be read from a session that exists.
    // Deferring creation is what left a new chat with no pickers at all.
    let bound = sessionId
    if (isUntitled(sessionId)) {
      const adopted = await this.bind(sessionId)
      // With no harness there is nothing to configure and nothing to read;
      // the first prompt retries the creation.
      if (adopted === undefined) {
        return { history: [], requestHandler: this.newSessionHandlerFor(sessionId) }
      }
      bound = adopted
    }
    this.lastActive = bound
    const entries = await this.readHistory(bound, token)
    const reachable = this.harness.client !== undefined

    // Warm the slash-command catalog now rather than on first use: reading it
    // is what sets the context keys that filter the composer's `/` dropdown,
    // and the first `/` can be typed long before the first command runs. This
    // waits for readHistory because that is what starts the harness for an
    // existing session — earlier there is no client for the read to use.
    if (reachable) void this.slash.list(bound)

    const options = await this.wirePickers(bound, context.inputState)

    return {
      title: this.projections.title(bound),
      history: foldHistory(entries),
      options,
      // An unreachable harness renders the transcript read-only rather than
      // offering a composer whose every send would fail.
      requestHandler: reachable ? this.handlerFor(bound) : undefined,
      activeResponseCallback: this.items.isRunning(bound)
        ? (stream, callbackToken) => this.attach(bound, stream, callbackToken)
        : undefined,
    }
  }

  /**
   * Binds a placeholder resource to a real dsh session.
   *
   * A blank session — one that has never run a turn — is reused when the
   * workspace already has one, which is the behaviour dsh documents for
   * exactly this case. Only when there is none is a session created, so
   * opening and abandoning new chats does not accumulate them.
   */
  private async bind(placeholder: string): Promise<SessionId | undefined> {
    const existing = this.adopted.get(placeholder)
    if (existing !== undefined) return existing

    let client
    try {
      client = await this.harness.ensureStarted()
    } catch {
      return undefined
    }

    const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
    const taken = new Set(this.adopted.values())
    const reused = this.items.blankSessionFor(cwd, taken)
    if (reused !== undefined) {
      this.adopted.set(placeholder, reused)
      this.log.info(`reusing blank session ${reused} for ${placeholder}`)
      return reused
    }

    const created = await client.call('session.create', cwd === undefined ? {} : { cwd })
    if (!created.ok) {
      this.log.error(`session.create failed: ${created.error.code}: ${created.error.message}`)
      return undefined
    }
    this.adopted.set(placeholder, created.value.sessionId)
    this.log.info(`created session ${created.value.sessionId} for ${placeholder}`)
    await this.applyPending(client, created.value.sessionId)
    return created.value.sessionId
  }

  /**
   * Applies what the user chose in a blank composer to the session that ended
   * up running it.
   *
   * The choices were made against host catalogs while no session existed;
   * this is the first moment they can be honoured. They are cleared either
   * way — a choice that failed to apply must not silently reappear on the
   * next new chat.
   */
  private async applyPending(client: DshApiClient, sessionId: SessionId): Promise<void> {
    const pending = this.pending
    this.pending = undefined
    if (pending === undefined) return

    if (pending.model !== undefined) {
      const cut = pending.model.indexOf('/')
      if (cut > 0) {
        const result = await client.call('session.selectModel', {
          sessionId,
          provider: pending.model.slice(0, cut),
          model: pending.model.slice(cut + 1),
          reasoningEffort: pending.effort,
        })
        if (!result.ok) this.log.error(`could not apply the chosen model: ${result.error.message}`)
        else this.log.info(`new session ${sessionId} set to ${pending.model}`)
      }
    }

    if (pending.preset !== undefined) {
      const result = await client.remote('commands/execute', {
        agentId: sessionId,
        line: `/permission ${pending.preset}`,
      })
      if (!result.ok) this.log.error(`could not apply the chosen preset: ${result.error.message}`)
      else this.log.info(`new session ${sessionId} set to ${pending.preset}`)
    }
  }

  /**
   * Supplies the composer's pickers, which is a **controller** hook rather
   * than part of the content.
   *
   * This is the one that matters for a chat nobody has sent anything in yet:
   * the editor calls it with `undefined` for the resource — untitled resources
   * included, it maps them to `undefined` itself — long before
   * `provideChatSessionContent` is asked for anything. Wiring the pickers only
   * in the content provider is why a new chat's composer had no controls on
   * it at all.
   */
  async provideInputState(
    resource: vscode.Uri | undefined,
    token: vscode.CancellationToken,
  ): Promise<vscode.ChatSessionInputState> {
    const sessionId = resource === undefined ? undefined : sessionIdOf(resource)
    this.log.info(`provideInputState for ${resource === undefined ? 'a blank chat' : resource.toString()}`)

    let client
    try {
      client = await this.harness.ensureStarted()
    } catch {
      return this.items.raw.createChatSessionInputState([])
    }
    if (token.isCancellationRequested) return this.items.raw.createChatSessionInputState([])

    // A blank chat has no session to read per-session state from, so its
    // controls come from the host catalogs and its choices are held until a
    // session exists to apply them to.
    if (sessionId === undefined || isUntitled(sessionId)) {
      return await this.blankInputState(client)
    }

    const state = this.items.raw.createChatSessionInputState([])
    await this.wirePickers(sessionId, state)
    return state
  }

  /**
   * The pickers for a chat with no session behind it.
   *
   * Choices made here are remembered and applied by {@link bind}, when the
   * session that will run them is created.
   */
  private async blankInputState(client: DshApiClient): Promise<vscode.ChatSessionInputState> {
    const defaults = await readBlankDefaults(client, this.log)
    // Created empty and then assigned, deliberately. The groups handed to
    // `createChatSessionInputState` are stored and *not* published — only the
    // setter runs the notifier that puts them on the controller, which is
    // where the editor's permission picker reads them from. Passing them to
    // the constructor alone means they exist and are never seen.
    const state = this.items.raw.createChatSessionInputState([])
    state.groups = buildBlankGroups(defaults.models, defaults.permissions)
    const subscription = state.onDidChange(() => {
      const chosen = {
        model: state.groups.find(group => group.id === MODEL_GROUP)?.selected?.id,
        effort: state.groups.find(group => group.id === EFFORT_GROUP)?.selected?.id,
        preset: state.groups.find(group => group.id === PERMISSION_GROUP)?.selected?.id,
      }
      this.pending = chosen
      this.log.info(`blank chat options: ${JSON.stringify(chosen)}`)
      // The efforts on offer belong to the chosen model, so the group follows
      // the model picker. Only a real difference is written back — see
      // `setGroups`.
      this.setGroups(state, buildBlankGroups(defaults.models, defaults.permissions, chosen))
    })
    state.onDidDispose(() => { subscription.dispose() })
    return state
  }

  /**
   * Fills in one session's projections without pulling its transcript.
   *
   * `session.history` is the only call that returns a projections block, and
   * it returns the raw events of every message it pages — so the page is one
   * message. Measured on a real session: 3 events, 1.2 KB, 88 ms.
   * `maxMessages: 0` is refused as `bad-request`, so one is the floor.
   */
  private async seedProjections(client: DshApiClient, sessionId: SessionId): Promise<void> {
    const result = await client.call('session.history', { sessionId, maxMessages: 1 })
    if (!result.ok) {
      this.log.info(`could not seed projections for ${sessionId}: ${result.error.code}`)
      return
    }
    this.projections.seed(sessionId, result.value.projections)
  }

  /**
   * Replaces the pickers only when they would actually render differently.
   *
   * Assigning `groups` notifies the workbench, which sets them back and fires
   * `onDidChange` again — so an unconditional assignment from inside that
   * handler never terminates. See `sameGroups`.
   */
  private setGroups(
    state: vscode.ChatSessionInputState,
    next: vscode.ChatSessionProviderOptionGroup[],
  ): void {
    if (sameGroups(state.groups, next)) return
    state.groups = next
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

    // The editor hands the same state object to both the controller hook and
    // the content provider. Wiring it twice would apply every picker change
    // twice, so the second caller only reads what the first already set.
    if (this.wired.has(inputState)) {
      return selectionsOf(inputState)
    }
    this.wired.add(inputState)

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

    // `session.list` carries each session's projections, so the preset is
    // normally already known — but a session created moments ago was announced
    // by a host frame, which carries none. Without this its permission picker
    // would be built from an absent projection and silently omitted.
    if (this.projections.permissions(sessionId) === undefined) {
      await this.seedProjections(client, sessionId)
    }

    // The permission preset is a projection rather than a call: dsh folds the
    // three knob events into `permissions` and pushes the whole value, so this
    // reads the same state its own composer chip renders.
    const rebuild = (): void => {
      this.setGroups(inputState, buildGroups(models, this.projections.permissions(sessionId)))
      this.optionsChanged.fire({
        resource: sessionResource(sessionId),
        updates: Object.entries(selectionsOf(inputState)).map(([optionId, value]) => ({ optionId, value })),
      })
    }
    rebuild()

    const subscription = inputState.onDidChange(() => {
      void (async () => {
        const permissions = this.projections.permissions(sessionId)
        if (permissions !== undefined) {
          // The switch lands as knob events, whose projection frame arrives on
          // the mux and rebuilds the group below — so nothing is set here
          // optimistically.
          await applyPermission(client, sessionId, permissions, inputState.groups, this.log)
        }
        const selected = await applySelection(client, sessionId, models, inputState.groups, this.log)
        if (selected === undefined) return
        // Re-read so the effort group follows the model that was just picked.
        const refreshed = await client.call('session.models', { sessionId })
        if (!refreshed.ok) return
        models = refreshed.value
        rebuild()
      })()
    })
    // A preset can change from anywhere — dsh's own web UI, a `/permission`
    // line typed into this composer, another editor window. The picker follows
    // whoever changed it.
    const projected = this.projections.onDidChange(change => {
      if (change.sessionId !== sessionId || change.key !== 'permissions') return
      rebuild()
    })
    // The model has no projection to follow, so a switch made outside this
    // composer — the control panel — announces itself through
    // {@link refreshPickers} instead.
    const refresh = async (): Promise<void> => {
      const reread = await client.call('session.models', { sessionId })
      if (!reread.ok) return
      models = reread.value
      rebuild()
    }
    let refreshers = this.refreshers.get(sessionId)
    if (refreshers === undefined) {
      refreshers = new Set()
      this.refreshers.set(sessionId, refreshers)
    }
    refreshers.add(refresh)
    inputState.onDidDispose(() => {
      subscription.dispose()
      projected.dispose()
      const set = this.refreshers.get(sessionId)
      set?.delete(refresh)
      if (set?.size === 0) this.refreshers.delete(sessionId)
    })

    return selectionsOf(inputState)
  }

  /** Re-reads the model catalog into every open picker for this session. */
  async refreshPickers(sessionId: SessionId): Promise<void> {
    await Promise.all([...(this.refreshers.get(sessionId) ?? [])].map(refresh => refresh()))
  }

  /**
   * Handles a prompt sent from a chat whose session was never bound.
   *
   * Binding normally happens when the content is provided, so this is the
   * retry for the one case that could not: the harness was unreachable then
   * and may be reachable now.
   */
  private newSessionHandlerFor(placeholder: string): vscode.ChatRequestHandler {
    return async (request, context, stream, token) => {
      const sessionId = await this.bind(placeholder)
      if (sessionId === undefined) {
        stream.warning('The harness is not running. Try "DeepSeek Harness: Restart Harness Process".')
        return {}
      }
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

  /**
   * The session a surface with no session context should act on — the one
   * most recently served or prompted. An entry point that cannot carry its
   * session (the composer's status strip, the Command Palette) is almost
   * always used from the composer of exactly this session.
   */
  lastActiveSession(): SessionId | undefined {
    return this.lastActive
  }

  /** Sends a prompt, then renders the turn it starts. */
  private handlerFor(sessionId: SessionId): vscode.ChatRequestHandler {
    return async (request, _context, stream, token): Promise<vscode.ChatResult> => {
      this.lastActive = sessionId
      this.log.info(`request for ${sessionId}: ${JSON.stringify(request.prompt.slice(0, 60))}`)
      const client = this.harness.client
      if (client === undefined) {
        this.log.error('request arrived with no harness client')
        stream.warning('The harness is not running. Try "DeepSeek Harness: Restart Harness Process".')
        return {}
      }

      // A command chosen in the composer's `/` dropdown — or typed and
      // recognised by the editor against the contributed list — arrives with
      // its name in `request.command` and *stripped from the prompt*, so only
      // rebuilding the line runs what the user actually submitted; without
      // this, the bare arguments would reach the model as a prompt. The line
      // goes to the command plane by default: the user explicitly picked a
      // command, so one this dsh turns out not to own renders as unknown
      // rather than costing a turn. Composer chips are ignored here — a
      // registry command has no attachment slot.
      //
      // One contributed name is the extension's rather than dsh's: `models`
      // opens dsh's model catalog, shadowing the editor's no-op global
      // `/models` — see docs/gaps.md §19. dsh outranks it: a catalog that
      // ever advertises the name is proxied like any other command, so
      // nothing dsh owns is shadowed by us.
      if (request.command !== undefined) {
        const catalog = await this.slash.list(sessionId)
        if (catalog?.some(command => command.name === request.command) !== true
          && request.command === 'models') {
          stream.markdown('Opening the model picker…')
          await vscode.commands.executeCommand('deepseekHarness.pickModel', sessionResource(sessionId))
          return {}
        }
        const argument = request.prompt.trim()
        const outcome = await this.slash.execute(
          sessionId,
          `/${request.command}${argument === '' ? '' : ` ${argument}`}`,
        )
        this.renderCommand(outcome, stream)
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
        // The composer's chips — the active selection, dropped files, pasted
        // images — are in `request.references` and in nothing else. Sending
        // only `request.prompt` is why the editor could show an attachment the
        // agent had never heard of.
        const content = await promptContentFor(request, this.items.cwdOf(sessionId), this.log)
        if (content.length === 0) {
          renderer.dispose()
          return {}
        }
        // A lone slash line that resolves to one of dsh's own commands is
        // proxied to the command registry instead of being sent to the model:
        // the running build does not intercept slash lines itself, so without
        // this a `/permission read-only` typed here reaches the model and
        // costs a turn. An unknown `/foo` is not intercepted and flows to the
        // model as an ordinary prompt, exactly as dsh's own composer treats
        // it. See docs/gaps.md §12.
        const commandLine = await this.commandLineOf(content, request, sessionId)
        if (commandLine !== undefined) {
          renderer.dispose()
          const outcome = await this.slash.execute(sessionId, commandLine)
          this.renderCommand(outcome, stream)
          return {}
        }
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
   * The slash-command line a request should be proxied to, when it is one.
   *
   * dsh's own contract for the path it does not implement is "a prompt whose
   * content is exactly one text block starting with `/`". That is mirrored
   * here, with one extra guard: attachment context is appended to the prompt
   * text, so a clean command line exists only when nothing else was mounted.
   * Unknown `/foo` lines parse to `undefined` and go to the model.
   */
  private async commandLineOf(
    content: PromptContentPart[],
    request: vscode.ChatRequest,
    sessionId: SessionId,
  ): Promise<string | undefined> {
    if (content.length !== 1) return undefined
    const part = content[0]
    if (part?.type !== 'text') return undefined
    if (part.text !== request.prompt.trim()) return undefined
    return (await this.slash.match(part.text, sessionId))?.line
  }

  /** Renders a proxied command's outcome in the chat, no turn involved. */
  private renderCommand(outcome: CommandOutcome, stream: vscode.ChatResponseStream): void {
    switch (outcome.kind) {
      case 'success':
        if (outcome.text !== undefined && outcome.text.trim() !== '') stream.markdown(outcome.text)
        break
      case 'error':
        stream.warning(outcome.text)
        break
      case 'unknown':
        stream.warning(`Unknown or malformed command: ${outcome.line}`)
        break
      case 'failed':
        stream.warning(outcome.message)
        break
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

  /**
   * Reads the tail of the log, far enough back to rebuild a conversation.
   *
   * One page is not enough: `session.history` pages by *message* count, one
   * agentic turn can span dozens of assistant messages, and the editor
   * silently drops every response turn that precedes the first request turn
   * in the history it is handed. So the tail page of a long session — often
   * mid-turn, with no human prompt in it — folded to a transcript the editor
   * rendered as empty after a window reload. Pages are fetched backwards with
   * `beforeSeq` until one carries a human prompt, so the fold always has a
   * request turn to hang the tail on. See docs/gaps.md §17.
   */
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

    /** Pages as fetched, newest window first; each page is in log order. */
    const pages: HistoryEntry[][] = []
    let beforeSeq: number | undefined
    let anchored = false
    for (let page = 0; page < MAX_HISTORY_PAGES; page++) {
      const result = await client.call('session.history', {
        sessionId,
        maxMessages,
        ...(beforeSeq === undefined ? {} : { beforeSeq }),
      })
      if (!result.ok) {
        this.log.error(`session.history failed for ${sessionId}: ${result.error.code}: ${result.error.message}`)
        // With pages in hand this is a torn tail, and rendering that beats
        // dropping it. With none, the transcript will open empty, and there
        // is no turn to carry an explanation — the editor drops a history
        // that holds only response turns — so a notification is the one
        // surface left that can say why. See docs/gaps.md §18.
        if (pages.length === 0) {
          void vscode.window.showWarningMessage(
            `DeepSeek Harness could not read this session's history: ${result.error.message}`,
          )
        }
        break
      }
      if (token.isCancellationRequested) return []

      // Only the tail page seeds projections — it carries the freshest block,
      // and an older page's would step the baseline backwards.
      if (beforeSeq === undefined) this.projections.seed(sessionId, result.value.projections)

      const events = result.value.events
      if (events.length > 0) pages.push(events)
      if (events.some(isHumanPrompt)) {
        anchored = true
        break
      }
      if (!result.value.hasMore) {
        // The whole log is in hand; a session with no human prompt at all
        // renders as far as the editor allows, and that is faithful.
        anchored = true
        break
      }
      const oldest = events[0]?.event.seq
      // No events, or a page that did not move backwards: stop rather than
      // refetch the same window forever.
      if (oldest === undefined || (beforeSeq !== undefined && oldest >= beforeSeq)) break
      beforeSeq = oldest
    }
    if (!anchored) {
      this.log.warn(
        `history for ${sessionId} shows no human prompt within ${String(MAX_HISTORY_PAGES)} pages of ${String(maxMessages)} messages; the transcript may open mid-turn`,
      )
    }

    // Assemble in log order — pages were fetched newest window first. Should
    // dsh ever read `beforeSeq` inclusively, adjacent pages would share the
    // boundary message; entries at or past the newer window's start are
    // dropped so the fold never sees an event twice.
    const ordered: HistoryEntry[][] = []
    let floor = Number.POSITIVE_INFINITY
    for (const page of pages) {
      const kept = page.filter(entry => entry.event.seq < floor)
      if (kept.length === 0) continue
      ordered.unshift(kept)
      floor = kept[0]?.event.seq ?? floor
    }
    return ordered.flat()
  }
}

/** The current selection of every group, keyed by group id. */
function selectionsOf(inputState: vscode.ChatSessionInputState): Record<string, string> {
  const options: Record<string, string> = {}
  for (const group of inputState.groups) {
    if (group.selected !== undefined) options[group.id] = group.selected.id
  }
  return options
}
