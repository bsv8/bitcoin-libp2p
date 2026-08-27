// Browser integration entrypoint. Build this file separately and load it in a
// real Chromium Window; it is not imported by the SDK or ordinary tests.
import { webRTCDirect } from '@libp2p/webrtc'
import { webSockets } from '@libp2p/websockets'
import { multiaddr } from '@multiformats/multiaddr'
import { authenticateConnection, createHost } from '../libp2p/index.js'
import { bytesToHex, hexToBytes, type PeerRecordInput } from '../identity/index.js'
import type { TypedSigner } from '../signer/index.js'

const PROTOCOL = '/bitcoin-libp2p/test/echo/1.0.0'
const TEST_ONLY_PUBLIC_KEY = '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798'

interface PeerRecordWire {
  peerIdPublicKey: Uint8Array
  addresses: Uint8Array[]
  sequence: bigint
}

type FailureScenario = 'pending' | 'exit' | 'stop' | undefined

class WorkerSigner implements TypedSigner {
  readonly #worker: Worker
  readonly #publicKey: Uint8Array
  readonly #scenario: FailureScenario
  readonly #pending = new Map<number, { resolve: (signature: Uint8Array) => void, reject: (error: Error) => void }>()
  #nextID = 1
  #noiseRequests = 0

  constructor (scenario: FailureScenario) {
    this.#scenario = scenario
    this.#worker = new Worker(new URL('./browser-signer-worker.js', import.meta.url), { type: 'module' })
    this.#publicKey = hexToBytes(TEST_ONLY_PUBLIC_KEY)
    this.#worker.addEventListener('message', event => {
      const response = event.data as { id: number, ok: boolean, signature?: Uint8Array, error?: string }
      const pending = this.#pending.get(response.id)
      if (pending == null) return
      this.#pending.delete(response.id)
      if (response.ok && response.signature != null) pending.resolve(new Uint8Array(response.signature))
      else pending.reject(new Error(response.error ?? 'worker signing failed'))
    })
    this.#worker.addEventListener('error', event => {
      const error = new Error(event.message || 'signer worker failed')
      for (const pending of this.#pending.values()) pending.reject(error)
      this.#pending.clear()
    })
  }

  publicKey (): Uint8Array {
    return new Uint8Array(this.#publicKey)
  }

  #request (request: { purpose: 'noise' | 'peer-record', input?: Uint8Array, record?: PeerRecordWire }, signal?: AbortSignal): Promise<Uint8Array> {
    if (signal?.aborted === true) return Promise.reject(signal.reason instanceof Error ? signal.reason : new DOMException('The operation was aborted', 'AbortError'))
    const id = this.#nextID++
    return new Promise<Uint8Array>((resolve, reject) => {
      const onAbort = (): void => {
        this.#pending.delete(id)
        reject(signal?.reason instanceof Error ? signal.reason : new DOMException('The operation was aborted', 'AbortError'))
      }
      this.#pending.set(id, {
        resolve: value => {
          signal?.removeEventListener('abort', onAbort)
          resolve(value)
        },
        reject: error => {
          signal?.removeEventListener('abort', onAbort)
          reject(error)
        }
      })
      signal?.addEventListener('abort', onAbort, { once: true })
      const message = { id, scenario: this.#scenario, ...request }
      if (message.input != null) {
        const input = new Uint8Array(message.input)
        this.#worker.postMessage({ ...message, input }, [input.buffer])
      } else {
        this.#worker.postMessage(message)
      }
    })
  }

  signNoiseStaticKey (staticKey32: Uint8Array, signal?: AbortSignal): Promise<Uint8Array> {
    this.#noiseRequests++
    return this.#request({ purpose: 'noise', input: new Uint8Array(staticKey32) }, signal)
  }

  signPeerRecord (record: PeerRecordInput, signal?: AbortSignal): Promise<Uint8Array> {
    const publicKey = record.peerId.publicKey?.raw
    if (publicKey == null) return Promise.reject(new Error('peer record has no inline public key'))
    return this.#request({
      purpose: 'peer-record',
      record: {
        peerIdPublicKey: new Uint8Array(publicKey),
        addresses: record.addresses.map(address => new Uint8Array(address.bytes)),
        sequence: record.sequence
      }
    }, signal)
  }

  get noiseRequests (): number { return this.#noiseRequests }
  get pendingCount (): number { return this.#pending.size }

  stop (): void {
    const error = new Error('browser signer worker stopped')
    for (const pending of this.#pending.values()) pending.reject(error)
    this.#pending.clear()
    this.#worker.terminate()
  }
}

async function readAll (stream: AsyncIterable<Uint8Array | { subarray (): Uint8Array }>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = []
  for await (const chunk of stream) chunks.push(chunk instanceof Uint8Array ? chunk : chunk.subarray())
  const result = new Uint8Array(chunks.reduce((length, chunk) => length + chunk.length, 0))
  let offset = 0
  for (const chunk of chunks) {
    result.set(chunk, offset)
    offset += chunk.length
  }
  return result
}

function equalBytes (left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((byte, index) => byte === right[index])
}

function publish (status: string, fields: Record<string, string>): void {
  for (const [key, value] of Object.entries(fields)) document.body.dataset[key] = value
  document.body.dataset.status = status
  const summary = Object.entries(fields).map(([key, value]) => `${key}=${value}`).join(' ')
  document.title = `${status} ${summary}`.trim()
  document.body.textContent = document.title
}

function payload (length: number): Uint8Array {
  const result = new Uint8Array(length)
  for (let i = 0; i < length; i++) result[i] = i & 0xff
  return result
}

async function main (): Promise<void> {
  const params = new URLSearchParams(location.search)
  const address = params.get('addr')
  const transportName = params.get('transport') ?? 'websocket'
  const failureValue = params.get('failure')
  const failure = failureValue === null ? undefined : failureValue as FailureScenario
  if (address == null) throw new Error('browser integration requires ?addr=')
  if (transportName !== 'websocket' && transportName !== 'webrtc-direct') throw new Error('unsupported browser transport')
  if (failure !== undefined && failure !== 'pending' && failure !== 'exit' && failure !== 'stop') throw new Error('unsupported browser failure scenario')

  const signer = new WorkerSigner(failure)
  const node = await createHost({
    signer,
    transports: [transportName === 'websocket' ? webSockets() : webRTCDirect()],
    // This test deliberately dials the local Go endpoint over loopback and
    // insecure ws. Production callers should keep the browser default gater.
    connectionGater: { denyDialMultiaddr: async () => false },
    signTimeoutMs: failure == null ? undefined : 300
  })
  try {
    const remoteAddress = multiaddr(address)
    const dial = node.dial(remoteAddress, { signal: AbortSignal.timeout(failure == null ? 15_000 : 5_000) })
    if (failure != null) {
      if (failure === 'stop') {
        await new Promise(resolve => setTimeout(resolve, 50))
        await node.stop()
      }
      let failed = false
      try {
        await dial
      } catch {
        failed = true
      }
      if (!failed) throw new Error('failure scenario unexpectedly dialled successfully')
      publish('PASS_FAILURE', { scenario: failure, pendingSigners: String(signer.pendingCount) })
      return
    }
    const connection = await dial
    const authenticated = authenticateConnection(connection)
    for (const data of [new TextEncoder().encode('browser-hello'), payload(128 * 1024)]) {
      const stream = await connection.newStream(PROTOCOL, { signal: AbortSignal.timeout(15_000) })
      stream.send(data)
      await stream.close()
      const response = await readAll(stream)
      if (!equalBytes(data, response)) throw new Error('browser echo response did not match')
    }
    publish('PASS', {
      peerId: authenticated.peerId.toString(),
      publicKey: bytesToHex(authenticated.publicKey),
      noiseRequests: String(signer.noiseRequests),
      streams: '2',
      pendingSigners: String(signer.pendingCount)
    })
  } finally {
    await node.stop()
    signer.stop()
  }
}

void main().catch(error => {
  const message = error instanceof Error ? error.message : 'browser integration failed'
  publish('FAIL', { error: message })
})
