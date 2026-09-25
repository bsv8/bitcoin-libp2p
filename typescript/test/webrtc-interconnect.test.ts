import type { PeerId, Stream } from '@libp2p/interface'
import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { RTCIceCandidate, RTCPeerConnection, RTCSessionDescription } from 'node-datachannel/polyfill'
import {
  buildWebRTCInterconnectAddress,
  createWebRTCInterconnectDialer,
  createWebRTCInterconnectHost,
  dialWebRTCInterconnect,
  parseWebRTCInterconnectAddress,
  validateWebRTCInterconnectEnvelope,
  WebRTCInterconnectError,
  type WebRTCInterconnectConnectionEvent,
  type WebRTCInterconnectEnvelope,
  type WebRTCInterconnectSignalingAdapter
} from '../src/webrtc-interconnect/index.js'
import { createHost } from '../src/libp2p/index.js'
import { LocalSigner } from '../src/signer/index.js'
import { peerIdFromPublicKeyBytes, publicKeyFromPeerId } from '../src/identity/index.js'
import { readStreamToEnd } from '../src/stream/index.js'

Object.assign(globalThis, { RTCPeerConnection, RTCSessionDescription, RTCIceCandidate })

function signer (value: number): LocalSigner {
  const raw = new Uint8Array(32)
  raw[31] = value
  return new LocalSigner(raw)
}

class MemorySignaling implements WebRTCInterconnectSignalingAdapter {
  readonly handlers = new Set<(signal: WebRTCInterconnectEnvelope) => void>()
  target?: MemorySignaling

  subscribe (handler: (signal: WebRTCInterconnectEnvelope) => void): () => void {
    this.handlers.add(handler)
    return () => { this.handlers.delete(handler) }
  }

  async send (signal: WebRTCInterconnectEnvelope): Promise<void> {
    this.target?.deliver(signal)
  }

  deliver (signal: WebRTCInterconnectEnvelope): void {
    const copy = structuredClone(signal)
    for (const handler of this.handlers) queueMicrotask(() => { handler(copy) })
  }
}

class ReorderingSignaling extends MemorySignaling {
  private pendingOffer?: WebRTCInterconnectEnvelope
  private offerTimer?: ReturnType<typeof setTimeout>
  reordered = false

  override async send (signal: WebRTCInterconnectEnvelope): Promise<void> {
    if (signal.signal.type === 'offer') {
      this.pendingOffer = signal
      this.offerTimer = setTimeout(() => { this.flushOffer() }, 10)
      return
    }
    if (this.pendingOffer != null && (signal.signal.type === 'ice-candidate' || signal.signal.type === 'end-of-candidates')) {
      this.reordered = true
      const offer = this.pendingOffer
      this.pendingOffer = undefined
      if (this.offerTimer != null) {
        clearTimeout(this.offerTimer)
        this.offerTimer = undefined
      }
      await super.send(signal)
      if (offer != null) this.target?.deliver(offer)
      return
    }
    await super.send(signal)
  }

  private flushOffer (): void {
    const offer = this.pendingOffer
    this.pendingOffer = undefined
    if (this.offerTimer != null) {
      clearTimeout(this.offerTimer)
      this.offerTimer = undefined
    }
    if (offer != null) this.target?.deliver(offer)
  }
}

function envelope (overrides: Partial<WebRTCInterconnectEnvelope> = {}): WebRTCInterconnectEnvelope {
  const identity = signer(1)
  const peerId = peerIdFromPublicKeyBytes(identity.publicKey())
  return {
    connectionId: 'connection-1',
    attemptId: 'attempt-1',
    from: peerId.toString(),
    to: peerId.toString(),
    sequence: 0,
    expiresAtMs: Date.now() + 60_000,
    signal: { type: 'offer', sdp: 'v=0\r\n' },
    ...overrides
  }
}

