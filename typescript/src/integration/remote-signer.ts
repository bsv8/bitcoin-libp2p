// Test-only typed signing lane/client. This file is integration-only and is
// excluded from the formal package build.
import { createConnection, createServer, type Socket } from 'node:net'
import { multiaddr } from '@multiformats/multiaddr'
import { parsePeerId, validatePublicKey } from '../identity/index.js'
import { LocalSigner, type TypedSigner } from '../signer/index.js'
import type { PeerRecordInput } from '../identity/index.js'

interface RemoteSignerRequest {
  id: number
  purpose: 'noise' | 'peer-record'
  static_key_hex?: string
  peer_id?: string
  addresses?: string[]
  sequence?: string
}

interface RemoteSignerResponse {
  id: number
  ok: boolean
  signature_der_hex?: string
  error?: string
}

type LaneMode = 'normal' | 'pending' | 'exit' | 'reject' | 'wrong-key'

function reasonOf (signal?: AbortSignal): Error {
  return signal?.reason instanceof Error ? signal.reason : new DOMException('The operation was aborted', 'AbortError')
}

export class RemoteSigner implements TypedSigner {
  readonly #publicKey: Uint8Array
  readonly #address: { host: string, port: number }
  #nextID = 0

  constructor (publicKey: Uint8Array, address: string) {
    this.#publicKey = validatePublicKey(publicKey)
    const separator = address.lastIndexOf(':')
    const port = Number(address.slice(separator + 1))
    if (separator <= 0 || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error('remote signer address is invalid')
    this.#address = { host: address.slice(0, separator), port }
  }

  publicKey (): Uint8Array {
    return new Uint8Array(this.#publicKey)
  }

  signNoiseStaticKey (staticKey32: Uint8Array, signal?: AbortSignal): Promise<Uint8Array> {
    if (staticKey32.length !== 32) return Promise.reject(new Error('Noise static key must be 32 bytes'))
    return this.#request({
      purpose: 'noise',
      static_key_hex: bytesToHex(staticKey32)
    }, signal)
  }

  signPeerRecord (record: PeerRecordInput, signal?: AbortSignal): Promise<Uint8Array> {
    const publicKey = record.peerId.publicKey?.raw
    if (publicKey == null) return Promise.reject(new Error('peer record has no inline public key'))
    return this.#request({
      purpose: 'peer-record',
      peer_id: record.peerId.toString(),
      addresses: record.addresses.map(address => address.toString()),
      sequence: record.sequence.toString()
    }, signal)
  }

  #request (input: Omit<RemoteSignerRequest, 'id'>, signal?: AbortSignal): Promise<Uint8Array> {
    if (signal?.aborted === true) return Promise.reject(reasonOf(signal))
    const request: RemoteSignerRequest = { id: ++this.#nextID, ...input }
    return new Promise<Uint8Array>((resolve, reject) => {
      let settled = false
      let buffer = ''
      const socket = createConnection(this.#address)
      const finish = (error?: Error, signature?: Uint8Array): void => {
        if (settled) return
        settled = true
        signal?.removeEventListener('abort', onAbort)
        socket.destroy()
        if (error != null) reject(error)
        else resolve(signature as Uint8Array)
      }
      const onAbort = (): void => { finish(reasonOf(signal)) }
      signal?.addEventListener('abort', onAbort, { once: true })
      socket.setEncoding('utf8')
      socket.once('connect', () => {
        socket.write(`${JSON.stringify(request)}\n`)
      })
      socket.on('data', chunk => {
        buffer += String(chunk)
        const newline = buffer.indexOf('\n')
        if (newline < 0) return
        const line = buffer.slice(0, newline)
        let response: RemoteSignerResponse
        try {
          response = JSON.parse(line) as RemoteSignerResponse
        } catch {
          finish(new Error('remote signer returned malformed response'))
          return
        }
        if (response.id !== request.id || !response.ok || response.signature_der_hex == null) {
          finish(new Error(response.error ?? 'remote signer rejected request'))
          return
        }
        try {
          finish(undefined, hexToBytes(response.signature_der_hex))
        } catch {
          finish(new Error('remote signer returned malformed signature'))
        }
      })
      socket.once('error', error => { finish(error) })
      socket.once('close', () => {
        if (!settled) finish(new Error('remote signer connection closed'))
      })
    })
  }
}

