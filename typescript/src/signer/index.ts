import type { AbortOptions } from '@libp2p/interface'
import { peerIdFromPublicKey } from '@libp2p/peer-id'
import { secp256k1 as secp } from '@noble/curves/secp256k1.js'
import { sha256 } from '@noble/hashes/sha2.js'
import {
  noiseSigningPayload,
  peerRecordUnsigned,
  publicKeyObject,
  validatePrivateKey,
  validatePublicKey,
  type PeerRecordInput
} from '../identity/index.js'

const SECP256K1_ORDER = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n

export type SignerErrorCode =
  | 'ERR_UNSUPPORTED_SIGNER_PURPOSE'
  | 'ERR_INVALID_SIGNER_INPUT'
  | 'ERR_INVALID_SIGNATURE'
  | 'ERR_SIGNER_PUBLIC_KEY'
  | 'ERR_SIGN_TIMEOUT'

export class SignerError extends Error {
  readonly code: SignerErrorCode

  constructor (code: SignerErrorCode, message: string) {
    super(message)
    this.name = 'SignerError'
    this.code = code
  }
}

export interface TypedSigner {
  publicKey(): Uint8Array
  signNoiseStaticKey(staticKey32: Uint8Array, signal?: AbortSignal): Promise<Uint8Array>
  signPeerRecord(record: PeerRecordInput, signal?: AbortSignal): Promise<Uint8Array>
}

function throwIfAborted (signal?: AbortSignal): void {
  if (signal?.aborted === true) {
    throw signal.reason instanceof Error ? signal.reason : new DOMException('The operation was aborted', 'AbortError')
  }
}

function abortable<T> (promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  throwIfAborted(signal)
  if (signal == null) return promise
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      signal.removeEventListener('abort', onAbort)
      reject(signal.reason instanceof Error ? signal.reason : new DOMException('The operation was aborted', 'AbortError'))
    }
    signal.addEventListener('abort', onAbort, { once: true })
    void promise.then(value => {
      signal.removeEventListener('abort', onAbort)
      resolve(value)
    }, error => {
      signal.removeEventListener('abort', onAbort)
      reject(error)
    })
  })
}

function integerFromDer (value: Uint8Array): bigint {
  let result = 0n
  for (const byte of value) result = (result << 8n) | BigInt(byte)
  return result
}

function validateDerEncoding (signature: Uint8Array): void {
  if (signature.length < 8 || signature[0] !== 0x30 || signature[1] !== signature.length - 2) {
    throw new SignerError('ERR_INVALID_SIGNATURE', 'signature is not strict DER')
  }
  let offset = 2
  const readInteger = (): Uint8Array => {
    if (signature[offset++] !== 0x02) throw new SignerError('ERR_INVALID_SIGNATURE', 'signature is not strict DER')
    const length = signature[offset++]
    if (length == null || length === 0 || length > 33 || offset + length > signature.length) {
      throw new SignerError('ERR_INVALID_SIGNATURE', 'signature integer is malformed')
    }
    const value = signature.subarray(offset, offset + length)
    offset += length
    if ((value[0] === 0 && (value.length === 1 || (value[1] & 0x80) === 0)) || (value[0] & 0x80) !== 0) {
      throw new SignerError('ERR_INVALID_SIGNATURE', 'signature integer is non-canonical')
    }
    return value
  }
  const r = readInteger()
  const s = readInteger()
  if (offset !== signature.length || integerFromDer(r) <= 0n || integerFromDer(r) >= SECP256K1_ORDER || integerFromDer(s) <= 0n || integerFromDer(s) > SECP256K1_ORDER / 2n) {
    throw new SignerError('ERR_INVALID_SIGNATURE', 'signature scalar is invalid or high-S')
  }
}

// VerifyDER is used after every remote signer response and before handing the
// result to js-libp2p.
export async function verifyDER (publicKey: Uint8Array, data: Uint8Array, signature: Uint8Array, signal?: AbortSignal): Promise<void> {
  throwIfAborted(signal)
  const key = publicKeyObject(publicKey)
  validateDerEncoding(signature)
  let valid: boolean | Promise<boolean>
  try {
    valid = key.verify(data, signature, { signal } as AbortOptions)
  } catch {
    throw new SignerError('ERR_INVALID_SIGNATURE', 'signature verification failed')
  }
  if (!await abortable(Promise.resolve(valid), signal)) {
    throw new SignerError('ERR_INVALID_SIGNATURE', 'signature verification failed')
  }
  throwIfAborted(signal)
}

// LocalSigner is for tests and trusted single-process code only. Its raw key
// never crosses the TypedSigner interface and is not suitable for a Window.
export class LocalSigner implements TypedSigner {
  readonly #privateKey: Uint8Array
  readonly #publicKey: Uint8Array

  constructor (rawPrivateKey: Uint8Array) {
    const validated = validatePrivateKey(rawPrivateKey)
    this.#privateKey = new Uint8Array(validated)
    this.#publicKey = new Uint8Array(secp.getPublicKey(this.#privateKey, true))
  }

  publicKey (): Uint8Array {
    return new Uint8Array(this.#publicKey)
  }

  async #sign (data: Uint8Array, signal?: AbortSignal): Promise<Uint8Array> {
    throwIfAborted(signal)
    const digest = sha256(data)
    const signature = new Uint8Array(secp.sign(digest, this.#privateKey, { prehash: false, format: 'der' }))
    throwIfAborted(signal)
    await verifyDER(this.#publicKey, data, signature, signal)
    return signature
  }

  async signNoiseStaticKey (staticKey32: Uint8Array, signal?: AbortSignal): Promise<Uint8Array> {
    if (staticKey32.length !== 32) throw new SignerError('ERR_INVALID_SIGNER_INPUT', 'Noise static key must be 32 bytes')
    return this.#sign(noiseSigningPayload(new Uint8Array(staticKey32)), signal)
  }

  async signPeerRecord (record: PeerRecordInput, signal?: AbortSignal): Promise<Uint8Array> {
    const id = peerIdFromPublicKey(publicKeyObject(this.#publicKey))
    const unsigned = peerRecordUnsigned(record, id)
    return this.#sign(unsigned, signal)
  }
}

export function signerPublicKey (signer: TypedSigner): Uint8Array {
  return validatePublicKey(signer.publicKey())
}
