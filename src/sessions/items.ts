import * as vscode from 'vscode'
import type { Harness } from '../dsh/harness'
import type { Log } from '../log'
import type { HostFrame, MuxFrame, SessionId, SessionSummary } from '../dsh/wire'
import type { ProjectionStore } from './projections'
import { SESSION_TYPE, sessionIdOf, sessionResource } from './resource'

/** Sessions whose turn is blocked on the user, so status can outrank `running`. */
export type PendingKind = 'question' | 'approval'

/** Projection keys that change what a row shows, so only these force a redraw. */
const ROW_PROJECTIONS = new Set(['title', 'contextPressure', 'tokenUsage'])

/** Token counts are read at a glance, so they are rendered at a glance. */
function compact(tokens: number): string {
  if (tokens < 1000) return String(tokens)
  if (tokens < 1_000_000) return `${(tokens / 1000).toFixed(tokens < 10_000 ? 1 : 0)}k`
  return `${(tokens / 1_000_000).toFixed(1)}M`
}

/**
 * The rows in the agent sessions view.
 *
 * The list itself is `session.list`; everything after that is the host stream
 * keeping it live. dsh's blank-session rule is honoured here: a session with no
 * turn yet is hidden, because it is the one the editor reuses for "new
 * session" and showing it would put an empty row in the list on every start.
 */
export class SessionItems implements vscode.Disposable {
  private readonly controller: vscode.ChatSessionItemController
  private readonly summaries = new Map<SessionId, SessionSummary>()
  private readonly pending = new Map<SessionId, Set<PendingKind>>()
  private readonly disposables: vscode.Disposable[] = []

  constructor(
    private readonly harness: Harness,
    private readonly projections: ProjectionStore,
    private readonly log: Log,
  ) {
    this.controller = vscode.chat.createChatSessionItemController(
      SESSION_TYPE,
      async token => { await this.refresh(token) },
    )
    this.disposables.push(this.controller)
    this.disposables.push(this.harness.onHostFrame(envelope => this.onHostFrame(envelope.payload)))
    this.disposables.push(this.harness.onMuxFrame(envelope => this.onMuxFrame(envelope.payload)))
    // Every reconnect invalidates the list: sessions may have come or gone
    // while the socket was down, and only a refetch can say which.
    this.disposables.push(this.harness.onDidConnect(() => { void this.refresh() }))
  }

  get items(): vscode.ChatSessionItemCollection {
    return this.controller.items
  }

  /** Exposed so later milestones can attach fork/new-session handlers. */
  get raw(): vscode.ChatSessionItemController {
    return this.controller
  }

  /** Re-reads the whole list from dsh and replaces the collection with it. */
  async refresh(token?: vscode.CancellationToken): Promise<void> {
    // Read through a function: the token flips across awaits, so narrowing
    // from one check must not stick for the next.
    const cancelled = (): boolean => token !== undefined && token.isCancellationRequested

    let client
    try {
      client = await this.harness.ensureStarted()
    } catch {
      // ensureStarted already reported why; an unreachable harness is an empty
      // list, not a thrown refresh.
      return
    }
    if (cancelled()) return

    const result = await client.call('session.list', {})
    if (!result.ok) {
      this.log.error(`session.list failed: ${result.error.code}: ${result.error.message}`)
      return
    }
    if (cancelled()) return

    this.summaries.clear()
    for (const summary of result.value.items) {
      this.summaries.set(summary.sessionId, summary)
      this.projections.seed(summary.sessionId, summary.projections)
    }
    this.replaceAll()
  }

  /**
   * The directory dsh runs this session in.
   *
   * Attachment paths are shown relative to it, so what the user sees in the
   * editor and what the agent's tools resolve are the same path.
   */
  cwdOf(sessionId: SessionId): string | undefined {
    return this.summaries.get(sessionId)?.cwd
  }

  /** The resolved agent preset a session runs, from its list summary. */
  presetOf(sessionId: SessionId): string | undefined {
    return this.summaries.get(sessionId)?.agentPreset
  }

  /**
   * Whether dsh reports this session as never having run a turn.
   *
   * `true` when the summary is missing, because a session we have not heard
   * about yet is no likelier to be started than blank — and treating it as
   * blank only leaves a preset picker unlockable, which the switch then
   * confirms or refuses with dsh's own answer.
   */
  isBlank(sessionId: SessionId): boolean {
    return this.summaries.get(sessionId)?.blank !== false
  }

