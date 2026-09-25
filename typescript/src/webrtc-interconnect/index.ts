import { serviceCapabilities, serviceDependencies, transportSymbol, type ComponentLogger, type Connection, type DialTransportOptions, type Libp2p, type Listener, type PeerId, type Transport, type Upgrader } from '@libp2p/interface'
import { AbstractMultiaddrConnection } from '@libp2p/utils'
import { multiaddr, type Multiaddr } from '@multiformats/multiaddr'
import { peerIdFromString } from '@libp2p/peer-id'
import { yamux } from '@chainsafe/libp2p-yamux'
import { publicKeyFromPeerId, publicKeyObject, validatePublicKey } from '../identity/index.js'
import { authenticateConnection, createHost, type AuthenticatedPeer, type HostConfig } from '../libp2p/index.js'
import type { DataChannelOptions } from '@libp2p/webrtc'

const DEFAULT_SIGNAL_LIFETIME_MS = 120_000
const DEFAULT_MAX_EARLY_SIGNALS = 1024
const DEFAULT_MAX_EARLY_SIGNALS_PER_CONNECTION = 32
const DEFAULT_CONNECTION_TIMEOUT_MS = 30_000
const DEFAULT_MAX_SIGNAL_BYTES = 256 * 1024
const DEFAULT_MAX_MESSAGE_BYTES = 16 * 1024
const DEFAULT_MAX_BUFFERED_AMOUNT = 2 * 1024 * 1024
const DEFAULT_CONNECTION_CLOSE_TIMEOUT_MS = 1_000
const DATA_CHANNEL_LABEL = 'bitcoin-libp2p-webrtc'

type TransportDirection = 'inbound' | 'outbound'

export type WebRTCInterconnectSignalRole = 'initiator' | 'responder'

export type WebRTCInterconnectErrorStage = 'validate' | 'signal' | 'dial' | 'connect' | 'authenticate' | 'shutdown'

export type WebRTCInterconnectErrorCode =
  | 'ERR_WEBRTC_INTERCONNECT_ADDRESS'
  | 'ERR_WEBRTC_INTERCONNECT_SIGNAL'
  | 'ERR_WEBRTC_INTERCONNECT_TIMEOUT'
  | 'ERR_WEBRTC_INTERCONNECT_DIAL'
  | 'ERR_WEBRTC_INTERCONNECT_AUTH'
  | 'ERR_WEBRTC_INTERCONNECT_NOT_CONFIGURED'
  | 'ERR_WEBRTC_INTERCONNECT_SHUTDOWN'

export class WebRTCInterconnectError extends Error {
  readonly code: WebRTCInterconnectErrorCode
  readonly stage: WebRTCInterconnectErrorStage

  constructor (code: WebRTCInterconnectErrorCode, stage: WebRTCInterconnectErrorStage, message: string, options: { cause?: unknown } = {}) {
    super(message, { cause: options.cause })
    this.name = 'WebRTCInterconnectError'
    this.code = code
    this.stage = stage
  }
}

export interface WebRTCInterconnectIceCandidate {
  candidate: string
  sdpMid?: string | null
  sdpMLineIndex?: number | null
  usernameFragment?: string | null
}

export type WebRTCInterconnectSignal =
  | { type: 'offer', sdp: string }
  | { type: 'answer', sdp: string }
  | { type: 'ice-candidate', candidate: WebRTCInterconnectIceCandidate | null }
  | { type: 'end-of-candidates' }
  | { type: 'close', reason?: string }

export interface WebRTCInterconnectEnvelope {
  connectionId: string
  attemptId: string
  from: string
  to: string
  sequence: number
  expiresAtMs: number
  signal: WebRTCInterconnectSignal
}

export interface WebRTCInterconnectSignalingAdapter {
  send(signal: WebRTCInterconnectEnvelope): Promise<void> | void
  subscribe(listener: (signal: WebRTCInterconnectEnvelope) => void): () => void
}

export interface WebRTCInterconnectTransportOptions {
  signaling: WebRTCInterconnectSignalingAdapter
  rtcConfiguration?: RTCConfiguration | (() => RTCConfiguration | Promise<RTCConfiguration>)
  dataChannel?: DataChannelOptions
  connectionTimeoutMs?: number
  signalLifetimeMs?: number
  maxEarlySignals?: number
  maxSignalBytes?: number
}

export interface WebRTCInterconnectTransportComponents {
  peerId: PeerId
  upgrader: Upgrader
  logger: ComponentLogger
  events: {
    addEventListener(type: 'connection:open', listener: (event: CustomEvent<Connection>) => void): void
    removeEventListener(type: 'connection:open', listener: (event: CustomEvent<Connection>) => void): void
  }
}

export interface WebRTCInterconnectConnectionEvent {
  connection: Connection
  remotePeerId: PeerId
  connectionId: string
  attemptId: string
  role: WebRTCInterconnectSignalRole
}

export interface WebRTCInterconnectDialer {
  readonly transport: (components: WebRTCInterconnectTransportComponents) => Transport
  dial(node: Libp2p, input: DialWebRTCInterconnectInput): Promise<DialWebRTCInterconnectResult>
  onConnection(listener: (event: WebRTCInterconnectConnectionEvent) => void): () => void
}

export interface CreateWebRTCInterconnectHostConfig extends Omit<HostConfig, 'transports' | 'listenAddrs'> {
  signaling: WebRTCInterconnectSignalingAdapter
  rtcConfiguration?: RTCConfiguration | (() => RTCConfiguration | Promise<RTCConfiguration>)
  dataChannel?: DataChannelOptions
  connectionTimeoutMs?: number
  signalLifetimeMs?: number
  maxEarlySignals?: number
  maxSignalBytes?: number
}

export interface DialWebRTCInterconnectInput {
  remotePeerId: PeerId | string
  publicKey?: Uint8Array
  peerId?: PeerId | string
  connectionId?: string
  attemptId?: string
  timeoutMs?: number
  signal?: AbortSignal
}

export interface DialWebRTCInterconnectResult {
  connection: Connection
  authenticatedPeer: AuthenticatedPeer
  remotePeerId: PeerId
  connectionId: string
  attemptId: string
}

interface DialContext {
  connectionId: string
  attemptId: string
  remotePeerId: PeerId
  timeoutMs: number
  publicKey?: Uint8Array
  peerId?: PeerId
}

interface BufferedEarlySignal {
  envelope: WebRTCInterconnectEnvelope
  expiresAtMs: number
}

type TransportComponents = WebRTCInterconnectTransportComponents

interface Deferred<T> {
  promise: Promise<T>
  resolve(value: T): void
  reject(error: Error): void
}

interface PeerAddress {
  peerId: PeerId
  address: Multiaddr
}

const transports = new WeakMap<object, ExternalWebRTCTransport>()

export function buildWebRTCInterconnectAddress (remotePeerId: PeerId | string): Multiaddr {
  const peerId = parseTargetPeerId(remotePeerId)
  return multiaddr(`/webrtc/p2p/${peerId.toString()}`)
}

