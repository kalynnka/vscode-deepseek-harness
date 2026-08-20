import { spawn, type ChildProcessByStdio } from 'node:child_process'
import type { Readable } from 'node:stream'
import { existsSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import type { HarnessConfig } from '../config'
import type { Log } from '../log'

/** How dsh was found, so the log can say which one is running. */
export type LaunchKind = 'setting' | 'path' | 'checkout'

export interface Launch {
  kind: LaunchKind
  command: string
  args: string[]
  /** Human-readable description of the resolution, for the log. */
  describe: string
}

/**
 * The banner `dsh web` prints once its `/api` route owner is mounted.
 *
 * Upstream treats this line as a readiness contract, not a courtesy: it is held
 * until the Loader settles and suppressed if the tree is torn down mid-boot, so
 * supervisors may RPC the moment they see it. Waiting for it is both how we
 * learn the ephemeral port and how we know the server is ready.
 */
const BANNER = /dsh web:\s*(https?:\/\/\S+)/

/** How long to wait for that banner before giving up on the child. */
const READY_TIMEOUT_MS = 60_000

/**
 * The flag that keeps `dsh web` from opening a browser tab.
 *
 * A local `dsh web` opens one on every start as of 0.1.0-rc.8, which for a
 * harness the editor started means a browser window over the editor whenever
 * a window is the first one up. Older harnesses do not know the flag and
 * refuse the whole invocation over it, so a refusal is caught and the start
 * retried without it — see {@link HarnessProcess.start}.
 */
const NO_OPEN = '--no-open'

export class HarnessResolutionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'HarnessResolutionError'
  }
}

/** A `dsh web` that refused to start because one of our flags is not in its build. */
export class HarnessOptionUnsupportedError extends Error {
  constructor(readonly option: string) {
    super(`dsh web does not know ${option}.`)
    this.name = 'HarnessOptionUnsupportedError'
  }
}

/**
 * Finds the dsh the user already has.
 *
 * The order is explicit setting, then `PATH`, then a configured checkout. There
 * is deliberately no bundled fallback: this extension never ships a dsh, so the
 * end of the list is an error naming the two settings that fix it, not a
 * silent switch to a second, empty harness.
 *
 * The checkout entry is not a developer convenience — a monorepo checkout with
 * no global install is a normal way to run dsh, and an extension that only
 * looked at `PATH` would fail for exactly those users.
 */
export function resolveLaunch(
  config: HarnessConfig,
  port: number,
  extraArgs: string[],
  suppressBrowser: boolean,
): Launch {
  const webArgs = [
    'web', '--host', '127.0.0.1', '--port', String(port),
    ...suppressBrowser ? [NO_OPEN] : [],
    ...extraArgs,
  ]

  if (config.executable !== '') {
    if (!existsSync(config.executable)) {
      throw new HarnessResolutionError(
        `deepseekHarness.executable points at ${config.executable}, which does not exist.`,
      )
    }
    return {
      kind: 'setting',
      command: config.executable,
      args: webArgs,
      describe: `deepseekHarness.executable (${config.executable})`,
    }
  }

  const onPath = findOnPath('dsh')
  if (onPath !== undefined) {
    return { kind: 'path', command: onPath, args: webArgs, describe: `dsh on PATH (${onPath})` }
  }

  if (config.checkoutPath !== '') {
    const bin = join(config.checkoutPath, 'apps', 'cli', 'lib', 'bin.js')
    if (!existsSync(bin)) {
      throw new HarnessResolutionError(
        `deepseekHarness.checkoutPath is ${config.checkoutPath}, but ${bin} does not exist. ` +
        'Build the checkout first, or point the setting at a different one.',
      )
    }
    // `process.execPath` is the wrong interpreter here. Inside the extension
    // host it is Electron, and Electron-as-node resolves pnpm's symlinked
    // workspace packages differently: dsh dies with ERR_MODULE_NOT_FOUND on
    // its own vendored plugins. A real node is required.
    const node = findOnPath('node')
    if (node === undefined) {
      throw new HarnessResolutionError(
        'Running dsh from a checkout needs `node` on your PATH, and there is none. ' +
        'Install Node, or point `deepseekHarness.executable` at a built dsh instead.',
      )
    }
    return {
      kind: 'checkout',
      command: node,
      args: [bin, ...webArgs],
      describe: `checkout (${bin}) via ${node}`,
    }
  }

  throw new HarnessResolutionError(
    'No dsh found. This extension never ships one — it drives the harness you installed. ' +
    'Put `dsh` on your PATH, or set `deepseekHarness.executable` to it, ' +
    'or set `deepseekHarness.checkoutPath` to a built deepseek-harness checkout.',
  )
}