  /**
   * Records a session `session.create` just made, so its resolved preset and
   * blank status are known before the host frame announcing it arrives.
   */
  noteCreated(sessionId: SessionId, agentPreset: string | undefined): void {
    const existing = this.summaries.get(sessionId)
    if (existing !== undefined) {
      if (agentPreset !== undefined) this.summaries.set(sessionId, { ...existing, agentPreset })
      return
    }
    this.summaries.set(sessionId, {
      sessionId,
      updatedAt: Date.now(),
      running: false,
      blank: true,
      ...(agentPreset === undefined ? {} : { agentPreset }),
    })
  }

  /**
   * Every session dsh has reported, newest first (blank ones included).
   *
   * The sessions view hides blank sessions, but a surface that needs to pick
   * a session to act on — the slash-command palette entry — wants the whole
   * set, or at least to know a blank one exists to reuse.
   */
  sessions(): SessionSummary[] {
    return [...this.summaries.values()].sort((a, b) => b.updatedAt - a.updatedAt)
  }

  /** The label the sessions view gives this session, for surfaces that show the same rows. */
  labelOf(sessionId: SessionId): string | undefined {
    const summary = this.summaries.get(sessionId)
    return summary === undefined ? undefined : this.labelFor(summary)
  }

  /**
   * A session in `cwd` that has never run a turn, if there is one going spare.
   *
   * dsh states the contract outright: clients "hide blank Sessions from lists
   * and reuse them for New Session on the same workspace". Reusing is what
   * keeps a new chat from leaving a session behind every time one is opened
   * and abandoned.
   */
  blankSessionFor(cwd: string | undefined, taken: ReadonlySet<SessionId>): SessionId | undefined {
    const candidates = [...this.summaries.values()]
      .filter(summary => summary.blank
        && summary.cwd === cwd
        && summary.origin !== 'subagent'
        && !taken.has(summary.sessionId))
      .sort((a, b) => b.updatedAt - a.updatedAt)
    return candidates[0]?.sessionId
  }

  /** True while the session is waiting on the user for a question or approval. */
  markPending(sessionId: SessionId, kind: PendingKind, isPending: boolean): void {
    let kinds = this.pending.get(sessionId)
    if (isPending) {
      kinds ??= new Set()
      kinds.add(kind)
      this.pending.set(sessionId, kinds)
    } else if (kinds !== undefined) {
      kinds.delete(kind)
      if (kinds.size === 0) this.pending.delete(sessionId)
    }
    this.upsert(sessionId)
  }

  private replaceAll(): void {
    const visible = [...this.summaries.values()]
      .filter(summary => !summary.blank)
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map(summary => this.itemFor(summary))
    this.controller.items.replace(visible)
  }

  private upsert(sessionId: SessionId): void {
    const summary = this.summaries.get(sessionId)
    if (summary === undefined || summary.blank) return
    this.controller.items.add(this.itemFor(summary))
  }

  private itemFor(summary: SessionSummary): vscode.ChatSessionItem {
    const item = this.controller.createChatSessionItem(
      sessionResource(summary.sessionId),
      this.labelFor(summary),
    )
    item.status = this.statusFor(summary)
    item.timing = { created: summary.updatedAt }
    item.description = this.contextDescription(summary.sessionId)
    item.tooltip = this.tooltipFor(summary)
    return item
  }

  /** How full this session's context is, as the row's subtitle. */
  private contextDescription(sessionId: SessionId): string | undefined {
    const pressure = this.projections.contextPressure(sessionId)
    if (pressure === undefined) return undefined
    const percent = Math.round((pressure.used / pressure.window) * 100)
    return `${String(percent)}% context`
  }

  private tooltipFor(summary: SessionSummary): vscode.MarkdownString | undefined {
    const lines: string[] = []
    if (summary.cwd !== undefined) lines.push(`\`${summary.cwd}\``)
    if (summary.agentPreset !== undefined) lines.push(`Preset: ${summary.agentPreset}`)

    const pressure = this.projections.contextPressure(summary.sessionId)
    if (pressure !== undefined) {
      lines.push(`Context: ${compact(pressure.used)} / ${compact(pressure.window)}`)
    }
    const usage = this.projections.tokenUsage(summary.sessionId)
    if (usage !== undefined) {
      const billed = usage.input + usage.cacheRead + usage.cacheWrite
      // A cache hit rate is the number that actually tells the user whether
      // their session is cheap, and it is the one dsh can answer exactly.
      const hitRate = billed === 0 ? 0 : Math.round((usage.cacheRead / billed) * 100)
      lines.push(`Tokens: ${compact(billed)} in / ${compact(usage.output)} out · ${String(hitRate)}% cache hit`)
    }
    return lines.length === 0 ? undefined : new vscode.MarkdownString(lines.join('\n\n'))
  }

