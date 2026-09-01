// Browser integration entrypoint. Build this file separately and load it in a
// real Chromium Window; it is not imported by the SDK or ordinary tests.
import { webSockets } from '@libp2p/websockets'
import { multiaddr } from '@multiformats/multiaddr'
import { authenticateConnection, createHost } from '../libp2p/index.js'
import { bytesToHex, hexToBytes, type PeerRecordInput } from '../identity/index.js'
import { readStreamToEnd, readUvarintFrames, writeUvarintFrame } from '../stream/index.js'
import { createWebRTCDirectDialer, dialAuthenticatedWebRTCDirect, parseWebRTCDirectEndpoint } from '../webrtc-direct/index.js'
import type { TypedSigner } from '../signer/index.js'

const PROTOCOL = '/bitcoin-libp2p/test/echo/1.0.0'
const FRAMING_PROTOCOL = '/bitcoin-libp2p/test/uvarint-framing/1.0.0'
const RESET_PROTOCOL = '/bitcoin-libp2p/test/reset/1.0.0'
const TEST_ONLY_PUBLIC_KEY = '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798'
const TEST_ONLY_REMOTE_PUBLIC_KEY = '02e940822d4e7a09ce013bed4fa812e92f22b0ed1fa2d1ad06ae0406680da1cc46'

interface PeerRecordWire {
  peerIdPublicKey: Uint8Array
  addresses: Uint8Array[]
  sequence: bigint
}

type FailureScenario = 'pending' | 'exit' | 'stop' | 'wrong-port' | 'wrong-certhash' | 'wrong-address-peer-id' | 'wrong-public-key' | 'abort' | 'dns-localhost' | 'dns-unavailable' | 'old-certhash' | 'stream-reset' | undefined

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

function framingPayloads (): Uint8Array[] {
  return [new TextEncoder().encode('framing'), new TextEncoder().encode('中文 payload'), payload(128 * 1024)]
}

async function readFramed (stream: Parameters<typeof readUvarintFrames>[0]): Promise<Uint8Array[]> {
  const output: Uint8Array[] = []
  for await (const value of readUvarintFrames(stream)) output.push(value)
  return output
}

