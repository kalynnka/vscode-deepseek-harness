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

export class HarnessResolutionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'HarnessResolutionError'
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
export function resolveLaunch(config: HarnessConfig, extraArgs: string[]): Launch {
  const webArgs = ['web', '--host', '127.0.0.1', '--port', '0', ...extraArgs]

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
    return {
      kind: 'checkout',
      command: process.execPath,
      args: [bin, ...webArgs],
      describe: `checkout (${bin})`,
    }
  }

  throw new HarnessResolutionError(
    'No dsh found. This extension never ships one — it drives the harness you installed. ' +
    'Put `dsh` on your PATH, or set `deepseekHarness.executable` to it, ' +
    'or set `deepseekHarness.checkoutPath` to a built deepseek-harness checkout.',
  )
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
 * Owns one `dsh web` child: spawn it, learn its port from the banner, and make
 * sure it dies with us.
 *
 * The server it starts has no TLS and no auth, which is only acceptable
 * because it is bound to loopback on an ephemeral port and owned by this
 * process. Nothing here may widen that: the bind host is fixed at `127.0.0.1`
 * and is not configurable.
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
   * @throws HarnessResolutionError when no dsh can be found.
   */
  async start(config: HarnessConfig): Promise<string> {
    if (this.running && this.baseUrlValue !== undefined) return this.baseUrlValue

    const launch = resolveLaunch(config, config.extraArgs)
    this.log.info(`starting harness via ${launch.describe}`)

    const env = { ...process.env }
    if (config.home !== '') {
      env.DSH_HOME = config.home
      this.log.info(`DSH_HOME overridden to ${config.home}`)
    } else {
      this.log.info(`DSH_HOME inherited (${env.DSH_HOME ?? 'default ~/.dsh'})`)
    }

    const child = spawn(launch.command, launch.args, {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    this.child = child
    this.stopping = false

    return await new Promise<string>((resolve, reject) => {
      let settled = false
      let stdoutBuffer = ''

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
          if (line.trim() !== '') this.log.warn(`dsh: ${line}`)
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
        reject(new Error(`dsh web exited before reporting a URL (${how}).`))
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
