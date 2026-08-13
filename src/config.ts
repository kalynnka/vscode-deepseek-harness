import * as vscode from 'vscode'

export const SECTION = 'deepseekHarness'

export interface HarnessConfig {
  /** Explicit dsh executable, or '' to resolve it. */
  executable: string
  /** A deepseek-harness checkout to fall back to when dsh is not on PATH. */
  checkoutPath: string
  /** `$DSH_HOME` override, or '' to inherit the user's real one. */
  home: string
  /** Extra arguments appended to `dsh web`. */
  extraArgs: string[]
}

export function readConfig(): HarnessConfig {
  const config = vscode.workspace.getConfiguration(SECTION)
  return {
    executable: config.get<string>('executable', '').trim(),
    checkoutPath: config.get<string>('checkoutPath', '').trim(),
    home: config.get<string>('home', '').trim(),
    extraArgs: config.get<string[]>('extraArgs', []),
  }
}

/** Fires when any setting under our section changes. */
export function onConfigChange(handler: () => void): vscode.Disposable {
  return vscode.workspace.onDidChangeConfiguration(event => {
    if (event.affectsConfiguration(SECTION)) handler()
  })
}
