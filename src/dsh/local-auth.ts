import { createHash, createHmac } from 'node:crypto'
import { open } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { parseDocument } from 'yaml'
import { DshEndpoint, isLocal } from './endpoint'
import { isRecord } from './remote-wire'
import { DshTransportError } from './transport-error'

/** Same home precedence and tilde expansion as dsh-home-paths. */
export function localDshHome(configured: string, inherited = process.env.DSH_HOME): string {
  const selected = configured || (inherited?.trim() ? inherited : join(homedir(), '.dsh'))
  return resolve(selected === '~' ? homedir()
    : selected.startsWith('~/') || selected.startsWith('~\\') ? join(homedir(), selected.slice(2)) : selected)
}

/**
 * Bootstrap a native local client from dsh's existing browser-session grant.
 * Mirrors BrowserAuth v1; never creates, rotates, or writes a dsh credential.
 * The caller must verify this cookie with the server before storing it.
 */
export async function localSessionCookie(endpoint: DshEndpoint, home: string): Promise<string | undefined> {
  const url = new URL(endpoint.base)
  if (!isLocal(endpoint.base) || url.protocol !== 'http:' || url.pathname !== '/') return undefined
  let file
  try { file = await open(join(home, '.credentials.yaml'), 'r') }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw localAuthError('Cannot read the local dsh authentication record.')
  }
  try {
    const stat = await file.stat()
    if (!stat.isFile() || stat.size > 4 * 1024 * 1024) throw localAuthError('Invalid local dsh credentials file.')
    if (process.platform !== 'win32' && ((stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.())) {
      throw localAuthError('The local dsh credentials file must be owned by you and accessible only to you.')
    }
    // Never forward YAML diagnostics: their source excerpts can contain credentials.
    const document = parseDocument(await file.readFile('utf8'), { prettyErrors: false, uniqueKeys: true })
    if (document.errors.length > 0) throw localAuthError('Cannot parse the local dsh credentials file.')
    const root: unknown = document.toJS({ maxAliasCount: 0 })
    if (!isRecord(root) || root.version !== 1) throw localAuthError('Unsupported local dsh credentials format.')
    const grant = isRecord(root.records) ? root.records['client-connection/browser-session'] : undefined
    if (grant === undefined) return undefined
    if (!isRecord(grant) || grant.kind !== 'grant' || !isRecord(grant.payload) || grant.payload.version !== 1
      || typeof grant.payload.secret !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(grant.payload.secret)) {
      throw localAuthError('Unsupported local dsh browser-session record.')
    }
    const secret = Buffer.from(grant.payload.secret, 'base64url')
    if (secret.length !== 32 || secret.toString('base64url') !== grant.payload.secret) {
      throw localAuthError('Invalid local dsh browser-session key.')
    }
    // One day fits every supported cookieMaxAgeDays configuration (minimum: 1).
    const issuedAt = Date.now()
    const body = Buffer.from(JSON.stringify({ version: 1, authority: url.host, issuedAt,
      expiresAt: issuedAt + 24 * 60 * 60 * 1000 })).toString('base64url')
    const signature = createHmac('sha256', secret).update(body).digest('base64url')
    const name = createHash('sha256').update(url.host).digest('base64url')
    return `dsh-auth-${name}=v1.${body}.${signature}`
  } catch (error) {
    if (error instanceof DshTransportError) throw error
    throw localAuthError('Cannot read the local dsh authentication record.')
  } finally { await file.close() }
}

function localAuthError(message: string): DshTransportError {
  return new DshTransportError('authentication', `${message} Check deepseekHarness.home matches the running dsh.`)
}
