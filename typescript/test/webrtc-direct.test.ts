import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { peerIdFromPublicKey } from '@libp2p/peer-id'
import { publicKeyFromRaw } from '@libp2p/crypto/keys'
import { multiaddr } from '@multiformats/multiaddr'
import {
  WebRTCDirectError,
  buildWebRTCDirectEndpoint,
  dialAuthenticatedWebRTCDirect,
  parseWebRTCDirectEndpoint,
  resolveWebRTCDirectEndpoint
} from '../src/webrtc-direct/index.js'
import { bytesToHex, hexToBytes } from '../src/identity/index.js'

interface ValidVector {
  name: string
  input: string
  canonical_address: string
  host_type: string
  host: string
  udp_port: number
  certhash: string
  certhash_digest_hex: string
  peer_id: string
  public_key_hex: string
}

interface BuildVector {
  name: string
  host_type: 'ip4' | 'ip6' | 'dns' | 'dns4' | 'dns6'
  host: string
  udp_port: number
  certhash: string
  public_key_hex: string
  expected_peer_id: string
  expected_address: string
}

interface InvalidBuildVector {
  name: string
  host_type: 'ip4' | 'ip6' | 'dns' | 'dns4' | 'dns6'
  host: string
  udp_port: number
  certhash: string
  public_key_hex: string
  expected_error_code: string
  expected_stage: string
}

interface InvalidVector {
  name: string
  input: string
  pin_public_key_hex?: string
  pin_peer_id?: string
  expected_error_code: string
  expected_stage: string
}

interface EndpointVectors {
  valid: ValidVector[]
  build: BuildVector[]
  build_invalid: InvalidBuildVector[]
  invalid: InvalidVector[]
}

const vectors = JSON.parse(readFileSync(new URL('../../testdata/webrtc-direct-endpoint-v1.json', import.meta.url), 'utf8')) as EndpointVectors

describe('WebRTC Direct endpoint vectors', () => {
  it('parses every shared valid vector and normalizes its address', () => {
    for (const vector of vectors.valid) {
      const endpoint = parseWebRTCDirectEndpoint(vector.input)
      expect(endpoint.address.toString(), vector.name).toBe(vector.canonical_address)
      expect(endpoint.hostType).toBe(vector.host_type)
      expect(endpoint.host).toBe(vector.host)
      expect(endpoint.udpPort).toBe(vector.udp_port)
      expect(endpoint.certhash).toBe(vector.certhash)
      expect(bytesToHex(endpoint.certhashDigest)).toBe(vector.certhash_digest_hex)
      expect(endpoint.peerId.toString()).toBe(vector.peer_id)
      expect(bytesToHex(endpoint.publicKey)).toBe(vector.public_key_hex)
      expect(parseWebRTCDirectEndpoint(endpoint.address).address.toString()).toBe(vector.canonical_address)
    }
  })

  it('builds every shared input and keeps returned bytes independent', () => {
    for (const vector of vectors.build) {
      const publicKey = hexToBytes(vector.public_key_hex)
      const endpoint = buildWebRTCDirectEndpoint({
        hostType: vector.host_type,
        host: vector.host,
        udpPort: vector.udp_port,
        certhash: vector.certhash,
        publicKey
      })
      expect(endpoint.address.toString(), vector.name).toBe(vector.expected_address)
      expect(endpoint.peerId.toString()).toBe(vector.expected_peer_id)
      const endpointPublicKeyBeforeInputMutation = new Uint8Array(endpoint.publicKey)
      publicKey[0] = publicKey[0] ^ 0xff
      expect(endpoint.publicKey).toEqual(endpointPublicKeyBeforeInputMutation)
      endpoint.publicKey[0] = endpoint.publicKey[0] ^ 0xff
      expect(endpoint.publicKey).not.toEqual(endpointPublicKeyBeforeInputMutation)
      expect(endpoint.certhashDigest).toHaveLength(32)
    }
  })

  it('classifies all shared invalid vectors by stable code and stage', () => {
    for (const vector of vectors.invalid) {
      try {
        parseWebRTCDirectEndpoint(vector.input, {
          publicKey: vector.pin_public_key_hex == null ? undefined : hexToBytes(vector.pin_public_key_hex),
          peerId: vector.pin_peer_id
        })
        throw new Error(`vector unexpectedly succeeded: ${vector.name}`)
      } catch (error) {
        expect(error, vector.name).toBeInstanceOf(WebRTCDirectError)
        expect(error, vector.name).toMatchObject({ code: vector.expected_error_code, stage: vector.expected_stage })
      }
    }
  })

  it('rejects unsafe builder host values using shared vectors', () => {
    for (const vector of vectors.build_invalid) {
      expect(() => buildWebRTCDirectEndpoint({
        hostType: vector.host_type,
        host: vector.host,
        udpPort: vector.udp_port,
        certhash: vector.certhash,
        publicKey: hexToBytes(vector.public_key_hex)
      }), vector.name).toThrowError(expect.objectContaining({
        code: vector.expected_error_code,
        stage: vector.expected_stage
      }))
    }
  })

  it('checks both public key and PeerId pins before dialing', () => {
    const vector = vectors.valid[0]!
    const endpoint = parseWebRTCDirectEndpoint(vector.input)
    expect(() => parseWebRTCDirectEndpoint(endpoint.address, {
      publicKey: hexToBytes('02e940822d4e7a09ce013bed4fa812e92f22b0ed1fa2d1ad06ae0406680da1cc46')
    })).toThrowError(expect.objectContaining({ code: 'ERR_WEBRTC_DIRECT_PEER_ID' }))
  })
})

