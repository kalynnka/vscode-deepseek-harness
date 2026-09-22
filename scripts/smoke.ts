/**
 * Read-only transport smoke test.
 *
 * Attaches to a `dsh web` you are already running, completes the readiness
 * handshake, and reads the session list and one session's history. It starts
 * no harness of its own — a second one over the same `$DSH_HOME` is what
 * docs/gaps.md §23 is about, and a measurement script has no business risking
 * it — and calls nothing that writes: no create, no prompt, no rename. Run
 * `dsh web` first, then `npm run smoke`; `DSH_URL` overrides the default
 * origin.
 */

import { localDshHome } from '../src/dsh/local-auth'
import { DshApiClient } from '../src/dsh/client'
import { ConnectionController } from '../src/dsh/connection'
import { DshEndpoint, resolveEndpoint } from '../src/dsh/endpoint'

const baseUrl = resolveEndpoint({
  // This script's own default, not the extension's: that one lives in
  // package.json, which a plain node script has no business reading.
  url: process.env.DSH_URL ?? 'http://127.0.0.1:3080',
  executable: '',
  checkoutPath: '',
  home: '',
  extraArgs: [],
})

async function main(): Promise<void> {
  console.log('missing global:', DshApiClient.missingGlobal() ?? 'none')
  console.log('base url:', new DshEndpoint(baseUrl).base)

  const client = new DshApiClient(baseUrl, undefined, localDshHome(''))

  const muxFrames: string[] = []
  const hostFrames: string[] = []
  let connected = false

  const connection = new ConnectionController(client, {
    onMuxEnvelope: envelope => { muxFrames.push(envelope.payload.type) },
    onHostEnvelope: envelope => { hostFrames.push(envelope.payload.type) },
    onConnected: () => { connected = true },
    onLog: message => console.log('[conn]', message),
  })
  await connection.start()
  console.log('handshake connected:', connected)
  console.log('mux frames seen:', muxFrames.length, [...new Set(muxFrames)])
  console.log('host frames seen:', hostFrames.length, [...new Set(hostFrames)])

  const list = await client.call('session.list', {})
  if (!list.ok) {
    throw new Error(`session.list: ${list.error.code}: ${list.error.message}`)
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
        throw new Error(`session.history: ${history.error.code}: ${history.error.message}`)
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
        throw new Error(`session.models: ${models.error.code}: ${models.error.message}`)
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
  await new Promise(resolve => setTimeout(resolve, 500))
}

main().then(
  () => { process.exit(0) },
  (error: unknown) => { console.error('SMOKE FAILED:', error); process.exit(1) },
)
