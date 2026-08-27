// Native TypeScript interoperability endpoint. This file intentionally does
// not import bitcoin-libp2p.
import { privateKeyFromProtobuf } from '@libp2p/crypto/keys'
import { identify, identifyPush } from '@libp2p/identify'
import { tcp } from '@libp2p/tcp'
import { createLibp2p } from 'libp2p'
import { multiaddr } from '@multiformats/multiaddr'
import { noise } from '@chainsafe/libp2p-noise'
import { yamux } from '@chainsafe/libp2p-yamux'

const PROTOCOL = '/bitcoin-libp2p/test/echo/1.0.0'
const SERVER_KEY = '278d5bed18a82b66619e026c2efb2a907e35310829d9658fb967180636afaa6a'
const CLIENT_KEY = '0000000000000000000000000000000000000000000000000000000000000001'

function option (name: string): string | undefined {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : undefined
}

function hexToBytes (value: string): Uint8Array {
  const result = new Uint8Array(value.length / 2)
  for (let i = 0; i < result.length; i++) result[i] = Number.parseInt(value.slice(i * 2, i * 2 + 2), 16)
  return result
}

function privateKeyFromRaw (raw: Uint8Array) {
  return privateKeyFromProtobuf(new Uint8Array([8, 2, 18, 32, ...raw]))
}

async function readAll (stream: AsyncIterable<Uint8Array | { subarray (): Uint8Array }>): Promise<Uint8Array> {
  const parts: Uint8Array[] = []
  for await (const part of stream) parts.push(part instanceof Uint8Array ? part : part.subarray())
  const result = new Uint8Array(parts.reduce((size, part) => size + part.length, 0))
  let offset = 0
  for (const part of parts) { result.set(part, offset); offset += part.length }
  return result
}

function payload (size: number): Uint8Array {
  const result = new Uint8Array(size)
  for (let i = 0; i < size; i++) result[i] = i & 0xff
  return result
}

function equalBytes (left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

async function main (): Promise<void> {
  const mode = option('--mode') ?? 'server'
  const remote = option('--addr')
  const keyHex = option('--key') ?? (mode === 'server' ? SERVER_KEY : CLIENT_KEY)
  const node = await createLibp2p({
    privateKey: privateKeyFromRaw(hexToBytes(keyHex)),
    addresses: { listen: mode === 'server' ? ['/ip4/127.0.0.1/tcp/0'] : [] },
    transports: [tcp()],
    streamMuxers: [yamux()],
    connectionEncrypters: [noise()],
    services: { identify: identify(), identifyPush: identifyPush() }
  })
  const stop = async (): Promise<void> => { await node.stop() }
  process.once('SIGINT', () => { void stop().finally(() => process.exit(130)) })
  process.once('SIGTERM', () => { void stop().finally(() => process.exit(143)) })

  if (mode === 'server') {
    await node.handle(PROTOCOL, async stream => {
      const input = await readAll(stream)
      if (input.length === 0 || input.length > 1 << 20) { stream.abort(new Error('invalid echo payload')); return }
      stream.send(input)
      await stream.close()
    })
    const listen = node.getMultiaddrs()[0]?.decapsulateCode(421)
    if (listen == null) throw new Error('host did not listen')
    console.log(`READY ${node.peerId.toString()} ${listen.encapsulate(`/p2p/${node.peerId.toString()}`).toString()} ${Buffer.from(node.peerId.publicKey?.raw ?? []).toString('hex')}`)
    await new Promise<void>(resolve => process.stdin.once('end', resolve))
    await stop()
    return
  }

  if (remote == null) throw new Error('--addr is required in client mode')
  const connection = await node.dial(multiaddr(remote), { signal: AbortSignal.timeout(10_000) })
  for (const data of [new TextEncoder().encode('native-typescript'), payload(128 * 1024)]) {
    const stream = await connection.newStream(PROTOCOL, { signal: AbortSignal.timeout(10_000) })
    stream.send(data)
    await stream.close()
    if (!equalBytes(data, await readAll(stream))) throw new Error('echo response did not match')
  }
  if (connection.remotePeer.type !== 'secp256k1' || connection.remotePeer.publicKey == null) throw new Error('remote peer is not secp256k1')
  const addressPeerId = multiaddr(remote).getComponents().find(component => component.name === 'p2p')?.value
  if (addressPeerId == null) throw new Error('dial address has no /p2p component')
  console.log(`OK ${connection.remotePeer.toString()} ${Buffer.from(connection.remotePeer.publicKey.raw).toString('hex')} ${addressPeerId}`)
  await stop()
}

await main()
