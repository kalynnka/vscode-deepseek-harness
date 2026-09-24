import * as vscode from 'vscode'

export const SECTION = 'deepseekHarness'

export interface HarnessConfig {
  /** Where the user-managed dsh serves `/api`. */
  url: string
  /** Home to read local authentication from, or '' to use the user's default. */
  home: string
  /** How long to retry transient attachment failures before staying quiet. */
  retryDurationSeconds: number
}

/**
 * Every default lives in `package.json` and nowhere else.
 *
 * A setting the manifest declares always resolves — to the user's value, or to
 * the default the manifest carries — so repeating those defaults here would be
 * a second place for them to drift from. The `??` below is a type narrowing
 * for a key that is not registered at all, not a policy: a `url` the user has
 * emptied by hand is left empty, and fails in `resolveEndpoint` naming the
 * setting, rather than quietly resolving to an address they did not ask for.
 */
function text(config: vscode.WorkspaceConfiguration, key: string): string {
  return (config.get<string>(key) ?? '').trim()
}

export function readConfig(): HarnessConfig {
  const config = vscode.workspace.getConfiguration(SECTION)
  return {
    url: text(config, 'url'),
    home: text(config, 'home'),
    retryDurationSeconds: Math.max(0, config.get<number>('retryDurationSeconds') ?? 0),
  }
}

/** Fires when any setting under our section changes. */
export function onConfigChange(handler: () => void): vscode.Disposable {
  return vscode.workspace.onDidChangeConfiguration(event => {
    if (event.affectsConfiguration(SECTION)) handler()
  })
}
