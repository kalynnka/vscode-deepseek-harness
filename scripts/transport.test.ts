import assert from 'node:assert/strict'
import { createHash, createHmac, randomBytes } from 'node:crypto'
import { EventEmitter, once } from 'node:events'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { readFileSync } from 'node:fs'
import { setImmediate as nextTurn } from 'node:timers/promises'
import timers = require('node:timers/promises')
import { test, type TestContext } from 'node:test'
import { WebSocketServer, type WebSocket } from 'ws'
import { DshAuthentication, type CredentialStore } from '../src/dsh/auth'
import { DshEndpoint } from '../src/dsh/endpoint'
import { DshRemoteClient, DshRemoteError } from '../src/dsh/remote-client'
import { DshTransportError, transportFailure, waitWithSignal } from '../src/dsh/transport-error'

class Secrets implements CredentialStore {
  readonly values = new Map<string, string>()
  async get(key: string): Promise<string | undefined> { return this.values.get(key) }
  async store(key: string, value: string): Promise<void> { this.values.set(key, value) }
  async delete(key: string): Promise<void> { this.values.delete(key) }
}

interface Open {
  endpoint: string
  streamId: string
  payload: unknown
  socket: WebSocket
}

interface FixtureOptions {
  signingSecret?: Buffer
  loginStatus?: number
  location?: string
  cookie?: string
  cookieAuthority?: string
  rootStatus?: number
  upgradeStatus?: number
  hangRoot?: boolean
  hangUpgrade?: boolean
  loginGate?: Promise<void>
  rpc?: (body: Record<string, unknown>, response: ServerResponse) => void
  opened?: (stream: Open) => void
}

async function fixture(t: TestContext, options: FixtureOptions = {}) {
  const changes = new EventEmitter()
  const requests: { url: string; cookie: string | undefined; body?: Record<string, unknown> }[] = []
  const opens: Open[] = []
  const cancels: string[] = []
  const upgrades: IncomingMessage[] = []
  const server = createServer((req, res) => {
    void handle(req, res).catch(() => { res.writeHead(500).end() })
  })
  const sockets = new Set<import('node:net').Socket>()
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)) })
  const wss = new WebSocketServer({ noServer: true })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  assert(address && typeof address !== 'string')
  const origin = `http://127.0.0.1:${address.port}`
  const base = `${origin}/mounted/`
  const token = 'fixture-launch-secret'
  const cookieName = `dsh-auth-${createHash('sha256').update(options.cookieAuthority ?? new URL(base).host).digest('base64url')}`
  const cookie = `${cookieName}=v1.fixture.signature`
  const launch = `${base}?token=${token}`
  const acceptsCookie = (value: string | undefined): boolean => {
    if (options.signingSecret === undefined) return value === cookie
    if (!value?.startsWith(`${cookieName}=v1.`)) return false
    const [body, signature] = value.slice(`${cookieName}=v1.`.length).split('.')
    if (createHmac('sha256', options.signingSecret).update(body).digest('base64url') !== signature) return false
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString())
    return payload.version === 1 && payload.authority === new URL(base).host
      && payload.issuedAt <= Date.now() && payload.expiresAt > Date.now()
      && payload.expiresAt - payload.issuedAt <= 86400000
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const request = { url: req.url ?? '', cookie: req.headers.cookie, body: undefined as Record<string, unknown> | undefined }
    requests.push(request)
    changes.emit('change')
    if (options.hangRoot && request.url.startsWith('/mounted/?')) return
    if (request.url === `/mounted/?token=${token}`) {
      await options.loginGate
      res.writeHead(options.loginStatus ?? 303, {
        location: options.location ?? './',
        'set-cookie': options.cookie ?? `${cookie}; Path=/; HttpOnly; SameSite=Strict`,
      }).end()
      return
    }
    if (request.url === '/mounted/' || (options.signingSecret !== undefined && request.url === '/')) {
      res.writeHead(options.rootStatus ?? (acceptsCookie(req.headers.cookie) ? 200 : 401)).end()
      return
    }
    if (!request.url.startsWith('/mounted/api/') || !acceptsCookie(req.headers.cookie)) {
      res.writeHead(401).end()
      return
    }
    let text = ''
    for await (const chunk of req) text += String(chunk)
    const body = JSON.parse(text) as Record<string, unknown>
    request.body = body
    if (options.rpc !== undefined) options.rpc(body, res)
    else res.setHeader('content-type', 'application/json').end(JSON.stringify({
      type: 'server-response', rpcId: body.rpcId, result: { ok: true, value: { accepted: true } },
    }))
  }

  server.on('upgrade', (req, socket, head) => {
    upgrades.push(req)
    if (options.hangUpgrade) return
    if (options.upgradeStatus !== undefined || req.url !== '/mounted/api/remote.mux' || !acceptsCookie(req.headers.cookie)) {
      socket.end(`HTTP/1.1 ${options.upgradeStatus ?? 401} Rejected\r\nContent-Length: 0\r\n\r\n`)
      return
    }
    wss.handleUpgrade(req, socket, head, ws => {
      wss.emit('connection', ws, req)
      ws.on('message', raw => {
        const value = JSON.parse(raw.toString()) as Record<string, unknown>
        if (value.type === 'open') {
          const opened = { ...value, socket: ws } as unknown as Open
          opens.push(opened)
          options.opened?.(opened)
        } else if (value.type === 'cancel') cancels.push(String(value.streamId))
        changes.emit('change')
      })
    })
  })
  const clients: DshRemoteClient[] = []
  t.after(async () => {
    clients.forEach(client => client.close())
    wss.clients.forEach(socket => socket.terminate())
    wss.close()
    sockets.forEach(socket => socket.destroy())
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  })
  return {
    base, origin, launch, cookie, token, requests, opens, cancels, upgrades,
    client(secrets = new Secrets(), url = launch, timeout = 1000) {
      const auth = new DshAuthentication(new DshEndpoint(url), secrets, timeout)
      const client = new DshRemoteClient(auth, timeout)
      clients.push(client)
      return client
    },
    async waitFor(predicate: () => boolean) {
      while (!predicate()) await once(changes, 'change', { signal: AbortSignal.timeout(2000) })
    },
  }
}

