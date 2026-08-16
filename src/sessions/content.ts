import * as vscode from 'vscode'
import type { Harness } from '../dsh/harness'
import type { Log } from '../log'
import type { HistoryEntry, PromptContentPart, SessionId, SessionModels } from '../dsh/wire'
import { foldHistory, isHumanPrompt } from './history'
import type { ProjectionStore } from './projections'
import type { SessionItems } from './items'
import { isUntitled, sessionIdOf, sessionResource } from './resource'
import { describeTurn, TurnRenderer, type TurnSummary } from './stream'
import type { ModelRoute } from '../dsh/events'
import {
  applyPermission, applyPreset, applySelection, applySelections, buildBlankGroups, buildGroups, presetSelectOf,
  sameGroups, selectionsFromGroups, type BlankChoices,
} from './options'
import { readBlankDefaults } from './defaults'
import { promptContentFor } from './references'
import type { DshApiClient } from '../dsh/client'
import { SECTION } from '../config'
import type { SlashProxy, CommandOutcome } from '../slash/proxy'

/**
 * How many messages each `session.history` call asks for, when the setting does
 * not say.
 *
 * It sizes the call, and bounds nothing else: the loop below reads back to the
 * first event of the log whatever this says, so the byte total is the whole log
 * either way and only the number of calls changes. What dsh does with it is
 * count *messages* — append-origin user and assistant messages — backwards from
 * where the call starts, then return the whole contiguous raw range behind
 * them, never cutting mid-message. Every tool call, tool result and token-level
 * `assistant/chunk` those messages own rides along, and the chunks are ~100% of
 * the bytes: 20 messages measured at 10 MB of JSON, 60 at 15 MB, with no
 * request flag to exclude them (docs/gaps.md §1). So a call is expensive
 * whatever its size, and asking for more messages per call is what keeps a long
 * log to a handful of them.
 *
 * 50 is also dsh's own default when the field is omitted.
 */
const DEFAULT_PAGE_MESSAGES = 50

/**
 * How long projection-driven picker rebuilds are coalesced.
 *
 * A permission switch arrives as a burst of `permissions` projection frames —
 * the old preset, an intermediate `custom`, then the target — within a few
 * milliseconds. Writing each one to the picker as it lands makes the chip
 * visibly snap back to the previous value before it settles. Debouncing lets
 * the burst fold into one rebuild of the final value.
 */
const PROJECTION_REBUILD_DEBOUNCE_MS = 150

/**
 * The one event type dropped as each page arrives rather than at the fold.
 *
 * `assistant/chunk` is the token-level delta stream, ~100% of a page's events
 * and of its bytes (§1). The committed `assistant/message` carries the same
 * text, so the fold discards every one of them — but holding a whole log's
 * worth in memory until it gets the chance is what would turn reading a long
 * session into an extension-host memory spike. Nothing else is filtered here:
 * the fold reads the last event before each prompt for its turn's completion
 * time, and chunks are never that event — `turn/end` follows them.
 */
const CHUNK_EVENT = 'assistant/chunk'

/**
 * Serves one session's content to the native chat UI: its past turns, its live
 * turn, and the handler that starts a new one.
 */
