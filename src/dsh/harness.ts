import * as vscode from 'vscode'
import { DshApiClient } from './client'
import { ConnectionController } from './connection'
import { HarnessProcess } from './process'
import { DshEndpoint, isLocal, portOf } from './endpoint'
import { localDshHome } from './local-auth'
import { DshTransportError } from './transport-error'
import { readConfig, type HarnessConfig } from '../config'
import type { CredentialStore } from './auth'
import type { Log } from '../log'
import type { Envelope, HostFrame, MuxFrame, SessionId } from './wire'

export type HarnessState = 'stopped' | 'connecting' | 'connected' | 'reconnecting' | 'failed'

/** One authenticated connection and, only when needed, one owned loopback child. */
export class Harness implements vscode.Disposable {
  private readonly process: HarnessProcess
  private connection: ConnectionController | undefined
  private clientValue: DshApiClient | undefined
  private stateValue: HarnessState = 'stopped'
  private connecting: Promise<DshApiClient> | undefined
  private ownedClient = false
  private reported = false
  private generation = 0
  private updatingUrl = false
  private readonly answerers = new Map<string, number>()
  private readonly muxEmitter = new vscode.EventEmitter<Envelope<MuxFrame>>()
  private readonly hostEmitter = new vscode.EventEmitter<Envelope<HostFrame>>()
  private readonly stateEmitter = new vscode.EventEmitter<HarnessState>()
  private readonly connectedEmitter = new vscode.EventEmitter<void>()
  private readonly spawnedEmitter = new vscode.EventEmitter<void>()
  readonly onMuxFrame = this.muxEmitter.event
  readonly onHostFrame = this.hostEmitter.event
  readonly onDidChangeState = this.stateEmitter.event
  readonly onDidConnect = this.connectedEmitter.event
  readonly onDidSpawn = this.spawnedEmitter.event

  constructor(private readonly log: Log, private readonly secrets: CredentialStore) {
    this.process = new HarnessProcess(log)
  }

  get owned(): boolean { return this.ownedClient && this.process.running }
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
    if (this.stateValue === 'connected' && this.clientValue !== undefined
      && (!this.ownedClient || this.process.running)) return this.clientValue
    this.connecting ??= this.connectOnce().finally(() => { this.connecting = undefined })
    return this.connecting
  }

  private async connectOnce(): Promise<DshApiClient> {
    const generation = this.generation
    this.setState('connecting')
    let client: DshApiClient | undefined
    let owned = false
    try {
      const config = readConfig()
      const attached = await this.attachOrStart(config)
      client = attached.client
      owned = attached.owned
      if (generation !== this.generation) throw new DshTransportError('cancelled', 'dsh connection cancelled.')
      this.clientValue = client
      this.ownedClient = owned
      const connection = new ConnectionController(client, {
        onMuxEnvelope: envelope => this.muxEmitter.fire(envelope),
        onHostEnvelope: envelope => this.hostEmitter.fire(envelope),
        canAnswer: sessionId => this.answerers.has(sessionId),
        onLog: message => this.log.warn(message),
        onFailure: error => {
          if (generation !== this.generation) return
          this.clientValue = undefined
          this.setState('failed')
          this.reportError(error)
        },
      })
      this.connection = connection
      await connection.start()
      if (generation !== this.generation) throw new DshTransportError('cancelled', 'dsh connection cancelled.')
      this.setState('connected')
      this.reported = false
      this.connectedEmitter.fire()
      if (owned) this.spawnedEmitter.fire()
      return client
    } catch (error) {
      client?.close()
      if (generation === this.generation) {
        this.connection?.stop()
        this.connection = undefined
        this.clientValue = undefined
        if (owned) this.process.stop()
        this.setState('failed')
        if (!this.reported) { this.reported = true; this.reportError(error) }
      }
      throw error
    }
  }

  private async attachOrStart(config: HarnessConfig): Promise<{ client: DshApiClient; owned: boolean }> {
    const endpoint = new DshEndpoint(config.url)
    const attached = new DshApiClient(config.url, this.secrets, localDshHome(config.home))
    try {
      await attached.authenticate()
      this.log.info(`authenticated dsh at ${endpoint.base}`)
      return { client: attached, owned: this.process.running }
    } catch (error) {
      attached.close()
      if (!(error instanceof DshTransportError) || error.kind !== 'refused') throw error
    }
    const parsed = new URL(endpoint.base)
    if (!isLocal(endpoint.base) || parsed.protocol !== 'http:' || parsed.pathname !== '/') {
      throw new DshTransportError('refused', `No dsh is listening at ${endpoint.base}. Start it at that address, then reconnect.`)
    }
    this.log.info(`nothing is listening at ${endpoint.base}; starting dsh`)
    let launch: string
    try { launch = await this.process.start(config, portOf(endpoint.base)) } catch (error) {
      // A second window may have won the port and saved its cookie while this one was starting.
      const winner = new DshApiClient(config.url, this.secrets, localDshHome(config.home))
      try { await winner.authenticate(); return { client: winner, owned: false } }
      catch { winner.close(); throw error }
    }
    const started = new DshApiClient(launch, this.secrets)
    try { await started.authenticate(); return { client: started, owned: true } }
    catch (error) { started.close(); this.process.stop(); throw error }
  }

  /** Explicit actions always get a notification; background failures are deduplicated by the caller. */
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
    this.generation += 1
    this.connection?.stop()
    this.connection = undefined
    this.clientValue?.close()
    this.clientValue = undefined
    this.ownedClient = false
    this.process.stop()
    this.setState('stopped')
  }

  async reconnect(): Promise<void> {
    this.stop()
    await this.connecting?.catch(() => {})
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
    this.spawnedEmitter.dispose()
  }
}

export function frameSessionId(frame: MuxFrame | HostFrame): SessionId | undefined {
  const candidate = (frame as { sessionId?: unknown }).sessionId
  return typeof candidate === 'string' ? candidate : undefined
}
