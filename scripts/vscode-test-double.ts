/** Minimal editor primitives used by request-path regression tests. */
export class Disposable {
  constructor(private readonly cleanup: () => void = () => {}) {}
  dispose(): void { this.cleanup() }
}
export class EventEmitter<T> {
  private readonly listeners = new Set<(value: T) => void>()
  readonly event = (listener: (value: T) => void): Disposable => {
    this.listeners.add(listener)
    return new Disposable(() => this.listeners.delete(listener))
  }
  fire(value: T): void { for (const listener of this.listeners) listener(value) }
  dispose(): void { this.listeners.clear() }
}
export class Uri {
  constructor(readonly scheme: string, readonly path: string) {}
  static from(value: { scheme: string; path: string }): Uri { return new Uri(value.scheme, value.path) }
  toString(): string { return `${this.scheme}:${this.path}` }
}
export class MarkdownString { constructor(readonly value: string) {} }
export class ChatToolInvocationPart { constructor(readonly toolName: string, readonly toolCallId: string) {} }
export const workspace = { workspaceFolders: [], getConfiguration: () => ({ get: (_key: string, fallback: unknown) => fallback }) }
export const ConfigurationTarget = { Global: 1 }
export class ThemeIcon { constructor(readonly id: string) {} }
export class Location {}
export class ChatQuestion { constructor(readonly id: string, readonly type: number, readonly title: string, readonly options: unknown) {} }
export const ChatQuestionType = { Text: 1, MultiSelect: 2, SingleSelect: 3 }
export class ChatResponseTurn2 { constructor(readonly parts: unknown[]) {} }
export class ChatRequestTurn2 { constructor(readonly prompt: string) {} }
export class ChatResponseMarkdownPart { constructor(readonly value: unknown) {} }
export const ProgressLocation = { Window: 1 }
export const window = { showWarningMessage: async () => undefined, showErrorMessage: async () => undefined,
  withProgress: async (_options: unknown, task: (progress: { report(): void }) => unknown) => task({ report() {} }) }
export const commands = { executeCommand: async () => undefined }