const signal = (): AbortSignal => new AbortController().signal
const failure = (kind: string) => (error: unknown): boolean => error instanceof DshTransportError && error.kind === kind
const item = (open: Open, value: unknown): void => { open.socket.send(JSON.stringify({ type: 'item', streamId: open.streamId, value })) }

test('endpoint preserves mounts and keeps the token out of its display/serialization', () => {
  const endpoint = new DshEndpoint('https://example.test/nested/dsh?token=secret#fragment')
  assert.equal(endpoint.base, 'https://example.test/nested/dsh/')
  assert.equal(endpoint.api('session/list').href, 'https://example.test/nested/dsh/api/session/list')
  assert.equal(endpoint.launchUrl()?.searchParams.get('token'), 'secret')
  assert(!JSON.stringify(endpoint).includes('secret'))
  assert.throws(() => endpoint.api('../outside'), failure('protocol'))
})

test('invalid configuration errors never echo credentials', () => {
  for (const input of ['invalid?token=secret', 'ftp://example.test/?token=secret', 'http://user:secret@example.test/']) {
    assert.throws(() => new DshEndpoint(input), error => error instanceof Error && !error.message.includes('secret'))
  }
  assert.throws(() => new DshEndpoint('http://localhost/?token=a&token=b'), failure('authentication'))
})

test('exchanges the launch token, sends the cookie and preserves exact RPC argument names', async t => {
  const f = await fixture(t)
  const secrets = new Secrets()
  const result = await f.client(secrets).call('session/list', { _request: {} })
  assert.deepEqual(result, { ok: true, value: { accepted: true } })
  assert.equal(f.requests[0].url, '/mounted/?token=fixture-launch-secret')
  assert.equal(f.requests[1].cookie, f.cookie)
  const rpc = f.requests[2]
  assert.equal(rpc.url, '/mounted/api/session/list')
  assert.equal(rpc.cookie, f.cookie)
  assert.deepEqual(rpc.body?.payload, { args: { _request: {} } })
  assert.equal(secrets.values.get(`deepseekHarness.cookie:${f.base}`), f.cookie)
})

test('a second client authenticates with the saved cookie and no launch token', async t => {
  const f = await fixture(t)
  const secrets = new Secrets()
  await f.client(secrets).call('session/list', { _request: {} })
  await f.client(secrets, f.base).call('session/list', { _request: {} })
  assert.equal(f.requests.filter(r => r.url.includes('?token=')).length, 1)
  assert.equal(f.requests.at(-2)?.cookie, f.cookie)
})

test('accepts the server cookie when a reverse proxy rewrites Host', async t => {
  const f = await fixture(t, { cookieAuthority: 'upstream.internal:3080' })
  assert.equal((await f.client().call('session/list', { _request: {} })).ok, true)
  assert.equal(f.requests.at(-1)?.cookie, f.cookie)
})

test('a stale stored cookie is replaced through one launch-token exchange', async t => {
  const f = await fixture(t)
  const secrets = new Secrets()
  secrets.values.set(`deepseekHarness.cookie:${f.base}`, f.cookie.replace('fixture', 'expired'))
  await f.client(secrets).call('session/list', { _request: {} })
  assert.equal(f.requests.length, 4)
  assert.equal(secrets.values.get(`deepseekHarness.cookie:${f.base}`), f.cookie)
})

test('credentials are scoped to the scheme, authority and deployment mount', async t => {
  const f = await fixture(t)
  const secrets = new Secrets()
  secrets.values.set(`deepseekHarness.cookie:${f.origin}/other/`, f.cookie)
  await assert.rejects(f.client(secrets, f.base).call('session/list', {}), failure('authentication'))
  assert.equal(f.requests[0].cookie, undefined)
})

for (const status of [401, 403]) {
  test(`classifies HTTP ${status} without leaking token or cookie`, async t => {
    const f = await fixture(t, { loginStatus: status })
    await assert.rejects(f.client().call('session/list', {}), error => {
      assert(error instanceof DshTransportError)
      assert.equal(error.kind, status === 401 ? 'authentication' : 'forbidden')
      assert(!String(error).includes(f.token))
      assert(!String(error).includes(f.cookie))
      return true
    })
    assert.equal(f.requests.length, 1)
  })
}

test('does not follow or save credentials from a redirect to another server', async t => {
  const target = await fixture(t)
  const f = await fixture(t, { location: target.base })
  const secrets = new Secrets()
  await assert.rejects(f.client(secrets).call('session/list', {}), failure('protocol'))
  assert.equal(target.requests.length, 0)
  assert.equal(secrets.values.size, 0)
})

test('rejects a missing or foreign authentication cookie', async t => {
  const f = await fixture(t, { cookie: 'other=value; Path=/' })
  await assert.rejects(f.client().call('session/list', {}), failure('protocol'))
  assert.equal(f.requests.length, 1)
})

test('rejects a legacy unauthenticated root without treating it as an empty port', async t => {
  const f = await fixture(t, { rootStatus: 200 })
  await assert.rejects(f.client(new Secrets(), f.base).call('session/list', {}), failure('protocol'))
})

