import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { Uint8ArrayList } from 'uint8arraylist'
import { tcp } from '@libp2p/tcp'
import { multiaddr } from '@multiformats/multiaddr'
import {
  bytesToHex,
  hexToBytes,
  noiseSigningPayload,
  peerIdFromPublicKeyBytes,
  publicKeyFromPrivateKey,
  peerRecordUnsigned,
  parsePeerRecordUnsigned
} from '../src/identity/index.js'
import { LocalSigner, type TypedSigner } from '../src/signer/index.js'
import { authenticateConnection, createHost, createIdentityAdapter, NonExtractableError } from '../src/libp2p/index.js'

interface NoiseVector { static_public_key_hex: string, payload_hex: string, sha256_hex: string, signature_der_hex: string }
interface PeerVector { peer_id: string, addresses: string[], sequence: number, protobuf_payload_hex: string, unsigned_envelope_payload_hex: string, signature_der_hex: string }
interface IdentityVector { private_key_hex: string, public_key_hex: string }

const identity = JSON.parse(readFileSync(new URL('../../testdata/identity-v1.json', import.meta.url), 'utf8')) as IdentityVector
const noise = JSON.parse(readFileSync(new URL('../../testdata/noise-signature-v1.json', import.meta.url), 'utf8')) as NoiseVector
const peer = JSON.parse(readFileSync(new URL('../../testdata/peer-record-v1.json', import.meta.url), 'utf8')) as PeerVector

