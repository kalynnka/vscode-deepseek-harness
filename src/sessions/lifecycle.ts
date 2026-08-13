import * as vscode from 'vscode'
import type { Harness } from '../dsh/harness'
import type { Log } from '../log'
import type { SessionItems } from './items'
import { seqOfTurnId } from './history'
import { sessionIdOf, sessionResource } from './resource'

/**
 * Wires the controller's create and fork handlers.
 *
 * Both are session lifecycle rather than session content, which is why they
 * live on the item controller: the editor needs a row back, not a transcript.
 */
export function registerLifecycle(
  controller: vscode.ChatSessionItemController,
  harness: Harness,
  items: SessionItems,
  log: Log,
): void {
  /**
   * Creates a session rooted at the workspace the user is actually in.
   *
   * `session.create` accepts a workspace id or a cwd but never both, and an
   * omitted project silently uses the *host's* cwd — which is wherever the
   * extension host happened to start, not the user's project. Passing cwd
   * explicitly is what makes a new session open where the user is.
   */
  controller.newChatSessionItemHandler = async (_context, _token) => {
    const client = await harness.ensureStarted()
    const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
    const result = await client.call('session.create', cwd === undefined ? {} : { cwd })
    if (!result.ok) {
      log.error(`session.create failed: ${result.error.code}: ${result.error.message}`)
      throw new Error(result.error.message)
    }
    log.info(`newChatSessionItemHandler created ${result.value.sessionId} (cwd=${cwd ?? 'host default'})`)
    await items.refresh()
    return controller.createChatSessionItem(
      sessionResource(result.value.sessionId),
      cwd === undefined ? 'New session' : basename(cwd),
    )
  }

  /**
   * Forks at a completed-turn boundary.
   *
   * The two sides agree on where the cut goes: VS Code says the fork "includes
   * all turns up to this request turn", and dsh resolves `atSeq` to the first
   * `turn/end` at or after it. An anchor inside a turn that is still open is
   * refused with `fork-unavailable`, which is surfaced rather than swallowed —
   * silently forking an earlier turn would give the user a session that is not
   * the one they asked for.
   */
  controller.forkHandler = async (resource, request, _token) => {
    const sessionId = sessionIdOf(resource)
    if (sessionId === undefined) throw new Error('not a DeepSeek Harness session')
    const client = await harness.ensureStarted()

    const atSeq = seqOfTurnId(request?.id)
    const result = await client.call('session.fork', atSeq === undefined ? { sessionId } : { sessionId, atSeq })
    if (!result.ok) {
      log.error(`session.fork failed: ${result.error.code}: ${result.error.message}`)
      throw new Error(result.error.code === 'fork-unavailable'
        ? 'That turn has not finished yet, so there is no completed point to fork from.'
        : result.error.message)
    }
    await items.refresh()
    return controller.createChatSessionItem(sessionResource(result.value.sessionId), 'Forked session')
  }
}

function basename(path: string): string {
  return path.split(/[/\\]/).filter(Boolean).pop() ?? path
}
