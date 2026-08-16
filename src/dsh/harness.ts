import * as vscode from 'vscode'
import { DshApiClient } from './client'
import { ConnectionController, type ConnectionState } from './connection'
import { HarnessProcess } from './process'
import { HarnessUnreachableError, isLocal, portOf, resolveEndpoint } from './endpoint'
import { readConfig, type HarnessConfig } from '../config'
import type { Log } from '../log'
import type { Envelope, HostFrame, MuxFrame, SessionId } from './wire'

/** What the harness is doing, for surfaces that show it. */
export type HarnessState = 'stopped' | 'connecting' | 'connected' | 'reconnecting' | 'failed'

/**
 * The whole dsh side of the extension: at most one child process, one API
 * client, one connection, and the frame bus everything else subscribes to.
 *
 * **Attach first, start second.** A dsh that is already serving the endpoint is
 * attached to — the one you ran in a terminal, or the one another window
 * started — and a child is spawned only when nothing answers there. That order
 * is the whole defence against the hazard dsh leaves open: it has no
 * cross-process lock on session logs, so two harnesses over one `$DSH_HOME`
 * interleave their appends and corrupt them (docs/gaps.md §23). The extension
 * therefore cannot become the second writer by accident; it can only be one if
 * the user starts another harness *after* it, which is what
 * {@link SHARED_HOME_WARNING} is for.
 *
 * Frames are re-broadcast rather than consumed here. This class knows how to
 * reach dsh; it deliberately knows nothing about how a turn renders, so the
 * session layer can be replaced without touching the transport.
 */
export class Harness implements vscode.Disposable {
  private readonly process: HarnessProcess
  private connection: ConnectionController | undefined
  private clientValue: DshApiClient | undefined
  private stateValue: HarnessState = 'stopped'
  private connecting: Promise<DshApiClient> | undefined
  /** Whether the client in hand talks to this window's own child. */
  private ownedClient = false
  /** Whether the user has already been told this harness is unreachable. */
  private reported = false

  private readonly muxEmitter = new vscode.EventEmitter<Envelope<MuxFrame>>()
  private readonly hostEmitter = new vscode.EventEmitter<Envelope<HostFrame>>()
  private readonly stateEmitter = new vscode.EventEmitter<HarnessState>()
  private readonly connectedEmitter = new vscode.EventEmitter<void>()
  private readonly spawnedEmitter = new vscode.EventEmitter<void>()

  /** Every mux frame, in arrival order. */
  readonly onMuxFrame = this.muxEmitter.event
  /** Every host frame, in arrival order. */
  readonly onHostFrame = this.hostEmitter.event
  readonly onDidChangeState = this.stateEmitter.event
  /** Fires after each connection generation settles — the cue to re-baseline. */
  readonly onDidConnect = this.connectedEmitter.event
  /**
   * Fires when this window *started* a harness rather than attaching to one.
   * The cue to tell the user their `$DSH_HOME` now has a writer they did not
   * start themselves.
   */
  readonly onDidSpawn = this.spawnedEmitter.event

  constructor(private readonly log: Log) {
    this.process = new HarnessProcess(log)
  }

  /** Whether the dsh in use is this window's child rather than one it attached to. */
  get owned(): boolean {
    return this.ownedClient && this.process.running
  }

  get state(): HarnessState {
    return this.stateValue
  }

  /** The API client, once connected. */
  get client(): DshApiClient | undefined {
    return this.clientValue
  }

  /**
   * Where this extension is looking for dsh, for surfaces that have to say so.
   *
   * A setting that does not resolve is quoted back as it stands rather than
   * repaired: "No dsh at `not-a-url`" points at the thing to fix, where a
   * substituted default would send the user looking for a harness that was
   * never going to be contacted.
   */
  get endpoint(): string {
    const { url } = readConfig()
    try {
      return resolveEndpoint(readConfig())
    } catch {
      return url === '' ? '(deepseekHarness.url is empty)' : JSON.stringify(url)
    }
  }

  /**
   * Resolves with a client that is ready to use: attached to a dsh already
   * serving the endpoint, or to one started here when nothing was. Concurrent
   * callers share one attempt.
   *
   * A client this window owns is only reusable while its child is alive; a
   * child that died has to be noticed here, or every later call goes to a port
   * nothing is listening on.
   *
   * @throws HarnessUnreachableError when nothing answers and none can be started.
   */
  async ensureConnected(): Promise<DshApiClient> {
    if (this.clientValue !== undefined && (this.ownedClient === false || this.process.running)) {
      return this.clientValue
    }
    if (this.clientValue !== undefined) {
      this.log.warn('the dsh this window started is gone; attaching again')
      this.stop()
    }
    this.connecting ??= this.connectOnce().finally(() => { this.connecting = undefined })
    return await this.connecting
  }