export function parseWebRTCInterconnectAddress (address: Multiaddr | string): PeerAddress {
  const parsed = typeof address === 'string' ? multiaddr(address) : multiaddr(address.toString())
  const components = parsed.getComponents()
  if (components.length !== 2 || components[0]?.name !== 'webrtc' || components[1]?.name !== 'p2p' || components[1].value == null) {
    throw interconnectError('ERR_WEBRTC_INTERCONNECT_ADDRESS', 'validate', 'WebRTC interconnect address must be /webrtc/p2p/<peer-id>')
  }
  return { peerId: parseTargetPeerId(components[1].value), address: parsed }
}

export function validateWebRTCInterconnectEnvelope (raw: WebRTCInterconnectEnvelope, maxSignalBytes = DEFAULT_MAX_SIGNAL_BYTES): WebRTCInterconnectEnvelope {
  return validateEnvelope(raw, maxSignalBytes)
}

export function createWebRTCInterconnectTransport (options: WebRTCInterconnectTransportOptions): (components: TransportComponents) => Transport {
  return createWebRTCInterconnectDialer(options).transport
}

export function createWebRTCInterconnectDialer (options: WebRTCInterconnectTransportOptions): WebRTCInterconnectDialer {
  validateSignalingAdapter(options.signaling)
  validateEarlySignalOptions(options)
  let transport: ExternalWebRTCTransport | undefined
  const connectionListeners = new Set<(event: WebRTCInterconnectConnectionEvent) => void>()
  const factory = (components: TransportComponents): Transport => {
    transport = new ExternalWebRTCTransport(components, options, event => {
      for (const listener of connectionListeners) {
        try { listener(event) } catch (error) { components.logger.forComponent('webrtc-interconnect').error('WebRTC interconnect connection listener failed: %s', errorCode(error)) }
      }
    })
    return transport
  }
  return {
    transport: factory,
    async dial(node, input) {
      if (transport == null) throw interconnectError('ERR_WEBRTC_INTERCONNECT_NOT_CONFIGURED', 'validate', 'WebRTC interconnect transport was not created')
      return await dialWithTransport(node, transport, input)
    },
    onConnection(listener) {
      connectionListeners.add(listener)
      return () => { connectionListeners.delete(listener) }
    }
  }
}

export async function createWebRTCInterconnectHost (config: CreateWebRTCInterconnectHostConfig): Promise<Libp2p> {
  const {
    signaling,
    rtcConfiguration,
    dataChannel,
    connectionTimeoutMs,
    signalLifetimeMs,
    maxEarlySignals,
    maxSignalBytes,
    ...hostConfig
  } = config
  validateSignalingAdapter(signaling)
  validateEarlySignalOptions({ signalLifetimeMs, maxEarlySignals })
  let transport: ExternalWebRTCTransport | undefined
  const node = await createHost({
    ...hostConfig,
    listenAddrs: [],
    transports: [components => {
      transport = new ExternalWebRTCTransport(components, {
        signaling,
        ...(rtcConfiguration === undefined ? {} : { rtcConfiguration }),
        ...(dataChannel === undefined ? {} : { dataChannel }),
        ...(connectionTimeoutMs === undefined ? {} : { connectionTimeoutMs }),
        ...(signalLifetimeMs === undefined ? {} : { signalLifetimeMs }),
        ...(maxEarlySignals === undefined ? {} : { maxEarlySignals }),
        ...(maxSignalBytes === undefined ? {} : { maxSignalBytes })
      })
      return transport
    }]
  })
  if (transport == null) {
    await node.stop()
    throw interconnectError('ERR_WEBRTC_INTERCONNECT_NOT_CONFIGURED', 'validate', 'WebRTC interconnect transport was not created')
  }
  transports.set(node, transport)
  return node
}

export async function dialWebRTCInterconnect (node: Libp2p, input: DialWebRTCInterconnectInput): Promise<DialWebRTCInterconnectResult> {
  const transport = transports.get(node)
  if (transport == null) {
    throw interconnectError('ERR_WEBRTC_INTERCONNECT_NOT_CONFIGURED', 'validate', 'node was not created by createWebRTCInterconnectHost')
  }
  return await dialWithTransport(node, transport, input)
}

async function dialWithTransport (node: Libp2p, transport: ExternalWebRTCTransport, input: DialWebRTCInterconnectInput): Promise<DialWebRTCInterconnectResult> {
  const remotePeerId = parseTargetPeerId(input.remotePeerId)
  const expectedPeerId = input.peerId == null ? undefined : parsePeerId(input.peerId)
  const expectedPublicKey = input.publicKey == null ? undefined : validatePublicKey(input.publicKey)
  if (expectedPeerId != null && !expectedPeerId.equals(remotePeerId)) {
    throw interconnectError('ERR_WEBRTC_INTERCONNECT_AUTH', 'validate', 'requested peer id does not match remote peer id')
  }
  if (expectedPublicKey != null && !equalBytes(expectedPublicKey, publicKeyFromPeerId(remotePeerId))) {
    throw interconnectError('ERR_WEBRTC_INTERCONNECT_AUTH', 'validate', 'requested public key does not match remote peer id')
  }
  const connectionId = validateIdentifier(input.connectionId ?? `webrtc-${crypto.randomUUID()}`, 'connectionId')
  const attemptId = validateIdentifier(input.attemptId ?? crypto.randomUUID(), 'attemptId')
  const timeoutMs = positiveInteger(input.timeoutMs ?? DEFAULT_CONNECTION_TIMEOUT_MS, 'timeoutMs')
  const address = buildWebRTCInterconnectAddress(remotePeerId)
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  const onAbort = (): void => controller.abort(input.signal?.reason ?? new DOMException('The operation was aborted', 'AbortError'))
  input.signal?.addEventListener('abort', onAbort, { once: true })
  if (input.signal?.aborted === true) onAbort()
  const context: DialContext = {
    connectionId,
    attemptId,
    remotePeerId,
    timeoutMs,
    ...(expectedPublicKey == null ? {} : { publicKey: expectedPublicKey }),
    ...(expectedPeerId == null ? {} : { peerId: expectedPeerId })
  }
  try {
    if (controller.signal.aborted) throw dialTimeoutError(controller.signal.reason)
    timer = setTimeout(() => controller.abort(new DOMException('WebRTC interconnect dial timed out', 'TimeoutError')), timeoutMs)
    transport.queueDial(context)
    const dialPromise = Promise.resolve(node.dial(address, { signal: controller.signal })).then(async connection => {
      if (controller.signal.aborted) {
        await closeConnectionQuietly(connection, controller.signal.reason)
        throw dialTimeoutError(controller.signal.reason)
      }
      return connection
    })
    const connection = await raceWithAbort(dialPromise, controller.signal)
    if (controller.signal.aborted) {
      await closeConnectionQuietly(connection, controller.signal.reason)
      throw dialTimeoutError(controller.signal.reason)
    }
    let authenticatedPeer: AuthenticatedPeer
    try {
      authenticatedPeer = authenticateConnection(connection, {
        ...(expectedPublicKey == null ? {} : { publicKey: expectedPublicKey }),
        peerId: remotePeerId
      })
    } catch (error) {
      await closeConnectionQuietly(connection, error)
      throw interconnectError('ERR_WEBRTC_INTERCONNECT_AUTH', 'authenticate', 'WebRTC interconnect connection authentication failed', { cause: error })
    }
    if (controller.signal.aborted) {
      await closeConnectionQuietly(connection, controller.signal.reason)
      throw dialTimeoutError(controller.signal.reason)
    }
    transport.notifyConnection({
      connection,
      remotePeerId,
      connectionId,
      attemptId,
      role: 'initiator'
    })
    return { connection, authenticatedPeer, remotePeerId, connectionId, attemptId }
  } catch (error) {
    if (error instanceof WebRTCInterconnectError) throw error
    if (controller.signal.aborted) {
      throw interconnectError('ERR_WEBRTC_INTERCONNECT_TIMEOUT', 'dial', 'WebRTC interconnect dial timed out or was aborted', { cause: error })
    }
    throw interconnectError('ERR_WEBRTC_INTERCONNECT_DIAL', 'dial', 'WebRTC interconnect dial failed', { cause: error })
  } finally {
    transport.removeDial(context)
    if (timer != null) clearTimeout(timer)
    input.signal?.removeEventListener('abort', onAbort)
  }
}