async function main (): Promise<void> {
  const params = new URLSearchParams(location.search)
  const address = params.get('addr')
  const transportName = params.get('transport') ?? 'websocket'
  const failureValue = params.get('failure')
  const failure = parseFailure(failureValue)
  if (address == null) throw new Error('browser integration requires ?addr=')
  if (transportName !== 'websocket' && transportName !== 'webrtc-direct') throw new Error('unsupported browser transport')
  const directFailure = transportName === 'webrtc-direct' && isDirectDialFailure(failure)
  if (failure != null && transportName === 'websocket' && failure !== 'pending' && failure !== 'exit' && failure !== 'stop') {
    throw new Error('unsupported WebSocket failure scenario')
  }

  const signer = new WorkerSigner(failure)
  // This test deliberately dials the local Go endpoint over loopback and
  // insecure ws. Production callers should keep the browser default gater.
  const node = transportName === 'webrtc-direct'
    ? await createWebRTCDirectDialer({
        signer,
        connectionGater: { denyDialMultiaddr: async () => false },
        signTimeoutMs: failure == null ? undefined : 300
      })
    : await createHost({
        signer,
        transports: [webSockets()],
        connectionGater: { denyDialMultiaddr: async () => false },
        signTimeoutMs: failure == null ? undefined : 300
      })
  try {
    const remoteAddress = multiaddr(address)
    if (failure != null && !directFailure && failure !== 'dns-localhost' && failure !== 'stream-reset') {
      const dial = node.dial(remoteAddress, { signal: AbortSignal.timeout(5_000) })
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
    let connection
    let authenticated
    let directEndpoint
    if (transportName === 'webrtc-direct') {
      const expectedPublicKey = hexToBytes(failure === 'wrong-public-key' ? TEST_ONLY_PUBLIC_KEY : TEST_ONLY_REMOTE_PUBLIC_KEY)
      const endpointAddress = failure != null ? alterDirectAddress(remoteAddress, failure) : remoteAddress
      const controller = new AbortController()
      const abortTimer = failure === 'abort' ? setTimeout(() => { controller.abort(new Error('test caller abort')) }, 10) : undefined
      try {
        const endpoint = parseWebRTCDirectEndpoint(endpointAddress, { publicKey: expectedPublicKey })
        directEndpoint = endpoint
        const result = await dialAuthenticatedWebRTCDirect(node, endpoint, {
          publicKey: expectedPublicKey,
          signal: controller.signal,
          resolver: async ({ host, hostType }) => {
            if (failure === 'dns-localhost' && host === 'localhost' && hostType === 'dns4') {
              return { hostType: 'ip4', host: '127.0.0.1' }
            }
            throw new Error(`test DNS resolver has no result for ${hostType}/${host}`)
          }
        })
        connection = result.connection
        authenticated = result.authenticatedPeer
        directEndpoint = result.endpoint
      } catch (error) {
        if (!directFailure) throw error
        publish('PASS_FAILURE', {
          scenario: failure,
          errorCode: stableErrorField(error, 'code'),
          errorStage: stableErrorField(error, 'stage'),
          pendingSigners: String(signer.pendingCount)
        })
        return
      } finally {
        if (abortTimer != null) clearTimeout(abortTimer)
      }
      if (directFailure) throw new Error(`direct failure scenario ${failure} unexpectedly succeeded`)
    } else {
      connection = await node.dial(remoteAddress, { signal: AbortSignal.timeout(15_000) })
      authenticated = authenticateConnection(connection)
    }
    if (failure === 'stream-reset') {
      const stream = await connection.newStream(RESET_PROTOCOL, { signal: AbortSignal.timeout(15_000) })
      const responsePromise = readStreamToEnd(stream, { timeoutMs: 15_000 })
      try {
        await responsePromise
        throw new Error('stream reset scenario unexpectedly reached EOF')
      } catch (error) {
        if (error instanceof Error && error.message === 'stream reset scenario unexpectedly reached EOF') throw error
        publish('PASS_FAILURE', {
          scenario: failure,
          errorCode: stableErrorField(error, 'code'),
          errorStage: 'stream',
          pendingSigners: String(signer.pendingCount)
        })
        return
      }
    }
    for (const data of [new TextEncoder().encode('browser-hello'), payload(128 * 1024)]) {
      const stream = await connection.newStream(PROTOCOL, { signal: AbortSignal.timeout(15_000) })
      const responsePromise = readStreamToEnd(stream)
      stream.send(data)
      await stream.close()
      const response = await responsePromise
      if (!equalBytes(data, response)) throw new Error('browser echo response did not match')
    }
    const framingData = framingPayloads()
    const framingStream = await connection.newStream(FRAMING_PROTOCOL, { signal: AbortSignal.timeout(15_000) })
    const framingResponsePromise = readFramed(framingStream)
    for (const data of framingData) writeUvarintFrame(framingStream, data)
    await framingStream.close()
    const framingResponses = await framingResponsePromise
    if (framingResponses.length !== framingData.length || framingResponses.some((value, index) => !equalBytes(value, framingData[index]))) {
      throw new Error('browser framing response did not match')
    }
    publish('PASS', {
      peerId: authenticated.peerId.toString(),
      publicKey: bytesToHex(authenticated.publicKey),
      ...(directEndpoint == null ? {} : {
        endpointAddress: directEndpoint.address.toString(),
        endpointHost: directEndpoint.host,
        endpointPort: String(directEndpoint.udpPort),
        endpointCerthash: directEndpoint.certhash,
        endpointPeerId: directEndpoint.peerId.toString()
      }),
      noiseRequests: String(signer.noiseRequests),
      streams: '2',
      framingFrames: String(framingResponses.length),
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

function parseFailure (value: string | null): FailureScenario {
  if (value == null) return undefined
  if (value === 'pending' || value === 'exit' || value === 'stop' || value === 'wrong-port' || value === 'wrong-certhash' || value === 'wrong-address-peer-id' || value === 'wrong-public-key' || value === 'abort' || value === 'dns-localhost' || value === 'dns-unavailable' || value === 'old-certhash' || value === 'stream-reset') return value
  throw new Error('unsupported browser failure scenario')
}

function isDirectDialFailure (failure: FailureScenario): failure is Exclude<FailureScenario, undefined> {
  return failure === 'wrong-port' || failure === 'wrong-certhash' || failure === 'wrong-address-peer-id' || failure === 'wrong-public-key' || failure === 'abort' || failure === 'dns-unavailable' || failure === 'old-certhash'
}

function alterDirectAddress (address: ReturnType<typeof multiaddr>, failure: Exclude<FailureScenario, undefined>): ReturnType<typeof multiaddr> {
  const endpoint = parseWebRTCDirectEndpoint(address)
  let value = endpoint.address.toString()
  if (failure === 'wrong-port') {
    const port = endpoint.udpPort === 65535 ? 65534 : endpoint.udpPort + 1
    value = value.replace(`/udp/${endpoint.udpPort}/`, `/udp/${port}/`)
  } else if (failure === 'wrong-certhash') {
    const replacement = endpoint.certhash.slice(0, -1) + (endpoint.certhash.endsWith('w') ? 'x' : 'w')
    value = value.replace(endpoint.certhash, replacement)
  } else if (failure === 'wrong-address-peer-id') {
    value = value.replace(endpoint.peerId.toString(), '16Uiu2HAm3cuhhRL2msUuLF62KRSfneFDx94RsuouyW25Ho42cFMq')
  } else if (failure === 'dns-localhost') {
    value = value.replace(`/ip4/${endpoint.host}/`, '/dns4/localhost/')
  } else if (failure === 'dns-unavailable') {
    value = value.replace(`/ip4/${endpoint.host}/`, '/dns4/does-not-exist.invalid/')
  }
  return multiaddr(value)
}

function stableErrorField (value: unknown, field: 'code' | 'stage'): string {
  if (typeof value === 'object' && value != null && field in value) {
    const fieldValue = (value as Record<string, unknown>)[field]
    if (typeof fieldValue === 'string') return fieldValue
  }
  return 'UNKNOWN'
}
