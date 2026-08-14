import * as vscode from 'vscode'
import type { Harness } from '../dsh/harness'
import type { Log } from '../log'
import type { CommandDescriptor, SessionId } from '../dsh/wire'
import type { SessionItems } from '../sessions/items'

/**
 * The slash-command proxy: dsh's command registry, surfaced in the editor.
 *
 * dsh's own web UI intercepts a composer line that starts with `/` and runs
 * it through the command registry instead of sending it to the model. The
 * editor gets the same behaviour here, through the same plane the web UI
 * uses: `commands/list` and `commands/execute` live on dsh's *remotes* RPC
 * plane (POST /api/<namespace>/<method>, arguments wrapped in `args`), not
 * in the 47-method map, and `session.prompt`'s documented slash-command
 * interception is not implemented by the running build — a `/permission`
 * line sent that way reaches the model and costs a turn. See
 * docs/gaps.md §12.
 *
 * Nothing is hardcoded: the command set, the descriptions and the input
 * hints all come from `commands/list` on the exact session, so a command
 * this dsh gains tomorrow appears here without an update.
 */

/** One slash-command outcome as the extension renders it. */
export type CommandOutcome =
  | { kind: 'success'; text?: string }
  | { kind: 'error'; text: string }
  | { kind: 'unknown'; line: string }
  | { kind: 'failed'; code: string; message: string }

/**
 * How long one session's command catalog is trusted between `commands/list`
 * calls. The registry is per-agent and changes rarely; a reconnect clears
 * the whole cache because a reconnected harness may compose different
 * plugins.
 */
const CATALOG_TTL_MS = 30_000

export class SlashProxy implements vscode.Disposable {
  private readonly catalog = new Map<SessionId, { at: number; commands: readonly CommandDescriptor[] }>()
  private readonly disposables: vscode.Disposable[] = []

  constructor(
    private readonly harness: Harness,
    private readonly items: SessionItems,
    private readonly log: Log,
  ) {
    // A reconnected harness may compose different plugins, so whatever the
    // old connection advertised is stale by definition.
    this.disposables.push(this.harness.onDidConnect(() => { this.catalog.clear() }))
  }

  /**
   * The commands dsh advertises for one session, read from the live catalog.
   * `undefined` means the harness is unreachable or the catalog could not be
   * read — never an empty list, so a caller can tell "no commands" apart
   * from "cannot say".
   */
  async list(sessionId: SessionId): Promise<readonly CommandDescriptor[] | undefined> {
    const cached = this.catalog.get(sessionId)
    if (cached !== undefined && Date.now() - cached.at < CATALOG_TTL_MS) return cached.commands

    const client = this.harness.client
    if (client === undefined) return undefined
    const result = await client.remote('commands/list', { agentId: sessionId })
    if (!result.ok) {
      this.log.warn(`commands/list failed for ${sessionId}: ${result.error.code}: ${result.error.message}`)
      return undefined
    }
    this.catalog.set(sessionId, { at: Date.now(), commands: result.value })
    return result.value
  }

  /**
   * Whether a chat prompt is one of dsh's commands for this session.
   *
   * Only *known* commands are intercepted — an unknown `/foo` flows to the
   * model as an ordinary prompt, which is exactly what dsh's own composer
   * does. Returns the exact line to execute (the original prompt, trimmed).
   */
  async match(
    prompt: string,
    sessionId: SessionId,
  ): Promise<{ line: string; descriptor: CommandDescriptor } | undefined> {
    const parsed = parseCommandLine(prompt)
    if (parsed === undefined) return undefined
    const commands = await this.list(sessionId)
    const descriptor = commands?.find(command => command.name === parsed.name)
    if (descriptor === undefined) return undefined
    return { line: `/${parsed.name}${parsed.rawInput}`, descriptor }
  }

  /**
   * Runs one line on dsh's command plane.
   *
   * The remotes plane answers `ok: true` even when the command's own outcome
   * is an error (its text rides `result.text`), and answers `value:
   * undefined` for a line no command matched — both are folded into distinct
   * outcome kinds here so callers render them differently from a transport
   * failure.
   */
  async execute(sessionId: SessionId, line: string): Promise<CommandOutcome> {
    const client = this.harness.client
    if (client === undefined) {
      return { kind: 'failed', code: 'no-client', message: 'The harness is not running.' }
    }
    const result = await client.remote('commands/execute', { agentId: sessionId, line })
    if (!result.ok) {
      this.log.error(`commands/execute failed for ${sessionId}: ${result.error.code}: ${result.error.message}`)
      return { kind: 'failed', code: result.error.code, message: result.error.message }
    }
    if (result.value === undefined) {
      this.log.info(`no command matched ${JSON.stringify(line)} on ${sessionId}`)
      return { kind: 'unknown', line }
    }
    const outcome = result.value.result
    this.log.info(`command ${JSON.stringify(line)} on ${sessionId}: ${outcome?.kind ?? 'no result'}`)
    if (outcome === undefined) return { kind: 'success' }
    if (outcome.kind === 'error') {
      return { kind: 'error', text: outcome.text ?? `command failed on ${sessionId}` }
    }
    return { kind: 'success', text: outcome.text }
  }

