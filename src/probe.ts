import * as vscode from 'vscode'
import { existsSync, writeFileSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import type { ProposedApiStatus } from './proposed'

/** Marker the caller drops in the extension folder to ask for one probe run. */
const REQUEST = '.dsh-probe-request'
/** Where the verdict is written. */
const RESULT = '.dsh-probe-result.json'

/**
 * Writes the proposed-API verdict to the extension folder and quits, when a
 * `.dsh-probe-request` marker is present.
 *
 * The proposal grant cannot be read from source: `product.json` decides for
 * some extensions, `argv.json` for the rest, and both change with the VS Code
 * release. This is how that question gets an answer from the build the user
 * actually runs, both at M0 and on every upgrade after it.
 *
 * A file marker rather than an environment variable, because the only reliable
 * way to start a second VS Code instance on macOS is `open -n`, which launches
 * through launchd and does not inherit the caller's environment.
 */
export function runProbeIfRequested(context: vscode.ExtensionContext, status: ProposedApiStatus): boolean {
  const request = join(context.extensionPath, REQUEST)
  if (!existsSync(request)) return false

  const report = {
    vscodeVersion: vscode.version,
    extensionId: context.extension.id,
    ok: status.ok,
    missing: status.missing,
  }
  try {
    writeFileSync(join(context.extensionPath, RESULT), JSON.stringify(report, null, 2), 'utf8')
    unlinkSync(request)
  } catch (error) {
    writeFileSync(join(context.extensionPath, `${RESULT}.error`), String(error), 'utf8')
  }
  void vscode.commands.executeCommand('workbench.action.quit')
  return true
}