function peerEnvelope (localPeerId: PeerId, remotePeerId: PeerId, overrides: Partial<WebRTCInterconnectEnvelope> = {}): WebRTCInterconnectEnvelope {
  return envelope({ from: remotePeerId.toString(), to: localPeerId.toString(), ...overrides })
}

async function flushMicrotasks (): Promise<void> {
  await new Promise<void>(resolve => queueMicrotask(resolve))
  await Promise.resolve()
}

function createBareTransport (signaling: MemorySignaling, options: { maxEarlySignals?: number, signalLifetimeMs?: number } = {}) {
  const localPeerId = peerIdFromPublicKeyBytes(signer(1).publicKey())
  const dialer = createWebRTCInterconnectDialer({
    signaling,
    rtcConfiguration: { iceServers: [] },
    ...options
  })
  const transport = dialer.transport({
    peerId: localPeerId,
    upgrader: {},
    logger: { forComponent: () => ({ error: () => {} }) },
    events: new EventTarget()
  } as any)
  return { dialer, localPeerId, transport }
}

async function send (stream: Stream, data: Uint8Array): Promise<void> {
  if (stream.send(data)) return
  await new Promise<void>((resolve, reject) => {
    const onDrain = (): void => {
      stream.removeEventListener('drain', onDrain)
      resolve()
    }
    const onClose = (): void => {
      stream.removeEventListener('drain', onDrain)
      reject(new Error('stream closed while waiting for drain'))
    }
    stream.addEventListener('drain', onDrain)
    stream.addEventListener('close', onClose)
  })
}

describe('WebRTC interconnect public boundary', () => {
  it('builds and parses only the external WebRTC address form', () => {
    const identity = signer(1)
    const peerId = peerIdFromPublicKeyBytes(identity.publicKey())
    const address = buildWebRTCInterconnectAddress(peerId)
    expect(address.toString()).toBe(`/webrtc/p2p/${peerId.toString()}`)
    expect(parseWebRTCInterconnectAddress(address).peerId.equals(peerId)).toBe(true)
    expect(() => parseWebRTCInterconnectAddress(`/webrtc/p2p/${peerId.toString()}/certhash/x`)).toThrowError(WebRTCInterconnectError)
  })

  it('validates signal envelope size, identity and expiry', () => {
    const valid = envelope()
    expect(validateWebRTCInterconnectEnvelope(valid).signal.type).toBe('offer')
    expect(() => validateWebRTCInterconnectEnvelope({ ...valid, expiresAtMs: Date.now() - 1 })).toThrowError(/expired/)
    expect(() => validateWebRTCInterconnectEnvelope({ ...valid, signal: { type: 'offer', sdp: 'x'.repeat(300_000) } })).toThrowError(/size/)
    expect(() => validateWebRTCInterconnectEnvelope({ ...valid, from: 'not-a-peer' })).toThrowError(/peer id/)
  })

  it('does not couple the SDK boundary to SatSubscription or Circuit Relay', () => {
    const source = readFileSync(new URL('../src/webrtc-interconnect/index.ts', import.meta.url), 'utf8')
    expect(source).not.toMatch(/SatSubscription|ChannelProtocol|@libp2p\/circuit-relay-v2/)
  })

  it('validates early signal memory limits', () => {
    const signaling = new MemorySignaling()
    expect(() => createWebRTCInterconnectDialer({ signaling, maxEarlySignals: 0 })).toThrow(/maxEarlySignals/)
    expect(() => createWebRTCInterconnectDialer({ signaling, signalLifetimeMs: 0 })).toThrow(/signalLifetimeMs/)
  })
})