  /**
   * dsh derives a title asynchronously, so a young session has none. Falling
   * back to the working directory beats a generic placeholder: it is the one
   * thing that distinguishes two untitled sessions from each other.
   */
  private labelFor(summary: SessionSummary): string {
    const title = this.projections.title(summary.sessionId)
    if (title !== undefined) return title
    if (summary.cwd !== undefined) {
      const base = summary.cwd.split(/[/\\]/).filter(Boolean).pop()
      if (base !== undefined) return base
    }
    return summary.sessionId.slice(0, 8)
  }

  private statusFor(summary: SessionSummary): vscode.ChatSessionStatus {
    if (this.pending.has(summary.sessionId)) return vscode.ChatSessionStatus.NeedsInput
    if (summary.running) return vscode.ChatSessionStatus.InProgress
    return vscode.ChatSessionStatus.Completed
  }

  private onHostFrame(frame: HostFrame): void {
    switch (frame.type) {
      case 'host/session-added': {
        const added = frame as Extract<HostFrame, { type: 'host/session-added' }>
        this.summaries.set(added.sessionId, {
          sessionId: added.sessionId,
          updatedAt: Date.now(),
          running: false,
          blank: added.blank,
          parentSessionId: added.parentSessionId,
          origin: added.origin,
          cwd: added.cwd,
          agentPreset: added.agentPreset,
        })
        this.upsert(added.sessionId)
        break
      }
      case 'host/session-removed': {
        const removed = frame as Extract<HostFrame, { type: 'host/session-removed' }>
        this.summaries.delete(removed.sessionId)
        this.pending.delete(removed.sessionId)
        this.projections.forget(removed.sessionId)
        this.replaceAll()
        break
      }
      case 'host/session-status': {
        const status = frame as Extract<HostFrame, { type: 'host/session-status' }>
        const summary = this.summaries.get(status.sessionId)
        if (summary === undefined) break
        // A blank session never runs, so the first `running: true` is also the
        // proof that this session has stopped being blank.
        const wasBlank = summary.blank
        this.summaries.set(status.sessionId, {
          ...summary,
          running: status.running,
          blank: status.running ? false : summary.blank,
          updatedAt: Date.now(),
        })
        if (wasBlank && status.running) this.replaceAll()
        else this.upsert(status.sessionId)
        break
      }
      case 'host/agent-error': {
        const error = frame as Extract<HostFrame, { type: 'host/agent-error' }>
        this.log.error(`agent error in ${error.sessionId}: ${error.message}`)
        break
      }
      default:
        break
    }
  }

  private onMuxFrame(frame: MuxFrame): void {
    switch (frame.type) {
      case 'session/projection': {
        const projection = frame as Extract<MuxFrame, { type: 'session/projection' }>
        this.projections.set(projection.sessionId, projection.key, projection.value, projection.seq)
        if (ROW_PROJECTIONS.has(projection.key)) this.upsert(projection.sessionId)
        break
      }
      // A session blocked on the user shows NeedsInput whether or not it is
      // open in this window — the row is how the user finds out that something
      // in another window, or started by a schedule, is waiting for them.
      case 'question/requested':
        this.setPending(frame, 'question', true)
        break
      case 'question/resolved':
        this.setPending(frame, 'question', false)
        break
      case 'approval/requested':
        this.setPending(frame, 'approval', true)
        break
      case 'approval/resolved':
        this.setPending(frame, 'approval', false)
        break
      default:
        break
    }
  }

  private setPending(frame: MuxFrame, kind: PendingKind, pending: boolean): void {
    const sessionId = (frame as { sessionId?: unknown }).sessionId
    if (typeof sessionId !== 'string') return
    this.markPending(sessionId, kind, pending)
  }

  /** Whether dsh reports this session's agent as mid-turn right now. */
  isRunning(sessionId: SessionId): boolean {
    return this.summaries.get(sessionId)?.running === true
  }

  /** The session behind a resource, when it is one of ours and still known. */
  summaryFor(resource: vscode.Uri): SessionSummary | undefined {
    const id = sessionIdOf(resource)
    return id === undefined ? undefined : this.summaries.get(id)
  }

  dispose(): void {
    for (const disposable of this.disposables.reverse()) disposable.dispose()
  }
}
