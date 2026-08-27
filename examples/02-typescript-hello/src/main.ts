// This file intentionally keeps the application flow visible. The SDK
// assembles standard libp2p; this application owns the Hello handler.
import { randomBytes } from 'node:crypto'
import { createInterface } from 'node:readline'
import type { Stream, StreamCloseEvent, StreamMessageEvent } from '@libp2p/interface'
import { tcp } from '@libp2p/tcp'
import { multiaddr, type Multiaddr } from '@multiformats/multiaddr'
import { authenticateConnection, createHost } from '@bsv8/bitcoin-libp2p/libp2p'
import { bytesToHex, hexToBytes, validatePublicKey } from '@bsv8/bitcoin-libp2p/identity'
import { LocalSigner } from '@bsv8/bitcoin-libp2p/signer'

const PROTOCOL = '/bitcoin-libp2p/demo/hello/1.0.0'
const MAX_MESSAGE = 1 << 10

interface ReadyEvent {
  event: 'ready'
  demo: 'typescript-hello'
  language: 'typescript'
  peerId: string
  publicKey: string
  address: string
  protocol: string
}

interface HelloEvent {
  event: 'hello'
  demo: 'typescript-hello'
  language: 'typescript'
  remotePeerId: string
  remotePublicKey: string
  remoteAddress: string
  addressPeerId: string
  request: string
  response: string
  streams: number
}

function option (name: string): string | undefined {
  const index = process.argv.indexOf(name)
  return index < 0 ? undefined : process.argv[index + 1]
}

async function main (): Promise<void> {
  const mode = option('--mode') ?? 'server'
  if (mode !== 'server' && mode !== 'client') throw new Error('--mode must be server or client')

  // LocalSigner is for this Demo/test process only. A production host should
  // receive a protected TypedSigner, not a copy of the business private key.
  const signer = new LocalSigner(new Uint8Array(randomPrivateKey()))
  const listenAddress = option('--listen') ?? '/ip4/127.0.0.1/tcp/0'
  const node = await createHost({
    signer,
    listenAddrs: mode === 'server' ? [multiaddr(listenAddress)] : [],
    transports: [tcp()]
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

    if (mode === 'server') {
      const listen = node.getMultiaddrs()[0]?.decapsulateCode(421)
      if (listen == null) throw new Error('host did not listen')
      const address = listen.encapsulate(multiaddr(`/p2p/${node.peerId.toString()}`)).toString()
      emit({
        event: 'ready', demo: 'typescript-hello', language: 'typescript',
        peerId: node.peerId.toString(), publicKey: bytesToHex(signer.publicKey()),
        address, protocol: PROTOCOL
      } satisfies ReadyEvent)
      await waitForStop()
      return
    }

    const dialValue = option('--dial')
    if (dialValue == null) throw new Error('--dial is required in client mode')
    const message = option('--message') ?? 'hello'
    const encodedMessage = new TextEncoder().encode(message)
    if (encodedMessage.length === 0 || encodedMessage.length > MAX_MESSAGE || !isUtf8(encodedMessage)) {
      throw new Error(`--message must be non-empty valid UTF-8 of at most ${MAX_MESSAGE} bytes`)
    }
    const remoteAddress = multiaddr(dialValue)
    const addressPeerId = remoteAddress.getComponents().find(component => component.name === 'p2p')?.value
    if (addressPeerId == null) throw new Error('--dial must contain a /p2p component')

    const connection = await node.dial(remoteAddress, { signal: AbortSignal.timeout(15_000) })
    const expectedPeerId = option('--expect-peer-id')
    const expectedPublicKeyValue = option('--expect-public-key')
    const authenticated = authenticateConnection(connection, {
      peerId: expectedPeerId,
      publicKey: expectedPublicKeyValue == null ? undefined : hexToBytes(expectedPublicKeyValue)
    })
    for (let streamNumber = 0; streamNumber < 2; streamNumber++) {
      const stream = await connection.newStream(PROTOCOL, { signal: AbortSignal.timeout(15_000) })
      stream.send(encodedMessage)
      await stream.close()
      const response = new TextDecoder('utf-8', { fatal: true }).decode(await readAll(stream))
      if (response !== `hello, ${message}`) throw new Error(`unexpected Hello response ${JSON.stringify(response)}`)
    }
    emit({
      event: 'hello', demo: 'typescript-hello', language: 'typescript',
      remotePeerId: authenticated.peerId.toString(), remotePublicKey: bytesToHex(authenticated.publicKey),
      remoteAddress: remoteAddress.toString(), addressPeerId,
      request: message, response: `hello, ${message}`, streams: 2
    } satisfies HelloEvent)
  } finally {
    process.removeListener('SIGINT', onSignal)
    process.removeListener('SIGTERM', onSignal)
    await stop()
  }
}

function randomPrivateKey (): Uint8Array {
  // Rejection is practically never needed, but keeping it explicit preserves
  // the SDK's 1..n-1 private-key boundary without a fixed test key.
  for (;;) {
    const raw = new Uint8Array(randomBytes(32))
    try {
      new LocalSigner(raw)
      return raw
    } catch {
      // Try another random scalar.
    }
  }
}

async function readAll (stream: Stream): Promise<Uint8Array> {
  const chunks: Uint8Array[] = []
  return await new Promise<Uint8Array>((resolve, reject) => {
    let settled = false
    const output = (): Uint8Array => {
      const result = new Uint8Array(chunks.reduce((size, chunk) => size + chunk.length, 0))
      let offset = 0
      for (const chunk of chunks) {
        result.set(chunk, offset)
        offset += chunk.length
      }
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
      if (stream.readBufferLength > 0) {
        queueMicrotask(() => { finish(force) })
        return
      }
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
    // A fast native peer can finish its writable end before the application
    // handler is invoked. Check the state after queued buffered data has had a
    // chance to dispatch so the read does not wait for an already-fired event.
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
    const finish = (): void => {
      input.close()
      resolve()
    }
    input.once('close', finish)
  })
}

function emit (value: ReadyEvent | HelloEvent): void {
  process.stdout.write(`${JSON.stringify(value)}\n`)
}

void main().catch(error => {
  const message = error instanceof Error ? error.message : String(error)
  process.stderr.write(`fatal: ${message}\n`)
  process.exitCode = 1
})