test('RPC failure preserves domain errors and checks response correlation', async t => {
  const f = await fixture(t, { rpc(body, res) {
    res.end(JSON.stringify({ type: 'server-response', rpcId: body.rpcId,
      result: { ok: false, error: { code: 'session/not-found', message: 'missing', details: {} } } }))
  } })
  assert.deepEqual(await f.client().call('session/page', { request: {} }), {
    ok: false, error: { code: 'session/not-found', message: 'missing', details: {} },
  })
  const wrong = await fixture(t, { rpc(_body, res) {
    res.end(JSON.stringify({ type: 'server-response', rpcId: 'wrong', result: { ok: true, value: {} } }))
  } })
  await assert.rejects(wrong.client().call('session/list', {}), failure('protocol'))
})

test('RPC 401 invalidates the saved credential without retrying the operation', async t => {
  const f = await fixture(t, { rpc(_body, res) { res.writeHead(401).end() } })
  const secrets = new Secrets()
  await assert.rejects(f.client(secrets).call('session/prompt', { request: {} }), failure('authentication'))
  assert.equal(secrets.values.size, 0)
  assert.equal(f.requests.filter(r => r.body !== undefined).length, 1)
})

test('event responses retain client and event correlation in args', async t => {
  const f = await fixture(t)
  const reply = { clientId: 'client-1', eventId: 'event-1', outcome: { kind: 'next' as const } }
  await f.client().respond(reply)
  assert.equal(f.requests.at(-1)?.url, '/mounted/api/$events/result')
  assert.deepEqual(f.requests.at(-1)?.body?.payload, { args: reply })
})

test('authentication and RPC waits are bounded', async t => {
  const auth = await fixture(t, { hangRoot: true })
  await assert.rejects(auth.client(new Secrets(), auth.launch, 50).call('session/list', {}), failure('timeout'))
  const rpc = await fixture(t, { rpc() {} })
  await assert.rejects(rpc.client(new Secrets(), rpc.launch, 100).call('session/list', {}), failure('timeout'))
})

test('only connection refusal is classified as an empty port', async () => {
  const error = (code: string) => Object.assign(new Error('private URL or token'), { code })
  assert.equal(transportFailure(new Error('fetch failed', { cause: error('ECONNREFUSED') })).kind, 'refused')
  assert.equal(transportFailure(new AggregateError([error('ECONNREFUSED'), error('ETIMEDOUT')])).kind, 'transport')
  assert.equal(transportFailure(error('ENOTFOUND')).kind, 'transport')
  assert.equal(transportFailure(error('CERT_HAS_EXPIRED')).kind, 'transport')
  assert(!transportFailure(error('ECONNRESET')).message.includes('private'))
})

test('one authenticated socket multiplexes interleaved streams without dropping buffered items', async t => {
  const f = await fixture(t)
  const client = f.client()
  const first = client.open('session/follow', { request: { sessionId: 'a' } }, signal())
  const second = client.open('session/control', {}, signal())
  const a = first.next()
  const b = second.next()
  await f.waitFor(() => f.opens.length === 2)
  assert.equal(f.upgrades.length, 1)
  assert.equal(f.upgrades[0].headers.cookie, f.cookie)
  const one = f.opens.find(open => open.endpoint === 'session/follow')!
  const two = f.opens.find(open => open.endpoint === 'session/control')!
  item(two, 'second')
  item(one, 'first')
  item(one, 'buffered')
  assert.equal((await a).value, 'first')
  assert.equal((await b).value, 'second')
  assert.equal((await first.next()).value, 'buffered')
  await first.return(undefined)
  item(two, 'still alive')
  assert.equal((await second.next()).value, 'still alive')
  await f.waitFor(() => f.cancels.includes(one.streamId))
  assert(!f.cancels.includes(two.streamId))
  await second.return(undefined)
})

test('abort sends cancellation even while the stream consumer is paused', async t => {
  const f = await fixture(t, { opened: open => item(open, 'initial') })
  const ac = new AbortController()
  const stream = f.client().open('session/follow', {}, ac.signal)
  await stream.next()
  ac.abort()
  await f.waitFor(() => f.cancels.length === 1)
  await assert.rejects(stream.next(), failure('cancelled'))
})

test('logical failure ends only that stream and retains the dsh error', async t => {
  const f = await fixture(t, { opened(open) {
    if (open.endpoint === 'session/control') { item(open, 'still alive'); return }
    open.socket.send(JSON.stringify({ type: 'error', streamId: open.streamId,
      error: { code: 'session/not-found', message: 'missing', details: {} } }))
  } })
  const client = f.client()
  await assert.rejects(client.open('session/follow', {}, signal()).next(), error =>
    error instanceof DshRemoteError && error.code === 'session/not-found')
  const sibling = client.open('session/control', {}, signal())
  assert.equal((await sibling.next()).value, 'still alive')
  assert.equal(f.upgrades.length, 1)
  assert.equal(f.cancels.length, 0)
  await sibling.return(undefined)
})

test('event readiness is validated and notifications preserve unknown event names', async t => {
  const f = await fixture(t, { opened(open) {
    item(open, { type: 'ready', clientId: 'client-1', host: { home: '/fixture' } })
    item(open, { type: 'emit', event: 'future/event', args: [1] })
  } })
  const events = f.client().events(signal())
  assert.deepEqual((await events.next()).value, { type: 'ready', clientId: 'client-1', host: { home: '/fixture' } })
  assert.deepEqual((await events.next()).value, { type: 'emit', event: 'future/event', args: [1] })
  await events.return(undefined)
  const invalid = await fixture(t, { opened: open => item(open, { type: 'ready', clientId: 'bad' }) })
  await assert.rejects(invalid.client().events(signal()).next(), failure('protocol'))
})

test('missing stream readiness times out and closes the logical stream', async t => {
  const f = await fixture(t)
  await assert.rejects(f.client(new Secrets(), f.launch, 100).events(signal()).next(), failure('timeout'))
  await f.waitFor(() => f.cancels.length === 1)
})

