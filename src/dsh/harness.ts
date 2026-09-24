import * as vscode from 'vscode'
import { setTimeout as delay } from 'node:timers/promises'
import { DshApiClient } from './client'
import { ConnectionController } from './connection'
import { DshEndpoint } from './endpoint'
import { localDshHome } from './local-auth'
import { DshTransportError, waitWithSignal } from './transport-error'
import { readConfig } from '../config'
import type { CredentialStore } from './auth'
import type { Log } from '../log'
import type { Envelope, HostFrame, MuxFrame, SessionId } from './wire'

export type HarnessState = 'stopped' | 'connecting' | 'connected' | 'reconnecting' | 'failed'

const RETRY_INTERVAL_MS = 10_000

function retryable(error: unknown): boolean {
  return error instanceof DshTransportError
    && ['refused', 'timeout', 'transport'].includes(error.kind)
}

/** One authenticated connection to a user-managed dsh. Never owns its process. */
export class Harness implements vscode.Disposable {
  private connection: ConnectionController | undefined
  private clientValue: DshApiClient | undefined
  private stateValue: HarnessState = 'stopped'
  private connecting: Promise<DshApiClient> | undefined
  private lastFailure: unknown
  private lifetime = new AbortController()
  private disposed = false
  private updatingUrl = false
  private readonly answerers = new Map<string, number>()
  private readonly muxEmitter = new vscode.EventEmitter<Envelope<MuxFrame>>()
  private readonly hostEmitter = new vscode.EventEmitter<Envelope<HostFrame>>()
  private readonly stateEmitter = new vscode.EventEmitter<HarnessState>()
  private readonly connectedEmitter = new vscode.EventEmitter<void>()
  readonly onMuxFrame = this.muxEmitter.event
  readonly onHostFrame = this.hostEmitter.event
  readonly onDidChangeState = this.stateEmitter.event
  readonly onDidConnect = this.connectedEmitter.event

  constructor(private readonly log: Log, private readonly secrets: CredentialStore) {}

  get state(): HarnessState { return this.stateValue }
  get client(): DshApiClient | undefined { return this.clientValue }
  get endpoint(): string {
    try { return new DshEndpoint(readConfig().url).base } catch { return '(invalid deepseekHarness.url)' }
  }

  claimInteractions(sessionId: string): vscode.Disposable {
    this.answerers.set(sessionId, (this.answerers.get(sessionId) ?? 0) + 1)
    return new vscode.Disposable(() => {
      const remaining = (this.answerers.get(sessionId) ?? 1) - 1
      if (remaining === 0) this.answerers.delete(sessionId)
      else this.answerers.set(sessionId, remaining)
    })
  }

  async ensureConnected(): Promise<DshApiClient> {
    if (this.disposed) throw new DshTransportError('cancelled', 'dsh connection disposed.')
    if (this.stateValue === 'connected' && this.clientValue !== undefined) return this.clientValue
    // Background list refreshes must not restart an exhausted retry cycle.
    if (this.stateValue === 'failed') throw this.lastFailure
    if (this.connecting === undefined) {
      const pending = this.connectWithRetries(this.lifetime.signal).finally(() => {
        if (this.connecting === pending) this.connecting = undefined
      })
      this.connecting = pending
    }
    return this.connecting
  }

  private async connectWithRetries(signal: AbortSignal): Promise<DshApiClient> {
    if (this.stateValue !== 'reconnecting') this.setState('connecting')
    const deadline = Date.now() + readConfig().retryDurationSeconds * 1000
    for (;;) {
      try {
        return await this.connectOnce(signal)
      } catch (error) {
        if (signal.aborted) throw new DshTransportError('cancelled', 'dsh connection cancelled.')
        this.log.warn(error instanceof Error ? error.message : 'dsh connection failed.')
        const remaining = deadline - Date.now()
        if (retryable(error) && remaining > 0) {
          this.setState('reconnecting')
          const wait = Math.min(RETRY_INTERVAL_MS, remaining)
          if (wait === RETRY_INTERVAL_MS) this.log.info('Retrying dsh connection in 10s')
          await delay(wait, undefined, { signal })
          if (Date.now() < deadline) continue
        }
        this.lastFailure = error
        this.setState('failed')
        this.log.info('Automatic connection attempts stopped. Run "DeepSeek Harness: Reconnect" to try again.')
        throw error
      }
    }
  }