describe('dialAuthenticatedWebRTCDirect', () => {
  const endpoint = parseWebRTCDirectEndpoint(vectors.valid[0]!.canonical_address)

  it('resolves DNS before dialing and preserves the endpoint identity', async () => {
    const dnsEndpoint = parseWebRTCDirectEndpoint(vectors.valid.find(vector => vector.host_type === 'dns4')!.canonical_address)
    const resolver = vi.fn(async () => ({ hostType: 'ip4' as const, host: '127.0.0.1' }))
    const node = {
      dial: vi.fn(async (address: any) => ({ remotePeer: dnsEndpoint.peerId, remoteAddr: address, close: vi.fn(async () => {}) }))
    }
    const result = await dialAuthenticatedWebRTCDirect(node as any, dnsEndpoint, {
      publicKey: dnsEndpoint.publicKey,
      resolver,
      timeoutMs: 100
    })
    expect(resolver).toHaveBeenCalledWith(expect.objectContaining({ host: 'example.com', hostType: 'dns4', signal: expect.any(AbortSignal) }))
    expect(node.dial.mock.calls[0]![0].toString()).toContain('/ip4/127.0.0.1/udp/4001/webrtc-direct/')
    expect(result.endpoint.hostType).toBe('ip4')
    expect(result.endpoint.host).toBe('127.0.0.1')
  })

  it('fails DNS dialing explicitly when no resolver is supplied', async () => {
    const dnsEndpoint = parseWebRTCDirectEndpoint(vectors.valid.find(vector => vector.host_type === 'dns4')!.canonical_address)
    const node = { dial: vi.fn() }
    await expect(dialAuthenticatedWebRTCDirect(node as any, dnsEndpoint, { publicKey: dnsEndpoint.publicKey, timeoutMs: 100 }))
      .rejects.toMatchObject({ code: 'ERR_WEBRTC_DIRECT_RESOLVE', stage: 'resolve' })
    expect(node.dial).not.toHaveBeenCalled()
  })

  it('rejects a DNS result from the wrong address family', async () => {
    const dnsEndpoint = parseWebRTCDirectEndpoint(vectors.valid.find(vector => vector.host_type === 'dns4')!.canonical_address)
    const node = { dial: vi.fn() }
    await expect(dialAuthenticatedWebRTCDirect(node as any, dnsEndpoint, {
      publicKey: dnsEndpoint.publicKey,
      resolver: async () => ({ hostType: 'ip6' as const, host: '::1' }),
      timeoutMs: 100
    })).rejects.toMatchObject({ code: 'ERR_WEBRTC_DIRECT_RESOLVE', stage: 'resolve' })
    expect(node.dial).not.toHaveBeenCalled()
  })

  it('returns a bounded resolve error when an injected resolver ignores abort', async () => {
    const dnsEndpoint = parseWebRTCDirectEndpoint(vectors.valid.find(vector => vector.host_type === 'dns4')!.canonical_address)
    const controller = new AbortController()
    const pending = resolveWebRTCDirectEndpoint(dnsEndpoint, {
      resolver: async () => await new Promise(() => {}),
      signal: controller.signal
    })
    controller.abort(new Error('caller cancelled'))
    await expect(pending).rejects.toMatchObject({ code: 'ERR_WEBRTC_DIRECT_RESOLVE', stage: 'resolve' })
  })

  it('does not dial when a DNS resolver ignores the overall dial timeout', async () => {
    vi.useFakeTimers()
    try {
      const dnsEndpoint = parseWebRTCDirectEndpoint(vectors.valid.find(vector => vector.host_type === 'dns4')!.canonical_address)
      const node = { dial: vi.fn() }
      const pending = dialAuthenticatedWebRTCDirect(node as any, dnsEndpoint, {
        publicKey: dnsEndpoint.publicKey,
        resolver: async () => await new Promise(() => {}),
        timeoutMs: 10
      }).then(() => undefined, error => error)
      await vi.advanceTimersByTimeAsync(10)
      await expect(pending).resolves.toMatchObject({ code: 'ERR_WEBRTC_DIRECT_TIMEOUT', stage: 'dial' })
      expect(node.dial).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('classifies DNS resolver cancellation at the dial boundary as a dial timeout', async () => {
    const dnsEndpoint = parseWebRTCDirectEndpoint(vectors.valid.find(vector => vector.host_type === 'dns4')!.canonical_address)
    const controller = new AbortController()
    const node = { dial: vi.fn() }
    const pending = dialAuthenticatedWebRTCDirect(node as any, dnsEndpoint, {
      publicKey: dnsEndpoint.publicKey,
      resolver: async () => await new Promise(() => {}),
      signal: controller.signal,
      timeoutMs: 10_000
    })
    controller.abort(new Error('caller cancelled'))
    await expect(pending).rejects.toMatchObject({ code: 'ERR_WEBRTC_DIRECT_TIMEOUT', stage: 'dial' })
    expect(node.dial).not.toHaveBeenCalled()
  })

  it('passes one canonical Direct multiaddr and authenticates before returning', async () => {
    const close = vi.fn(async () => {})
    const node = {
      dial: vi.fn(async (address: any) => ({ remotePeer: endpoint.peerId, remoteAddr: address, close }))
    }
    const result = await dialAuthenticatedWebRTCDirect(node as any, endpoint, {
      publicKey: endpoint.publicKey,
      peerId: endpoint.peerId,
      timeoutMs: 100
    })
    expect(node.dial).toHaveBeenCalledTimes(1)
    expect(node.dial.mock.calls[0]![0].toString()).toBe(endpoint.address.toString())
    expect(result.authenticatedPeer.peerId.equals(endpoint.peerId)).toBe(true)
    expect(close).not.toHaveBeenCalled()
  })

  it('rejects a missing independent identity pin before node.dial', async () => {
    const node = { dial: vi.fn() }
    await expect(dialAuthenticatedWebRTCDirect(node as any, endpoint, {})).rejects.toMatchObject({
      code: 'ERR_WEBRTC_DIRECT_PEER_ID',
      stage: 'validate'
    })
    expect(node.dial).not.toHaveBeenCalled()
  })

  it('closes a connection when the authenticated Noise identity is wrong', async () => {
    const wrongKey = hexToBytes('02e940822d4e7a09ce013bed4fa812e92f22b0ed1fa2d1ad06ae0406680da1cc46')
    const wrongPeer = peerIdFromPublicKey(publicKeyFromRaw(wrongKey))
    const close = vi.fn(async () => {})
    const abort = vi.fn()
    const node = { dial: vi.fn(async () => ({ remotePeer: wrongPeer, close, abort })) }
    await expect(dialAuthenticatedWebRTCDirect(node as any, endpoint, { publicKey: endpoint.publicKey, timeoutMs: 100 }))
      .rejects.toMatchObject({ code: 'ERR_WEBRTC_DIRECT_AUTH', stage: 'authenticate' })
    expect(close).not.toHaveBeenCalled()
    expect(abort).toHaveBeenCalledTimes(1)
  })

  it('does not hang forever when an unauthenticated connection close never resolves', async () => {
    vi.useFakeTimers()
    try {
      const wrongKey = hexToBytes('02e940822d4e7a09ce013bed4fa812e92f22b0ed1fa2d1ad06ae0406680da1cc46')
      const wrongPeer = peerIdFromPublicKey(publicKeyFromRaw(wrongKey))
      const node = { dial: vi.fn(async () => ({ remotePeer: wrongPeer, close: vi.fn(() => new Promise<void>(() => {})) })) }
      const result = dialAuthenticatedWebRTCDirect(node as any, endpoint, { publicKey: endpoint.publicKey, timeoutMs: 100 })
        .then(() => undefined, error => error)
      await vi.advanceTimersByTimeAsync(1_000)
      await expect(result).resolves.toMatchObject({ code: 'ERR_WEBRTC_DIRECT_AUTH', stage: 'authenticate' })
    } finally {
      vi.useRealTimers()
    }
  })

  it('wraps AggregateError causes into bounded safe diagnostics', async () => {
    const cause = new AggregateError([
      new Error('ICE failed'),
      new Error('SDP includes signature and private key')
    ], 'transport failed')
    const node = { dial: vi.fn(async () => { throw cause }) }
    const error = await dialAuthenticatedWebRTCDirect(node as any, endpoint, { publicKey: endpoint.publicKey, timeoutMs: 100 })
      .then(() => undefined, value => value as WebRTCDirectError)
    expect(error).toMatchObject({ code: 'ERR_WEBRTC_DIRECT_DIAL', stage: 'dial' })
    expect(error.diagnostics.length).toBeLessThanOrEqual(24)
    expect(error.diagnostics.join(' ')).not.toMatch(/SDP|signature|private key/i)
    expect(error.cause).toBe(cause)
  })

  it('bounds circular and non-Error causes without losing the dial category', async () => {
    const circular = new Error('circular transport failure')
    Object.defineProperty(circular, 'cause', { value: circular })
    const circularNode = { dial: vi.fn(async () => { throw circular }) }
    const circularError = await dialAuthenticatedWebRTCDirect(circularNode as any, endpoint, { peerId: endpoint.peerId, timeoutMs: 100 })
      .then(() => undefined, value => value as WebRTCDirectError)
    expect(circularError).toMatchObject({ code: 'ERR_WEBRTC_DIRECT_DIAL', stage: 'dial' })
    expect(circularError.diagnostics.join(' ')).toMatch(/cycle/)

    const valueNode = { dial: vi.fn(async () => { throw 'transport failed' }) }
    const valueError = await dialAuthenticatedWebRTCDirect(valueNode as any, endpoint, { peerId: endpoint.peerId, timeoutMs: 100 })
      .then(() => undefined, value => value as WebRTCDirectError)
    expect(valueError).toMatchObject({ code: 'ERR_WEBRTC_DIRECT_DIAL', stage: 'dial' })
    expect(valueError.diagnostics.join(' ')).toContain('transport failed')
  })

  it('returns a stable timeout for timeout and external abort', async () => {
      vi.useFakeTimers()
    try {
      const node = { dial: vi.fn(() => new Promise<any>(() => {})) }
      const pending = dialAuthenticatedWebRTCDirect(node as any, endpoint, { publicKey: endpoint.publicKey, timeoutMs: 10 })
      const timeoutResult = pending.then(() => undefined, value => value)
      await vi.advanceTimersByTimeAsync(10)
      await expect(timeoutResult).resolves.toMatchObject({ code: 'ERR_WEBRTC_DIRECT_TIMEOUT', stage: 'dial' })

      const controller = new AbortController()
      const aborted = dialAuthenticatedWebRTCDirect(node as any, endpoint, { publicKey: endpoint.publicKey, signal: controller.signal, timeoutMs: 100 })
      const abortResult = aborted.then(() => undefined, value => value)
      controller.abort(new Error('caller cancelled'))
      await expect(abortResult).resolves.toMatchObject({ code: 'ERR_WEBRTC_DIRECT_TIMEOUT', stage: 'dial' })
    } finally {
      vi.useRealTimers()
    }
  })

  it('aborts a connection that resolves after the dial timeout', async () => {
    vi.useFakeTimers()
    try {
      let resolveDial: ((connection: any) => void) | undefined
      const pendingDial = new Promise<any>(resolve => { resolveDial = resolve })
      const node = { dial: vi.fn(() => pendingDial) }
      const pending = dialAuthenticatedWebRTCDirect(node as any, endpoint, { publicKey: endpoint.publicKey, timeoutMs: 10 })
      const result = pending.then(() => undefined, error => error)
      await vi.advanceTimersByTimeAsync(10)
      await expect(result).resolves.toMatchObject({ code: 'ERR_WEBRTC_DIRECT_TIMEOUT', stage: 'dial' })

      const abort = vi.fn()
      resolveDial?.({ remotePeer: endpoint.peerId, close: vi.fn(async () => {}), abort })
      await Promise.resolve()
      await Promise.resolve()
      expect(abort).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not start a dial when the caller signal is already aborted', async () => {
    const controller = new AbortController()
    controller.abort(new Error('already cancelled'))
    const node = { dial: vi.fn() }
    await expect(dialAuthenticatedWebRTCDirect(node as any, endpoint, {
      publicKey: endpoint.publicKey,
      signal: controller.signal
    })).rejects.toMatchObject({ code: 'ERR_WEBRTC_DIRECT_TIMEOUT', stage: 'dial' })
    expect(node.dial).not.toHaveBeenCalled()
  })

  it('does not require a transport fallback when node.dial rejects', async () => {
    const node = { dial: vi.fn(async () => { throw new Error('no direct route') }) }
    await expect(dialAuthenticatedWebRTCDirect(node as any, endpoint, { peerId: endpoint.peerId, timeoutMs: 100 }))
      .rejects.toMatchObject({ code: 'ERR_WEBRTC_DIRECT_DIAL', stage: 'dial' })
    expect(node.dial).toHaveBeenCalledTimes(1)
  })

  it('accepts a string PeerId pin', async () => {
    const close = vi.fn(async () => {})
    const node = { dial: vi.fn(async () => ({ remotePeer: endpoint.peerId, close })) }
    await expect(dialAuthenticatedWebRTCDirect(node as any, endpoint, { peerId: endpoint.peerId.toString(), timeoutMs: 100 })).resolves.toMatchObject({
      endpoint: { address: multiaddr(endpoint.address.toString()) }
    })
  })
})
