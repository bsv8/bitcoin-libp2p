import { publicKeyFromRaw } from '@libp2p/crypto/keys'
import type { PublicKey, Secp256k1PublicKey, PeerId } from '@libp2p/interface'
import { peerIdFromPublicKey, peerIdFromString } from '@libp2p/peer-id'
import { PeerRecord as NativePeerRecord } from '@libp2p/peer-record'
import { multiaddr } from '@multiformats/multiaddr'
import { secp256k1 as secp } from '@noble/curves/secp256k1.js'
import { sha256 } from '@noble/hashes/sha2.js'

export type BytesLike = Uint8Array | {
  subarray (beginInclusive?: number, endExclusive?: number): Uint8Array
}

export type ErrorCode =
  | 'ERR_INVALID_PRIVATE_KEY'
  | 'ERR_INVALID_PUBLIC_KEY'
  | 'ERR_INVALID_PEER_ID'
  | 'ERR_PEER_ID_MISMATCH'
  | 'ERR_INVALID_MULTIADDR'

export class IdentityError extends Error {
  readonly code: ErrorCode

  constructor (code: ErrorCode, message: string) {
    super(message)
    this.name = 'IdentityError'
    this.code = code
  }
}

const noiseStaticKeyPrefix = new TextEncoder().encode('noise-libp2p-static-key:')
export const PEER_RECORD_DOMAIN = 'libp2p-peer-record'
const peerRecordPayloadType = Uint8Array.from([0x03, 0x01])

function equalBytes (a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index])
}

export function toBytes (value: BytesLike): Uint8Array {
  return value instanceof Uint8Array ? new Uint8Array(value) : value.subarray()
}

export function bytesToHex (value: Uint8Array): string {
  return Array.from(value, byte => byte.toString(16).padStart(2, '0')).join('')
}

export function hexToBytes (value: string, code: ErrorCode = 'ERR_INVALID_PUBLIC_KEY'): Uint8Array {
  if (value.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(value)) {
    throw new IdentityError(code, 'hex value is malformed')
  }
  const result = new Uint8Array(value.length / 2)
  for (let i = 0; i < result.length; i++) {
    result[i] = Number.parseInt(value.slice(i * 2, i * 2 + 2), 16)
  }
  return result
}

export function validatePrivateKey (value: Uint8Array): Uint8Array {
  if (value.length !== 32) {
    throw new IdentityError('ERR_INVALID_PRIVATE_KEY', 'private key must be 32 bytes')
  }
  try {
    // The native libp2p implementation validates 1 <= scalar < secp256k1.N.
    secp.getPublicKey(new Uint8Array(value), true)
  } catch {
    throw new IdentityError('ERR_INVALID_PRIVATE_KEY', 'private key scalar is outside 1..n-1')
  }
  return new Uint8Array(value)
}

export function validatePublicKey (value: Uint8Array): Uint8Array {
  if (value.length !== 33 || (value[0] !== 0x02 && value[0] !== 0x03)) {
    throw new IdentityError('ERR_INVALID_PUBLIC_KEY', 'public key must be a compressed 33-byte SEC1 key')
  }
  try {
    const key = publicKeyFromRaw(new Uint8Array(value))
    if (key.type !== 'secp256k1' || !equalBytes(key.raw, value)) {
      throw new Error('public key was not canonical compressed SEC1')
    }
  } catch {
    throw new IdentityError('ERR_INVALID_PUBLIC_KEY', 'public key is not a valid secp256k1 point')
  }
  return new Uint8Array(value)
}

export function publicKeyFromPrivateKey (privateKey: Uint8Array): Uint8Array {
  const validated = validatePrivateKey(privateKey)
  return new Uint8Array(secp.getPublicKey(validated, true))
}

export function publicKeyObject (publicKey: Uint8Array): Secp256k1PublicKey {
  const key = publicKeyFromRaw(validatePublicKey(publicKey))
  if (key.type !== 'secp256k1') {
    throw new IdentityError('ERR_INVALID_PUBLIC_KEY', 'public key is not secp256k1')
  }
  return key
}

export function peerIdFromPublicKeyBytes (publicKey: Uint8Array): PeerId {
  return peerIdFromPublicKey(publicKeyObject(publicKey))
}

export function publicKeyFromPeerId (peerId: PeerId | string): Uint8Array {
  const id = typeof peerId === 'string' ? parsePeerId(peerId) : peerId
  if (id.type !== 'secp256k1' || id.publicKey == null) {
    throw new IdentityError('ERR_INVALID_PUBLIC_KEY', 'peer id does not embed a secp256k1 public key')
  }
  const publicKey = validatePublicKey(id.publicKey.raw)
  if (!peerIdFromPublicKeyBytes(publicKey).equals(id)) {
    throw new IdentityError('ERR_PEER_ID_MISMATCH', 'peer id is not derived from its public key')
  }
  return publicKey
}

export function parsePeerId (value: string): PeerId {
  try {
    return peerIdFromString(value)
  } catch {
    throw new IdentityError('ERR_INVALID_PEER_ID', 'peer id is malformed')
  }
}