/**
 * The environment for the child, with the extension host's own Electron
 * plumbing removed.
 *
 * The host runs as Electron-pretending-to-be-node and advertises that through
 * the environment. Inherited wholesale, `ELECTRON_RUN_AS_NODE` and VS Code's
 * private variables follow dsh into a process that is neither Electron nor
 * part of VS Code's IPC, and change how its module resolution behaves.
 */
function childEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  delete env.NODE_OPTIONS
  for (const key of Object.keys(env)) {
    if (key.startsWith('VSCODE_')) delete env[key]
  }
  return env
}

/** Looks up an executable on `PATH` without shelling out. */
function findOnPath(name: string): string | undefined {
  const path = process.env.PATH
  if (path === undefined) return undefined
  for (const dir of path.split(delimiter)) {
    if (dir === '') continue
    const candidate = join(dir, name)
    if (existsSync(candidate)) return candidate
  }
  return undefined
}

/**
 * Owns one `dsh web` child: spawn it, confirm its URL from the banner, and
 * make sure it dies with us.
 *
 * The server it starts has no TLS and no auth, which is only acceptable
 * because it is bound to loopback and owned by this process. Nothing here may
 * widen that: the bind host is fixed at `127.0.0.1` and is not configurable.
 *
 * The *port* is fixed rather than ephemeral, and that is load-bearing: it is
 * the address the next window probes before starting anything, so a fixed one
 * is what makes four editor windows share one harness instead of running four
 * writers over one `$DSH_HOME` (docs/gaps.md §23).
 */
export class HarnessProcess {
  private child: ChildProcessByStdio<null, Readable, Readable> | undefined
  private baseUrlValue: string | undefined
  private stopping = false

  constructor(private readonly log: Log) {}

  /** The `http://127.0.0.1:<port>` origin, once the banner has been seen. */
  get baseUrl(): string | undefined {
    return this.baseUrlValue
  }

  get running(): boolean {
    return this.child !== undefined && this.child.exitCode === null
  }

  /**
   * Starts dsh and resolves with its base URL once the readiness banner lands.
   *
   * The browser flag is retried away rather than probed for: a dsh that does
   * not know {@link NO_OPEN} reports exactly that and exits, and one that does
   * is the common case, so the flag is passed first and dropped only when a
   * harness says it cannot take it. The alternative — asking a candidate its
   * version before starting it — costs every start a process to learn a
   * number that a checkout between two releases states wrongly anyway.
   *
   * @throws HarnessResolutionError when no dsh can be found.
   */
  async start(config: HarnessConfig, port: number): Promise<string> {
    if (this.running && this.baseUrlValue !== undefined) return this.baseUrlValue

    const env = childEnv()
    if (config.home !== '') {
      env.DSH_HOME = config.home
      this.log.info(`DSH_HOME overridden to ${config.home}`)
    } else {
      this.log.info(`DSH_HOME inherited (${env.DSH_HOME ?? 'default ~/.dsh'})`)
    }

    try {
      return await this.launch(resolveLaunch(config, port, config.extraArgs, true), env)
    } catch (error) {
      // Only our own flag is retried away. An unknown option the user put in
      // `extraArgs` is theirs to fix, and dropping ours would not fix it.
      if (!(error instanceof HarnessOptionUnsupportedError) || error.option !== NO_OPEN) throw error
      this.log.warn(`this dsh does not know ${NO_OPEN}; starting it again without it, so it will open a browser tab`)
      return await this.launch(resolveLaunch(config, port, config.extraArgs, false), env)
    }
  }