test('WebSocket authorization failures and handshake timeout remain classified', async t => {
  for (const status of [401, 403, 404]) {
    const f = await fixture(t, { upgradeStatus: status })
    await assert.rejects(f.client().events(signal()).next(), failure(status === 401 ? 'authentication' : status === 403 ? 'forbidden' : 'protocol'))
  }
  const hung = await fixture(t, { hangUpgrade: true })
  await assert.rejects(hung.client(new Secrets(), hung.launch, 100).events(signal()).next(), failure('timeout'))
})

test('malformed frames and socket loss wake all active consumers', async t => {
  for (const malformed of [true, false]) {
    const f = await fixture(t)
    const client = f.client()
    const a = client.open('session/follow', {}, signal()).next()
    const b = client.open('session/control', {}, signal()).next()
    const failures = [assert.rejects(a, failure(malformed ? 'protocol' : 'transport')),
      assert.rejects(b, failure(malformed ? 'protocol' : 'transport'))]
    await f.waitFor(() => f.opens.length === 2)
    if (malformed) f.opens[0].socket.send('not-json')
    else f.opens[0].socket.terminate()
    await Promise.all(failures)
  }
})

test('closing the client aborts pending streams and disallows new work', async t => {
  const f = await fixture(t)
  const client = f.client()
  const pending = client.open('session/control', {}, signal()).next()
  const rejected = assert.rejects(pending, failure('cancelled'))
  await f.waitFor(() => f.opens.length === 1)
  client.close()
  await rejected
  await assert.rejects(client.call('session/list', {}), failure('cancelled'))
})

test('cancelling one caller does not cancel shared authentication or leak its abort reason', async t => {
  let release!: () => void
  const loginGate = new Promise<void>(resolve => { release = resolve })
  const f = await fixture(t, { loginGate })
  const client = f.client()
  const ac = new AbortController()
  const first = client.call('session/list', {}, ac.signal)
  const rejected = assert.rejects(first, error => {
    assert(error instanceof DshTransportError)
    assert.equal(error.kind, 'cancelled')
    assert(!error.message.includes('sensitive'))
    return true
  })
  const second = client.call('session/list', {})
  await f.waitFor(() => f.requests.length === 1)
  ac.abort('sensitive reason')
  await rejected
  release()
  assert.equal((await second).ok, true)
  assert.equal(f.requests.filter(r => r.url.includes('?token=')).length, 1)
})

test('a normal logical end does not send a redundant cancel', async t => {
  const f = await fixture(t, { opened(open) {
    open.socket.send(JSON.stringify({ type: 'end', streamId: open.streamId }))
  } })
  assert.equal((await f.client().open('session/follow', {}, signal()).next()).done, true)
  assert.equal(f.cancels.length, 0)
})

test('a stream that ends before ready is incompatible', async t => {
  const f = await fixture(t, { opened(open) {
    open.socket.send(JSON.stringify({ type: 'end', streamId: open.streamId }))
  } })
  await assert.rejects(f.client().events(signal()).next(), failure('protocol'))
})

test('RPC redirects are not followed and non-JSON responses are incompatible', async t => {
  const destination = await fixture(t)
  const redirect = await fixture(t, { rpc(_body, res) { res.writeHead(307, { location: destination.base }).end() } })
  await assert.rejects(redirect.client().call('session/list', {}), failure('protocol'))
  assert.equal(destination.requests.length, 0)
  const html = await fixture(t, { rpc(_body, res) { res.end('<html>not dsh</html>') } })
  await assert.rejects(html.client().call('session/list', {}), failure('protocol'))
})

// Exercise the same adapter and request handler that the installed extension uses.
import type * as vscode from 'vscode'
import { DshApiClient } from '../src/dsh/client'
import { ConnectionController } from '../src/dsh/connection'
import { SessionContent } from '../src/sessions/content'
import { ProjectionStore } from '../src/sessions/projections'
import { sessionResource } from '../src/sessions/resource'
import { Harness, type HarnessState } from '../src/dsh/harness'
import type { SessionItems } from '../src/sessions/items'
import type { SlashProxy } from '../src/slash/proxy'
import type { Log } from '../src/log'
import type { Envelope, HostFrame, MuxFrame } from '../src/dsh/wire'
import { EventEmitter as EditorEvents, Disposable, workspace as editorWorkspace, window as editorWindow } from './vscode-test-double'

const log = { info() {}, warn() {}, error() {}, debug() {} } as unknown as Log
const token = { isCancellationRequested: false, onCancellationRequested: () => new Disposable() } as vscode.CancellationToken
const snapshot = { type: 'snapshot', header: { id: 'session-1' }, cursor: 20,
  records: [], hasMore: false, projections: { asOfSeq: 20, values: {} } }

function ready(open: Open): void {
  item(open, open.endpoint === '$events'
    ? { type: 'ready', clientId: 'fixture-client', host: { home: '/fixture' } }
    : { type: 'baseline', value: { projections: {} } })
}

const defaultRetryDuration = JSON.parse(readFileSync('package.json', 'utf8'))
  .contributes.configuration.properties['deepseekHarness.retryDurationSeconds'].default as number

function attachedHarness(t: TestContext, url: () => string, retryDurationSeconds = defaultRetryDuration): Harness {
  t.mock.method(editorWorkspace, 'getConfiguration', () => ({ get: (key: string) =>
    key === 'url' ? url() : key === 'retryDurationSeconds' ? retryDurationSeconds : '' }))
  const harness = new Harness(log, new Secrets())
  t.after(() => harness.dispose())
  return harness
}

function stateReached(harness: Harness, state: HarnessState): Promise<void> {
  if (harness.state === state) return Promise.resolve()
  return new Promise(resolve => {
    const subscription = harness.onDidChangeState(value => {
      if (value !== state) return
      subscription.dispose()
      resolve()
    })
  })
}