describe('typed signer and non-extractable adapter', () => {
  it('matches Go Noise and Signed Peer Record vectors', async () => {
    const local = new LocalSigner(hexToBytes(identity.private_key_hex, 'ERR_INVALID_PRIVATE_KEY'))
    const staticKey = hexToBytes(noise.static_public_key_hex)
    expect(bytesToHex(noiseSigningPayload(staticKey))).toBe(noise.payload_hex)
    expect(bytesToHex(await local.signNoiseStaticKey(staticKey))).toBe(noise.signature_der_hex)

    const peerId = peerIdFromPublicKeyBytes(hexToBytes(identity.public_key_hex))
    const record = {
      peerId,
      addresses: peer.addresses.map(address => multiaddr(address)),
      sequence: BigInt(peer.sequence)
    }
    const unsigned = peerRecordUnsigned(record, peerId)
    expect(bytesToHex(unsigned)).toBe(peer.unsigned_envelope_payload_hex)
    expect(bytesToHex(await local.signPeerRecord(record))).toBe(peer.signature_der_hex)
    expect(bytesToHex(parsePeerRecordUnsigned(unsigned, peerId).addresses[0].bytes)).toBe('047f000001060fa1')
  })

  it('rejects malformed Peer Record purposes', async () => {
    const peerId = peerIdFromPublicKeyBytes(hexToBytes(identity.public_key_hex))
    const record = {
      peerId,
      addresses: [multiaddr('/ip4/127.0.0.1/tcp/4001')],
      sequence: 7n
    }
    const unsigned = peerRecordUnsigned(record, peerId)
    const wrongDomain = new Uint8Array(unsigned)
    wrongDomain[1] = 'X'.charCodeAt(0)
    expect(() => parsePeerRecordUnsigned(wrongDomain, peerId)).toThrow()
    const wrongType = new Uint8Array(unsigned)
    wrongType[1 + 'libp2p-peer-record'.length + 1] = 4
    expect(() => parsePeerRecordUnsigned(wrongType, peerId)).toThrow()
    const otherPrivateKey = new Uint8Array(32)
    otherPrivateKey[31] = 1
    const otherPeerId = peerIdFromPublicKeyBytes(publicKeyFromPrivateKey(otherPrivateKey))
    expect(() => peerRecordUnsigned({ ...record, peerId: otherPeerId }, peerId)).toThrow()
    expect(() => peerRecordUnsigned({ ...record, addresses: [{ bytes: new Uint8Array() } as ReturnType<typeof multiaddr>] }, peerId)).toThrow()
  })

  it('accepts Uint8ArrayList bytes and refuses raw/unknown purposes', async () => {
    const local = new LocalSigner(hexToBytes(identity.private_key_hex, 'ERR_INVALID_PRIVATE_KEY'))
    const adapter = createIdentityAdapter(local)
    expect(() => adapter.raw).toThrowError(NonExtractableError)
    await expect(adapter.sign(new Uint8ArrayList(noiseSigningPayload(new Uint8Array(32))))).resolves.toBeInstanceOf(Uint8Array)
    await expect(adapter.sign(new TextEncoder().encode('arbitrary'))).rejects.toMatchObject({ code: 'ERR_UNSUPPORTED_SIGNER_PURPOSE' })
    const shortNoise = new Uint8Array([...noiseSigningPayload(new Uint8Array(32)).subarray(0, 24), ...new Uint8Array(31)])
    await expect(adapter.sign(shortNoise)).rejects.toMatchObject({ code: 'ERR_INVALID_SIGNER_INPUT' })
  })

  it('rejects a signer response that is not valid low-S DER', async () => {
    const publicKey = hexToBytes(identity.public_key_hex)
    const badSigner: TypedSigner = {
      publicKey: () => new Uint8Array(publicKey),
      signNoiseStaticKey: async () => Uint8Array.from([0x01]),
      signPeerRecord: async () => Uint8Array.from([0x01])
    }
    const adapter = createIdentityAdapter(badSigner)
    await expect(adapter.sign(noiseSigningPayload(new Uint8Array(32)))).rejects.toMatchObject({ code: 'ERR_INVALID_SIGNATURE' })

    const wrongPrivateKey = new Uint8Array(32)
    wrongPrivateKey[31] = 2
    const wrongSignature = await new LocalSigner(wrongPrivateKey).signNoiseStaticKey(new Uint8Array(32))
    const wrongKeySigner: TypedSigner = {
      publicKey: () => new Uint8Array(publicKey),
      signNoiseStaticKey: async () => wrongSignature,
      signPeerRecord: async () => wrongSignature
    }
    const wrongKeyAdapter = createIdentityAdapter(wrongKeySigner)
    await expect(wrongKeyAdapter.sign(noiseSigningPayload(new Uint8Array(32)))).rejects.toMatchObject({ code: 'ERR_INVALID_SIGNATURE' })

    const lowSignature = await new LocalSigner(hexToBytes(identity.private_key_hex, 'ERR_INVALID_PRIVATE_KEY')).signNoiseStaticKey(new Uint8Array(32))
    const compactSigner: TypedSigner = {
      publicKey: () => new Uint8Array(publicKey),
      signNoiseStaticKey: async () => compactSignature(lowSignature),
      signPeerRecord: async () => compactSignature(lowSignature)
    }
    await expect(createIdentityAdapter(compactSigner).sign(noiseSigningPayload(new Uint8Array(32)))).rejects.toMatchObject({ code: 'ERR_INVALID_SIGNATURE' })

    const changingPublicKey = publicKeyFromPrivateKey(wrongPrivateKey)
    const highKeySigner: TypedSigner = {
      publicKey: () => new Uint8Array(publicKey),
      signNoiseStaticKey: async () => highS(lowSignature),
      signPeerRecord: async () => highS(lowSignature)
    }
    await expect(createIdentityAdapter(highKeySigner).sign(noiseSigningPayload(new Uint8Array(32)))).rejects.toMatchObject({ code: 'ERR_INVALID_SIGNATURE' })

    let activePublicKey = new Uint8Array(publicKey)
    const changingKeySigner: TypedSigner = {
      publicKey: () => new Uint8Array(activePublicKey),
      signNoiseStaticKey: async () => {
        activePublicKey = changingPublicKey
        return lowSignature
      },
      signPeerRecord: async () => lowSignature
    }
    await expect(createIdentityAdapter(changingKeySigner).sign(noiseSigningPayload(new Uint8Array(32)))).rejects.toMatchObject({ code: 'ERR_SIGNER_PUBLIC_KEY' })
  })

  it('rejects authenticated public-key and PeerId pin mismatches', () => {
    const publicKey = hexToBytes(identity.public_key_hex)
    const peerId = peerIdFromPublicKeyBytes(publicKey)
    const wrongPrivateKey = scalarPrivateKey(2)
    const wrongPublicKey = publicKeyFromPrivateKey(wrongPrivateKey)
    const wrongPeerId = peerIdFromPublicKeyBytes(wrongPublicKey)
    const connection = { remotePeer: peerId } as any
    expect(() => authenticateConnection(connection, { publicKey: wrongPublicKey })).toThrow(/public key pin/)
    expect(() => authenticateConnection(connection, { peerId: wrongPeerId })).toThrow(/peer id pin/)
    expect(authenticateConnection(connection, { publicKey, peerId }).peerId.equals(peerId)).toBe(true)
  })

  it('settles a pending signer wait on AbortSignal cancellation', async () => {
    const publicKey = hexToBytes(identity.public_key_hex)
    const pending = new Promise<Uint8Array>(() => {})
    const remote: TypedSigner = {
      publicKey: () => new Uint8Array(publicKey),
      signNoiseStaticKey: async () => await pending,
      signPeerRecord: async () => await pending
    }
    const adapter = createIdentityAdapter(remote)
    const controller = new AbortController()
    const result = adapter.sign(noiseSigningPayload(new Uint8Array(32)), { signal: controller.signal })
    controller.abort(new Error('cancelled'))
    await expect(result).rejects.toThrow('cancelled')
  })

  it('ends a real host dial when the signer never resolves', async () => {
    const server = await createHost({
      signer: new LocalSigner(hexToBytes(identity.private_key_hex, 'ERR_INVALID_PRIVATE_KEY')),
      listenAddrs: [multiaddr('/ip4/127.0.0.1/tcp/0')],
      transports: [tcp()]
    })
    const blocker = new BlockingSigner(publicKeyFromPrivateKey(scalarPrivateKey(1)))
    const client = await createHost({ signer: blocker, transports: [tcp()], signTimeoutMs: 50 })
    const address = server.getMultiaddrs()[0].decapsulateCode(421).encapsulate(`/p2p/${server.peerId.toString()}`)
    try {
      const dial = client.dial(address, { signal: AbortSignal.timeout(1_000) }).then(() => undefined, error => error)
      await blocker.started
      const error = await dial
      expect(error).toBeInstanceOf(Error)
      expect(blocker.calls).toBe(1)
    } finally {
      blocker.release()
      await client.stop()
      await server.stop()
    }
  })

  it('host stop cancels a real pending signer wait', async () => {
    const server = await createHost({
      signer: new LocalSigner(hexToBytes(identity.private_key_hex, 'ERR_INVALID_PRIVATE_KEY')),
      listenAddrs: [multiaddr('/ip4/127.0.0.1/tcp/0')],
      transports: [tcp()]
    })
    const blocker = new BlockingSigner(publicKeyFromPrivateKey(scalarPrivateKey(1)))
    const client = await createHost({ signer: blocker, transports: [tcp()], signTimeoutMs: 5_000 })
    const address = server.getMultiaddrs()[0].decapsulateCode(421).encapsulate(`/p2p/${server.peerId.toString()}`)
    try {
      const dial = client.dial(address, { signal: AbortSignal.timeout(5_000) }).then(() => undefined, error => error)
      await blocker.started
      await client.stop()
      const error = await dial
      expect(error).toBeInstanceOf(Error)
      expect(blocker.calls).toBe(1)
    } finally {
      blocker.release()
      await client.stop()
      await server.stop()
    }
  })
})

