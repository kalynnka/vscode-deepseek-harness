import * as vscode from 'vscode'

export const SECTION = 'deepseekHarness'

export interface HarnessConfig {
  /**
   * Where a dsh is expected to serve `/api`.
   *
   * It is read twice: as the address to attach to when something is already
   * serving there, and as the port to start one on when nothing is.
   */
  url: string
  /** Explicit dsh executable, or '' to resolve it. */
  executable: string
  /** A deepseek-harness checkout to fall back to when dsh is not on PATH. */
  checkoutPath: string
  /** `$DSH_HOME` override, or '' to inherit the user's real one. */
  home: string
  /** Extra arguments appended to `dsh web`. */
  extraArgs: string[]
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
    executable: text(config, 'executable'),
    checkoutPath: text(config, 'checkoutPath'),
    home: text(config, 'home'),
    extraArgs: config.get<string[]>('extraArgs') ?? [],
  }
}

/** Fires when any setting under our section changes. */
export function onConfigChange(handler: () => void): vscode.Disposable {
  return vscode.workspace.onDidChangeConfiguration(event => {
    if (event.affectsConfiguration(SECTION)) handler()
  })
}