class ExternalWebRTCTransport implements Transport {
  readonly [Symbol.toStringTag] = 'bitcoin-libp2p/webrtc-interconnect'
  readonly [transportSymbol] = true as const
  readonly [serviceCapabilities] = ['@libp2p/transport']
  readonly [serviceDependencies]: string[] = []

  readonly components: TransportComponents
  readonly options: WebRTCInterconnectTransportOptions
  private readonly sessions = new Map<string, ExternalWebRTCSession>()
  private readonly earlySignals = new Map<string, BufferedEarlySignal[]>()
  private readonly completedAttempts = new Map<string, { attemptId: string, expiresAtMs: number }>()
  private readonly pendingDials = new Map<string, DialContext[]>()
  private readonly maxEarlySignals: number
  private readonly maxEarlySignalsPerConnection: number
  private readonly signalLifetimeMs: number
  private readonly onConnection?: (event: WebRTCInterconnectConnectionEvent) => void
  private unsubscribe?: () => void
  private earlySignalCleanupTimer?: ReturnType<typeof setTimeout>
  private earlySignalCount = 0
  private started = false

  constructor (components: TransportComponents, options: WebRTCInterconnectTransportOptions, onConnection?: (event: WebRTCInterconnectConnectionEvent) => void) {
    this.components = components
    this.options = options
    this.maxEarlySignals = positiveInteger(options.maxEarlySignals === undefined ? DEFAULT_MAX_EARLY_SIGNALS : options.maxEarlySignals, 'maxEarlySignals')
    this.maxEarlySignalsPerConnection = Math.min(DEFAULT_MAX_EARLY_SIGNALS_PER_CONNECTION, this.maxEarlySignals)
    this.signalLifetimeMs = positiveInteger(options.signalLifetimeMs === undefined ? DEFAULT_SIGNAL_LIFETIME_MS : options.signalLifetimeMs, 'signalLifetimeMs')
    this.onConnection = onConnection
  }

  isStarted (): boolean {
    return this.started
  }

  async start (): Promise<void> {
    if (this.started) return
    this.started = true
    try {
      this.unsubscribe = this.options.signaling.subscribe(signal => {
        void this.receive(signal).catch(error => {
          this.components.logger.forComponent('webrtc-interconnect').error('WebRTC interconnect signal failed: %s', errorCode(error))
        })
      })
    } catch (error) {
      this.started = false
      throw error
    }
    this.scheduleEarlySignalCleanup()
  }

  async stop (): Promise<void> {
    this.started = false
    this.unsubscribe?.()
    this.unsubscribe = undefined
    if (this.earlySignalCleanupTimer != null) {
      clearTimeout(this.earlySignalCleanupTimer)
      this.earlySignalCleanupTimer = undefined
    }
    const sessions = [...this.sessions.values()]
    this.sessions.clear()
    this.earlySignals.clear()
    this.completedAttempts.clear()
    this.earlySignalCount = 0
    await Promise.all(sessions.map(session => session.close(false)))
  }

  createListener (_options: { upgrader: Upgrader }): Listener {
    const listener = new EventTarget()
    return Object.assign(listener, {
      listen: async () => {},
      getAddrs: () => [],
      updateAnnounceAddrs: () => {},
      close: async () => {}
    }) as unknown as Listener
  }

  listenFilter (_multiaddrs: Multiaddr[]): Multiaddr[] {
    return []
  }

  dialFilter (multiaddrs: Multiaddr[]): Multiaddr[] {
    return multiaddrs.filter(isWebRTCInterconnectAddress)
  }

  async dial (address: Multiaddr, options: DialTransportOptions): Promise<Connection> {
    const target = parseWebRTCInterconnectAddress(address)
    const context = this.takeDial(target.peerId)
    if (context == null) {
      throw interconnectError('ERR_WEBRTC_INTERCONNECT_SIGNAL', 'dial', 'external WebRTC dial context is missing')
    }
    if (!target.peerId.equals(context.remotePeerId)) {
      throw interconnectError('ERR_WEBRTC_INTERCONNECT_ADDRESS', 'validate', 'WebRTC dial address does not match the requested peer')
    }
    if (this.sessions.has(context.connectionId)) {
      throw interconnectError('ERR_WEBRTC_INTERCONNECT_SIGNAL', 'dial', 'WebRTC connection id is already active')
    }
    const session = new ExternalWebRTCSession(this, {
      connectionId: context.connectionId,
      attemptId: context.attemptId,
      localPeerId: this.components.peerId,
      remotePeerId: context.remotePeerId,
      role: 'initiator',
      timeoutMs: context.timeoutMs,
      signal: options.signal,
      upgrader: options.upgrader
    })
    this.sessions.set(context.connectionId, session)
    try {
      return await session.runOutbound(options)
    } catch (error) {
      await session.close(false)
      throw error
    }
  }

  queueDial (context: DialContext): void {
    const key = context.remotePeerId.toString()
    const queue = this.pendingDials.get(key) ?? []
    queue.push(context)
    this.pendingDials.set(key, queue)
  }

  removeDial (context: DialContext): void {
    const key = context.remotePeerId.toString()
    const queue = this.pendingDials.get(key)
    if (queue == null) return
    const index = queue.indexOf(context)
    if (index >= 0) queue.splice(index, 1)
    if (queue.length === 0) this.pendingDials.delete(key)
  }