export class SessionContent implements vscode.ChatSessionContentProvider {
  /** Placeholder resource id to the dsh session its first prompt created. */
  private readonly adopted = new Map<string, SessionId>()
  /**
   * What each blank composer chose, keyed by its input state until the session
   * that will run the choices is bound.
   *
   * A WeakMap rather than one field, so two blank chats cannot overwrite each
   * other's choices, and a chat closed without binding has its choices
   * collected with its state instead of leaking onto the next new chat.
   */
  private readonly pendingByState = new WeakMap<vscode.ChatSessionInputState, BlankChoices>()
  /** Input states already carrying picker handlers, so none is wired twice. */
  private readonly wired = new WeakSet<vscode.ChatSessionInputState>()
  /** Live pickers by session, so a switch made elsewhere can pull them along. */
  private readonly refreshers = new Map<SessionId, Set<() => Promise<void>>>()
  /**
   * The last model catalog read for a session, kept only to turn the route a
   * finished turn reports into the display name that route is advertised
   * under. One small record per session this window has opened.
   */
  private readonly catalogs = new Map<SessionId, SessionModels>()
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
      const adopted = await this.bind(sessionId, context.inputState)
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
      // Folded after `wirePickers`, which is what reads the model catalog the
      // footers name their routes from.
      history: foldHistory(entries, route => this.modelNameOf(bound, route)),
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
  private async bind(
    placeholder: string,
    inputState?: vscode.ChatSessionInputState,
  ): Promise<SessionId | undefined> {
    const existing = this.adopted.get(placeholder)
    if (existing !== undefined) return existing

    let client
    try {
      client = await this.harness.ensureStarted()
    } catch {
      return undefined
    }

    const pending = inputState === undefined ? undefined : this.pendingByState.get(inputState)

    const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
    const taken = new Set(this.adopted.values())
    const reused = this.items.blankSessionFor(cwd, taken)
    if (reused !== undefined) {
      this.adopted.set(placeholder, reused)
      this.log.info(`reusing blank session ${reused} for ${placeholder}`)
      // The reused session already exists, so there is no `session.create` to
      // carry the agent preset; it is switched here like the other choices.
      await this.applyPending(client, reused, false, pending)
      return reused
    }

    // A chosen agent preset rides `session.create` so the new session is
    // composed with it from the start (and the host frame announces the right
    // preset) rather than being switched afterwards.
    const created = await client.call('session.create', {
      ...(cwd === undefined ? {} : { cwd }),
      ...(pending?.agentPreset === undefined ? {} : { agentPreset: pending.agentPreset }),
    })
    if (!created.ok) {
      this.log.error(`session.create failed: ${created.error.code}: ${created.error.message}`)
      return undefined
    }
    this.adopted.set(placeholder, created.value.sessionId)
    this.log.info(`created session ${created.value.sessionId} for ${placeholder}`)
    // Record the resolved preset now, so the picker reads it without waiting
    // for the host frame that announces the new session.
    this.items.noteCreated(created.value.sessionId, created.value.agentPreset)
    await this.applyPending(client, created.value.sessionId, true, pending)
    return created.value.sessionId
  }