export function validateIdentity (publicKey: Uint8Array, peerId: PeerId | string, address?: string): void {
  const key = validatePublicKey(publicKey)
  const id = typeof peerId === 'string' ? parsePeerId(peerId) : peerId
  if (!peerIdFromPublicKeyBytes(key).equals(id)) {
    throw new IdentityError('ERR_PEER_ID_MISMATCH', 'peer id does not match public key')
  }
  if (address == null || address === '') return
  let parsed
  try {
    parsed = multiaddr(address)
  } catch {
    throw new IdentityError('ERR_INVALID_MULTIADDR', 'multiaddr is malformed')
  }
  const p2p = parsed.getComponents().find(component => component.name === 'p2p')
  if (p2p?.value == null) {
    throw new IdentityError('ERR_INVALID_MULTIADDR', 'multiaddr has no /p2p component')
  }
  let addressPeer: PeerId
  try {
    addressPeer = parsePeerId(p2p.value)
  } catch {
    throw new IdentityError('ERR_INVALID_MULTIADDR', 'multiaddr peer id is malformed')
  }
  if (!addressPeer.equals(id)) {
    throw new IdentityError('ERR_PEER_ID_MISMATCH', 'multiaddr peer id does not match public key')
  }
}

export function noiseSigningPayload (staticKey: Uint8Array): Uint8Array {
  if (staticKey.length !== 32) {
    throw new IdentityError('ERR_INVALID_PUBLIC_KEY', 'Noise static key must be 32 bytes')
  }
  const result = new Uint8Array(noiseStaticKeyPrefix.length + 32)
  result.set(noiseStaticKeyPrefix)
  result.set(staticKey, noiseStaticKeyPrefix.length)
  return result
}

export function sha256Bytes (value: Uint8Array): Uint8Array {
  return new Uint8Array(sha256(value))
}

function encodeVarint (value: number): Uint8Array {
  const output: number[] = []
  do {
    let byte = value & 0x7f
    value = Math.floor(value / 128)
    if (value > 0) byte |= 0x80
    output.push(byte)
  } while (value > 0)
  return Uint8Array.from(output)
}

function readVarint (data: Uint8Array, offset: number): { value: number, next: number } {
  let value = 0
  let multiplier = 1
  for (let i = offset; i < data.length && i < offset + 5; i++) {
    const byte = data[i]
    value += (byte & 0x7f) * multiplier
    if ((byte & 0x80) === 0) {
      const encoded = encodeVarint(value)
      if (!equalBytes(encoded, data.subarray(offset, i + 1))) {
        throw new Error('non-canonical varint')
      }
      return { value, next: i + 1 }
    }
    multiplier *= 128
  }
  throw new Error('malformed varint')
}

function readField (data: Uint8Array, offset: number): { field: Uint8Array, next: number } {
  const length = readVarint(data, offset)
  const end = length.next + length.value
  if (end > data.length) throw new Error('field exceeds input')
  return { field: data.subarray(length.next, end), next: end }
}

function concat (...values: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(values.reduce((size, value) => size + value.length, 0))
  let offset = 0
  for (const value of values) {
    result.set(value, offset)
    offset += value.length
  }
  return result
}

export interface PeerRecordInput {
  peerId: PeerId
  addresses: ReturnType<typeof multiaddr>[]
  sequence: bigint
}

function validateRecord (record: PeerRecordInput, expected: PeerId): void {
  if (record.peerId.type !== 'secp256k1' || !record.peerId.equals(expected)) {
    throw new IdentityError('ERR_PEER_ID_MISMATCH', 'peer record peer id does not match the bound identity')
  }
  if (record.sequence < 0n) throw new IdentityError('ERR_INVALID_PEER_ID', 'peer record sequence is negative')
  for (const address of record.addresses) {
    if (address.bytes.length === 0) throw new IdentityError('ERR_INVALID_MULTIADDR', 'peer record contains an empty multiaddr')
    // Reparse the exact bytes so a caller cannot smuggle an invalid address.
    multiaddr(address.bytes)
  }
}

export function marshalPeerRecord (record: PeerRecordInput, expected: PeerId): Uint8Array {
  validateRecord(record, expected)
  return new NativePeerRecord({
    peerId: record.peerId,
    multiaddrs: record.addresses,
    seqNumber: record.sequence
  }).marshal()
}

export function peerRecordUnsigned (record: PeerRecordInput, expected: PeerId): Uint8Array {
  const payload = marshalPeerRecord(record, expected)
  return concat(
    encodeVarint(new TextEncoder().encode(PEER_RECORD_DOMAIN).length),
    new TextEncoder().encode(PEER_RECORD_DOMAIN),
    encodeVarint(peerRecordPayloadType.length),
    peerRecordPayloadType,
    encodeVarint(payload.length),
    payload
  )
}

export function parsePeerRecordUnsigned (data: Uint8Array, expected: PeerId): PeerRecordInput {
  try {
    let offset = 0
    const domain = readField(data, offset); offset = domain.next
    if (new TextDecoder().decode(domain.field) !== PEER_RECORD_DOMAIN) throw new Error('wrong peer record domain')
    const payloadType = readField(data, offset); offset = payloadType.next
    if (!equalBytes(payloadType.field, peerRecordPayloadType)) throw new Error('wrong peer record payload type')
    const payload = readField(data, offset); offset = payload.next
    if (offset !== data.length) throw new Error('trailing bytes')
    const native = NativePeerRecord.createFromProtobuf(payload.field)
    const record: PeerRecordInput = {
      peerId: native.peerId,
      addresses: native.multiaddrs,
      sequence: native.seqNumber
    }
    validateRecord(record, expected)
    if (!equalBytes(marshalPeerRecord(record, expected), payload.field)) throw new Error('non-canonical peer record')
    return record
  } catch (error) {
    if (error instanceof IdentityError) throw error
    throw new IdentityError('ERR_INVALID_PEER_ID', 'signed peer record payload is invalid')
  }
}

export function isSecp256k1PublicKey (value: PublicKey | undefined): value is Secp256k1PublicKey {
  return value?.type === 'secp256k1'
}