  private takeDial (remotePeerId: PeerId): DialContext | undefined {
    const key = remotePeerId.toString()
    const context = this.pendingDials.get(key)?.shift()
    if (this.pendingDials.get(key)?.length === 0) this.pendingDials.delete(key)
    return context
  }

  notifyConnection (event: WebRTCInterconnectConnectionEvent): void {
    this.onConnection?.(event)
  }

  removeSession (session: ExternalWebRTCSession): void {
    if (this.sessions.get(session.connectionId) === session) {
      this.sessions.delete(session.connectionId)
      if (!this.completedAttempts.has(session.connectionId) && this.completedAttempts.size >= this.maxEarlySignals) {
        const oldest = this.completedAttempts.keys().next().value
        if (oldest != null) this.completedAttempts.delete(oldest)
      }
      this.completedAttempts.set(session.connectionId, {
        attemptId: session.attemptId,
        expiresAtMs: Date.now() + this.signalLifetimeMs
      })
      this.scheduleEarlySignalCleanup()
    }
  }

  async send (envelope: WebRTCInterconnectEnvelope): Promise<void> {
    await this.options.signaling.send(envelope)
  }

  private bufferEarlySignal (envelope: WebRTCInterconnectEnvelope): void {
    const now = Date.now()
    this.pruneEarlySignals(now)
    if (this.earlySignalCount >= this.maxEarlySignals) return
    const queue = this.earlySignals.get(envelope.connectionId) ?? []
    if (queue.length >= this.maxEarlySignalsPerConnection) return
    const expiresAtMs = Math.min(envelope.expiresAtMs, now + this.signalLifetimeMs)
    if (expiresAtMs <= now) return
    queue.push({ envelope, expiresAtMs })
    this.earlySignals.set(envelope.connectionId, queue)
    this.earlySignalCount += 1
    this.scheduleEarlySignalCleanup()
  }

  private takeEarlySignals (connectionId: string, attemptId: string, from: string): WebRTCInterconnectEnvelope[] {
    const now = Date.now()
    this.pruneEarlySignals(now)
    const queue = this.earlySignals.get(connectionId)
    if (queue == null) return []
    this.earlySignalCount -= queue.length
    this.earlySignals.delete(connectionId)
    this.scheduleEarlySignalCleanup()
    return queue
      .filter(entry => entry.expiresAtMs > now && entry.envelope.attemptId === attemptId && entry.envelope.from === from && isEarlySignalType(entry.envelope.signal.type))
      .sort((left, right) => left.envelope.sequence - right.envelope.sequence)
      .map(entry => entry.envelope)
  }

  private pruneEarlySignals (now: number): void {
    for (const [connectionId, queue] of this.earlySignals) {
      const active = queue.filter(entry => entry.expiresAtMs > now)
      this.earlySignalCount -= queue.length - active.length
      if (active.length === 0) this.earlySignals.delete(connectionId)
      else this.earlySignals.set(connectionId, active)
    }
    for (const [connectionId, completed] of this.completedAttempts) {
      if (completed.expiresAtMs <= now) this.completedAttempts.delete(connectionId)
    }
  }

  private scheduleEarlySignalCleanup (): void {
    if (this.earlySignalCleanupTimer != null) {
      clearTimeout(this.earlySignalCleanupTimer)
      this.earlySignalCleanupTimer = undefined
    }
    if (!this.started) return
    let next = Infinity
    for (const queue of this.earlySignals.values()) {
      for (const entry of queue) next = Math.min(next, entry.expiresAtMs)
    }
    for (const completed of this.completedAttempts.values()) next = Math.min(next, completed.expiresAtMs)
    if (!Number.isFinite(next)) return
    const delay = Math.min(Math.max(1, next - Date.now()), 2_147_483_647)
    const timer = setTimeout(() => {
      this.earlySignalCleanupTimer = undefined
      if (!this.started) return
      this.pruneEarlySignals(Date.now())
      this.scheduleEarlySignalCleanup()
    }, delay)
    unrefTimer(timer)
    this.earlySignalCleanupTimer = timer
  }

  private async receive (raw: WebRTCInterconnectEnvelope): Promise<void> {
    if (!this.started) return
    const envelope = validateEnvelope(raw, this.options.maxSignalBytes ?? DEFAULT_MAX_SIGNAL_BYTES)
    if (envelope.to !== this.components.peerId.toString()) return
    const completed = this.completedAttempts.get(envelope.connectionId)
    if (completed?.attemptId === envelope.attemptId) return
    let session = this.sessions.get(envelope.connectionId)
    if (session == null) {
      if (envelope.signal.type !== 'offer') {
        if (isEarlySignalType(envelope.signal.type)) this.bufferEarlySignal(envelope)
        return
      }
      const remote = parseTargetPeerId(envelope.from)
      session = new ExternalWebRTCSession(this, {
        connectionId: envelope.connectionId,
        attemptId: envelope.attemptId,
        localPeerId: this.components.peerId,
        remotePeerId: remote,
        role: 'responder',
        timeoutMs: this.options.connectionTimeoutMs ?? DEFAULT_CONNECTION_TIMEOUT_MS,
        upgrader: this.components.upgrader
      })
      this.sessions.set(envelope.connectionId, session)
    }
    if (session.attemptId !== envelope.attemptId || session.remotePeerId.toString() !== envelope.from) return
    try {
      if (envelope.signal.type === 'offer') {
        const queued = this.takeEarlySignals(envelope.connectionId, envelope.attemptId, envelope.from)
        const accepted = await session.receiveOffer(envelope, queued)
        if (accepted) await session.completeInbound()
      } else {
        await session.receive(envelope)
      }
    } catch (error) {
      await session.close(false)
      throw error
    }
  }
}

interface ExternalSessionInit {
  connectionId: string
  attemptId: string
  localPeerId: PeerId
  remotePeerId: PeerId
  role: WebRTCInterconnectSignalRole
  timeoutMs: number
  upgrader: Upgrader
  signal?: AbortSignal
}

class ExternalWebRTCSession {
  readonly connectionId: string
  readonly attemptId: string
  readonly localPeerId: PeerId
  readonly remotePeerId: PeerId
  readonly role: WebRTCInterconnectSignalRole

  private readonly owner: ExternalWebRTCTransport
  private readonly init: ExternalSessionInit
  private readonly controller = new AbortController()
  private readonly connected: Deferred<void>
  private readonly channelReady: Deferred<RTCDataChannel>
  private readonly answerReady: Deferred<void>
  private readonly queuedLocalSignals: WebRTCInterconnectSignal[] = []
  private readonly queuedRemoteCandidates: WebRTCInterconnectIceCandidate[] = []
  private peerConnection?: RTCPeerConnection
  private dataChannel?: RTCDataChannel
  private maConnection?: RTCDataChannelConnection
  private connection?: Connection
  private localDescriptionPublished = false
  private remoteDescriptionSet = false
  private sequence = 0
  private lastSequence = -1
  private closed = false
  private detached = false
  private sendQueue: Promise<void> = Promise.resolve()
  private receiveQueue: Promise<void> = Promise.resolve()
  private offerSetup?: Promise<void>
  private inboundCompletion?: Promise<void>
  private readonly setupTimer: ReturnType<typeof setTimeout>

