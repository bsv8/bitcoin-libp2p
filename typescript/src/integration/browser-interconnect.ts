import type { Stream } from '@libp2p/interface'
import { bytesToHex, hexToBytes } from '../identity/index.js'
import { createWebRTCInterconnectHost, dialWebRTCInterconnect, type WebRTCInterconnectEnvelope, type WebRTCInterconnectSignalingAdapter } from '../webrtc-interconnect/index.js'
import { readStreamToEnd } from '../stream/index.js'
import type { PeerRecordInput } from '../identity/index.js'
import type { TypedSigner } from '../signer/index.js'
import { peerIdFromPublicKeyBytes } from '../identity/index.js'

const PROTOCOL = '/bitcoin-libp2p/test/interconnect-echo/1.0.0'
const CANCEL_PROTOCOL = '/bitcoin-libp2p/test/interconnect-cancel/1.0.0'
const KEY_ONE_PUBLIC = '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798'
const KEY_TWO_PUBLIC = '02c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5'
const DEFAULT_PAYLOAD_BYTES = 16 * 1024 * 1024
const DEFAULT_TIMEOUT_MS = 120_000

interface PeerRecordWire {
  peerIdPublicKey: Uint8Array
  addresses: Uint8Array[]
  sequence: bigint
}

class WorkerSigner implements TypedSigner {
  readonly #worker: Worker
  readonly #publicKey: Uint8Array
  readonly #keyId: 1 | 2
  readonly #pending = new Map<number, { resolve: (signature: Uint8Array) => void, reject: (error: Error) => void }>()
  #nextID = 1
  #noiseRequests = 0

  constructor (keyId: 1 | 2) {
    this.#keyId = keyId
    this.#publicKey = hexToBytes(keyId === 1 ? KEY_ONE_PUBLIC : KEY_TWO_PUBLIC)
    this.#worker = new Worker(new URL('./browser-signer-worker.js', import.meta.url), { type: 'module' })
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

  signNoiseStaticKey (staticKey32: Uint8Array, signal?: AbortSignal): Promise<Uint8Array> {
    this.#noiseRequests++
    return this.#request({ purpose: 'noise', keyId: this.#keyId, input: new Uint8Array(staticKey32) }, signal)
  }

  signPeerRecord (record: PeerRecordInput, signal?: AbortSignal): Promise<Uint8Array> {
    const publicKey = record.peerId.publicKey?.raw
    if (publicKey == null) return Promise.reject(new Error('peer record has no inline public key'))
    return this.#request({
      purpose: 'peer-record',
      keyId: this.#keyId,
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

  #request (request: { purpose: 'noise' | 'peer-record', keyId: 1 | 2, input?: Uint8Array, record?: PeerRecordWire }, signal?: AbortSignal): Promise<Uint8Array> {
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
      const message = { id, ...request }
      if (request.input != null) {
        const input = new Uint8Array(request.input)
        this.#worker.postMessage({ ...message, input }, [input.buffer])
      } else {
        this.#worker.postMessage(message)
      }
    })
  }
}

class HttpSignaling implements WebRTCInterconnectSignalingAdapter {
  readonly #token: string
  readonly #peerId: string
  readonly #listeners = new Set<(signal: WebRTCInterconnectEnvelope) => void>()
  #cursor = 0
  #running = false

  constructor (token: string, peerId: string) {
    this.#token = token
    this.#peerId = peerId
  }

