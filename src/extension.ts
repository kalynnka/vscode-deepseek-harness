import * as vscode from 'vscode'
import { Log } from './log'
import { checkProposedApi } from './proposed'
import { runProbeIfRequested } from './probe'
import { Harness } from './dsh/harness'
import { ProjectionStore } from './sessions/projections'
import { SessionItems } from './sessions/items'
import { SessionContent } from './sessions/content'
import { SlashProxy } from './slash/proxy'
import { ModelPicker } from './model-picker'
import { registerLifecycle } from './sessions/lifecycle'
import { PARTICIPANT } from './sessions/history'
import { SCHEME } from './sessions/resource'
import { onConfigChange } from './config'
import { HarnessStatus } from './status'
import { SHARED_HOME_WARNING } from './dsh/endpoint'

/** Global-state key: the shared-`$DSH_HOME` warning has been acknowledged. */
const SHARED_HOME_ACKNOWLEDGED = 'deepseekHarness.sharedHomeAcknowledged'

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
  context.subscriptions.push(new HarnessStatus(harness))

  // Starting a harness puts a second potential writer on the user's
  // `$DSH_HOME`, and dsh has no lock that would make that safe. The extension
  // avoids being that writer by attaching to anything already serving, but the
  // user can still start one *after* this — so the moment a child exists, they
  // are told what not to do. Logged every time, shown until acknowledged.
  context.subscriptions.push(harness.onDidSpawn(() => {
    log.warn(SHARED_HOME_WARNING)
    if (context.globalState.get<boolean>(SHARED_HOME_ACKNOWLEDGED) === true) return
    void vscode.window.showWarningMessage(SHARED_HOME_WARNING, 'Got It', 'Show Log').then(choice => {
      if (choice === 'Show Log') log.show()
      if (choice !== undefined) void context.globalState.update(SHARED_HOME_ACKNOWLEDGED, true)
    })
  }))

  const projections = new ProjectionStore()
  context.subscriptions.push(projections)
  const items = new SessionItems(harness, projections, log)
  context.subscriptions.push(items)

  registerLifecycle(items.raw, harness, items, log)

  // dsh's slash commands, proxied: typed in the chat they are intercepted
  // before they can reach the model, and a Command Palette entry runs one
  // against a session of the user's choosing. The command set is read live
  // from dsh — nothing here is a hardcoded list.
  const slash = new SlashProxy(harness, items, log)
  context.subscriptions.push(slash)

  const content = new SessionContent(harness, projections, items, log, slash)

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
  // dsh's own mark rather than a codicon, so the agent reads as the harness it
  // drives. The wordmark's whale is drawn in `currentColor`, so it is rendered
  // once per theme rather than pinned to a colour that would vanish in one.
  participant.iconPath = {
    light: vscode.Uri.joinPath(context.extensionUri, 'media', 'agent-light.png'),
    dark: vscode.Uri.joinPath(context.extensionUri, 'media', 'agent-dark.png'),
  }
  context.subscriptions.push(participant)
  context.subscriptions.push(
    vscode.chat.registerChatSessionContentProvider(SCHEME, content, participant, {
      supportsInterruptions: true,
    }),
  )

  context.subscriptions.push(
    vscode.commands.registerCommand('deepseekHarness.reconnect', async () => {
      log.info('reconnect requested')
      await harness.reconnect()
      await items.refresh()
    }),
  )

  context.subscriptions.push(
    vscode.commands.registerCommand('deepseekHarness.slashCommand.run', () => slash.runPalette()),
  )

  // dsh's model catalog behind `/models` and the Command Palette — the
  // shadow that makes the editor's no-op `/models` do something real.
  const models = new ModelPicker(harness, items, content, log)
  context.subscriptions.push(
    vscode.commands.registerCommand('deepseekHarness.pickModel', (resource?: unknown) => models.pick(resource)),
  )


  // A changed URL points at a different harness, so the open connection is to
  // the wrong one; re-attaching is the only way to honour the new setting.
  context.subscriptions.push(onConfigChange(() => {
    log.info('configuration changed; re-attaching to the harness')
    void harness.reconnect().then(() => items.refresh(), () => {})
  }))
}

export function deactivate(): void {
  log?.info('deactivating')
}