  constructor (owner: ExternalWebRTCTransport, init: ExternalSessionInit) {
    this.owner = owner
    this.init = init
    this.connectionId = init.connectionId
    this.attemptId = init.attemptId
    this.localPeerId = init.localPeerId
    this.remotePeerId = init.remotePeerId
    this.role = init.role
    this.connected = deferred<void>()
    this.channelReady = deferred<RTCDataChannel>()
    this.answerReady = deferred<void>()
    this.connected.promise.catch(() => {})
    this.channelReady.promise.catch(() => {})
    this.answerReady.promise.catch(() => {})
    const signal = init.signal
    if (signal != null) {
      if (signal.aborted) this.controller.abort(signal.reason)
      else signal.addEventListener('abort', () => { this.controller.abort(signal.reason) }, { once: true })
    }
    this.setupTimer = setTimeout(() => this.controller.abort(new DOMException('WebRTC interconnect timed out', 'TimeoutError')), init.timeoutMs)
    this.controller.signal.addEventListener('abort', () => {
      clearTimeout(this.setupTimer)
      void this.close(true)
    }, { once: true })
  }

  async runOutbound (options: DialTransportOptions): Promise<Connection> {
    try {
      this.createPeerConnection()
      await this.waitForPeerConnection()
      this.dataChannel = this.peerConnection!.createDataChannel(DATA_CHANNEL_LABEL)
      this.acceptChannel(this.dataChannel)
      const offer = await this.peerConnection!.createOffer()
      await this.peerConnection!.setLocalDescription(offer)
      await this.publish({ type: 'offer', sdp: this.peerConnection!.localDescription?.sdp ?? offer.sdp ?? '' })
      await this.answerReady.promise
      await this.channelReady.promise
      await this.connected.promise
      const upgraded = await this.upgradeOutbound(options.upgrader, options.onProgress)
      clearTimeout(this.setupTimer)
      this.detach()
      return upgraded
    } catch (error) {
      await this.close(false)
      if (error instanceof WebRTCInterconnectError) throw error
      if (this.controller.signal.aborted) throw interconnectError('ERR_WEBRTC_INTERCONNECT_TIMEOUT', 'connect', 'WebRTC interconnect connection timed out', { cause: error })
      throw interconnectError('ERR_WEBRTC_INTERCONNECT_DIAL', 'connect', 'WebRTC interconnect connection failed', { cause: error })
    }
  }

  receive (envelope: WebRTCInterconnectEnvelope): Promise<boolean> {
    return this.enqueueReceive(async () => await this.receiveNow(envelope))
  }

  receiveOffer (offer: WebRTCInterconnectEnvelope, earlySignals: WebRTCInterconnectEnvelope[]): Promise<boolean> {
    return this.enqueueReceive(async () => await this.receiveNow(offer, async () => {
      for (const envelope of earlySignals) {
        if (!this.matchesEnvelope(envelope) || !isEarlySignalType(envelope.signal.type)) continue
        await this.receiveNow(envelope)
        if (this.closed) break
      }
    }))
  }

  private async receiveNow (envelope: WebRTCInterconnectEnvelope, onOfferAdmitted?: () => Promise<void>): Promise<boolean> {
    if (!this.matchesEnvelope(envelope)) return false
    if (!Number.isSafeInteger(envelope.sequence) || envelope.sequence <= this.lastSequence) return false
    this.lastSequence = envelope.sequence
    if (envelope.expiresAtMs <= Date.now()) throw interconnectError('ERR_WEBRTC_INTERCONNECT_SIGNAL', 'signal', 'WebRTC interconnect signal has expired')
    if (envelope.signal.type === 'close') {
      await this.close(false)
      return true
    }
    if (envelope.signal.type === 'offer') {
      if (this.role !== 'responder') throw interconnectError('ERR_WEBRTC_INTERCONNECT_SIGNAL', 'signal', 'initiator received an unexpected offer')
      await this.acceptOffer(envelope.signal.sdp, onOfferAdmitted)
      return true
    }
    if (envelope.signal.type === 'answer') {
      if (this.role !== 'initiator') throw interconnectError('ERR_WEBRTC_INTERCONNECT_SIGNAL', 'signal', 'responder received an unexpected answer')
      await this.acceptAnswer(envelope.signal.sdp)
      this.answerReady.resolve()
      return true
    }
    if (envelope.signal.type === 'ice-candidate') {
      if (envelope.signal.candidate == null) return true
      if (!this.remoteDescriptionSet) this.queuedRemoteCandidates.push(envelope.signal.candidate)
      else await this.peerConnection!.addIceCandidate(envelope.signal.candidate)
      return true
    }
    return true
  }

  private enqueueReceive<T> (operation: () => Promise<T>): Promise<T> {
    const result = this.receiveQueue.then(operation)
    this.receiveQueue = result.then(() => undefined, () => undefined)
    return result
  }

  private matchesEnvelope (envelope: WebRTCInterconnectEnvelope): boolean {
    return !this.closed && !this.detached && envelope.attemptId === this.attemptId && envelope.from === this.remotePeerId.toString() && envelope.to === this.localPeerId.toString()
  }

  private async waitForPeerConnection (): Promise<void> {
    for (let attempt = 0; attempt < 100; attempt++) {
      if (this.peerConnection != null) return
      await new Promise(resolve => setTimeout(resolve, 0))
    }
    throw new Error('WebRTC peer connection was not created')
  }

  private createPeerConnection (): void {
    if (this.peerConnection != null) return
    const configuration = this.owner.options.rtcConfiguration
    const resolved = Promise.resolve(typeof configuration === 'function' ? configuration() : configuration)
    void resolved.then((configurationValue: RTCConfiguration | undefined) => {
      if (this.closed) return
      const pc = new globalThis.RTCPeerConnection(configurationValue)
      this.peerConnection = pc
      pc.onconnectionstatechange = () => {
        if (pc.connectionState === 'connected') this.connected.resolve()
        if (pc.connectionState === 'failed' || pc.connectionState === 'closed') this.connected.reject(new Error('WebRTC peer connection closed before upgrade'))
      }
      pc.onicecandidate = event => {
        const value = event.candidate?.toJSON()
        const candidate = value == null || typeof value.candidate !== 'string' || value.candidate === ''
          ? null
          : {
              candidate: value.candidate,
              ...(value.sdpMid == null ? {} : { sdpMid: value.sdpMid }),
              ...(value.sdpMLineIndex == null ? {} : { sdpMLineIndex: value.sdpMLineIndex }),
              ...(value.usernameFragment == null ? {} : { usernameFragment: value.usernameFragment })
            }
        void this.publishLocalCandidate(candidate)
      }
      pc.ondatachannel = event => {
        if (event.channel.label !== DATA_CHANNEL_LABEL) {
          event.channel.close()
          return
        }
        this.acceptChannel(event.channel)
      }
      this.controller.signal.addEventListener('abort', () => pc.close(), { once: true })
    }).catch((error: unknown) => {
      this.connected.reject(error instanceof Error ? error : new Error(String(error)))
    })
  }