  subscribe (listener: (signal: WebRTCInterconnectEnvelope) => void): () => void {
    this.#listeners.add(listener)
    if (!this.#running) {
      this.#running = true
      void this.#poll()
    }
    return () => {
      this.#listeners.delete(listener)
      if (this.#listeners.size === 0) this.#running = false
    }
  }

  async send (signal: WebRTCInterconnectEnvelope): Promise<void> {
    const response = await fetch('/signals', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-interconnect-token': this.#token
      },
      body: JSON.stringify(signal)
    })
    if (!response.ok) throw new Error(`signaling send failed: ${response.status}`)
  }

  async #poll (): Promise<void> {
    while (this.#running) {
      try {
        const query = new URLSearchParams({ to: this.#peerId, after: String(this.#cursor) })
        const response = await fetch(`/signals?${query.toString()}`, { headers: { 'x-interconnect-token': this.#token } })
        if (response.status === 200) {
          const body = await response.json() as { cursor: number, signals: WebRTCInterconnectEnvelope[] }
          this.#cursor = body.cursor
          for (const signal of body.signals) {
            for (const listener of this.#listeners) listener(signal)
          }
        }
      } catch {
      }
      if (this.#running) await new Promise(resolve => setTimeout(resolve, 0))
    }
  }
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
  for (let index = 0; index < result.length; index += 1) result[index] = index & 0xff
  return result
}

async function digest (bytes: Uint8Array): Promise<string> {
  return bytesToHex(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)))
}

function parsePositiveInteger (value: string | null, fallback: number): number {
  if (value == null) return fallback
  const result = Number(value)
  if (!Number.isSafeInteger(result) || result <= 0) throw new Error('positive integer required')
  return result
}

async function main (): Promise<void> {
  const params = new URLSearchParams(location.search)
  const role = params.get('role')
  const token = params.get('token')
  const remotePeerId = params.get('remotePeerId')
  const remotePublicKey = params.get('remotePublicKey')
  const payloadBytes = parsePositiveInteger(params.get('payloadBytes'), DEFAULT_PAYLOAD_BYTES)
  const timeoutMs = parsePositiveInteger(params.get('timeoutMs'), DEFAULT_TIMEOUT_MS)
  if (role !== 'buyer' && role !== 'seller') throw new Error('browser role must be buyer or seller')
  if (token == null || token === '') throw new Error('browser signaling token is required')
  if (role === 'buyer' && (remotePeerId == null || remotePublicKey == null)) throw new Error('buyer requires remote identity')
  const buyerRemotePeerId = remotePeerId
  const buyerRemotePublicKey = remotePublicKey

  const keyId = role === 'buyer' ? 1 : 2
  const signer = new WorkerSigner(keyId)
  const localPeerId = peerIdFromPublicKeyBytes(signer.publicKey()).toString()
  const signaling = new HttpSignaling(token, localPeerId)
  const node = await createWebRTCInterconnectHost({
    signer,
    signaling,
    rtcConfiguration: { iceServers: [] },
    connectionGater: { denyDialMultiaddr: async () => false },
    signTimeoutMs: timeoutMs
  })
  let largeHash = ''
  let largeBytes = 0
  let completedStreams = 0
  let cancelled = 0
  let remoteAddress = ''
  let resolveSellerDone: (() => void) | undefined
  const sellerDone = new Promise<void>(resolve => { resolveSellerDone = resolve })
  const maybePublishSeller = (): void => {
    if (completedStreams !== 2 || cancelled !== 1) return
    publish('PASS', {
      role,
      peerId: localPeerId,
      publicKey: bytesToHex(signer.publicKey()),
      remoteAddr: remoteAddress,
      streams: String(completedStreams),
      largeBytes: String(largeBytes),
      largeHash,
      cancelled: String(cancelled),
      noiseRequests: String(signer.noiseRequests),
       pendingSigners: String(signer.pendingCount)
     })
     resolveSellerDone?.()
   }

   try {
    node.handle(PROTOCOL, stream => {
      void (async () => {
        const connection = node.getConnections().find(value => value.remoteAddr != null)
        remoteAddress = connection?.remoteAddr?.toString() ?? remoteAddress
        const data = await readStreamToEnd(stream, { maxBytes: payloadBytes + 1024, timeoutMs })
        await send(stream, data, timeoutMs)
        await stream.close()
        completedStreams += 1
        if (data.byteLength > largeBytes) {
          largeBytes = data.byteLength
          largeHash = await digest(data)
        }
        maybePublishSeller()
      })().catch(() => {})
    })
    node.handle(CANCEL_PROTOCOL, stream => {
      void (async () => {
        await new Promise<void>(resolve => {
          const onMessage = (): void => {
            stream.removeEventListener('message', onMessage)
            resolve()
          }
          stream.addEventListener('message', onMessage)
        })
        try { stream.abort(new Error('e2e cancellation')) } catch {}
        cancelled += 1
        maybePublishSeller()
      })().catch(() => {})
    })
    publish('READY', {
      role,
      peerId: localPeerId,
      publicKey: bytesToHex(signer.publicKey()),
      noiseRequests: String(signer.noiseRequests)
    })
    if (role === 'buyer') {
      if (buyerRemotePeerId == null || buyerRemotePublicKey == null) throw new Error('buyer requires remote identity')
      const result = await dialWebRTCInterconnect(node, {
        remotePeerId: buyerRemotePeerId,
        publicKey: hexToBytes(buyerRemotePublicKey),
        timeoutMs
      })
      const large = payload(payloadBytes)
      const small = payload(64 * 1024)
      const [largeResponse, smallResponse] = await Promise.all([
        exchange(result.connection, large, payloadBytes, timeoutMs),
        exchange(result.connection, small, small.byteLength, timeoutMs)
      ])
      await cancel(result.connection, timeoutMs)
      const largeHash = await digest(largeResponse)
      const expectedLargeHash = await digest(large)
      if (largeHash !== expectedLargeHash) throw new Error(`large response hash mismatch length=${largeResponse.byteLength}/${large.byteLength} actual=${largeHash} expected=${expectedLargeHash}`)
      if (!equalBytes(small, smallResponse)) throw new Error('small response mismatch')
      publish('PASS', {
        role,
        peerId: localPeerId,
        publicKey: bytesToHex(signer.publicKey()),
        remoteAddr: result.connection.remoteAddr.toString(),
        streams: '2',
        largeBytes: String(large.byteLength),
        largeHash,
        cancelled: '1',
        noiseRequests: String(signer.noiseRequests),
        pendingSigners: String(signer.pendingCount)
      })
    } else {
      await sellerDone
    }
  } finally {
    await node.stop()
    signer.stop()
  }
}

async function send (stream: Stream, data: Uint8Array, timeoutMs: number): Promise<void> {
  if (stream.send(data)) return
  await new Promise<void>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const cleanup = (): void => {
      if (timer != null) clearTimeout(timer)
      stream.removeEventListener('drain', onDrain)
      stream.removeEventListener('close', onClose)
    }
    const onDrain = (): void => {
      cleanup()
      resolve()
    }
    const onClose = (): void => {
      cleanup()
      reject(new Error('stream closed while waiting for drain'))
    }
    stream.addEventListener('drain', onDrain)
    stream.addEventListener('close', onClose)
    timer = setTimeout(() => {
      cleanup()
      reject(new Error('stream drain timed out'))
    }, timeoutMs)
  })
}

async function exchange (connection: { newStream: (protocol: string, options?: { signal?: AbortSignal }) => Promise<any> }, data: Uint8Array, maxBytes: number, timeoutMs: number): Promise<Uint8Array> {
  const stream = await connection.newStream(PROTOCOL, { signal: AbortSignal.timeout(timeoutMs) })
  const responsePromise = readStreamToEnd(stream, { maxBytes, timeoutMs })
  await send(stream, data, timeoutMs)
  await stream.close()
  return await responsePromise
}

async function cancel (connection: { newStream: (protocol: string, options?: { signal?: AbortSignal }) => Promise<any> }, timeoutMs: number): Promise<void> {
  const stream = await connection.newStream(CANCEL_PROTOCOL, { signal: AbortSignal.timeout(timeoutMs) })
  const responsePromise = readStreamToEnd(stream, { maxBytes: 1024, timeoutMs })
  await send(stream, new Uint8Array([1]), timeoutMs)
  await stream.close()
  let rejected = false
  try {
    await responsePromise
  } catch {
    rejected = true
  }
  if (!rejected) throw new Error('cancellation did not reset the stream')
}

function equalBytes (left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && left.every((value, index) => value === right[index])
}

void main().catch(error => {
  const message = error instanceof Error ? error.message : 'browser interconnect failed'
  const code = typeof error === 'object' && error != null && 'code' in error && typeof (error as { code?: unknown }).code === 'string' ? (error as { code: string }).code : 'UNKNOWN'
  const stage = typeof error === 'object' && error != null && 'stage' in error && typeof (error as { stage?: unknown }).stage === 'string' ? (error as { stage: string }).stage : 'unknown'
  publish('FAIL', { error: message, errorCode: code, errorStage: stage })
})
