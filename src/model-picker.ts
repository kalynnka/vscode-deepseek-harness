import * as vscode from 'vscode'
import type { Harness } from './dsh/harness'
import type { DshApiClient } from './dsh/client'
import type { Log } from './log'
import type { SessionId, SessionModels } from './dsh/wire'
import type { SessionItems } from './sessions/items'
import type { SessionContent } from './sessions/content'
import { isUntitled, sessionIdOf } from './sessions/resource'
import { unreachableMessage } from './dsh/endpoint'

/**
 * The model picker behind `/models` and the Command Palette.
 *
 * Composer-typed `/models` lands here because the participant's own commands
 * outrank the editor's global registry at parse time; the editor's
 * identically named entry stays a no-op for contributed sessions. See
 * docs/gaps.md §19. The catalog is dsh's — `session.models` in,
 * `session.selectModel` out — and a switch pulls every open composer picker
 * along.
 */
export class ModelPicker {
  constructor(
    private readonly harness: Harness,
    private readonly items: SessionItems,
    private readonly content: SessionContent,
    private readonly log: Log,
  ) {}

  async pick(target?: unknown): Promise<void> {
    let client
    try {
      client = await this.harness.ensureConnected()
    } catch {
      void vscode.window.showErrorMessage(unreachableMessage(this.harness.endpoint))
      return
    }
    const sessionId = await this.resolveSession(target)
    if (sessionId === undefined) return
    const models = await client.call('session.models', { sessionId })
    if (!models.ok) {
      void vscode.window.showWarningMessage(`This session's models cannot be read: ${models.error.message}`)
      return
    }
    await this.switchModel(client, sessionId, models.value)
  }

  /** dsh's whole catalog, one pick, one `session.selectModel`. */
  private async switchModel(client: DshApiClient, sessionId: SessionId, catalog: SessionModels): Promise<void> {
    const items = catalog.groups.flatMap(provider => provider.models.map(model => ({
      label: model.name,
      description: provider.name,
      detail: model.description,
      picked: provider.id === catalog.current.provider && model.id === catalog.current.model,
      route: { provider: provider.id, model: model.id },
    })))
    const chosen = await vscode.window.showQuickPick(items, {
      title: this.items.labelOf(sessionId) ?? 'DeepSeek',
      placeHolder: 'Switch this session to…',
    })
    if (chosen === undefined || chosen.picked) return
    // A new route may not offer the old effort, so the switch drops it —
    // the same rule the composer picker applies.
    const result = await client.call('session.selectModel', { sessionId, ...chosen.route })
    if (!result.ok) {
      this.log.error(`session.selectModel failed: ${result.error.code}: ${result.error.message}`)
      void vscode.window.showErrorMessage(`Could not switch model: ${result.error.message}`)
      return
    }
    await this.content.refreshPickers(sessionId)
  }

  /**
   * The session to act on. `/models` passes the resource of the composer it
   * was typed in; the Command Palette passes nothing, and the most recently
   * served or prompted session is the answer — the picker only asks when
   * nothing has been active at all.
   */
  private async resolveSession(target: unknown): Promise<SessionId | undefined> {
    if (target instanceof vscode.Uri) {
      const id = sessionIdOf(target)
      if (id !== undefined && !isUntitled(id)) return id
    }

    await this.items.refresh()
    const candidates = this.items.sessions().filter(summary => !summary.blank)
    const last = this.content.lastActiveSession()
    if (last !== undefined && candidates.some(summary => summary.sessionId === last)) return last
    if (candidates.length === 0) {
      void vscode.window.showInformationMessage('No DeepSeek Harness session yet — start one first.')
      return undefined
    }
    if (candidates.length === 1) return candidates[0]?.sessionId
    const picked = await vscode.window.showQuickPick(
      candidates.map(summary => ({
        label: this.items.labelOf(summary.sessionId) ?? summary.sessionId.slice(0, 8),
        description: summary.cwd,
        sessionId: summary.sessionId,
      })),
      { title: 'DeepSeek Harness: Switch Model', placeHolder: 'Which session?' },
    )
    return picked?.sessionId
  }
}