  private async connectOnce(): Promise<DshApiClient> {
    const missing = DshApiClient.missingGlobal()
    if (missing !== undefined) {
      this.setState('failed')
      throw new Error(
        `This VS Code's extension host has no global \`${missing}\`, which the dsh transport needs. ` +
        'A newer VS Code (with a newer bundled Node) is the fix.',
      )
    }

    this.setState('connecting')
    try {
      const config = readConfig()
      const endpoint = resolveEndpoint(config)

      const { client, owned } = await this.attachOrStart(config, endpoint)
      this.clientValue = client
      this.ownedClient = owned
      this.reported = false
      if (owned) this.spawnedEmitter.fire()

      this.connection = new ConnectionController(client, {
        onMuxEnvelope: envelope => this.muxEmitter.fire(envelope),
        onHostEnvelope: envelope => this.hostEmitter.fire(envelope),
        onConnected: () => {
          this.setState('connected')
          this.connectedEmitter.fire()
        },
        onStateChange: (state: ConnectionState) => {
          if (state === 'reconnecting') this.setState('reconnecting')
        },
        onLog: message => this.log.warn(message),
      })
      this.connection.start()
      return client
    } catch (error) {
      this.setState('failed')
      const message = error instanceof Error ? error.message : String(error)
      this.log.error(message)
      // Every surface reports this in its own place — a warning in the chat, a
      // message on a picker — but a window whose sessions list is simply empty
      // shows none of them, and that is the first thing a user sees. Told
      // once per outage, not once per call.
      if (!this.reported) {
        this.reported = true
        void vscode.window.showWarningMessage(message, 'Copy Command', 'Show Log').then(choice => {
          if (choice === 'Show Log') this.log.show()
          // The command rather than a terminal running it: starting your dsh
          // stays your keystroke, in your shell, with your environment.
          if (choice === 'Copy Command') void vscode.env.clipboard.writeText('dsh web')
        })
      }
      throw error
    }
  }

  /**
   * The attach-first order: use the dsh already serving the endpoint, and
   * start one only when nothing answers there.
   *
   * "Nothing answers" is the only case that justifies a child, because it is
   * the only case where starting one cannot make this window the second writer
   * of a `$DSH_HOME` — see the class comment. Attaching also means a second,
   * third and fourth editor window cost no extra harness: they all find the
   * first one's child on the same fixed port.
   */
  private async attachOrStart(
    config: HarnessConfig,
    endpoint: string,
  ): Promise<{ client: DshApiClient; owned: boolean }> {
    const attached = new DshApiClient(endpoint)
    if (await this.describe(attached, endpoint, 'attached to')) {
      return { client: attached, owned: false }
    }

    if (!isLocal(endpoint)) {
      throw new HarnessUnreachableError(
        `Nothing is serving ${endpoint}, and that is not this machine — a harness started here `
        + 'would bind loopback and still not answer it. Start dsh where that URL points, '
        + 'or clear `deepseekHarness.url` to use a local one.',
      )
    }

    this.log.info(`nothing is serving ${endpoint}; starting a dsh for this window`)
    let baseUrl: string
    try {
      baseUrl = await this.process.start(config, portOf(endpoint))
    } catch (error) {
      // Two windows waking together both find the port silent and both start a
      // dsh; one binds it and the other dies on the address. The loser attaches
      // to the winner rather than reporting a failure that has already fixed
      // itself.
      const winner = new DshApiClient(endpoint)
      if (await this.describe(winner, endpoint, 'lost the start race, attached to')) {
        return { client: winner, owned: false }
      }
      throw error
    }

    const started = new DshApiClient(baseUrl)
    if (!await this.describe(started, baseUrl, 'started')) {
      throw new HarnessUnreachableError(
        `dsh reported ${baseUrl} but does not answer there. `
        + 'Run "DeepSeek Harness: Show Log" for its output.',
      )
    }
    return { client: started, owned: true }
  }

  /**
   * Whether a dsh answers here, and a log line saying which one it is.
   *
   * `host.describe` is an open record — a deployment may publish more or fewer
   * fields than this build knows — so the line is built from whatever scalars
   * it did send.
   */
  private async describe(client: DshApiClient, baseUrl: string, verb: string): Promise<boolean> {
    const described = await client.call('host.describe', {})
    if (!described.ok) {
      this.log.info(`no dsh at ${baseUrl} (${described.error.code}: ${described.error.message})`)
      return false
    }
    const host = described.value
    const field = (key: string): string => {
      const value = host[key]
      return typeof value === 'string' || typeof value === 'number' ? String(value) : '?'
    }
    this.log.info(
      `${verb} dsh ${field('version')} at ${baseUrl} `
      + `(cwd ${field('cwd')}, ${field('attachedSessions')} sessions attached)`,
    )
    return true
  }

  /** Drops the connection and any child this window started. */
  stop(): void {
    this.connection?.stop()
    this.connection = undefined
    this.clientValue = undefined
    this.ownedClient = false
    this.process.stop()
    this.setState('stopped')
  }

  /** Drops the connection and attaches again — after a restart of dsh, or a settings change. */
  async reconnect(): Promise<void> {
    this.stop()
    this.reported = false
    await this.ensureConnected()
  }

  private setState(state: HarnessState): void {
    if (this.stateValue === state) return
    this.stateValue = state
    this.log.info(`harness state: ${state}`)
    this.stateEmitter.fire(state)
  }

  dispose(): void {
    this.stop()
    this.muxEmitter.dispose()
    this.hostEmitter.dispose()
    this.stateEmitter.dispose()
    this.connectedEmitter.dispose()
  }
}

/** Narrows a mux frame to the session it concerns, when it concerns one. */
export function frameSessionId(frame: MuxFrame | HostFrame): SessionId | undefined {
  const candidate = (frame as { sessionId?: unknown }).sessionId
  return typeof candidate === 'string' ? candidate : undefined
}
