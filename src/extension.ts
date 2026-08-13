import * as vscode from 'vscode'
import { Log } from './log'
import { checkProposedApi } from './proposed'
import { runProbeIfRequested } from './probe'
import { Harness } from './dsh/harness'
import { ProjectionStore } from './sessions/projections'
import { SessionItems } from './sessions/items'
import { SessionContent } from './sessions/content'
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

  const harness = new Harness(log)
  context.subscriptions.push(harness)

  const projections = new ProjectionStore()
  const items = new SessionItems(harness, projections, log)
  context.subscriptions.push(items)

  const participant = vscode.chat.createChatParticipant(PARTICIPANT, () => {
    // Requests reach the session's own `requestHandler`; this participant
    // exists because the content provider registration requires one.
    return {}
  })
  participant.iconPath = new vscode.ThemeIcon('sparkle')
  context.subscriptions.push(participant)

  const content = new SessionContent(harness, projections, items, log)
  context.subscriptions.push(
    vscode.chat.registerChatSessionContentProvider(SCHEME, content, participant, {
      supportsInterruptions: true,
    }),
  )

  context.subscriptions.push(
    vscode.commands.registerCommand('deepseekHarness.restart', async () => {
      log?.info('restart requested')
      await harness.restart()
      await items.refresh()
    }),
  )

  // A changed executable, home or argument list means the running child is the
  // wrong one; restarting is the only way to honour the new setting.
  context.subscriptions.push(onConfigChange(() => {
    log?.info('configuration changed; restarting harness')
    void harness.restart().then(() => items.refresh())
  }))

  log.info('activated')
}

export function deactivate(): void {
  log?.info('deactivating')
}
