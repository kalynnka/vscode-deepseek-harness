import * as vscode from 'vscode'
import type { Harness, HarnessState } from './dsh/harness'

/** States worth a permanent hint; everything else hides the item. */
const VISIBLE = new Set<HarnessState>(['failed', 'reconnecting'])

/**
 * The standing hint that there is no dsh to talk to.
 *
 * Every other surface reports this only when the user asks it something — a
 * warning in the chat, a message on a picker — and the notification raised on
 * the first failure is gone in seconds. What is left is a sessions list that
 * is simply empty, which reads as a broken extension rather than as a harness
 * that could neither be found nor started. So the condition gets a place that
 * lasts as long as it does, and clicking it tries again.
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
    // The warning background is loud, and deliberately so for `failed`: nothing
    // in the extension works until it is fixed. A dropped socket is retrying on
    // its own, so it stays quiet.
    this.item.backgroundColor = reconnecting
      ? undefined
      : new vscode.ThemeColor('statusBarItem.warningBackground')
    this.item.tooltip = new vscode.MarkdownString(reconnecting
      ? `Lost the connection to dsh at ${this.harness.endpoint}, and retrying.\n\nClick to retry now.`
      : `No dsh is answering at ${this.harness.endpoint}, and starting one failed.\n\n`
        + 'See **DeepSeek Harness: Show Log** for why, or run `dsh web` yourself. Click to try again.')
    this.item.show()
  }

  dispose(): void {
    for (const disposable of this.disposables.reverse()) disposable.dispose()
  }
}