/** Advance retry waits without replacing the HTTP fixture's socket timers. */
function retryClock(t: TestContext) {
  let now = Date.now()
  const waits: { at: number; resolve: () => void }[] = []
  t.mock.method(Date, 'now', () => now)
  t.mock.method(timers, 'setTimeout', (ms: number, _value: unknown, options?: { signal?: AbortSignal }) => {
    const pending = new Promise<void>(resolve => { waits.push({ at: now + ms, resolve }) })
    return waitWithSignal(pending, options?.signal)
  })
  return { tick(ms: number) {
    now += ms
    for (const wait of waits.splice(0)) {
      if (wait.at <= now) wait.resolve()
      else waits.push(wait)
    }
  } }
}

test('disposing or reconnecting one window leaves the other window and server usable', { timeout: 5000 }, async t => {
  const f = await fixture(t, { opened: ready })
  const first = attachedHarness(t, () => f.launch)
  const second = new Harness(log, new Secrets())
  t.after(() => second.dispose())
  await Promise.all([first.ensureConnected(), second.ensureConnected()])
  const secondClient = second.client!
  await first.reconnect()
  assert.equal(second.client, secondClient)
  assert.equal((await secondClient.call('session.list', {})).ok, true)
  first.dispose()
  assert.equal(second.state, 'connected')
  assert.equal((await secondClient.call('session.list', {})).ok, true)
  const third = new Harness(log, new Secrets())
  t.after(() => third.dispose())
  await third.ensureConnected()
  assert.equal(third.state, 'connected')
})

test('startup retries a transient failure and shares the attempt across callers', { timeout: 5000 }, async t => {
  const clock = retryClock(t)
  let unavailable = true
  const f = await fixture(t, { opened: open => unavailable ? open.socket.terminate() : ready(open) })
  const notifications = t.mock.method(editorWindow, 'showErrorMessage')
  const harness = attachedHarness(t, () => f.launch)
  const pending = Promise.all([harness.ensureConnected(), harness.ensureConnected()])
  await stateReached(harness, 'reconnecting')
  unavailable = false
  clock.tick(9999)
  await nextTurn()
  assert.equal(f.upgrades.length, 1)
  clock.tick(1)
  const [one, two] = await pending
  assert.equal(one, two)
  assert.equal(harness.state, 'connected')
  assert.equal(f.upgrades.length, 2)
  assert.equal(notifications.mock.callCount(), 0)
})

test('default retry window lasts one minute, then stays quiet until explicit reconnect', { timeout: 5000 }, async t => {
  const clock = retryClock(t)
  assert.equal(defaultRetryDuration, 60)
  let unavailable = true
  const f = await fixture(t, { opened: ready })
  const authenticate = DshApiClient.prototype.authenticate
  const attempts = t.mock.method(DshApiClient.prototype, 'authenticate', async function (this: DshApiClient) {
    if (unavailable) throw new DshTransportError('refused', 'The dsh connection was refused.')
    await authenticate.call(this)
  })
  const notifications = t.mock.method(editorWindow, 'showErrorMessage')
  const warnings = t.mock.method(editorWindow, 'showWarningMessage')
  const harness = attachedHarness(t, () => f.launch)
  const rejected = assert.rejects(harness.ensureConnected(), failure('refused'))
  await stateReached(harness, 'reconnecting')
  for (let count = 2; count <= 6; count += 1) {
    clock.tick(10_000)
    await nextTurn()
    assert.equal(attempts.mock.callCount(), count)
  }
  clock.tick(9999)
  await nextTurn()
  assert.equal(harness.state, 'reconnecting')
  clock.tick(1)
  await rejected
  assert.equal(harness.state, 'failed')
  await assert.rejects(harness.ensureConnected(), failure('refused'))
  await assert.rejects(harness.ensureConnected(), failure('refused'))
  clock.tick(60_000)
  await nextTurn()
  assert.equal(attempts.mock.callCount(), 6)
  assert.equal(notifications.mock.callCount(), 0)
  assert.equal(warnings.mock.callCount(), 0)
  unavailable = false
  await harness.reconnect()
  assert.equal(harness.state, 'connected')
  assert.equal(attempts.mock.callCount(), 7)
})

test('custom retry duration stops at its deadline without shortening the 10-second interval', { timeout: 5000 }, async t => {
  const clock = retryClock(t)
  const attempts = t.mock.method(DshApiClient.prototype, 'authenticate', async () => {
    throw new DshTransportError('refused', 'The dsh connection was refused.')
  })
  const harness = attachedHarness(t, () => 'http://127.0.0.1:3080', 25)
  const rejected = assert.rejects(harness.ensureConnected(), failure('refused'))
  await stateReached(harness, 'reconnecting')
  for (let count = 2; count <= 3; count += 1) {
    clock.tick(10_000)
    await nextTurn()
    assert.equal(attempts.mock.callCount(), count)
  }
  clock.tick(4999)
  await nextTurn()
  assert.equal(harness.state, 'reconnecting')
  clock.tick(1)
  await rejected
  assert.equal(attempts.mock.callCount(), 3)
  assert.equal(harness.state, 'failed')
})

test('zero retry duration makes only the initial attachment attempt', { timeout: 5000 }, async t => {
  const attempts = t.mock.method(DshApiClient.prototype, 'authenticate', async () => {
    throw new DshTransportError('refused', 'The dsh connection was refused.')
  })
  const harness = attachedHarness(t, () => 'http://127.0.0.1:3080', 0)
  await assert.rejects(harness.ensureConnected(), failure('refused'))
  assert.equal(attempts.mock.callCount(), 1)
  assert.equal(harness.state, 'failed')
})

