// Native comparison endpoint. It uses ordinary libp2p directly and contains
// no bitcoin-libp2p dependency, adapter, typed signer, or authentication helper.
import { randomBytes } from 'node:crypto'
import { createInterface } from 'node:readline'
import type { Stream, StreamCloseEvent, StreamMessageEvent } from '@libp2p/interface'
import { privateKeyFromProtobuf } from '@libp2p/crypto/keys'
import { identify, identifyPush } from '@libp2p/identify'
import { tcp } from '@libp2p/tcp'
import { noise } from '@chainsafe/libp2p-noise'
import { yamux } from '@chainsafe/libp2p-yamux'
import { createLibp2p } from 'libp2p'
import { multiaddr } from '@multiformats/multiaddr'

const PROTOCOL = '/bitcoin-libp2p/demo/hello/1.0.0'
const MAX_MESSAGE = 1 << 10

interface ReadyEvent {
  event: 'ready'
  demo: 'native-typescript-hello'
  language: 'typescript'
  peerId: string
  publicKey: string
  address: string
  protocol: string
}

function option (name: string): string | undefined {
  const index = process.argv.indexOf(name)
  return index < 0 ? undefined : process.argv[index + 1]
}

async function main (): Promise<void> {
  if ((option('--mode') ?? 'server') !== 'server') throw new Error('native TypeScript endpoint only supports --mode server')
  const raw = option('--key') == null ? randomPrivateKey() : hexToBytes(option('--key') as string)
  const privateKey = privateKeyFromProtobuf(new Uint8Array([8, 2, 18, 32, ...raw]))
  const node = await createLibp2p({
    privateKey,
    addresses: { listen: [option('--listen') ?? '/ip4/127.0.0.1/tcp/0'] },
    transports: [tcp()],
    streamMuxers: [yamux()],
    connectionEncrypters: [noise()],
    services: { identify: identify(), identifyPush: identifyPush() }
  })
  let stopping = false
  const stop = async (): Promise<void> => {
    if (stopping) return
    stopping = true
    await node.stop()
  }
  const onSignal = (): void => { void stop().finally(() => process.exit(130)) }
  process.once('SIGINT', onSignal)
  process.once('SIGTERM', onSignal)
  try {
    await node.handle(PROTOCOL, async stream => {
      const input = await readAll(stream)
      if (input.length === 0 || input.length > MAX_MESSAGE || !isUtf8(input)) {
        stream.abort(new Error('invalid Hello message'))
        return
      }
      stream.send(new TextEncoder().encode(`hello, ${new TextDecoder().decode(input)}`))
      await stream.close()
    })
    const listen = node.getMultiaddrs()[0]?.decapsulateCode(421)
    if (listen == null) throw new Error('native TypeScript host did not listen')
    emit({
      event: 'ready', demo: 'native-typescript-hello', language: 'typescript',
      peerId: node.peerId.toString(), publicKey: bytesToHex(node.peerId.publicKey?.raw),
      address: listen.encapsulate(multiaddr(`/p2p/${node.peerId.toString()}`)).toString(), protocol: PROTOCOL
    })
    await waitForStop()
  } finally {
    process.removeListener('SIGINT', onSignal)
    process.removeListener('SIGTERM', onSignal)
    await stop()
  }
}

function randomPrivateKey (): Uint8Array {
  for (;;) {
    const raw = new Uint8Array(randomBytes(32))
    try {
      privateKeyFromProtobuf(new Uint8Array([8, 2, 18, 32, ...raw]))
      return raw
    } catch {
      // Keep the native endpoint on the same valid secp256k1 scalar boundary.
    }
  }
}

function hexToBytes (value: string): Uint8Array {
  if (value.length !== 64 || !/^[0-9a-fA-F]+$/.test(value)) throw new Error('--key must be 32-byte hex')
  const output = new Uint8Array(32)
  for (let index = 0; index < 32; index++) output[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16)
  return output
}

function bytesToHex (value: Uint8Array | undefined): string {
  if (value == null) throw new Error('native identity has no public key')
  return Array.from(value, byte => byte.toString(16).padStart(2, '0')).join('')
}

async function readAll (stream: Stream): Promise<Uint8Array> {
  const chunks: Uint8Array[] = []
  return await new Promise<Uint8Array>((resolve, reject) => {
    let settled = false
    const output = (): Uint8Array => {
      const result = new Uint8Array(chunks.reduce((size, chunk) => size + chunk.length, 0))
      let offset = 0
      for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.length }
      return result
    }
    const cleanup = (): void => {
      stream.removeEventListener('message', onMessage)
      stream.removeEventListener('end', onEnd)
      stream.removeEventListener('remoteCloseWrite', onRemoteCloseWrite)
      stream.removeEventListener('close', onClose)
    }
    const finish = (force = false): void => {
      if (settled) return
      if (stream.readBufferLength > 0) { queueMicrotask(() => { finish(force) }); return }
      if (!force && !stream.readableEnded && stream.remoteWriteStatus !== 'closed') return
      settled = true
      cleanup()
      resolve(output())
    }
    const onMessage = (event: StreamMessageEvent): void => {
      const chunk = event.data
      chunks.push(chunk instanceof Uint8Array ? chunk : chunk.subarray())
    }
    const onEnd = (): void => { finish() }
    const onRemoteCloseWrite = (): void => { queueMicrotask(() => { finish() }) }
    const onClose = (event: StreamCloseEvent): void => {
      if (event.error != null) {
        settled = true
        cleanup()
        reject(event.error)
        return
      }
      finish(true)
    }
    stream.addEventListener('message', onMessage)
    stream.addEventListener('end', onEnd)
    stream.addEventListener('remoteCloseWrite', onRemoteCloseWrite)
    stream.addEventListener('close', onClose)
    queueMicrotask(() => { finish() })
  })
}

function isUtf8 (value: Uint8Array): boolean {
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(value)
    return true
  } catch {
    return false
  }
}

async function waitForStop (): Promise<void> {
  await new Promise<void>(resolve => {
    const input = createInterface({ input: process.stdin })
    input.once('close', () => { input.close(); resolve() })
  })
}

function emit (value: ReadyEvent): void {
  process.stdout.write(`${JSON.stringify(value)}\n`)
}

void main().catch(error => {
  process.stderr.write(`fatal: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
})
