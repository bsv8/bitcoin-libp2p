// Explicit local integration endpoint. It is not part of the SDK runtime and
// is never imported by ordinary tests.
import { tcp } from '@libp2p/tcp'
import { multiaddr } from '@multiformats/multiaddr'
import { createHost } from '../libp2p/index.js'
import { hexToBytes } from '../identity/index.js'
import { readStreamToEnd, readUvarintFrames, writeUvarintFrame } from '../stream/index.js'
import { RemoteSigner } from './remote-signer.js'

const PROTOCOL = '/bitcoin-libp2p/test/echo/1.0.0'
const FRAMING_PROTOCOL = '/bitcoin-libp2p/test/uvarint-framing/1.0.0'

function option (name: string): string | undefined {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : undefined
}

function payload (size: number): Uint8Array {
  const result = new Uint8Array(size)
  for (let i = 0; i < result.length; i++) result[i] = i & 0xff
  return result
}

function equalBytes (a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index])
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
  const mode = option('--mode') ?? 'server'
  const remote = option('--addr')
  const publicKeyHex = option('--public-key')
  const signerAddress = option('--signer-addr')
  const signTimeoutValue = option('--sign-timeout-ms')
  const hostStopAfterValue = option('--host-stop-after-ms')
  if (publicKeyHex == null || signerAddress == null) throw new Error('--public-key and --signer-addr are required')
  const signTimeoutMs = signTimeoutValue == null ? undefined : Number(signTimeoutValue)
  const hostStopAfterMs = hostStopAfterValue == null ? undefined : Number(hostStopAfterValue)
  if (signTimeoutMs != null && (!Number.isFinite(signTimeoutMs) || signTimeoutMs <= 0)) throw new Error('--sign-timeout-ms is invalid')
  if (hostStopAfterMs != null && (!Number.isFinite(hostStopAfterMs) || hostStopAfterMs <= 0)) throw new Error('--host-stop-after-ms is invalid')
  const publicKey = hexToBytes(publicKeyHex)
  const node = await createHost({
    signer: new RemoteSigner(publicKey, signerAddress),
    listenAddrs: mode === 'server' ? [multiaddr('/ip4/127.0.0.1/tcp/0')] : [],
    transports: [tcp()],
    signTimeoutMs
  })
  const close = async (): Promise<void> => { await node.stop() }
  process.once('SIGINT', () => { void close().finally(() => process.exit(130)) })
  process.once('SIGTERM', () => { void close().finally(() => process.exit(143)) })

  if (mode === 'server') {
    await node.handle(PROTOCOL, async stream => {
      const input = await readStreamToEnd(stream)
      if (input.length === 0 || input.length > 1 << 20) {
        stream.abort(new Error('invalid echo payload'))
        return
      }
      stream.send(input)
      await stream.close()
    })
    await node.handle(FRAMING_PROTOCOL, async stream => {
      try {
        for await (const value of readUvarintFrames(stream)) writeUvarintFrame(stream, value)
        await stream.close()
      } catch {
        stream.abort(new Error('framing handler failed'))
      }
    })
    const listen = node.getMultiaddrs()[0]?.decapsulateCode(421)
    if (listen == null) throw new Error('host did not listen')
    console.log(`READY ${node.peerId.toString()} ${listen.encapsulate(`/p2p/${node.peerId.toString()}`).toString()} ${Buffer.from(publicKey).toString('hex')}`)
    await new Promise<void>(resolve => process.stdin.once('end', resolve))
    await close()
    return
  }

  if (remote == null) throw new Error('--addr is required in client mode')
  if (hostStopAfterMs != null) setTimeout(() => { void node.stop() }, hostStopAfterMs)
  const remoteAddress = multiaddr(remote)
  const connection = await node.dial(remoteAddress, { signal: AbortSignal.timeout(10_000) })
  if (process.argv.includes('--framing')) {
    const data = framingPayloads()
    const stream = await connection.newStream(FRAMING_PROTOCOL, { signal: AbortSignal.timeout(10_000) })
    const responsePromise = readFramed(stream)
    for (const value of data) writeUvarintFrame(stream, value)
    await stream.close()
    const responses = await responsePromise
    if (responses.length !== data.length || responses.some((value, index) => !equalBytes(value, data[index]))) {
      throw new Error('framing response did not match')
    }
  } else {
    for (const data of [new TextEncoder().encode('hello'), payload(128 * 1024)]) {
      const stream = await connection.newStream(PROTOCOL, { signal: AbortSignal.timeout(10_000) })
      const responsePromise = readStreamToEnd(stream)
      stream.send(data)
      await stream.close()
      const response = await responsePromise
      if (!equalBytes(data, response)) throw new Error('echo response did not match')
    }
  }
  const authenticated = connection.remotePeer
  if (authenticated.type !== 'secp256k1') throw new Error('remote peer is not secp256k1')
  const addressPeerId = remoteAddress.getComponents().find(component => component.name === 'p2p')?.value
  if (addressPeerId == null) throw new Error('dial address has no /p2p component')
  console.log(`OK ${authenticated.toString()} ${Buffer.from(authenticated.publicKey.raw).toString('hex')} ${addressPeerId}`)
  await close()
}

await main()