  /**
   * Applies what the user chose in a blank composer to the session that ended
   * up running it.
   *
   * The choices were made against host catalogs while no session existed;
   * this is the first moment they can be honoured. The entry is consumed
   * rather than reused — a choice that failed to apply must not silently
   * reappear on the next new chat.
   *
   * @param agentPresetApplied whether the session was already composed with
   * the chosen agent preset at creation; a reused blank session has not, so
   * its preset is switched here instead.
   */
  private async applyPending(
    client: DshApiClient,
    sessionId: SessionId,
    agentPresetApplied: boolean,
    pending: BlankChoices | undefined,
  ): Promise<void> {
    if (pending === undefined) return

    await applySelections(client, sessionId, {
      model: pending.model,
      effort: pending.effort,
      preset: pending.preset,
      ...(agentPresetApplied ? {} : { agentPreset: pending.agentPreset }),
    }, this.log)

    // `agentPreset.select` publishes no host frame, so the summary would keep
    // the previous preset until the next refresh. Record the switch now so the
    // preset chip reads the truth immediately.
    if (!agentPresetApplied && pending.agentPreset !== undefined) {
      this.items.noteAgentPreset(sessionId, pending.agentPreset)
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
    state.groups = buildBlankGroups(defaults.models, defaults.permissions, defaults.presets)
    const subscription = state.onDidChange(() => {
      const chosen = selectionsFromGroups(state.groups)
      this.pendingByState.set(state, chosen)
      this.log.info(`blank chat options: ${JSON.stringify(chosen)}`)
      // The efforts on offer belong to the chosen model, so the group follows
      // the model picker. Only a real difference is written back — see
      // `setGroups`.
      this.setGroups(state, buildBlankGroups(defaults.models, defaults.permissions, defaults.presets, chosen))
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
    this.catalogs.set(sessionId, models)
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

    // The agent-preset roster is read live per open, so a preset authored in
    // Creator mode or installed by a plugin since the last read is offered on
    // the next open. The chip exists only while the session is still blank:
    // dsh refuses to recompose a started session, and this matches its own
    // composer, which offers the preset picker only when creating a session.
    const roster = await client.call('agentPreset.list', {})
    let presetSelect = this.items.isBlank(sessionId) && roster.ok
      ? presetSelectOf(roster.value, this.items.presetOf(sessionId))
      : undefined

    // The permission preset is a projection rather than a call: dsh folds the
    // three knob events into `permissions` and pushes the whole value, so this
    // reads the same state its own composer chip renders.
    const rebuildNow = (): void => {
      this.setGroups(inputState, buildGroups(models, this.projections.permissions(sessionId), presetSelect))
      this.optionsChanged.fire({
        resource: sessionResource(sessionId),
        updates: Object.entries(selectionsOf(inputState)).map(([optionId, value]) => ({ optionId, value })),
      })
    }
    // Projection frames arrive in a burst (see the constant), so the picker is
    // rebuilt on a trailing edge rather than per frame.
    let rebuildTimer: ReturnType<typeof setTimeout> | undefined
    const scheduleRebuild = (): void => {
      if (rebuildTimer !== undefined) clearTimeout(rebuildTimer)
      rebuildTimer = setTimeout(() => {
        rebuildTimer = undefined
        rebuildNow()
      }, PROJECTION_REBUILD_DEBOUNCE_MS)
    }
    rebuildNow()

    const subscription = inputState.onDidChange(() => {
      void (async () => {
        const permissions = this.projections.permissions(sessionId)
        if (permissions !== undefined) {
          // The switch lands as knob events, whose projection frames arrive on
          // the mux and rebuild the group below — so nothing is set here
          // optimistically.
          await applyPermission(client, sessionId, permissions, inputState.groups, this.log)
        }
        const appliedPreset = presetSelect === undefined
          ? undefined
          : await applyPreset(client, sessionId, presetSelect.currentValue, inputState.groups, this.log)
        if (appliedPreset !== undefined && presetSelect !== undefined) {
          presetSelect = { ...presetSelect, currentValue: appliedPreset }
        }
        const selected = await applySelection(client, sessionId, models, inputState.groups, this.log)
        if (selected === undefined && appliedPreset === undefined) return
        // Re-read so the effort group follows the model that was just picked.
        const refreshed = await client.call('session.models', { sessionId })
        if (!refreshed.ok) return
        models = refreshed.value
        this.catalogs.set(sessionId, models)
        rebuildNow()
      })()
    })
    // A preset can change from anywhere — dsh's own web UI, a `/permission`
    // line typed into this composer, another editor window. The picker follows
    // whoever changed it.
    const projected = this.projections.onDidChange(change => {
      if (change.sessionId !== sessionId || change.key !== 'permissions') return
      scheduleRebuild()
    })
    // The first turn fixes the agent preset, and it can start from anywhere —
    // dsh's web UI, another window — not only from this composer. When the
    // session stops being blank, the preset chip must go even if this window
    // never ran the turn.
    const blankFlipped = this.items.onBlankFlipped(flippedId => {
      if (flippedId !== sessionId || presetSelect === undefined) return
      presetSelect = undefined
      rebuildNow()
    })
    // The model has no projection to follow, so a switch made outside this
    // composer — the control panel — announces itself through
    // {@link refreshPickers} instead.
    const refresh = async (): Promise<void> => {
      const reread = await client.call('session.models', { sessionId })
      if (!reread.ok) return
      models = reread.value
      this.catalogs.set(sessionId, models)
      if (this.items.isBlank(sessionId)) {
        // The roster may have gained a preset since this composer was wired, so
        // a switch made elsewhere pulls the newest patterns along too.
        const reroster = await client.call('agentPreset.list', {})
        presetSelect = reroster.ok
          ? presetSelectOf(reroster.value, presetSelect?.currentValue ?? this.items.presetOf(sessionId))
          : undefined
      } else {
        // A turn has run: the preset is fixed, and the chip disappears.
        presetSelect = undefined
      }
      rebuildNow()
    }
    let refreshers = this.refreshers.get(sessionId)
    if (refreshers === undefined) {
      refreshers = new Set()
      this.refreshers.set(sessionId, refreshers)
    }
    refreshers.add(refresh)
    inputState.onDidDispose(() => {
      if (rebuildTimer !== undefined) clearTimeout(rebuildTimer)
      subscription.dispose()
      projected.dispose()
      blankFlipped.dispose()
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
      const sessionId = await this.bind(placeholder, context.chatSessionContext?.inputState)
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
        // The first turn made the session non-blank, so the preset chip must
        // disappear from the composer — the preset is fixed now.
        void this.refreshPickers(sessionId)
        const details = this.detailsFor(sessionId, renderer.summary())
        return details === undefined ? {} : { details }
      } finally {
        renderer.dispose()
      }
    }
  }

  /**
   * The footer line for a finished turn: the model that ran it, and what it
   * cost.
   *
   * The route comes from the turn's own events rather than from the picker, so
   * a model switched part-way through — by this window or another — is named
   * as it actually was. The catalog supplies only the display name, and a
   * route it does not advertise falls back to the provider's own model id,
   * which is still the truth about what ran.
   */
  private detailsFor(sessionId: SessionId, summary: TurnSummary): string | undefined {
    const route = summary.route
    return describeTurn(route === undefined ? undefined : this.modelNameOf(sessionId, route), summary.usage)
  }

  private modelNameOf(sessionId: SessionId, route: ModelRoute): string {
    const provider = this.catalogs.get(sessionId)?.groups.find(group => group.id === route.provider)
    return provider?.models.find(model => model.id === route.model)?.name ?? route.model
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
   * Reads a session's log back to its first event, so a reopened session is
   * the conversation it was.
   *
   * `session.history` pages by *message* count, and one page is not a
   * conversation. One agentic turn can span dozens of assistant messages, and
   * the editor silently drops every response turn that precedes the first
   * request turn in the history it is handed — so the tail page of a long
   * session, often mid-turn with no human prompt in it, folded to a transcript
   * the editor rendered as empty after a window reload. A page that does carry
   * a prompt still holds only the exchanges that fit in it, so stopping there
   * reopened a three-round session showing two. See docs/gaps.md §17.
   *
   * Stopping at *any* count has the same shape as stopping at one page — the
   * transcript silently begins later than the conversation did — and the chat
   * API offers nothing to repair it later: `ChatSession.history` is a single
   * readonly array read once when the session opens, with no callback for
   * scrolling further back and no event to re-provide it, so there is no lazy
   * tail to load. The whole log is therefore read up front, and the cost of
   * that (§1) is paid where the user can see it: pages are fetched backwards
   * with `beforeSeq` until dsh reports no more, under a progress indicator.
   */
  private async readHistory(sessionId: SessionId, token: vscode.CancellationToken): Promise<HistoryEntry[]> {
    let client
    try {
      client = await this.harness.ensureStarted()
    } catch {
      return []
    }
    if (token.isCancellationRequested) return []

    const configured = vscode.workspace.getConfiguration(SECTION)
      .get<number>('historyPageMessages', DEFAULT_PAGE_MESSAGES)
    const maxMessages = Math.max(1, configured)

    return vscode.window.withProgress(
      { location: vscode.ProgressLocation.Window, title: 'Restoring the DeepSeek Harness transcript' },
      progress => this.pageHistory(client, sessionId, maxMessages, progress, token),
    )
  }

  /** {@link readHistory}'s paging loop, in log order and chunk-free. */
  private async pageHistory(
    client: DshApiClient,
    sessionId: SessionId,
    maxMessages: number,
    progress: vscode.Progress<{ message: string }>,
    token: vscode.CancellationToken,
  ): Promise<HistoryEntry[]> {
    /** Pages as fetched, newest window first; each page is in log order. */
    const pages: HistoryEntry[][] = []
    let beforeSeq: number | undefined
    /** Human prompts read so far — the transcript's rounds, and its progress. */
    let prompts = 0
    /** Whether paging stopped because the log ran out rather than at a fault. */
    let whole = false
    /** Raw events read, against those retained, for the report below. */
    let seen = 0
    let retained = 0
    /** Requests made rather than pages kept: a chunk-only window costs one too. */
    let requests = 0

    for (;;) {
      progress.report({ message: `${String(prompts)} prompts, page ${String(++requests)}` })
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
      seen += events.length
      // Read from the raw page: the cursor is a log position, and taking it
      // from the retained events would step over every chunk-only window and
      // re-request the messages just read.
      const oldest = events[0]?.event.seq
      const kept = events.filter(entry => entry.event.type !== CHUNK_EVENT)
      retained += kept.length
      if (kept.length > 0) pages.push(kept)
      prompts += kept.filter(isHumanPrompt).length

      if (!result.value.hasMore) {
        // The whole log is in hand; a session with no human prompt at all
        // renders as far as the editor allows, and that is faithful.
        whole = true
        break
      }
      // No events, or a page that did not move backwards: stop rather than
      // refetch the same window forever.
      if (oldest === undefined || (beforeSeq !== undefined && oldest >= beforeSeq)) break
      beforeSeq = oldest
    }

    this.log.info(
      `history for ${sessionId}: ${String(requests)} pages of ${String(maxMessages)} messages, `
      + `${String(prompts)} prompts, ${String(retained)} of ${String(seen)} events kept`
      + `${whole ? '' : ' (the log was not read to its start)'}`,
    )
    if (prompts === 0 && retained > 0) {
      // The log has content the transcript cannot show: with no request turn
      // to hang them on, the editor drops every response turn read.
      this.log.warn(
        `history for ${sessionId} holds no human prompt; the transcript may open empty or mid-turn`,
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
