import * as vscode from 'vscode'

/**
 * The extension's single output channel. Everything that fails in this
 * extension fails somewhere the user cannot see — a child process, a socket, a
 * proposed API that silently went missing — so every layer reports here and the
 * user reaches it with one command.
 */
export class Log {
  private readonly channel: vscode.LogOutputChannel

  constructor() {
    this.channel = vscode.window.createOutputChannel('DeepSeek Harness', { log: true })
  }

  info(message: string, ...args: unknown[]): void {
    this.channel.info(message, ...args)
  }

  warn(message: string, ...args: unknown[]): void {
    this.channel.warn(message, ...args)
  }

  error(message: string, ...args: unknown[]): void {
    this.channel.error(message, ...args)
  }

  debug(message: string, ...args: unknown[]): void {
    this.channel.debug(message, ...args)
  }

  show(): void {
    this.channel.show()
  }

  dispose(): void {
    this.channel.dispose()
  }
}
