/**
 * Read-only transport smoke test.
 *
 * Starts the user's own dsh, completes the readiness handshake, and reads the
 * session list and one session's history. It calls nothing that writes: no
 * create, no prompt, no rename. Run it with `npm run smoke`.
 */

import { DshApiClient } from '../src/dsh/client'
import { ConnectionController } from '../src/dsh/connection'
import { HarnessProcess, resolveLaunch } from '../src/dsh/process'
import type { HarnessConfig } from '../src/config'

const config: HarnessConfig = {
  executable: process.env.DSH_EXECUTABLE ?? '',
  checkoutPath: process.env.DSH_CHECKOUT ?? '',
  home: '',
  extraArgs: [],
}

const log = {
  info: (message: string, ...rest: unknown[]) => console.log('[info]', message, ...rest),
  warn: (message: string, ...rest: unknown[]) => console.warn('[warn]', message, ...rest),
  error: (message: string, ...rest: unknown[]) => console.error('[error]', message, ...rest),
  debug: () => {},
  show: () => {},
  dispose: () => {},
}

async function main(): Promise<void> {
  console.log('missing global:', DshApiClient.missingGlobal() ?? 'none')
  console.log('resolution:', resolveLaunch(config, []).describe)

  const process_ = new HarnessProcess(log as never)
  const baseUrl = await process_.start(config)
  console.log('base url:', baseUrl)

  const client = new DshApiClient(baseUrl)

  const muxFrames: string[] = []
  const hostFrames: string[] = []
  let connected = false

  const connection = new ConnectionController(client, {
    onMuxEnvelope: envelope => { muxFrames.push(envelope.payload.type) },
    onHostEnvelope: envelope => { hostFrames.push(envelope.payload.type) },
    onConnected: () => { connected = true },
    onLog: message => console.log('[conn]', message),
  })
  connection.start()

  await new Promise(resolve => setTimeout(resolve, 4000))
  console.log('handshake connected:', connected)
  console.log('mux frames seen:', muxFrames.length, [...new Set(muxFrames)])
  console.log('host frames seen:', hostFrames.length, [...new Set(hostFrames)])

  const described = await client.call('host.describe', {})
  console.log('host.describe ok:', described.ok)
  if (described.ok) console.log('  keys:', Object.keys(described.value).join(', '))

  const list = await client.call('session.list', {})
  if (!list.ok) {
    console.log('session.list FAILED:', list.error.code, list.error.message)
  } else {
    const items = list.value.items
    console.log('session.list ok:', items.length, 'sessions')
    for (const item of items.slice(0, 5)) {
      console.log(`  ${item.sessionId.slice(0, 8)} blank=${String(item.blank)} running=${String(item.running)} cwd=${item.cwd ?? '-'}`)
      if (item.projections !== undefined) {
        console.log('    projections:', Object.keys(item.projections.values).join(', '), `asOfSeq=${String(item.projections.asOfSeq)}`)
      }
    }
    const candidate = items.find(item => !item.blank)
    if (candidate !== undefined) {
      const history = await client.call('session.history', { sessionId: candidate.sessionId, maxMessages: 50 })
      if (!history.ok) {
        console.log('session.history FAILED:', history.error.code, history.error.message)
      } else {
        const types = history.value.events.map(entry => entry.event.type)
        console.log('session.history ok:', types.length, 'events, hasMore=', history.value.hasMore)
        console.log('  event types:', [...new Set(types)].join(', '))
        console.log('  tail projections:', history.value.projections === undefined
          ? 'none'
          : Object.keys(history.value.projections.values).join(', '))
      }
      const models = await client.call('session.models', { sessionId: candidate.sessionId })
      if (!models.ok) {
        console.log('session.models FAILED:', models.error.code, models.error.message)
      } else {
        console.log('session.models ok: current=', JSON.stringify(models.value.current), 'routable=', models.value.routable)
        for (const group of models.value.groups) {
          console.log(`  provider ${group.id}: ${group.models.map(m => m.id).join(', ')}`)
          for (const model of group.models) {
            if (model.reasoning !== undefined) {
              console.log(`    ${model.id} efforts: ${model.reasoning.efforts.map(e => e.id).join(', ')} default=${model.reasoning.defaultEffort ?? '-'}`)
            }
          }
        }
      }
    }
  }

  connection.stop()
  process_.stop()
  await new Promise(resolve => setTimeout(resolve, 500))
}

main().then(
  () => { process.exit(0) },
  (error: unknown) => { console.error('SMOKE FAILED:', error); process.exit(1) },
)
