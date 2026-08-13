import * as vscode from 'vscode'
import { Log } from './log'
import { checkProposedApi } from './proposed'
import { runProbeIfRequested } from './probe'

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

  log.info('activated')
}

export function deactivate(): void {
  log?.info('deactivating')
}