  /**
   * One spawn attempt, resolved by the banner and rejected by anything else.
   *
   * @throws HarnessOptionUnsupportedError when the child named one of our
   *   flags as unknown before it exited.
   */
  private async launch(launch: Launch, env: NodeJS.ProcessEnv): Promise<string> {
    this.log.info(`starting harness via ${launch.describe}`)

    const child = spawn(launch.command, launch.args, {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    this.child = child
    this.stopping = false

    return await new Promise<string>((resolve, reject) => {
      let settled = false
      let stdoutBuffer = ''
      /** The flag the child named as unknown, if it refused the invocation over one. */
      let unknownOption: string | undefined

      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        this.log.error(`harness did not report a URL within ${READY_TIMEOUT_MS / 1000}s`)
        this.stop()
        reject(new Error('dsh web did not report its URL in time. Run "DeepSeek Harness: Show Log" for its output.'))
      }, READY_TIMEOUT_MS)

      child.stdout.setEncoding('utf8')
      child.stdout.on('data', (chunk: string) => {
        stdoutBuffer += chunk
        for (const line of takeLines()) {
          this.log.info(`dsh: ${line}`)
          const match = BANNER.exec(line)
          if (match === null || settled) continue
          settled = true
          clearTimeout(timer)
          this.baseUrlValue = match[1].replace(/\/+$/, '')
          this.log.info(`harness ready at ${this.baseUrlValue}`)
          resolve(this.baseUrlValue)
        }
      })

      child.stderr.setEncoding('utf8')
      child.stderr.on('data', (chunk: string) => {
        for (const line of chunk.split('\n')) {
          if (line.trim() === '') continue
          this.log.warn(`dsh: ${line}`)
          // dsh parses its command line with commander, which writes this one
          // line and exits before anything else happens.
          const refused = /unknown option '([^']+)'/u.exec(line)
          if (refused !== null) unknownOption = refused[1]
        }
      })

      child.on('error', (error) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        reject(error)
      })

      child.on('exit', (code, signal) => {
        this.baseUrlValue = undefined
        const how = signal !== null ? `signal ${signal}` : `code ${String(code)}`
        if (this.stopping) {
          this.log.info(`harness exited (${how})`)
        } else {
          this.log.error(`harness exited unexpectedly (${how})`)
        }
        if (settled) return
        settled = true
        clearTimeout(timer)
        reject(unknownOption !== undefined
          ? new HarnessOptionUnsupportedError(unknownOption)
          : new Error(`dsh web exited before reporting a URL (${how}).`))
      })

      /** Yields whole lines, keeping any partial tail in the buffer. */
      function* takeLines(): Generator<string> {
        let index = stdoutBuffer.indexOf('\n')
        while (index >= 0) {
          const line = stdoutBuffer.slice(0, index).trimEnd()
          stdoutBuffer = stdoutBuffer.slice(index + 1)
          if (line !== '') yield line
          index = stdoutBuffer.indexOf('\n')
        }
      }
    })
  }

  /** Terminates the child. Never leave one behind: it holds a port and a session lock. */
  stop(): void {
    const child = this.child
    if (child === undefined) return
    this.stopping = true
    this.baseUrlValue = undefined
    this.child = undefined
    child.kill('SIGTERM')
    // A harness that ignores SIGTERM still must not outlive the window.
    const escalate = setTimeout(() => child.kill('SIGKILL'), 5_000)
    child.once('exit', () => clearTimeout(escalate))
  }

  dispose(): void {
    this.stop()
  }
}