test('losing a required stream automatically reattaches and publishes fresh readiness', { timeout: 5000 }, async t => {
  const f = await fixture(t, { opened: ready })
  const notifications = t.mock.method(editorWindow, 'showErrorMessage')
  const harness = attachedHarness(t, () => f.launch)
  let connections = 0
  harness.onDidConnect(() => { connections += 1 })
  await harness.ensureConnected()
  const reconnecting = stateReached(harness, 'reconnecting')
  f.opens[0].socket.terminate()
  await reconnecting
  await stateReached(harness, 'connected')
  assert.equal(connections, 2)
  assert.equal(f.upgrades.length, 2)
  assert.equal(notifications.mock.callCount(), 0)
})

test('disposing during retry cancels the timer and never reattaches', { timeout: 5000 }, async t => {
  const clock = retryClock(t)
  const f = await fixture(t, { opened: open => open.socket.terminate() })
  const harness = attachedHarness(t, () => f.launch)
  const rejected = assert.rejects(harness.ensureConnected())
  await stateReached(harness, 'reconnecting')
  harness.dispose()
  await rejected
  clock.tick(60_000)
  await nextTurn()
  assert.equal(harness.state, 'stopped')
  assert.equal(f.upgrades.length, 1)
  await assert.rejects(harness.ensureConnected(), failure('cancelled'))
})

test('settings change cancels a pending attach without letting it replace the new connection', { timeout: 5000 }, async t => {
  let release!: () => void
  const loginGate = new Promise<void>(resolve => { release = resolve })
  const old = await fixture(t, { loginGate, opened: ready })
  const replacement = await fixture(t, { opened: ready })
  let url = old.launch
  const harness = attachedHarness(t, () => url)
  const rejected = assert.rejects(harness.ensureConnected(), failure('cancelled'))
  await old.waitFor(() => old.requests.length === 1)
  url = replacement.launch
  await harness.configurationChanged()
  await rejected
  release()
  await old.waitFor(() => old.requests.length === 2)
  assert.equal(harness.client?.base, replacement.base)
  assert.equal(harness.state, 'connected')
  assert.equal(old.upgrades.length, 0)
})

test('authentication failures stop without automatic retries or notifications', { timeout: 5000 }, async t => {
  const f = await fixture(t, { loginStatus: 401 })
  const notifications = t.mock.method(editorWindow, 'showErrorMessage')
  const harness = attachedHarness(t, () => f.launch)
  await assert.rejects(harness.ensureConnected(), failure('authentication'))
  assert.equal(harness.state, 'failed')
  assert.equal(f.requests.length, 1)
  assert.equal(notifications.mock.callCount(), 0)
})

function chatHarness(client?: DshApiClient, connectError?: Error) {
  const notifications: string[] = []
  const mux = new EditorEvents<Envelope<MuxFrame>>()
  const host = new EditorEvents<Envelope<HostFrame>>()
  const harness = {
    client, endpoint: client?.base ?? 'http://127.0.0.1:3080/',
    ensureConnected: async () => { if (connectError) throw connectError; return client! },
    reportError: (error: Error) => { notifications.push(error.message); return error.message },
    onMuxFrame: mux.event, onHostFrame: host.event, claimInteractions: () => new Disposable(),
  } as unknown as Harness
  const items = { isRunning: () => false, cwdOf: () => undefined, markPending() {}, refresh: async () => {} } as unknown as SessionItems
  const slash = { match: async () => undefined } as unknown as SlashProxy
  const content = new SessionContent(harness, new ProjectionStore(), items, log, slash)
  const warnings: string[] = []
  const markdown: string[] = []
  const stream = { warning: (value: string) => warnings.push(value), markdown: (value: string) => markdown.push(value),
    usage() {}, thinkingProgress() {}, beginToolInvocation() {}, updateToolInvocation() {}, push() {} } as unknown as vscode.ChatResponseStream
  const context = { chatSessionContext: { chatSessionItem: { resource: sessionResource('session-1') } } } as vscode.ChatContext
  const request = { prompt: 'hello', references: [] } as unknown as vscode.ChatRequest
  return { content, harness, host, warnings, markdown, stream, context, request, notifications }
}

test('failed sends remain callable and show chat errors plus a notification on every retry', async () => {
  const chat = chatHarness(undefined, new Error('dsh authentication expired.'))
  const session = await chat.content.provideChatSessionContent(sessionResource('session-1'), token,
    { inputState: { groups: [] } as unknown as vscode.ChatSessionInputState })
  assert.equal(typeof session.requestHandler, 'function')
  for (let i = 0; i < 2; i++) {
    const result = await session.requestHandler!(chat.request, chat.context, chat.stream, token)
    assert.equal(result?.errorDetails?.message, 'dsh authentication expired.')
  }
  assert.deepEqual(chat.notifications, ['dsh authentication expired.', 'dsh authentication expired.'])
  assert.deepEqual(chat.warnings, chat.notifications)
})

test('agent requests without a session produce a visible error', async () => {
  const chat = chatHarness()
  const result = await chat.content.handleAgentRequest(chat.request, {} as vscode.ChatContext, chat.stream, token)
  assert.match(result.errorDetails!.message, /Open a DeepSeek Harness session/)
  assert.equal(chat.notifications.length, 1)
})