class BlockingSigner implements TypedSigner {
  readonly #publicKey: Uint8Array
  readonly started: Promise<void>
  readonly #start!: () => void
  readonly #release!: () => void
  readonly #response: Promise<Uint8Array>
  calls = 0

  constructor (publicKey: Uint8Array) {
    this.#publicKey = new Uint8Array(publicKey)
    this.started = new Promise(resolve => { this.#start = resolve })
    this.#response = new Promise(resolve => { this.#release = () => resolve(Uint8Array.of(1)) })
  }

  publicKey (): Uint8Array { return new Uint8Array(this.#publicKey) }

  async signNoiseStaticKey (): Promise<Uint8Array> {
    this.calls++
    this.#start()
    return this.#response
  }

  async signPeerRecord (): Promise<Uint8Array> {
    this.calls++
    this.#start()
    return this.#response
  }

  release (): void { this.#release() }
}

function scalarPrivateKey (lastByte: number): Uint8Array {
  const key = new Uint8Array(32)
  key[31] = lastByte
  return key
}

function highS (signature: Uint8Array): Uint8Array {
  const rLength = signature[3]
  const r = signature.slice(4, 4 + rLength)
  const sLengthOffset = 4 + rLength + 1
  const sLength = signature[sLengthOffset]
  const s = signature.slice(sLengthOffset + 1, sLengthOffset + 1 + sLength)
  let value = 0n
  for (const byte of s) value = (value << 8n) | BigInt(byte)
  const order = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n
  const high = order - value
  const highBytes32 = new Uint8Array(32)
  let remaining = high
  for (let index = highBytes32.length - 1; index >= 0; index--) {
    highBytes32[index] = Number(remaining & 0xffn)
    remaining >>= 8n
  }
  const highBytes = highBytes32[0] >= 0x80 ? Uint8Array.from([0, ...highBytes32]) : highBytes32
  const output = new Uint8Array(6 + r.length + highBytes.length)
  output.set([0x30, output.length - 2, 0x02, r.length], 0)
  output.set(r, 4)
  const sStart = 4 + r.length
  output.set([0x02, highBytes.length], sStart)
  output.set(highBytes, sStart + 2)
  return output
}

function compactSignature (signature: Uint8Array): Uint8Array {
  const rLength = signature[3]
  const r = signature.slice(4, 4 + rLength)
  const sLengthOffset = 4 + rLength + 1
  const sLength = signature[sLengthOffset]
  const s = signature.slice(sLengthOffset + 1, sLengthOffset + 1 + sLength)
  const output = new Uint8Array(64)
  output.set(r.slice(-32), 0)
  output.set(s.slice(-32), 32)
  return output
}
