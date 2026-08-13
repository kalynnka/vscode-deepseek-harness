import type { ProjectionsBlock, SessionId } from '../dsh/wire'

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
  }

  get(sessionId: SessionId, key: string): unknown {
    return this.bySession.get(sessionId)?.get(key)?.value
  }

  /** The session title, or undefined when none has been derived yet. */
  title(sessionId: SessionId): string | undefined {
    const value = this.get(sessionId, 'title')
    return typeof value === 'string' && value.trim() !== '' ? value : undefined
  }

  forget(sessionId: SessionId): void {
    this.bySession.delete(sessionId)
  }

  clear(): void {
    this.bySession.clear()
  }
}
