/** Safe carrier diagnostics: never include request URLs, cookies or response bodies. */
export type TransportFailure = 'refused' | 'authentication' | 'forbidden' | 'protocol'
  | 'timeout' | 'cancelled' | 'transport'

export class DshTransportError extends Error {
  constructor(readonly kind: TransportFailure, message: string) {
    super(message)
    this.name = 'DshTransportError'
  }
}

export function httpFailure(status: number): DshTransportError {
  if (status === 401) return new DshTransportError('authentication', 'dsh authentication required. Use its current launch URL.')
  if (status === 403) return new DshTransportError('forbidden', 'dsh rejected this address under its Host/Origin policy.')
  return new DshTransportError('protocol', `dsh returned HTTP ${status}; the current Remote API is required.`)
}

export function transportFailure(error: unknown): DshTransportError {
  if (error instanceof DshTransportError) return error
  if (error instanceof Error && error.name === 'TimeoutError') {
    return new DshTransportError('timeout', 'dsh request timed out.')
  }
  if (error instanceof Error && error.name === 'AbortError') {
    return new DshTransportError('cancelled', 'dsh request cancelled.')
  }
  if (refused(error)) return new DshTransportError('refused', 'The dsh connection was refused.')
  return new DshTransportError('transport', 'The dsh connection failed.')
}

function refused(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  if ('code' in error && error.code === 'ECONNREFUSED') return true
  if (error instanceof AggregateError) return error.errors.length > 0 && error.errors.every(refused)
  return error.cause !== undefined && refused(error.cause)
}

/** A caller can stop waiting without cancelling another caller's shared handshake. */
export function waitWithSignal<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (signal === undefined) return promise
  return new Promise((resolve, reject) => {
    const abort = (): void => { reject(abortFailure(signal)) }
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
    void promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort))
  })
}

export function abortFailure(signal: AbortSignal): DshTransportError {
  return signal.reason instanceof Error && signal.reason.name === 'TimeoutError'
    ? new DshTransportError('timeout', 'dsh request timed out.')
    : new DshTransportError('cancelled', 'dsh request cancelled.')
}