  private acceptChannel (channel: RTCDataChannel): void {
    if (this.dataChannel != null && this.dataChannel !== channel) {
      channel.close()
      return
    }
    this.dataChannel = channel
    channel.binaryType = 'arraybuffer'
    this.channelReady.resolve(channel)
  }

  private async acceptOffer (sdp: string, onOfferAdmitted?: () => Promise<void>): Promise<void> {
    if (this.offerSetup != null) {
      await this.offerSetup
      return
    }
    const setup = this.setupOffer(sdp, onOfferAdmitted)
    this.offerSetup = setup
    try {
      await setup
    } catch (error) {
      if (this.offerSetup === setup) this.offerSetup = undefined
      throw error
    }
  }

  private async setupOffer (sdp: string, onOfferAdmitted?: () => Promise<void>): Promise<void> {
    this.createPeerConnection()
    await this.waitForPeerConnection()
    const pc = this.peerConnection!
    await pc.setRemoteDescription({ type: 'offer', sdp })
    this.remoteDescriptionSet = true
    if (onOfferAdmitted != null) {
      await onOfferAdmitted()
      if (this.closed) return
    }
    await this.flushRemoteCandidates()
    const answer = await pc.createAnswer()
    await pc.setLocalDescription(answer)
    await this.publish({ type: 'answer', sdp: pc.localDescription?.sdp ?? answer.sdp ?? '' })
  }

  async completeInbound (): Promise<void> {
    if (this.role !== 'responder') return
    if (this.inboundCompletion != null) return this.inboundCompletion
    this.inboundCompletion = this.finishInbound()
    return this.inboundCompletion
  }

  private async finishInbound (): Promise<void> {
    if (this.closed) return
    try {
      await this.channelReady.promise
      await this.connected.promise
      await this.upgradeInbound()
      clearTimeout(this.setupTimer)
      this.detach()
    } catch (error) {
      await this.close(false)
      throw error
    }
  }

  private async acceptAnswer (sdp: string): Promise<void> {
    this.createPeerConnection()
    await this.waitForPeerConnection()
    const pc = this.peerConnection!
    await pc.setRemoteDescription({ type: 'answer', sdp })
    this.remoteDescriptionSet = true
    await this.flushRemoteCandidates()
  }

  private async flushRemoteCandidates (): Promise<void> {
    const pc = this.peerConnection
    if (pc == null) return
    const candidates = this.queuedRemoteCandidates.splice(0)
    for (const candidate of candidates) await pc.addIceCandidate(candidate)
  }

  private async publishLocalCandidate (candidate: WebRTCInterconnectIceCandidate | null): Promise<void> {
    const signal: WebRTCInterconnectSignal = candidate == null
      ? { type: 'end-of-candidates' }
      : { type: 'ice-candidate', candidate }
    if (!this.localDescriptionPublished) {
      this.queuedLocalSignals.push(signal)
      return
    }
    try {
      await this.publish(signal)
    } catch (error) {
      await this.close(false)
      throw error
    }
  }

  private async publish (signal: WebRTCInterconnectSignal): Promise<void> {
    if (signal.type === 'offer' || signal.type === 'answer') {
      const result = this.enqueue(async () => {
        await this.owner.send({
          connectionId: this.connectionId,
          attemptId: this.attemptId,
          from: this.localPeerId.toString(),
          to: this.remotePeerId.toString(),
          sequence: this.sequence++,
          expiresAtMs: Date.now() + (this.owner.options.signalLifetimeMs ?? DEFAULT_SIGNAL_LIFETIME_MS),
          signal
        })
      })
      this.localDescriptionPublished = true
      await result
      const queued = this.queuedLocalSignals.splice(0)
      for (const queuedSignal of queued) await this.publish(queuedSignal)
      return
    }
    await this.enqueue(async () => {
      await this.owner.send({
        connectionId: this.connectionId,
        attemptId: this.attemptId,
        from: this.localPeerId.toString(),
        to: this.remotePeerId.toString(),
        sequence: this.sequence++,
        expiresAtMs: Date.now() + (this.owner.options.signalLifetimeMs ?? DEFAULT_SIGNAL_LIFETIME_MS),
        signal
      })
    })
  }

  private async enqueue (operation: () => Promise<void>): Promise<void> {
    const next = this.sendQueue.catch(() => {}).then(operation)
    this.sendQueue = next
    await next
  }

  private async upgradeOutbound (upgrader: Upgrader, onProgress?: (event: any) => void): Promise<Connection> {
    await this.channelReady.promise
    const channel = this.dataChannel
    if (channel == null) throw new Error('WebRTC data channel is not ready')
    this.maConnection = new RTCDataChannelConnection({
      channel,
      remoteAddr: multiaddr(`/webrtc/p2p/${this.remotePeerId.toString()}`),
      localAddr: multiaddr(`/webrtc/p2p/${this.localPeerId.toString()}`),
      direction: 'outbound',
      log: this.owner.components.logger.forComponent('webrtc-interconnect'),
      maxMessageSize: this.owner.options.dataChannel?.maxMessageSize ?? DEFAULT_MAX_MESSAGE_BYTES,
      maxBufferedAmount: this.owner.options.dataChannel?.maxBufferedAmount ?? DEFAULT_MAX_BUFFERED_AMOUNT
    })
    const connection = await upgrader.upgradeOutbound(this.maConnection, {
      signal: this.controller.signal,
      remotePeer: this.remotePeerId,
      initiator: true,
      muxerFactory: yamux()(),
      ...(onProgress == null ? {} : { onProgress })
    } as never)
    this.connection = connection
    connection.addEventListener('close', () => { void this.close(false) })
    return connection
  }

