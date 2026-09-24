import * as vscode from 'vscode'
import type { Harness, HarnessState } from './dsh/harness'

/** States worth a permanent hint; everything else hides the item. */
const VISIBLE = new Set<HarnessState>(['failed', 'reconnecting'])

/**
 * The standing hint that there is no dsh to talk to.
 *
 * Automatic attachment failures stay quiet. This item keeps the disconnected
 * state visible and offers a manual retry without a notification.
 */
export class HarnessStatus implements vscode.Disposable {
  private readonly item: vscode.StatusBarItem
  private readonly disposables: vscode.Disposable[] = []

  constructor(private readonly harness: Harness) {
    // Far left, ahead of the language and line-ending items: this is a "your
    // agent cannot run" condition, not an ambient fact about the file.
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100)
    this.item.command = 'deepseekHarness.reconnect'
    this.disposables.push(this.item)
    this.disposables.push(harness.onDidChangeState(state => { this.render(state) }))
    this.render(harness.state)
  }

  private render(state: HarnessState): void {
    if (!VISIBLE.has(state)) {
      this.item.hide()
      return
    }
    const reconnecting = state === 'reconnecting'
    this.item.text = reconnecting ? '$(sync~spin) dsh' : '$(debug-disconnect) dsh'
    this.item.tooltip = new vscode.MarkdownString(reconnecting
      ? `Connecting to dsh at ${this.harness.endpoint}; retrying automatically.\n\nClick to retry now.`
      : `Disconnected from dsh at ${this.harness.endpoint}. Automatic attempts have stopped.\n\n`
        + 'Start or check your dsh server, then click to reconnect. See **DeepSeek Harness: Show Log** for details.')
    this.item.show()
  }

  dispose(): void {
    for (const disposable of this.disposables.reverse()) disposable.dispose()
  }
}
