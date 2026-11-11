import * as vscode from 'vscode'
import { SESSION_TYPE } from './sessions/resource'

/** `chatProvider` metadata keeps this dispatch model out of other chat sessions. */
interface SessionModelInformation extends vscode.LanguageModelChatInformation {
  readonly targetChatSessionType: string
}

/**
 * VS Code resolves ChatRequest.model before invoking even an external session's
 * handler. This model supplies that dispatch identity; DSH's own model picker
 * and session.prompt still own model selection and inference.
 */
export function registerSessionModel(): vscode.Disposable {
  const model: SessionModelInformation = {
    id: 'session',
    name: 'DeepSeek Harness',
    family: SESSION_TYPE,
    version: '1',
    targetChatSessionType: SESSION_TYPE,
    maxInputTokens: 0,
    maxOutputTokens: 0,
    capabilities: { toolCalling: true, imageInput: true },
  }
  return vscode.lm.registerLanguageModelChatProvider(SESSION_TYPE, {
    provideLanguageModelChatInformation: () => [model],
    provideLanguageModelChatResponse: async () => {
      throw new Error('Send messages through a DeepSeek Harness session.')
    },
    provideTokenCount: async () => {
      throw new Error('Token counting is managed by the DeepSeek Harness session.')
    },
  })
}
