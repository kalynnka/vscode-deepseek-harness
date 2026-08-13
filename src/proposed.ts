import * as vscode from 'vscode'
import type { Log } from './log'

/** One proposed-API entry point this extension cannot work without. */
interface ProposedProbe {
  /** The proposal name as it appears in `enabledApiProposals`. */
  proposal: string
  /** What we look for, for the message. */
  member: string
  /** Whether the live `vscode` module actually has it. */
  present: () => boolean
}

const PROBES: ProposedProbe[] = [
  {
    proposal: 'chatSessionsProvider',
    member: 'chat.createChatSessionItemController',
    present: () => typeof (vscode.chat as { createChatSessionItemController?: unknown }).createChatSessionItemController === 'function',
  },
  {
    proposal: 'chatSessionsProvider',
    member: 'chat.registerChatSessionContentProvider',
    present: () => typeof (vscode.chat as { registerChatSessionContentProvider?: unknown }).registerChatSessionContentProvider === 'function',
  },
  {
    proposal: 'chatParticipantAdditions',
    member: 'ChatQuestion',
    present: () => typeof (vscode as { ChatQuestion?: unknown }).ChatQuestion === 'function',
  },
]

/** What the live editor actually granted us. */
export interface ProposedApiStatus {
  ok: boolean
  missing: string[]
}

/**
 * Proves the proposed API is really live before anything tries to use it.
 *
 * A proposal that was stripped does not throw on use — the member is simply
 * absent, so the first symptom is an empty sessions list with no error
 * anywhere. Checking once at activation turns that into one accurate sentence.
 *
 * On stable VS Code the grant comes only from `enable-proposed-api` in
 * `argv.json`; extension development mode does NOT grant it, because the
 * editor requires `isExtensionDevelopment && quality !== 'stable'`.
 */
export function checkProposedApi(log: Log): ProposedApiStatus {
  const missing = PROBES.filter(probe => !probe.present()).map(probe => `${probe.member} (${probe.proposal})`)
  if (missing.length === 0) {
    log.info('proposed API: all required members are live')
    return { ok: true, missing }
  }
  log.error(
    'proposed API is NOT enabled for this extension. Missing: ' + missing.join(', ') +
    '. Add "enable-proposed-api": ["kalynnka.deepseek-harness-sessions"] to your argv.json ' +
    '(Command Palette: "Preferences: Configure Runtime Arguments") and restart VS Code. ' +
    'Extension development mode alone does not grant proposals on stable builds.',
  )
  return { ok: false, missing }
}