test('current dsh RPC adapter uses named args, stable history cursor, and preset string result', async t => {
  const calls: Record<string, unknown>[] = []
  const f = await fixture(t, {
    opened: open => { assert.equal(open.endpoint, 'session/follow'); item(open, { ...snapshot, hasMore: true }) },
    rpc: (body, response) => {
      calls.push(body)
      const value = body.method === 'session/list' ? { items: [] }
        : body.method === 'session/page' ? { records: [], hasMore: false }
        : body.method === 'agentPresets/select' ? 'coding' : {}
      response.end(JSON.stringify({ type: 'server-response', rpcId: body.rpcId, result: { ok: true, value } }))
    },
  })
  const client = new DshApiClient(f.launch)
  t.after(() => client.close())
  assert.deepEqual(await client.call('session.list', {}), { ok: true, value: { items: [] } })
  assert.deepEqual(calls[0].payload, { args: { _request: {} } })
  const first = await client.call('session.history', { sessionId: 'session-1' })
  assert(first.ok)
  assert.equal(first.value.throughSeq, 20)
  assert((await client.call('session.history', { sessionId: 'session-1', throughSeq: 20, beforeSeq: 10 })).ok)
  assert.deepEqual(calls[1].payload, { args: { request: {
    address: { kind: 'session', sessionId: 'session-1' }, throughSeq: 20, beforeSeq: 10,
  } } })
  assert.deepEqual(await client.call('agentPreset.select', { sessionId: 'session-1', agentPreset: 'coding' }),
    { ok: true, value: { agentPreset: 'coding' } })
  assert.deepEqual(calls[2].payload, { args: { agentId: 'session-1', agentPreset: 'coding' } })
})

test('real prompt handler waits for follow readiness and renders events arriving before the POST response', async t => {
  let follow: Open | undefined
  const f = await fixture(t, {
    opened: open => {
      follow = open
      assert.equal(open.endpoint, 'session/follow')
      item(open, snapshot)
    },
    rpc: (body, response) => {
      assert.equal(body.method, 'session/prompt')
      const args = (body.payload as { args: { request: { requestId: string; content: unknown } } }).args
      assert.match(args.request.requestId, /^[0-9a-f-]{36}$/)
      assert.deepEqual(args.request.content, [{ type: 'text', text: 'hello' }])
      assert(follow, 'follow must be ready before prompt is sent')
      item(follow, { type: 'assistant-stream', frame: { type: 'start', attemptId: 'attempt-1' } })
      item(follow, { type: 'assistant-stream', frame: { type: 'chunk', attemptId: 'attempt-1', index: 0,
        time: 1, chunk: { type: 'text-delta', text: 'Hello back' } } })
      item(follow, { type: 'event', event: { seq: 21, time: 2, type: 'assistant/message',
        data: { message: { content: [{ type: 'text', text: 'Hello back' }] } } } })
      item(follow, { type: 'event', event: { seq: 22, time: 3, type: 'turn/end', data: {} } })
      setTimeout(() => response.end(JSON.stringify({ type: 'server-response', rpcId: body.rpcId,
        result: { ok: true, value: {} } })), 20)
    },
  })
  const client = new DshApiClient(f.launch)
  t.after(() => client.close())
  const chat = chatHarness(client)
  const result = await chat.content.handleAgentRequest(chat.request, chat.context, chat.stream, token)
  assert.equal(result.errorDetails, undefined)
  assert.deepEqual(chat.markdown, ['Hello back'])
  assert.deepEqual(chat.notifications, [])
})

test('a rejected prompt and an interrupted response both surface visible errors', async t => {
  for (const mode of ['reject', 'disconnect']) {
    let follow: Open | undefined
    const f = await fixture(t, {
      opened: open => { follow = open; item(open, snapshot) },
      rpc: (body, response) => {
        response.end(JSON.stringify({ type: 'server-response', rpcId: body.rpcId,
          result: mode === 'reject'
            ? { ok: false, error: { code: 'model', message: 'No model is configured.', details: {} } }
            : { ok: true, value: {} } }))
        if (mode === 'disconnect') setTimeout(() => follow!.socket.close(), 20)
      },
    })
    const client = new DshApiClient(f.launch)
    t.after(() => client.close())
    const chat = chatHarness(client)
    const result = await chat.content.handleAgentRequest(chat.request, chat.context, chat.stream, token)
    assert(result.errorDetails?.message)
    assert.equal(chat.notifications.length, 1)
    assert.deepEqual(chat.notifications, chat.warnings)
  }
})

test('connection readiness requires current event and control baselines', async t => {
  let events: Open | undefined
  const f = await fixture(t, { opened: open => {
    if (open.endpoint === '$events') events = open
    else { assert.equal(open.endpoint, 'session/control'); item(open, { type: 'baseline', value: { projections: {} } }) }
  } })
  const client = new DshApiClient(f.launch)
  t.after(() => client.close())
  let connected = false
  const connection = new ConnectionController(client, { onConnected: () => { connected = true } })
  const ready = connection.start()
  await f.waitFor(() => f.opens.length === 2)
  assert.equal(connected, false)
  item(events!, { type: 'ready', clientId: 'client-1', host: { home: '/fixture' } })
  await ready
  assert.equal(connected, true)
  connection.stop()
})

test('current interaction replies echo event/client IDs and cancellations suppress late answers', async t => {
  let events: Open | undefined
  const f = await fixture(t, { opened: open => {
    if (open.endpoint === '$events') {
      events = open
      item(open, { type: 'ready', clientId: 'editor-1', host: { home: '/fixture' } })
    } else item(open, { type: 'baseline', value: { projections: {} } })
  } })
  const client = new DshApiClient(f.launch)
  t.after(() => client.close())
  const frames: Envelope<MuxFrame>[] = []
  const received = new EventEmitter()
  const connection = new ConnectionController(client, { canAnswer: id => id === 'session-1',
    onMuxEnvelope: envelope => { frames.push(envelope); received.emit('frame') } })
  await connection.start()
  const waitFor = async (predicate: () => boolean) => {
    while (!predicate()) await once(received, 'frame', { signal: AbortSignal.timeout(2000) })
  }
  item(events!, { type: 'waterfall', event: 'approval/request', eventId: 'approval-1', agentId: 'session-1',
    request: { toolName: 'shell' } })
  await waitFor(() => frames.some(frame => frame.rpcId === 'approval-1'))
  await client.respondToEvent('approval-1', { kind: 'result', value: 'allowed-once' })
  const response = f.requests.find(request => request.body?.method === '$events/result')
  assert.deepEqual(response?.body?.payload, { args: { clientId: 'editor-1', eventId: 'approval-1',
    outcome: { kind: 'result', value: 'allowed-once' } } })
  item(events!, { type: 'waterfall', event: 'user-questions/request', eventId: 'question-1', agentId: 'session-1',
    request: { questions: [] } })
  item(events!, { type: 'cancel', eventId: 'question-1' })
  await waitFor(() => frames.some(frame => frame.payload.type === 'question/resolved'))
  await client.respondToEvent('question-1', { kind: 'result', value: { answers: [] } })
  assert.equal(f.requests.filter(request => request.body?.method === '$events/result').length, 1)
  connection.stop()
})