describe('external signaling WebRTC transport', () => {
  it('maps post-dial authentication failures and aborts without notifying', async () => {
    const signaling = new MemorySignaling()
    const { dialer, transport } = createBareTransport(signaling)
    await transport.start()
    const expectedPeerId = peerIdFromPublicKeyBytes(signer(2).publicKey())
    const authCause = new Error('post-dial authentication failure')
    const abort = vi.fn()
    const close = vi.fn(async () => {})
    const connection = {
      get remotePeer (): never { throw authCause },
      remoteAddr: buildWebRTCInterconnectAddress(expectedPeerId),
      abort,
      close
    }
    const node = { dial: vi.fn(async () => connection) }
    const observed: WebRTCInterconnectConnectionEvent[] = []
    const stopObserving = dialer.onConnection(event => { observed.push(event) })
    try {
      const error = await dialer.dial(node as any, {
        remotePeerId: expectedPeerId,
        publicKey: publicKeyFromPeerId(expectedPeerId),
        timeoutMs: 1_000
      }).then(() => undefined, value => value as WebRTCInterconnectError)
      expect(error).toMatchObject({ code: 'ERR_WEBRTC_INTERCONNECT_AUTH', stage: 'authenticate' })
      expect(error?.cause).toBe(authCause)
      expect(abort).toHaveBeenCalledTimes(1)
      expect(close).not.toHaveBeenCalled()
      expect(observed).toHaveLength(0)
    } finally {
      stopObserving()
      await transport.stop()
    }
  })

  it('aborts a connection that resolves after the caller aborts', async () => {
    const signaling = new MemorySignaling()
    const { dialer, transport } = createBareTransport(signaling)
    await transport.start()
    const remotePeerId = peerIdFromPublicKeyBytes(signer(2).publicKey())
    let resolveDial: ((connection: any) => void) | undefined
    const pendingDial = new Promise<any>(resolve => { resolveDial = resolve })
    const abort = vi.fn()
    const connection = {
      remotePeer: remotePeerId,
      remoteAddr: buildWebRTCInterconnectAddress(remotePeerId),
      abort,
      close: vi.fn(async () => {})
    }
    const node = { dial: vi.fn(() => pendingDial) }
    const controller = new AbortController()
    const observed: WebRTCInterconnectConnectionEvent[] = []
    const stopObserving = dialer.onConnection(event => { observed.push(event) })
    try {
      const pending = dialer.dial(node as any, {
        remotePeerId,
        publicKey: publicKeyFromPeerId(remotePeerId),
        timeoutMs: 1_000,
        signal: controller.signal
      }).then(() => undefined, value => value as WebRTCInterconnectError)
      controller.abort(new Error('caller cancelled'))
      const error = await pending
      expect(error).toMatchObject({ code: 'ERR_WEBRTC_INTERCONNECT_TIMEOUT', stage: 'dial' })
      resolveDial?.(connection)
      await flushMicrotasks()
      expect(abort).toHaveBeenCalledTimes(1)
      expect(observed).toHaveLength(0)
    } finally {
      stopObserving()
      await transport.stop()
    }
  })

  it('replays ICE candidates delivered before a responder offer', async () => {
    const buyerSignaling = new ReorderingSignaling()
    const sellerSignaling = new MemorySignaling()
    buyerSignaling.target = sellerSignaling
    sellerSignaling.target = buyerSignaling
    const buyer = await createWebRTCInterconnectHost({ signer: signer(1), signaling: buyerSignaling, rtcConfiguration: { iceServers: [] } })
    const seller = await createWebRTCInterconnectHost({ signer: signer(2), signaling: sellerSignaling, rtcConfiguration: { iceServers: [] } })
    try {
      const result = await dialWebRTCInterconnect(buyer, {
        remotePeerId: seller.peerId,
        publicKey: publicKeyFromPeerId(seller.peerId),
        timeoutMs: 10_000
      })
      expect(buyerSignaling.reordered).toBe(true)
      expect(result.connection.status).toBe('open')
    } finally {
      await buyer.stop()
      await seller.stop()
    }
  }, 30_000)

  it('bounds early signals globally and per connection', async () => {
    const signaling = new MemorySignaling()
    const { localPeerId, transport } = createBareTransport(signaling, { maxEarlySignals: 3 })
    await transport.start()
    const remotePeerId = peerIdFromPublicKeyBytes(signer(2).publicKey())
    const earlySignals = (transport as any).earlySignals as Map<string, unknown[]>
    try {
      for (let index = 0; index < 5; index += 1) {
        signaling.deliver(peerEnvelope(localPeerId, remotePeerId, {
          connectionId: `global-${index}`,
          sequence: index,
          signal: { type: 'ice-candidate', candidate: { candidate: `candidate:${index}` } }
        }))
      }
      await flushMicrotasks()
      expect([...earlySignals.values()].reduce((total, queue) => total + queue.length, 0)).toBe(3)
    } finally {
      await transport.stop()
    }

    const perConnectionSignaling = new MemorySignaling()
    const perConnection = createBareTransport(perConnectionSignaling, { maxEarlySignals: 100 })
    await perConnection.transport.start()
    const perConnectionSignals = (perConnection.transport as any).earlySignals as Map<string, unknown[]>
    try {
      for (let index = 0; index < 40; index += 1) {
        perConnectionSignaling.deliver(peerEnvelope(perConnection.localPeerId, remotePeerId, {
          connectionId: 'per-connection',
          sequence: index,
          signal: { type: 'ice-candidate', candidate: { candidate: `candidate:${index}` } }
        }))
      }
      await flushMicrotasks()
      expect(perConnectionSignals.get('per-connection')).toHaveLength(32)
    } finally {
      await perConnection.transport.stop()
    }
  })

  it('prunes early signals using the local lifetime', async () => {
    vi.useFakeTimers()
    const signaling = new MemorySignaling()
    const { localPeerId, transport } = createBareTransport(signaling, { signalLifetimeMs: 25 })
    await transport.start()
    const remotePeerId = peerIdFromPublicKeyBytes(signer(2).publicKey())
    const earlySignals = (transport as any).earlySignals as Map<string, unknown[]>
    try {
      signaling.deliver(peerEnvelope(localPeerId, remotePeerId, {
        connectionId: 'ttl',
        signal: { type: 'ice-candidate', candidate: { candidate: 'candidate:ttl' } }
      }))
      await flushMicrotasks()
      expect(earlySignals.get('ttl')).toHaveLength(1)
      await vi.advanceTimersByTimeAsync(26)
      expect(earlySignals.has('ttl')).toBe(false)
    } finally {
      await transport.stop()
      vi.useRealTimers()
    }
  })

  it('can attach the transport factory to an existing libp2p host', async () => {
    const buyerSignaling = new MemorySignaling()
    const sellerSignaling = new MemorySignaling()
    buyerSignaling.target = sellerSignaling
    sellerSignaling.target = buyerSignaling
    const setupTimeoutMs = 5_000
    const buyerDialer = createWebRTCInterconnectDialer({ signaling: buyerSignaling, connectionTimeoutMs: setupTimeoutMs, rtcConfiguration: { iceServers: [] } })
    const sellerDialer = createWebRTCInterconnectDialer({ signaling: sellerSignaling, connectionTimeoutMs: setupTimeoutMs, rtcConfiguration: { iceServers: [] } })
    const buyer = await createHost({ signer: signer(1), transports: [buyerDialer.transport], listenAddrs: [], connectionGater: { denyDialMultiaddr: async () => false } })
    const seller = await createHost({ signer: signer(2), transports: [sellerDialer.transport], listenAddrs: [], connectionGater: { denyDialMultiaddr: async () => false } })
    const observed: WebRTCInterconnectConnectionEvent[] = []
    const sellerObserved: WebRTCInterconnectConnectionEvent[] = []
    const stopObserving = buyerDialer.onConnection(event => { observed.push(event) })
    const stopSellerObserving = sellerDialer.onConnection(event => { sellerObserved.push(event) })
    try {
      const received = new Promise<Uint8Array>((resolve, reject) => {
        seller.handle('/bitcoin-libp2p/test/interconnect-existing/1.0.0', async stream => {
          try { resolve(await readStreamToEnd(stream, { maxBytes: 1024, timeoutMs: 30_000 })) } catch (error) { reject(error) }
        }).catch(reject)
      })
      const result = await buyerDialer.dial(buyer, { remotePeerId: seller.peerId, publicKey: publicKeyFromPeerId(seller.peerId), timeoutMs: setupTimeoutMs })
      const stream = await result.connection.newStream('/bitcoin-libp2p/test/interconnect-existing/1.0.0')
      await send(stream, new Uint8Array([1, 2, 3]))
      await stream.close()
      expect(await received).toEqual(new Uint8Array([1, 2, 3]))
      expect(observed).toHaveLength(1)
      expect(observed[0]?.role).toBe('initiator')
      expect(observed[0]?.connection).toBe(result.connection)
      expect(observed[0]?.remotePeerId.equals(seller.peerId)).toBe(true)
      expect(sellerObserved).toHaveLength(1)
      expect(sellerObserved[0]?.role).toBe('responder')
      expect(sellerObserved[0]?.connection).toBeDefined()
      expect(sellerObserved[0]?.remotePeerId.equals(buyer.peerId)).toBe(true)
      // Both setup deadlines have elapsed; established sessions must stay usable.
      await new Promise(resolve => setTimeout(resolve, setupTimeoutMs + 100))
      expect(result.connection.status).toBe('open')
      expect(sellerObserved[0]?.connection.status).toBe('open')
      const secondReceived = new Promise<Uint8Array>((resolve, reject) => {
        seller.handle('/bitcoin-libp2p/test/interconnect-after-timeout/1.0.0', async stream => {
          try { resolve(await readStreamToEnd(stream, { maxBytes: 1024, timeoutMs: 5_000 })) } catch (error) { reject(error) }
        }).catch(reject)
      })
      const secondStream = await result.connection.newStream('/bitcoin-libp2p/test/interconnect-after-timeout/1.0.0')
      await send(secondStream, new Uint8Array([4, 5, 6]))
      await secondStream.close()
      expect(await secondReceived).toEqual(new Uint8Array([4, 5, 6]))
    } finally {
      stopObserving()
      stopSellerObserving()
      await buyer.stop()
      await seller.stop()
    }
  }, 60_000)

  it('establishes a standard libp2p stream and transfers a large payload', async () => {
    const buyerSignaling = new MemorySignaling()
    const sellerSignaling = new MemorySignaling()
    buyerSignaling.target = sellerSignaling
    sellerSignaling.target = buyerSignaling
    const buyer = await createWebRTCInterconnectHost({ signer: signer(1), signaling: buyerSignaling, rtcConfiguration: { iceServers: [] } })
    const seller = await createWebRTCInterconnectHost({ signer: signer(2), signaling: sellerSignaling, rtcConfiguration: { iceServers: [] } })
    try {
      const received = new Promise<Uint8Array>((resolve, reject) => {
        seller.handle('/bitcoin-libp2p/test/interconnect/1.0.0', async stream => {
          try {
            resolve(await readStreamToEnd(stream, { maxBytes: 4 * 1024 * 1024, timeoutMs: 30_000 }))
          } catch (error) {
            reject(error)
          }
        }).catch(reject)
      })
      const sellerPublicKey = publicKeyFromPeerId(seller.peerId)
      const result = await dialWebRTCInterconnect(buyer, { remotePeerId: seller.peerId, publicKey: sellerPublicKey, timeoutMs: 30_000 })
      const stream = await result.connection.newStream('/bitcoin-libp2p/test/interconnect/1.0.0')
      const payload = new Uint8Array(1024 * 1024)
      for (let index = 0; index < payload.length; index += 1) payload[index] = index & 0xff
      await send(stream, payload)
      await stream.close()
      const bytes = await received
      expect(bytes).toEqual(payload)
      await new Promise(resolve => setTimeout(resolve, 250))
      expect(result.connection.status).toBe('open')
      expect(result.connection.remoteAddr.toString()).toContain('/webrtc/p2p/')
    } finally {
      await buyer.stop()
      await seller.stop()
    }
  }, 60_000)
})