  private async upgradeInbound (): Promise<void> {
    await this.channelReady.promise
    const channel = this.dataChannel
    if (channel == null) throw new Error('WebRTC data channel is not ready')
    this.maConnection = new RTCDataChannelConnection({
      channel,
      remoteAddr: multiaddr(`/webrtc/p2p/${this.remotePeerId.toString()}`),
      localAddr: multiaddr(`/webrtc/p2p/${this.localPeerId.toString()}`),
      direction: 'inbound',
      log: this.owner.components.logger.forComponent('webrtc-interconnect'),
      maxMessageSize: this.owner.options.dataChannel?.maxMessageSize ?? DEFAULT_MAX_MESSAGE_BYTES,
      maxBufferedAmount: this.owner.options.dataChannel?.maxBufferedAmount ?? DEFAULT_MAX_BUFFERED_AMOUNT
    })
    const connectionReady = deferred<Connection>()
    connectionReady.promise.catch(() => undefined)
    const onConnectionOpen = (event: CustomEvent<Connection>): void => {
      const connection = event.detail
      if (connection.direction === 'inbound' && connection.remotePeer.equals(this.remotePeerId)) connectionReady.resolve(connection)
    }
    const onAbort = (): void => connectionReady.reject(new Error('WebRTC inbound connection was aborted'))
    this.owner.components.events.addEventListener('connection:open', onConnectionOpen)
    this.controller.signal.addEventListener('abort', onAbort, { once: true })
    try {
      await this.init.upgrader.upgradeInbound(this.maConnection, {
        signal: this.controller.signal,
        remotePeer: this.remotePeerId,
        muxerFactory: yamux()()
      } as never)
      const connection = await connectionReady.promise
      this.connection = connection
      this.owner.notifyConnection({
        connection,
        remotePeerId: this.remotePeerId,
        connectionId: this.connectionId,
        attemptId: this.attemptId,
        role: 'responder'
      })
      this.maConnection.addEventListener('close', () => { void this.close(false) })
    } finally {
      this.owner.components.events.removeEventListener('connection:open', onConnectionOpen)
      this.controller.signal.removeEventListener('abort', onAbort)
    }
  }

  private detach (): void {
    this.detached = true
    this.owner.removeSession(this)
  }

  async close (sendClose: boolean): Promise<void> {
    if (this.closed) return
    this.closed = true
    if (!this.detached) {
      if (sendClose) {
        await this.enqueue(async () => {
          try {
            await this.owner.send({
              connectionId: this.connectionId,
              attemptId: this.attemptId,
              from: this.localPeerId.toString(),
              to: this.remotePeerId.toString(),
              sequence: this.sequence++,
              expiresAtMs: Date.now() + (this.owner.options.signalLifetimeMs ?? DEFAULT_SIGNAL_LIFETIME_MS),
              signal: { type: 'close', reason: 'connection_closed' }
            })
          } catch {
          }
        }).catch(() => {})
      }
      this.owner.removeSession(this)
    }
    this.controller.abort(new DOMException('WebRTC interconnect connection closed', 'AbortError'))
    this.connected.reject(new Error('WebRTC interconnect connection closed'))
    this.channelReady.reject(new Error('WebRTC interconnect connection closed'))
    this.answerReady.reject(new Error('WebRTC interconnect connection closed'))
    try { this.dataChannel?.close() } catch {}
    try { this.peerConnection?.close() } catch {}
  }
}

function unrefTimer (timer: ReturnType<typeof setTimeout>): void {
  const unref = (timer as ReturnType<typeof setTimeout> & { unref?: () => void }).unref
  if (typeof unref === 'function') unref.call(timer)
}

function dialTimeoutError (cause: unknown): WebRTCInterconnectError {
  return interconnectError('ERR_WEBRTC_INTERCONNECT_TIMEOUT', 'dial', 'WebRTC interconnect dial timed out or was aborted', { cause })
}

function raceWithAbort<T> (promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(dialTimeoutError(signal.reason))
  return new Promise<T>((resolve, reject) => {
    let settled = false
    const onAbort = (): void => {
      if (settled) return
      settled = true
      cleanup()
      reject(dialTimeoutError(signal.reason))
    }
    const cleanup = (): void => signal.removeEventListener('abort', onAbort)
    signal.addEventListener('abort', onAbort, { once: true })
    void promise.then(value => {
      if (settled) return
      settled = true
      cleanup()
      resolve(value)
    }, error => {
      if (settled) return
      settled = true
      cleanup()
      reject(error)
    })
  })
}

async function closeConnectionQuietly (connection: Connection | undefined, reason: unknown): Promise<void> {
  if (connection == null) return
  const error = reason instanceof Error ? reason : new Error('WebRTC interconnect connection cleanup')
  try {
    const abort = connection.abort
    if (typeof abort === 'function') {
      abort.call(connection, error)
      return
    }
  } catch {}
  await new Promise<void>(resolve => {
    let settled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const finish = (): void => {
      if (settled) return
      settled = true
      if (timer != null) clearTimeout(timer)
      resolve()
    }
    timer = setTimeout(finish, DEFAULT_CONNECTION_CLOSE_TIMEOUT_MS)
    unrefTimer(timer)
    void Promise.resolve().then(() => connection.close()).then(finish, finish)
  })
}

function isEarlySignalType (type: WebRTCInterconnectSignal['type']): boolean {
  return type === 'ice-candidate' || type === 'end-of-candidates' || type === 'close'
}

class RTCDataChannelConnection extends AbstractMultiaddrConnection {
  private readonly channel: RTCDataChannel
  private readonly maxMessageBytes: number
  private readonly maxBufferedBytes: number

  constructor (init: {
    channel: RTCDataChannel
    remoteAddr: Multiaddr
    localAddr: Multiaddr
    direction: TransportDirection
    log: any
    maxMessageSize: number
    maxBufferedAmount: number
  }) {
    super({
      remoteAddr: init.remoteAddr,
      localAddr: init.localAddr,
      direction: init.direction,
      log: init.log,
      maxMessageSize: init.maxMessageSize
    })
    this.channel = init.channel
    this.maxMessageBytes = positiveInteger(init.maxMessageSize, 'maxMessageSize')
    this.maxBufferedBytes = positiveInteger(init.maxBufferedAmount, 'maxBufferedAmount')
    this.channel.binaryType = 'arraybuffer'
    this.channel.bufferedAmountLowThreshold = Math.max(1, Math.floor(this.maxBufferedBytes / 2))
    this.channel.onopen = () => this.onMuxerDrain()
    this.channel.onbufferedamountlow = () => this.onMuxerDrain()
    this.channel.onmessage = event => {
      if (!(event.data instanceof ArrayBuffer) || event.data.byteLength === 0) return
      this.onData(new Uint8Array(event.data))
    }
    this.channel.onerror = event => {
      this.abort(event instanceof Error ? event : new Error('WebRTC data channel error'))
    }
    this.channel.onclose = () => {
      this.onRemoteCloseWrite()
      this.onTransportClosed()
    }
  }

  sendData (data: Parameters<AbstractMultiaddrConnection['sendData']>[0]): { sentBytes: number, canSendMore: boolean } {
    if (this.channel.readyState !== 'open') return { sentBytes: 0, canSendMore: false }
    let sentBytes = 0
    for (const chunk of data) {
      let offset = 0
      while (offset < chunk.byteLength) {
        if (this.channel.bufferedAmount > this.maxBufferedBytes) return { sentBytes, canSendMore: false }
        const end = Math.min(offset + this.maxMessageBytes, chunk.byteLength)
        try {
          this.channel.send(Uint8Array.from(chunk.subarray(offset, end)).buffer)
        } catch (error) {
          this.abort(error instanceof Error ? error : new Error(String(error)))
          return { sentBytes, canSendMore: false }
        }
        sentBytes += end - offset
        offset = end
      }
    }
    return { sentBytes, canSendMore: this.channel.bufferedAmount <= this.maxBufferedBytes }
  }