function bytesToHex (value: Uint8Array): string {
  return Array.from(value, byte => byte.toString(16).padStart(2, '0')).join('')
}

function hexToBytes (value: string): Uint8Array {
  if (value.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(value)) throw new Error('remote signer returned malformed hex')
  const output = new Uint8Array(value.length / 2)
  for (let index = 0; index < output.length; index++) output[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16)
  return output
}

export async function runRemoteSignerLane (privateKey: Uint8Array, maxNoise = 1, mode: LaneMode = 'normal'): Promise<void> {
  if (!['normal', 'pending', 'exit', 'reject', 'wrong-key'].includes(mode)) throw new Error(`unsupported test signer mode ${mode}`)
  const signer = new LocalSigner(privateKey)
  const wrongKey = new Uint8Array(32)
  wrongKey[31] = 2
  const wrongSigner = new LocalSigner(wrongKey)
  const server = createServer()
  let noiseCount = 0
  server.on('connection', socket => {
    let buffer = ''
    socket.setEncoding('utf8')
    socket.on('data', chunk => {
      buffer += String(chunk)
      const newline = buffer.indexOf('\n')
      if (newline < 0) return
      const line = buffer.slice(0, newline)
      try {
        void handleLaneRequest(socket, signer, wrongSigner, mode, JSON.parse(line) as RemoteSignerRequest, () => ++noiseCount, maxNoise)
      } catch {
        socket.end(JSON.stringify({ id: 0, ok: false, error: 'malformed request' }) + '\n')
      }
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (typeof address !== 'object' || address == null) return reject(new Error('remote signer did not listen'))
      console.log(`READY ${bytesToHex(signer.publicKey())} ${address.address}:${address.port}`)
      resolve()
    })
  })
  await new Promise<void>(resolve => {
    const close = (): void => { server.close(() => resolve()) }
    process.once('SIGINT', close)
    process.once('SIGTERM', close)
    process.stdin.once('end', close)
    process.stdin.resume()
  })
}

async function handleLaneRequest (socket: Socket, signer: LocalSigner, wrongSigner: LocalSigner, mode: LaneMode, request: RemoteSignerRequest, nextNoise: () => number, maxNoise: number): Promise<void> {
  try {
    if (mode === 'pending') {
      await new Promise<void>(resolve => {
        if (socket.destroyed) resolve()
        else socket.once('close', resolve)
      })
      return
    }
    if (mode === 'exit') process.exit(42)
    if (mode === 'reject') throw new Error('test signer rejected request')
    const activeSigner = mode === 'wrong-key' ? wrongSigner : signer
    let signature: Uint8Array
    if (request.purpose === 'noise') {
      if (nextNoise() > maxNoise) throw new Error('test lane rejected repeated Noise signing')
      if (request.static_key_hex == null) throw new Error('missing Noise static key')
      signature = await activeSigner.signNoiseStaticKey(hexToBytes(request.static_key_hex))
    } else if (request.purpose === 'peer-record') {
      if (request.peer_id == null || request.addresses == null || request.sequence == null) throw new Error('incomplete Peer Record')
      const record: PeerRecordInput = {
        peerId: parsePeerId(request.peer_id),
        addresses: request.addresses.map(address => multiaddr(address)),
        sequence: BigInt(request.sequence)
      }
      signature = await activeSigner.signPeerRecord(record)
    } else {
      throw new Error('unsupported signer purpose')
    }
    const response: RemoteSignerResponse = { id: request.id, ok: true, signature_der_hex: bytesToHex(signature) }
    socket.end(`${JSON.stringify(response)}\n`)
  } catch (error) {
    const response: RemoteSignerResponse = { id: request.id, ok: false, error: error instanceof Error ? error.message : 'signing failed' }
    socket.end(`${JSON.stringify(response)}\n`)
  }
}

if (process.argv[1]?.endsWith('remote-signer.js')) {
  const keyIndex = process.argv.indexOf('--key') >= 0 ? process.argv.indexOf('--key') : process.argv.indexOf('-key')
  const keyHex = keyIndex >= 0 ? process.argv[keyIndex + 1] : undefined
  if (keyHex == null) throw new Error('--key is required')
  const modeIndex = process.argv.indexOf('--mode')
  const mode = (modeIndex >= 0 ? process.argv[modeIndex + 1] : 'normal') as LaneMode
  void runRemoteSignerLane(hexToBytes(keyHex), 1, mode)
}