test('an incompatible opening control stream fails connection rather than reporting readiness', async t => {
  const f = await fixture(t, { opened: open => item(open, open.endpoint === '$events'
    ? { type: 'ready', clientId: 'editor-1', host: { home: '/fixture' } }
    : { type: 'unexpected' }) })
  const client = new DshApiClient(f.launch)
  t.after(() => client.close())
  let connected = false
  const connection = new ConnectionController(client, { onConnected: () => { connected = true } })
  await assert.rejects(connection.start(), failure('protocol'))
  assert.equal(connected, false)
})

test('agent failure after prompt acceptance ends the waiting response with a visible error', async t => {
  let notify: (() => void) | undefined
  const f = await fixture(t, {
    opened: open => item(open, snapshot),
    rpc: (body, response) => {
      response.end(JSON.stringify({ type: 'server-response', rpcId: body.rpcId, result: { ok: true, value: {} } }))
      setTimeout(() => notify!(), 10)
    },
  })
  const client = new DshApiClient(f.launch)
  t.after(() => client.close())
  const chat = chatHarness(client)
  notify = () => chat.host.fire({ rpcId: '', payload: { type: 'host/agent-error', sessionId: 'session-1', message: 'Provider rejected the request.' } })
  const result = await chat.content.handleAgentRequest(chat.request, chat.context, chat.stream, token)
  assert.equal(result.errorDetails?.message, 'Provider rejected the request.')
  assert.deepEqual(chat.notifications, ['Provider rejected the request.'])
})

import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir, homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { localDshHome, localSessionCookie } from '../src/dsh/local-auth'

async function localHome(t: TestContext, secret = randomBytes(32)) {
  const home = await mkdtemp(join(tmpdir(), 'dsh-local-auth-test-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  const filename = join(home, '.credentials.yaml')
  const contents = `version: 1\nrecords:\n  client-connection/browser-session:\n    kind: grant\n    payload:\n      version: 1\n      secret: ${secret.toString('base64url')}\n`
  await writeFile(filename, contents, { mode: 0o600 })
  return { home, filename, contents, secret }
}

test('local home follows the configured, environment, and default dsh precedence', () => {
  assert.equal(localDshHome('/configured', '/environment'), resolve('/configured'))
  assert.equal(localDshHome('', '/environment'), resolve('/environment'))
  assert.equal(localDshHome('', '  '), join(homedir(), '.dsh'))
  assert.equal(localDshHome('~/custom', '/environment'), join(homedir(), 'custom'))
})

test('local authentication connects without a launch token and never changes dsh credentials', async t => {
  const local = await localHome(t)
  const f = await fixture(t, { signingSecret: local.secret })
  const secrets = new Secrets()
  const endpoint = new DshEndpoint(f.origin)
  const auth = new DshAuthentication(endpoint, secrets, 1000, local.home)
  const headers = await auth.headers()
  assert.match(headers.cookie, /^dsh-auth-.*=v1\./)
  assert.equal(secrets.values.size, 1)
  assert(f.requests.every(request => !request.url.includes('token=')))
  assert.equal(await readFile(local.filename, 'utf8'), local.contents)
  // Stored credentials work even when the local file is no longer present.
  await rm(local.filename)
  assert.deepEqual(await new DshAuthentication(endpoint, secrets, 1000, local.home).headers(), headers)
})

test('an expired saved cookie is replaced automatically from the local grant', async t => {
  const local = await localHome(t)
  const f = await fixture(t, { signingSecret: local.secret })
  const secrets = new Secrets()
  secrets.values.set(`deepseekHarness.cookie:${f.origin}/`, f.cookie)
  await new DshAuthentication(new DshEndpoint(f.origin), secrets, 1000, local.home).headers()
  assert.notEqual([...secrets.values.values()][0], f.cookie)
})

test('local bootstrap never reads a home for remote, TLS, or mounted endpoints', async () => {
  for (const url of ['https://example.test/', 'http://example.test/', 'https://127.0.0.1/', 'http://localhost/mount/']) {
    assert.equal(await localSessionCookie(new DshEndpoint(url), '/unreadable/no-such-home'), undefined)
  }
})

test('a mismatched local home fails authentication without saving the cookie', async t => {
  const local = await localHome(t)
  const f = await fixture(t, { signingSecret: randomBytes(32) })
  const secrets = new Secrets()
  await assert.rejects(new DshAuthentication(new DshEndpoint(f.origin), secrets, 1000, local.home).headers(), failure('authentication'))
  assert.equal(secrets.values.size, 0)
  assert.equal(await readFile(local.filename, 'utf8'), local.contents)
})

test('invalid local records fail without leaking YAML content or secret values', async t => {
  const local = await localHome(t)
  for (const contents of ['version: [secret-value', 'version: 2',
    'version: 1\nrecords:\n  client-connection/browser-session:\n    kind: grant\n    payload: {version: 1, secret: secret-value}']) {
    await writeFile(local.filename, contents)
    await assert.rejects(localSessionCookie(new DshEndpoint('http://127.0.0.1:3080'), local.home), error =>
      error instanceof DshTransportError && error.kind === 'authentication' && !error.message.includes('secret-value'))
  }
})