  async sendClose (options?: { signal?: AbortSignal }): Promise<void> {
    const deadline = Date.now() + 30_000
    while (this.channel.readyState === 'open' && this.channel.bufferedAmount > 0 && Date.now() < deadline) {
      options?.signal?.throwIfAborted()
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    options?.signal?.throwIfAborted()
    this.channel.close()
  }

  sendReset (): void {
    this.channel.close()
  }

  sendPause (): void {}

  sendResume (): void {}
}

function deferred<T> (): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((resolveFn, rejectFn) => {
    resolve = resolveFn
    reject = rejectFn
  })
  return { promise, resolve, reject }
}

function isWebRTCInterconnectAddress (address: Multiaddr): boolean {
  const components = address.getComponents()
  return components.length === 2 && components[0]?.name === 'webrtc' && components[1]?.name === 'p2p' && components[1].value != null
}

function validateSignalingAdapter (adapter: WebRTCInterconnectSignalingAdapter): void {
  if (adapter == null || typeof adapter.send !== 'function' || typeof adapter.subscribe !== 'function') {
    throw new TypeError('WebRTC interconnect signaling adapter is invalid')
  }
}

function validateEarlySignalOptions (options: Pick<WebRTCInterconnectTransportOptions, 'signalLifetimeMs' | 'maxEarlySignals'>): void {
  positiveInteger(options.signalLifetimeMs === undefined ? DEFAULT_SIGNAL_LIFETIME_MS : options.signalLifetimeMs, 'signalLifetimeMs')
  positiveInteger(options.maxEarlySignals === undefined ? DEFAULT_MAX_EARLY_SIGNALS : options.maxEarlySignals, 'maxEarlySignals')
}

function validateEnvelope (raw: WebRTCInterconnectEnvelope, maxBytes: number): WebRTCInterconnectEnvelope {
  positiveInteger(maxBytes, 'maxSignalBytes')
  if (raw == null || typeof raw !== 'object') throw interconnectError('ERR_WEBRTC_INTERCONNECT_SIGNAL', 'signal', 'WebRTC interconnect signal envelope is invalid')
  const connectionId = validateIdentifier(raw.connectionId, 'connectionId')
  const attemptId = validateIdentifier(raw.attemptId, 'attemptId')
  const from = parsePeerId(raw.from)
  const to = parsePeerId(raw.to)
  if (!Number.isSafeInteger(raw.sequence) || raw.sequence < 0 || !Number.isFinite(raw.expiresAtMs)) {
    throw interconnectError('ERR_WEBRTC_INTERCONNECT_SIGNAL', 'signal', 'WebRTC interconnect signal sequence or expiry is invalid')
  }
  if (raw.expiresAtMs <= Date.now()) throw interconnectError('ERR_WEBRTC_INTERCONNECT_SIGNAL', 'signal', 'WebRTC interconnect signal has expired')
  const signal = raw.signal
  if (signal == null || typeof signal !== 'object') throw interconnectError('ERR_WEBRTC_INTERCONNECT_SIGNAL', 'signal', 'WebRTC interconnect signal payload is invalid')
  let encoded: number
  try {
    encoded = new TextEncoder().encode(JSON.stringify(signal)).byteLength
  } catch (error) {
    throw interconnectError('ERR_WEBRTC_INTERCONNECT_SIGNAL', 'signal', 'WebRTC interconnect signal payload is invalid', { cause: error })
  }
  if (encoded > maxBytes) throw interconnectError('ERR_WEBRTC_INTERCONNECT_SIGNAL', 'signal', 'WebRTC interconnect signal exceeds the configured size limit')
  if (signal.type === 'offer' || signal.type === 'answer') {
    if (typeof signal.sdp !== 'string' || signal.sdp.length === 0) throw interconnectError('ERR_WEBRTC_INTERCONNECT_SIGNAL', 'signal', 'WebRTC SDP is invalid')
  } else if (signal.type === 'ice-candidate') {
    validateIceCandidate(signal.candidate)
  } else if (signal.type === 'close') {
    if (signal.reason != null && typeof signal.reason !== 'string') throw interconnectError('ERR_WEBRTC_INTERCONNECT_SIGNAL', 'signal', 'WebRTC close reason is invalid')
  } else if (signal.type !== 'end-of-candidates') {
    throw interconnectError('ERR_WEBRTC_INTERCONNECT_SIGNAL', 'signal', 'WebRTC interconnect signal type is invalid')
  }
  return { connectionId, attemptId, from: from.toString(), to: to.toString(), sequence: raw.sequence, expiresAtMs: raw.expiresAtMs, signal }
}

function validateIceCandidate (candidate: WebRTCInterconnectIceCandidate | null | undefined): void {
  if (candidate == null) return
  if (typeof candidate !== 'object' || typeof candidate.candidate !== 'string') {
    throw interconnectError('ERR_WEBRTC_INTERCONNECT_SIGNAL', 'signal', 'WebRTC ICE candidate is invalid')
  }
  if (candidate.sdpMid != null && typeof candidate.sdpMid !== 'string') throw interconnectError('ERR_WEBRTC_INTERCONNECT_SIGNAL', 'signal', 'WebRTC ICE candidate is invalid')
  if (candidate.sdpMLineIndex != null && (!Number.isSafeInteger(candidate.sdpMLineIndex) || candidate.sdpMLineIndex < 0)) throw interconnectError('ERR_WEBRTC_INTERCONNECT_SIGNAL', 'signal', 'WebRTC ICE candidate is invalid')
  if (candidate.usernameFragment != null && typeof candidate.usernameFragment !== 'string') throw interconnectError('ERR_WEBRTC_INTERCONNECT_SIGNAL', 'signal', 'WebRTC ICE candidate is invalid')
}

function parseTargetPeerId (value: PeerId | string): PeerId {
  const peerId = parsePeerId(value)
  publicKeyFromPeerId(peerId)
  return peerId
}

function parsePeerId (value: PeerId | string): PeerId {
  try {
    return typeof value === 'string' ? peerIdFromString(value) : value
  } catch (error) {
    throw interconnectError('ERR_WEBRTC_INTERCONNECT_ADDRESS', 'validate', 'WebRTC interconnect peer id is invalid', { cause: error })
  }
}

function validateIdentifier (value: string, field: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 128 || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new TypeError(`${field} is invalid`)
  }
  return value
}

function positiveInteger (value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError(`${field} must be a positive integer`)
  return value
}

function equalBytes (left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && left.every((value, index) => value === right[index])
}

function interconnectError (code: WebRTCInterconnectErrorCode, stage: WebRTCInterconnectErrorStage, message: string, options: { cause?: unknown } = {}): WebRTCInterconnectError {
  return new WebRTCInterconnectError(code, stage, message, options)
}

function errorCode (error: unknown): string {
  return error instanceof WebRTCInterconnectError ? error.code : 'ERR_WEBRTC_INTERCONNECT_UNKNOWN'
}
