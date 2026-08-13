import * as vscode from 'vscode'
import { DshApiClient } from './client'
import { ConnectionController, type ConnectionState } from './connection'
import { HarnessProcess, HarnessResolutionError } from './process'
import { readConfig } from '../config'
import type { Log } from '../log'
import type { Envelope, HostFrame, MuxFrame, SessionId } from './wire'

/** What the harness is doing, for surfaces that show it. */
export type HarnessState = 'stopped' | 'starting' | 'connected' | 'reconnecting' | 'failed'

/**
 * The whole dsh side of the extension: one child process, one API client, one
 * connection, and the frame bus everything else subscribes to.
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
  private starting: Promise<DshApiClient> | undefined

  private readonly muxEmitter = new vscode.EventEmitter<Envelope<MuxFrame>>()
  private readonly hostEmitter = new vscode.EventEmitter<Envelope<HostFrame>>()
  private readonly stateEmitter = new vscode.EventEmitter<HarnessState>()
  private readonly connectedEmitter = new vscode.EventEmitter<void>()

  /** Every mux frame, in arrival order. */
  readonly onMuxFrame = this.muxEmitter.event
  /** Every host frame, in arrival order. */
  readonly onHostFrame = this.hostEmitter.event
  readonly onDidChangeState = this.stateEmitter.event
  /** Fires after each connection generation settles — the cue to re-baseline. */
  readonly onDidConnect = this.connectedEmitter.event

  constructor(private readonly log: Log) {
    this.process = new HarnessProcess(log)
  }

  get state(): HarnessState {
    return this.stateValue
  }

  /** The API client, once connected. */
  get client(): DshApiClient | undefined {
    return this.clientValue
  }

  /**
   * Starts the harness if it is not already running, and resolves with a
   * client that is ready to use. Concurrent callers share one start.
   */
  async ensureStarted(): Promise<DshApiClient> {
    if (this.clientValue !== undefined && this.process.running) return this.clientValue
    this.starting ??= this.startOnce().finally(() => { this.starting = undefined })
    return await this.starting
  }

  private async startOnce(): Promise<DshApiClient> {
    const missing = DshApiClient.missingGlobal()
    if (missing !== undefined) {
      this.setState('failed')
      throw new Error(
        `This VS Code's extension host has no global \`${missing}\`, which the dsh transport needs. ` +
        'A newer VS Code (with a newer bundled Node) is the fix.',
      )
    }

    this.setState('starting')
    try {
      const baseUrl = await this.process.start(readConfig())
      const client = new DshApiClient(baseUrl)
      this.clientValue = client

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
      if (error instanceof HarnessResolutionError) this.log.error(error.message)
      else this.log.error(`failed to start harness: ${error instanceof Error ? error.message : String(error)}`)
      throw error
    }
  }

  /** Stops the connection and the child, leaving the harness restartable. */
  stop(): void {
    this.connection?.stop()
    this.connection = undefined
    this.clientValue = undefined
    this.process.stop()
    this.setState('stopped')
  }

  async restart(): Promise<void> {
    this.stop()
    await this.ensureStarted()
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
