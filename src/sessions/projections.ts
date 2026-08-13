import * as vscode from 'vscode'
import type { ProjectionsBlock, SessionId } from '../dsh/wire'

/** One session's permission select, exactly as dsh's `permissions` projection carries it. */
export interface PermissionSelect {
  options: { value: string; name: string; description?: string }[]
  currentValue: string
}

/**
 * Per-session projection values under higher-seq-wins.
 *
 * Projections are dsh's live derived state — title, token usage, context
 * pressure, plan mode, and whatever else the running deployment mounts. They
 * arrive from three places that can interleave arbitrarily: the `session.list`
 * summary, the history tail page, and `session/projection` frames. The seq
 * comparison is what makes those three converge instead of racing, and it is
 * also why a stale list baseline can never overwrite a fresher push.
 *
 * The key space is deliberately open. A deployment that mounts no token meter
 * simply never sends `tokenUsage`, and a newer dsh may send keys this build has
 * never heard of; both are normal, so nothing here enumerates them.
 */
export class ProjectionStore {
  private readonly bySession = new Map<SessionId, Map<string, { value: unknown; seq: number }>>()
  private readonly changed = new vscode.EventEmitter<{ sessionId: SessionId; key: string }>()

  /**
   * Fires for each projection value that was actually applied.
   *
   * A projection is dsh's own answer about the session, and it can change
   * because of something this window never did — another client, a slash
   * command, the agent itself. Anything rendering one has to be told.
   */
  readonly onDidChange = this.changed.event

  /** Seeds a whole block, as delivered by `session.list` or a history tail page. */
  seed(sessionId: SessionId, block: ProjectionsBlock | undefined): void {
    if (block === undefined) return
    for (const [key, value] of Object.entries(block.values)) {
      this.set(sessionId, key, value, block.asOfSeq)
    }
  }

  /** Applies one `session/projection` frame. Older seqs are ignored, not applied. */
  set(sessionId: SessionId, key: string, value: unknown, seq: number): void {
    let session = this.bySession.get(sessionId)
    if (session === undefined) {
      session = new Map()
      this.bySession.set(sessionId, session)
    }
    const existing = session.get(key)
    if (existing !== undefined && existing.seq > seq) return
    session.set(key, { value, seq })
    this.changed.fire({ sessionId, key })
  }

  get(sessionId: SessionId, key: string): unknown {
    return this.bySession.get(sessionId)?.get(key)?.value
  }

  /** The session title, or undefined when none has been derived yet. */
  title(sessionId: SessionId): string | undefined {
    const value = this.get(sessionId, 'title')
    return typeof value === 'string' && value.trim() !== '' ? value : undefined
  }

  /**
   * Context occupancy for the session row.
   *
   * The fields are last-wins records of different moments rather than one
   * atomic observation — dsh says so explicitly — so this is a user-facing
   * reference, never an input to a decision about whether a prompt will fit.
   */
  contextPressure(sessionId: SessionId): { used: number; window: number } | undefined {
    const value = this.get(sessionId, 'contextPressure')
    if (typeof value !== 'object' || value === null) return undefined
    const record = value as { projectedTokens?: unknown; pressureTokens?: unknown; contextWindow?: unknown }
    const used = typeof record.projectedTokens === 'number'
      ? record.projectedTokens
      : typeof record.pressureTokens === 'number' ? record.pressureTokens : undefined
    if (used === undefined || typeof record.contextWindow !== 'number' || record.contextWindow <= 0) return undefined
    return { used, window: record.contextWindow }
  }

  /** Cumulative provider-reported usage across the whole durable log. */
  tokenUsage(sessionId: SessionId): { input: number; output: number; cacheRead: number; cacheWrite: number } | undefined {
    const value = this.get(sessionId, 'tokenUsage')
    if (typeof value !== 'object' || value === null) return undefined
    const record = value as Record<string, unknown>
    const number = (key: string): number => typeof record[key] === 'number' ? record[key] : 0
    const total = number('uncachedInputTokens') + number('outputTokens') + number('cacheReadTokens') + number('cacheWriteTokens')
    if (total === 0) return undefined
    return {
      input: number('uncachedInputTokens'),
      output: number('outputTokens'),
      cacheRead: number('cacheReadTokens'),
      cacheWrite: number('cacheWriteTokens'),
    }
  }

  /**
   * The session's permission preset and the presets it can switch to.
   *
   * The key is absent when the host composes no permission service, which is
   * dsh's way of saying "this deployment has no such control" — so the picker
   * has to disappear rather than show a guess.
   */
  permissions(sessionId: SessionId): PermissionSelect | undefined {
    const value = this.get(sessionId, 'permissions')
    if (typeof value !== 'object' || value === null) return undefined
    const record = value as { options?: unknown; currentValue?: unknown }
    if (!Array.isArray(record.options) || typeof record.currentValue !== 'string') return undefined
    const options = record.options.filter((option): option is { value: string; name: string; description?: string } =>
      typeof option === 'object' && option !== null
      && typeof (option as { value?: unknown }).value === 'string'
      && typeof (option as { name?: unknown }).name === 'string')
    if (options.length === 0) return undefined
    return { options, currentValue: record.currentValue }
  }

  forget(sessionId: SessionId): void {
    this.bySession.delete(sessionId)
  }

  clear(): void {
    this.bySession.clear()
  }

  dispose(): void {
    this.changed.dispose()
  }
}
