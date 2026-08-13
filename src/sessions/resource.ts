import * as vscode from 'vscode'
import type { SessionId } from '../dsh/wire'

/**
 * The URI scheme this extension's sessions live under.
 *
 * It is also the key VS Code uses to route a session resource back to our
 * content provider, so it must match the scheme passed to
 * `registerChatSessionContentProvider`.
 */
export const SCHEME = 'deepseek-harness'

/** The chat session type declared in `contributes.chatSessions`. */
export const SESSION_TYPE = 'deepseek-harness'

/**
 * `deepseek-harness:/<sessionId>` — the editor's own convention for a session
 * resource: the scheme names the provider and the single path segment is the id.
 */
export function sessionResource(sessionId: SessionId): vscode.Uri {
  return vscode.Uri.from({ scheme: SCHEME, path: `/${sessionId}` })
}

/**
 * Whether this is the editor's placeholder for a chat that has not started.
 *
 * VS Code mints an `untitled-<uuid>` resource as soon as a new chat is opened
 * and asks for its content before the user has typed anything, so there is no
 * dsh session behind it yet.
 */
export function isUntitled(sessionId: SessionId): boolean {
  return sessionId.startsWith('untitled-')
}

/** The inverse of {@link sessionResource}; undefined for a URI that is not ours. */
export function sessionIdOf(resource: vscode.Uri): SessionId | undefined {
  if (resource.scheme !== SCHEME) return undefined
  const id = resource.path.replace(/^\//, '')
  return id === '' ? undefined : id
}
