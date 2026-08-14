import * as vscode from 'vscode'
import { Log } from './log'
import { checkProposedApi } from './proposed'
import { runProbeIfRequested } from './probe'
import { Harness } from './dsh/harness'
import { ProjectionStore } from './sessions/projections'
import { SessionItems } from './sessions/items'
import { SessionContent } from './sessions/content'
import { registerLifecycle } from './sessions/lifecycle'
import { PARTICIPANT } from './sessions/history'
import { SCHEME } from './sessions/resource'
import { onConfigChange } from './config'

let log: Log | undefined

export function activate(context: vscode.ExtensionContext): void {
  log = new Log()
  context.subscriptions.push(log)

  log.info(`activating ${context.extension.id} on VS Code ${vscode.version}`)

  context.subscriptions.push(
    vscode.commands.registerCommand('deepseekHarness.showLog', () => log?.show()),
  )

  const proposed = checkProposedApi(log)
  if (runProbeIfRequested(context, proposed)) return

  if (!proposed.ok) {
    void vscode.window.showErrorMessage(
      'DeepSeek Harness Sessions needs proposed APIs that this VS Code has not granted. See the log for the exact one-line fix.',
      'Show Log',
    ).then(choice => {
      if (choice === 'Show Log') log?.show()
    })
    return
  }

  try {
    register(context, log)
  } catch (error) {
    // Anything thrown from here up abandons the rest of registration, and the
    // editor reports it only in its own extension-host log — which is not
    // where anyone looks. Declaring a chat participant that is missing from
    // package.json is one such throw, and it silently cost the session
    // provider its content provider.
    log.error(`activation failed: ${error instanceof Error ? error.message : String(error)}`)
    void vscode.window.showErrorMessage(
      'DeepSeek Harness Sessions failed to activate. See the log for the reason.',
      'Show Log',
    ).then(choice => {
      if (choice === 'Show Log') log?.show()
    })
    return
  }

  log.info('activated')
}

/** Everything activation registers, so one failure is reported rather than swallowed. */
function register(context: vscode.ExtensionContext, log: Log): void {
  const harness = new Harness(log)
  context.subscriptions.push(harness)

  const projections = new ProjectionStore()
  context.subscriptions.push(projections)
  const items = new SessionItems(harness, projections, log)
  context.subscriptions.push(items)

  registerLifecycle(items.raw, harness, items, log)

  const content = new SessionContent(harness, projections, items, log)

  // The composer's pickers hang off the controller, not off the session
  // content: the editor asks for them with `undefined` for any chat that has
  // no session yet, which is every new chat.
  items.raw.getChatSessionInputState = (resource, _context, token) =>
    content.provideInputState(resource, token)

  // This participant is the implementation behind the agent VS Code registers
  // for the session type, so it has to do the real work — a stub here is an
  // empty response bubble for every request routed the agent way.
  const participant = vscode.chat.createChatParticipant(
    PARTICIPANT,
    (request, chatContext, stream, token) => content.handleAgentRequest(request, chatContext, stream, token),
  )
  participant.iconPath = new vscode.ThemeIcon('sparkle')
  context.subscriptions.push(participant)
  context.subscriptions.push(
    vscode.chat.registerChatSessionContentProvider(SCHEME, content, participant, {
      supportsInterruptions: true,
    }),
  )

  context.subscriptions.push(
    vscode.commands.registerCommand('deepseekHarness.restart', async () => {
      log.info('restart requested')
      await harness.restart()
      await items.refresh()
    }),
  )

  // A changed executable, home or argument list means the running child is the
  // wrong one; restarting is the only way to honour the new setting.
  context.subscriptions.push(onConfigChange(() => {
    log.info('configuration changed; restarting harness')
    void harness.restart().then(() => items.refresh())
  }))
}

export function deactivate(): void {
  log?.info('deactivating')
}
