import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  bytesToHex,
  hexToBytes,
  peerIdFromPublicKeyBytes,
  publicKeyFromPeerId,
  publicKeyFromPrivateKey,
  validatePrivateKey,
  validatePublicKey,
  validateIdentity
} from '../src/identity/index.js'

interface IdentityVector {
  private_key_hex: string
  public_key_hex: string
  peer_id: string
}

const vector = JSON.parse(readFileSync(new URL('../../testdata/identity-v1.json', import.meta.url), 'utf8')) as IdentityVector

describe('identity vector', () => {
  it('derives the same public key and PeerId as Go', () => {
    const privateKey = hexToBytes(vector.private_key_hex, 'ERR_INVALID_PRIVATE_KEY')
    const publicKey = publicKeyFromPrivateKey(privateKey)
    expect(bytesToHex(publicKey)).toBe(vector.public_key_hex)
    expect(peerIdFromPublicKeyBytes(publicKey).toString()).toBe(vector.peer_id)
    expect(bytesToHex(publicKeyFromPeerId(vector.peer_id))).toBe(vector.public_key_hex)
  })

  it('rejects invalid scalar and public-key encodings', () => {
    const invalidPrivateKeys = [
      new Uint8Array(32),
      hexToBytes('fffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141', 'ERR_INVALID_PRIVATE_KEY'),
      hexToBytes('fffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364142', 'ERR_INVALID_PRIVATE_KEY'),
      new Uint8Array(31),
      new Uint8Array(33)
    ]
    for (const key of invalidPrivateKeys) {
      expect(() => validatePrivateKey(key)).toThrowError(/private key/)
    }
    expect(() => validatePublicKey(Uint8Array.from([0x04, ...new Uint8Array(32)]))).toThrowError(/public key/)
    expect(() => validatePublicKey(Uint8Array.from([0x02, ...new Uint8Array(32)]))).toThrowError(/public key/)
  })

  it('pins the /p2p component', () => {
    const publicKey = hexToBytes(vector.public_key_hex)
    expect(() => validateIdentity(publicKey, vector.peer_id, `/ip4/127.0.0.1/tcp/4001/p2p/${vector.peer_id}`)).not.toThrow()
    expect(() => validateIdentity(publicKey, vector.peer_id, '/ip4/127.0.0.1/tcp/4001')).toThrow(/p2p component/)
  })
})
