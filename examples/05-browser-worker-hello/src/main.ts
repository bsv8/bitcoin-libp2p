import { webSockets } from '@libp2p/websockets'
import { multiaddr } from '@multiformats/multiaddr'
import { authenticateConnection, createHost } from 'bitcoin-libp2p/libp2p'
import { bytesToHex, hexToBytes, type PeerRecordInput } from 'bitcoin-libp2p/identity'
import type { TypedSigner } from 'bitcoin-libp2p/signer'
import { createWebRTCDirectDialer, dialAuthenticatedWebRTCDirect, parseWebRTCDirectEndpoint } from 'bitcoin-libp2p/webrtc-direct'
import { readStreamToEnd } from 'bitcoin-libp2p/stream'

const PROTOCOL = '/bitcoin-libp2p/demo/hello/1.0.0'

type Request =
  | { purpose: 'noise-static-key', staticKey: Uint8Array }
  | { purpose: 'peer-record', peerIdPublicKey: Uint8Array, addresses: Uint8Array[], sequence: string }

type WorkerMode = 'normal' | 'pending' | 'exit'
type WorkerState = 'starting' | 'ready' | 'closed' | 'failed' | 'stopped'

type Pending = {
  resolve: (value: Uint8Array) => void
  reject: (error: Error) => void
  signal?: AbortSignal
  onAbort: () => void
}

class WorkerSigner implements TypedSigner {
  readonly #worker = new Worker('/signer-worker.js', { type: 'module' })
  readonly #pending = new Map<number, Pending>()
  #nextID = 1
  #publicKey?: Uint8Array
  #noiseRequests = 0
  #ready: Promise<void>
  #resolveReady!: () => void
  #rejectReady!: (error: Error) => void
  #readySettled = false
  #state: WorkerState = 'starting'