  private async connectOnce(signal: AbortSignal): Promise<DshApiClient> {
    let client: DshApiClient | undefined
    let connection: ConnectionController | undefined
    try {
      if (signal.aborted) throw new DshTransportError('cancelled', 'dsh connection cancelled.')
      const config = readConfig()
      client = new DshApiClient(config.url, this.secrets, localDshHome(config.home))
      this.clientValue = client
      await waitWithSignal(client.authenticate(), signal)
      if (signal.aborted) throw new DshTransportError('cancelled', 'dsh connection cancelled.')
      connection = new ConnectionController(client, {
        onMuxEnvelope: envelope => this.muxEmitter.fire(envelope),
        onHostEnvelope: envelope => this.hostEmitter.fire(envelope),
        canAnswer: sessionId => this.answerers.has(sessionId),
        onLog: message => this.log.warn(message),
        onFailure: error => {
          if (signal.aborted) return
          this.stop()
          this.log.warn(error.message)
          if (retryable(error)) {
            this.setState('reconnecting')
            void this.ensureConnected().catch(() => {})
          } else {
            this.lastFailure = error
            this.setState('failed')
          }
        },
      })
      this.connection = connection
      await connection.start()
      if (signal.aborted) throw new DshTransportError('cancelled', 'dsh connection cancelled.')
      this.setState('connected')
      this.connectedEmitter.fire()
      return client
    } catch (error) {
      client?.close()
      connection?.stop()
      if (!signal.aborted) {
        this.connection = undefined
        this.clientValue = undefined
      }
      throw error
    }
  }

  /** Explicit actions can report an error; automatic attachment stays quiet. */
  reportError(error: unknown): string {
    const message = error instanceof Error ? error.message : 'DeepSeek Harness failed. See its log.'
    this.log.error(message)
    void vscode.window.showErrorMessage(message, 'Connect with Launch URL', 'Show Log').then(choice => {
      if (choice === 'Show Log') this.log.show()
      if (choice === 'Connect with Launch URL') void vscode.commands.executeCommand('deepseekHarness.authenticate')
    })
    return message
  }

  /** Authenticate a pasted URL in memory; store only the resulting cookie and clean endpoint. */
  async authenticateWithUrl(url: string): Promise<void> {
    const endpoint = new DshEndpoint(url)
    const client = new DshApiClient(url, this.secrets)
    try { await client.authenticate() } finally { client.close() }
    this.updatingUrl = true
    try {
      await vscode.workspace.getConfiguration('deepseekHarness').update('url', endpoint.base, vscode.ConfigurationTarget.Global)
    } finally { this.updatingUrl = false }
    await this.reconnect()
  }

  async configurationChanged(): Promise<void> {
    if (!this.updatingUrl) await this.reconnect()
  }

  stop(): void {
    this.lifetime.abort()
    this.lifetime = new AbortController()
    this.connecting = undefined
    this.connection?.stop()
    this.connection = undefined
    this.clientValue?.close()
    this.clientValue = undefined
    this.lastFailure = undefined
    this.setState('stopped')
  }

  async reconnect(): Promise<void> {
    this.stop()
    await this.ensureConnected()
  }

  private setState(state: HarnessState): void {
    if (this.stateValue === state) return
    this.stateValue = state
    this.log.info(`harness state: ${state}`)
    this.stateEmitter.fire(state)
  }

  dispose(): void {
    this.disposed = true
    this.stop()
    this.muxEmitter.dispose()
    this.hostEmitter.dispose()
    this.stateEmitter.dispose()
    this.connectedEmitter.dispose()
  }
}

export function frameSessionId(frame: MuxFrame | HostFrame): SessionId | undefined {
  const candidate = (frame as { sessionId?: unknown }).sessionId
  return typeof candidate === 'string' ? candidate : undefined
}