  /**
   * The Command Palette entry: pick a session, pick a command from dsh's own
   * catalog, fill its argument, and run it.
   *
   * A freshly created session is used when none has ever run a turn, and the
   * catalog is read per session so a preset switch that changes which
   * commands resolve is reflected here too.
   */
  async runPalette(): Promise<void> {
    let client
    try {
      client = await this.harness.ensureStarted()
    } catch {
      void vscode.window.showErrorMessage('The harness is not running. Try "DeepSeek Harness: Restart Harness Process".')
      return
    }

    // A fresh list: sessions may have come or gone since the last refresh,
    // and the rows are the only place this command can learn about them.
    await this.items.refresh()
    let candidates = this.items.sessions().filter(summary => !summary.blank)
    let sessionId: SessionId | undefined = candidates[0]?.sessionId

    if (candidates.length === 0) {
      // No session has ever run a turn. Creating one in the workspace is the
      // same thing "New Session" does, so the command has somewhere to act.
      const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
      const created = await client.call('session.create', cwd === undefined ? {} : { cwd })
      if (!created.ok) {
        void vscode.window.showErrorMessage(`Could not create a session: ${created.error.message}`)
        return
      }
      sessionId = created.value.sessionId
      this.log.info(`slash command will run on a new session ${sessionId}`)
    } else if (candidates.length > 1) {
      const picked = await vscode.window.showQuickPick(
        candidates.map(summary => ({
          label: this.items.labelOf(summary.sessionId) ?? summary.sessionId.slice(0, 8),
          description: summary.cwd,
          sessionId: summary.sessionId,
        })),
        { title: 'DeepSeek Harness: Run Slash Command', placeHolder: 'Which session should it act on?' },
      )
      if (picked === undefined) return
      sessionId = picked.sessionId
    }
    if (sessionId === undefined) return

    const commands = await this.list(sessionId)
    if (commands === undefined || commands.length === 0) {
      void vscode.window.showWarningMessage('This dsh build offers no slash commands for this session.')
      return
    }

    const rows: CommandPickItem[] = [{
      label: '$(terminal-prompt) Enter a slash command…',
      detail: 'Type any /command line, including ones the picker does not list yet',
      freeform: true,
    }]
    for (const command of commands) {
      rows.push({
        label: `/${command.name}`,
        description: command.input?.hint,
        detail: command.description,
        command,
      })
    }
    const pickedCommand = await vscode.window.showQuickPick(rows, {
      title: 'DeepSeek Harness: Run Slash Command',
      placeHolder: 'Pick a command dsh offers for this session',
    })
    if (pickedCommand === undefined) return

    let line: string
    if (pickedCommand.freeform) {
      const typed = await vscode.window.showInputBox({
        prompt: 'Full slash command line',
        value: '/',
        ignoreFocusOut: true,
      })
      if (typed === undefined || typed.trim() === '') return
      line = typed.trim()
    } else if (pickedCommand.command !== undefined) {
      const { name, input } = pickedCommand.command
      if (input === undefined) {
        line = `/${name}`
      } else {
        const argument = await vscode.window.showInputBox({
          prompt: `Arguments for /${name}`,
          value: `/${name} `,
          placeHolder: input.hint,
          ignoreFocusOut: true,
        })
        if (argument === undefined) return
        line = argument.trim()
      }
    } else {
      return
    }

    await this.runAndReport(sessionId, line)
  }

  /** Executes one line and puts its outcome in front of the user. */
  private async runAndReport(sessionId: SessionId, line: string): Promise<void> {
    const outcome = await this.execute(sessionId, line)
    switch (outcome.kind) {
      case 'success':
        if (outcome.text !== undefined && outcome.text.trim() !== '') {
          void vscode.window.showInformationMessage(outcome.text)
        } else {
          void vscode.window.showInformationMessage(`${line} — done.`)
        }
        break
      case 'error':
        void vscode.window.showWarningMessage(outcome.text)
        break
      case 'unknown':
        void vscode.window.showWarningMessage(`Unknown or malformed command: ${outcome.line}`)
        break
      case 'failed':
        void vscode.window.showErrorMessage(outcome.message)
        break
    }
  }

  dispose(): void {
    for (const disposable of this.disposables.reverse()) disposable.dispose()
  }
}

/** One row of the command picker, tagged with what it runs. */
interface CommandPickItem extends vscode.QuickPickItem {
  command?: CommandDescriptor
  freeform?: boolean
}

/**
 * Parses a prompt as one exact slash-command line, with dsh's own grammar:
 * `/name` followed by whitespace-or-end, everything after the name being the
 * raw input. A line that is not a command at all parses to `undefined`.
 */
export function parseCommandLine(line: string): { name: string; rawInput: string } | undefined {
  const trimmed = line.trim()
  const match = /^\/([a-z][a-z0-9_-]*)(?=$|[\t\n\r ])/u.exec(trimmed)
  if (match === null) return undefined
  const name = match[1]
  if (name === undefined) return undefined
  return { name, rawInput: trimmed.slice(match[0].length) }
}
