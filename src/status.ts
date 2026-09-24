import * as vscode from 'vscode'
import type { Harness, HarnessState } from './dsh/harness'

const LABELS: Record<HarnessState, string> = {
  stopped: 'Disconnected',
  connecting: 'Connecting…',
  connected: 'Connected',
  reconnecting: 'Reconnecting…',
  failed: 'Disconnected',
}

/**
 * Always shows the dsh connection state and offers a manual reconnect.
 * Non-connected states use a disconnected plug and warning color.
 */
export class HarnessStatus implements vscode.Disposable {
  private readonly item: vscode.StatusBarItem
  private readonly disposables: vscode.Disposable[] = []

  constructor(private readonly harness: Harness) {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100)
    this.item.command = 'deepseekHarness.reconnect'
    this.disposables.push(this.item)
    this.disposables.push(harness.onDidChangeState(state => { this.render(state) }))
    this.render(harness.state)
  }

  private render(state: HarnessState): void {
    const connected = state === 'connected'
    this.item.text = `$(${connected ? 'debug-connected' : 'debug-disconnect'}) dsh`
    this.item.backgroundColor = connected ? undefined : new vscode.ThemeColor('statusBarItem.warningBackground')
    const detail = state === 'reconnecting'
      ? 'Retrying automatically. Click to retry now.'
      : state === 'connecting'
        ? 'Connection attempt in progress. Click to retry now.'
        : connected
          ? 'Click to reconnect.'
          : 'Start or check your dsh server, then click to reconnect. See **DeepSeek Harness: Show Log** for details.'
    this.item.tooltip = new vscode.MarkdownString(`${LABELS[state]} — dsh at ${this.harness.endpoint}.\n\n${detail}`)
    this.item.show()
  }

  dispose(): void {
    for (const disposable of this.disposables.reverse()) disposable.dispose()
  }
}