  constructor (mode: WorkerMode) {
    this.#ready = new Promise<void>((resolve, reject) => {
      this.#resolveReady = resolve
      this.#rejectReady = reject
    })
    this.#worker.addEventListener('message', event => {
      const value = event.data as { event?: string, reason?: string, publicKey?: Uint8Array, id?: number, ok?: boolean, signature?: Uint8Array, error?: string }
      if (value.event === 'ready' && value.publicKey != null) {
        this.#publicKey = new Uint8Array(value.publicKey)
        this.#state = 'ready'
        this.#readySettled = true
        this.#resolveReady()
        return
      }
      if (value.event === 'closed') {
        this.#end(new Error(value.reason ?? 'signer Worker closed'), 'closed')
        return
      }
      if (value.id == null) return
      const pending = this.#pending.get(value.id)
      if (pending == null) return
      this.#pending.delete(value.id)
      pending.signal?.removeEventListener('abort', pending.onAbort)
      if (value.ok === true && value.signature != null) pending.resolve(new Uint8Array(value.signature))
      else pending.reject(new Error(value.error ?? 'signer Worker failed'))
    })
    this.#worker.addEventListener('error', event => {
      this.#end(new Error(event.message || 'signer Worker failed'), 'failed')
    })
    this.#worker.addEventListener('messageerror', () => { this.#end(new Error('signer Worker message failed'), 'failed') })
    this.#worker.postMessage({ event: 'configure', mode })
  }

  async ready (): Promise<void> { await this.#ready }

  publicKey (): Uint8Array {
    if (this.#publicKey == null) throw new Error('signer Worker is not ready')
    return new Uint8Array(this.#publicKey)
  }

  get state (): WorkerState { return this.#state }

  #request (request: Request, signal?: AbortSignal): Promise<Uint8Array> {
    if (signal?.aborted === true) return Promise.reject(reasonOf(signal))
    if (this.#state !== 'ready') return Promise.reject(new Error(`signer Worker is ${this.#state}`))
    const id = this.#nextID++
    return new Promise<Uint8Array>((resolve, reject) => {
      const onAbort = (): void => {
        this.#pending.delete(id)
        reject(reasonOf(signal))
      }
      this.#pending.set(id, { resolve, reject, signal, onAbort })
      signal?.addEventListener('abort', onAbort, { once: true })
      try {
        if (request.purpose === 'noise-static-key') {
          const staticKey = new Uint8Array(request.staticKey)
          this.#worker.postMessage({ ...request, id, staticKey }, [staticKey.buffer])
        } else {
          this.#worker.postMessage({ ...request, id })
        }
      } catch (error) {
        this.#pending.delete(id)
        signal?.removeEventListener('abort', onAbort)
        reject(error instanceof Error ? error : new Error('failed to send signer request'))
      }
    })
  }

  signNoiseStaticKey (staticKey32: Uint8Array, signal?: AbortSignal): Promise<Uint8Array> {
    if (staticKey32.length !== 32) return Promise.reject(new Error('Noise static key must be 32 bytes'))
    this.#noiseRequests++
    return this.#request({ purpose: 'noise-static-key', staticKey: new Uint8Array(staticKey32) }, signal)
  }

  signPeerRecord (record: PeerRecordInput, signal?: AbortSignal): Promise<Uint8Array> {
    const publicKey = record.peerId.publicKey?.raw
    if (publicKey == null) return Promise.reject(new Error('peer record has no inline public key'))
    return this.#request({
      purpose: 'peer-record',
      peerIdPublicKey: new Uint8Array(publicKey),
      addresses: record.addresses.map(address => new Uint8Array(address.bytes)),
      sequence: record.sequence.toString()
    }, signal)
  }

  get noiseRequests (): number { return this.#noiseRequests }
  get pendingCount (): number { return this.#pending.size }

  stop (): void {
    const error = new Error('signer Worker stopped')
    if (this.#state !== 'closed' && this.#state !== 'failed') this.#end(error, 'stopped')
    this.#worker.terminate()
  }

  #end (error: Error, state: Exclude<WorkerState, 'starting' | 'ready'>): void {
    if (this.#state === 'closed' || this.#state === 'failed' || this.#state === 'stopped') return
    this.#state = state
    if (!this.#readySettled) {
      this.#readySettled = true
      this.#rejectReady(error)
    }
    for (const pending of this.#pending.values()) {
      pending.signal?.removeEventListener('abort', pending.onAbort)
      pending.reject(error)
    }
    this.#pending.clear()
  }
}

async function main (): Promise<void> {
  const parameters = new URLSearchParams(location.search)
  const address = parameters.get('addr')
  const transportName = parameters.get('transport') ?? 'websocket'
  const expectedPublicKeyValue = parameters.get('expected-public-key')
  const failureMode = parseFailureMode(parameters.get('failure'))
  if (address == null) throw new Error('browser Hello requires an addr query parameter')
  if (transportName !== 'websocket' && transportName !== 'webrtc-direct') throw new Error('unsupported browser transport')
  if (transportName === 'webrtc-direct' && expectedPublicKeyValue == null) throw new Error('WebRTC Direct requires an independent expected-public-key query parameter')

  const signer = new WorkerSigner(failureMode === 'worker-exit' ? 'exit' : failureMode == null ? 'normal' : 'pending')
  let node: Awaited<ReturnType<typeof createHost>> | undefined
  let failure: Error | undefined
  let abortTimer: number | undefined
  let actionTimer: number | undefined
  let stopTimer: number | undefined
  try {
    await signer.ready()
    // The local example intentionally permits loopback dialing. Production
    // applications should retain their normal connection-gater policy.
    node = transportName === 'webrtc-direct'
      ? await createWebRTCDirectDialer({
          signer,
          signTimeoutMs: failureMode === 'pending' ? 500 : undefined,
          connectionGater: { denyDialMultiaddr: async () => false }
        })
      : await createHost({
          signer,
          transports: [webSockets()],
          signTimeoutMs: failureMode === 'pending' ? 500 : undefined,
          connectionGater: { denyDialMultiaddr: async () => false }
        })
    const remoteAddress = multiaddr(address)
    const dialAbort = new AbortController()
    abortTimer = window.setTimeout(() => dialAbort.abort(new Error('browser dial timed out')), 15_000)
    if (failureMode === 'abort') {
      actionTimer = window.setTimeout(() => dialAbort.abort(new Error('browser dial aborted by test')), 100)
    }
    if (failureMode === 'host-stop') {
      stopTimer = window.setTimeout(() => {
        void Promise.resolve(node?.stop()).catch(() => {})
        dialAbort.abort(new Error('browser host stopped by test'))
      }, 100)
    }
    let connection
    let authenticated
    if (transportName === 'webrtc-direct') {
      const expectedPublicKey = hexToBytes(expectedPublicKeyValue as string)
      const result = await dialAuthenticatedWebRTCDirect(node, parseWebRTCDirectEndpoint(remoteAddress, { publicKey: expectedPublicKey }), {
        publicKey: expectedPublicKey,
        signal: dialAbort.signal
      })
      connection = result.connection
      authenticated = result.authenticatedPeer
    } else {
      connection = await node.dial(remoteAddress, { signal: dialAbort.signal })
      authenticated = authenticateConnection(connection)
    }
    const message = 'browser hello'
    let lastResponse = ''
    for (let streamNumber = 0; streamNumber < 2; streamNumber++) {
      const stream = await connection.newStream('/bitcoin-libp2p/demo/hello/1.0.0', { signal: AbortSignal.timeout(15_000) })
      const responsePromise = readStreamToEnd(stream)
      stream.send(new TextEncoder().encode(message))
      await stream.close()
      lastResponse = new TextDecoder('utf-8', { fatal: true }).decode(await responsePromise)
      if (lastResponse !== `hello, ${message}`) throw new Error('Hello response did not match')
    }
    if (failureMode != null) throw new Error(`browser failure mode ${failureMode} unexpectedly succeeded`)
    publish('PASS', {
      browserPeerId: node.peerId.toString(), browserPublicKey: bytesToHex(signer.publicKey()),
      remotePeerId: authenticated.peerId.toString(), remotePublicKey: bytesToHex(authenticated.publicKey),
      transport: transportName, request: message, response: lastResponse,
      streams: '2', noiseRequests: String(signer.noiseRequests),
      pendingSignerRequests: String(signer.pendingCount), pendingSigners: String(signer.pendingCount)
    })
  } catch (error) {
    failure = error instanceof Error ? error : new Error(String(error))
  } finally {
    if (abortTimer != null) window.clearTimeout(abortTimer)
    if (actionTimer != null) window.clearTimeout(actionTimer)
    if (stopTimer != null) window.clearTimeout(stopTimer)
    await Promise.resolve(node?.stop()).catch(() => {})
    signer.stop()
  }
  if (failure != null) {
    publish('FAIL', {
      failure: failureMode ?? 'unexpected', error: failure.message, workerState: signer.state,
      noiseRequests: String(signer.noiseRequests), pendingSignerRequests: String(signer.pendingCount),
      pendingSigners: String(signer.pendingCount)
    })
  }
}

function parseFailureMode (value: string | null): 'pending' | 'worker-exit' | 'abort' | 'host-stop' | undefined {
  if (value == null) return undefined
  if (value === 'pending' || value === 'worker-exit' || value === 'abort' || value === 'host-stop') return value
  throw new Error(`unsupported browser failure mode ${value}`)
}

function reasonOf (signal?: AbortSignal): Error {
  return signal?.reason instanceof Error ? signal.reason : new DOMException('The operation was aborted', 'AbortError')
}

function publish (status: string, fields: Record<string, string>): void {
  document.body.dataset.status = status
  document.body.dataset.event = status === 'PASS' ? 'passed' : 'failure'
  for (const [key, value] of Object.entries(fields)) {
    document.body.dataset[key] = value
    const element = document.getElementById(key)
    if (element != null) element.textContent = value
  }
  const statusElement = document.getElementById('status')
  if (statusElement != null) statusElement.textContent = status === 'PASS' ? 'Hello succeeded.' : fields.error ?? status
}

void main().catch(error => {
  publish('FAIL', { error: error instanceof Error ? error.message : String(error) })
})
