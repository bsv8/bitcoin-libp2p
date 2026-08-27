import type { Connection, Libp2p, PeerId } from '@libp2p/interface'
import { webRTCDirect, type DataChannelOptions, type WebRTCTransportDirectInit } from '@libp2p/webrtc'
import { peerIdFromPublicKey, peerIdFromString } from '@libp2p/peer-id'
import { bases, digest } from 'multiformats/basics'
import { base64url } from 'multiformats/bases/base64'
import { multiaddr, registry, type Component, type Multiaddr } from '@multiformats/multiaddr'
import { authenticateConnection, createHost, type AuthenticatedPeer, type HostConfig } from '../libp2p/index.js'
import { IdentityError, publicKeyFromPeerId, publicKeyObject, validatePublicKey } from '../identity/index.js'

const HOST_TYPES = new Set<WebRTCDirectHostType>(['ip4', 'ip6', 'dns', 'dns4', 'dns6'])
const EXPECTED_COMPONENTS = ['host', 'udp', 'webrtc-direct', 'certhash', 'p2p'] as const
const DEFAULT_DIAL_TIMEOUT_MS = 15_000
const CONNECTION_CLOSE_TIMEOUT_MS = 1_000

/** WebRTC Direct 地址允许的主机组件类型。 */
export type WebRTCDirectHostType = 'ip4' | 'ip6' | 'dns' | 'dns4' | 'dns6'

/** WebRTC Direct endpoint 的稳定错误码。 */
export type WebRTCDirectErrorCode =
  | 'ERR_WEBRTC_DIRECT_ADDRESS'
  | 'ERR_WEBRTC_DIRECT_CERTHASH'
  | 'ERR_WEBRTC_DIRECT_PEER_ID'
  | 'ERR_WEBRTC_DIRECT_RESOLVE'
  | 'ERR_WEBRTC_DIRECT_TIMEOUT'
  | 'ERR_WEBRTC_DIRECT_DIAL'
  | 'ERR_WEBRTC_DIRECT_AUTH'

/** WebRTC Direct endpoint 错误所处的高层阶段。 */
export type WebRTCDirectErrorStage = 'validate' | 'resolve' | 'dial' | 'authenticate'

/**
 * WebRTC Direct 的稳定错误。
 *
 * `code`/`stage` 是给业务控制流使用的稳定字段；`cause` 和有界
 * `diagnostics` 用于开发诊断。诊断会过滤 PEM、SDP、签名和私钥关键词。
 */
export class WebRTCDirectError extends Error {
  readonly code: WebRTCDirectErrorCode
  readonly stage: WebRTCDirectErrorStage
  readonly diagnostics: readonly string[]

  constructor (code: WebRTCDirectErrorCode, stage: WebRTCDirectErrorStage, message: string, options: { cause?: unknown } = {}) {
    super(message, { cause: options.cause })
    this.name = 'WebRTCDirectError'
    this.code = code
    this.stage = stage
    this.diagnostics = collectDiagnostics(options.cause)
  }
}

/** 规范化、完整且可拨号的 WebRTC Direct 地址。 */
export interface WebRTCDirectEndpoint {
  /** 规范化后的完整 multiaddr。 */
  address: Multiaddr
  /** 主机组件类型：ip4/ip6/dns/dns4/dns6。 */
  hostType: WebRTCDirectHostType
  /** IP 地址或 DNS 名称。DNS 只在拨号阶段解析。 */
  host: string
  /** UDP 监听端口，范围为 1..65535。 */
  udpPort: number
  /** 规范化的 multibase-multihash 证书指纹。 */
  certhash: string
  /** SHA2-256 multihash 中的 32 字节 digest 副本。 */
  certhashDigest: Uint8Array
  /** 地址声明的 secp256k1 PeerId。 */
  peerId: PeerId
  /** 从 PeerId 取回的 33 字节压缩公钥副本。 */
  publicKey: Uint8Array
}

/** 拨号前绑定的长期业务身份。不能只依赖地址自报 PeerId。 */
export interface WebRTCDirectEndpointPin {
  /** 期望的 33 字节压缩 secp256k1 业务公钥。 */
  publicKey?: Uint8Array
  /** 期望的 PeerId，可以传 PeerId 对象或标准字符串。 */
  peerId?: PeerId | string
}

/** 构造 WebRTC Direct endpoint 的输入。publicKey 与 peerId 至少提供一个。 */
export interface BuildWebRTCDirectEndpointInput {
  /** 主机组件类型。 */
  hostType: WebRTCDirectHostType
  /** IP 地址或 DNS 名称。 */
  host: string
  /** UDP 监听端口，范围为 1..65535。 */
  udpPort: number
  /** 服务端当前 DTLS 证书指纹。 */
  certhash: string
  /** 业务公钥；未传 peerId 时据此派生 PeerId。 */
  publicKey?: Uint8Array
  /** 地址 PeerId；未传 publicKey 时据此取回公钥。 */
  peerId?: PeerId | string
}

/** DNS 解析结果。解析器必须返回可直接用于 WebRTC Direct 的 IP 地址。 */
export interface WebRTCDirectResolveResult {
  /** 解析后的地址族，只允许 ip4 或 ip6。 */
  hostType: 'ip4' | 'ip6'
  /** 解析后的 IP 地址。 */
  host: string
}

/**
 * WebRTC Direct DNS 解析器。
 *
 * 浏览器没有通用的系统 DNS API，因此 SDK 不内置公网 DNS 服务；调用方应
 * 注入自己的解析器（浏览器可使用应用后端，Node 可使用 node:dns）。
 */
export type WebRTCDirectResolver = (input: {
  /** 原始 DNS 名称。 */
  host: string
  /** 原始 DNS 地址族约束。 */
  hostType: 'dns' | 'dns4' | 'dns6'
  /** 整体拨号的取消信号。 */
  signal: AbortSignal
}) => Promise<WebRTCDirectResolveResult | readonly WebRTCDirectResolveResult[]>

/** resolveWebRTCDirectEndpoint 的选项。 */
export interface ResolveWebRTCDirectEndpointOptions {
  /** DNS 解析器；IP endpoint 不需要解析器。 */
  resolver?: WebRTCDirectResolver
  /** 解析阶段的取消信号。 */
  signal?: AbortSignal
}

/** 创建 Direct dialer 时对 createHost 的必要配置。浏览器不提供 listenAddrs。 */
export interface WebRTCDirectDialerConfig extends Omit<HostConfig, 'transports' | 'listenAddrs'> {
  /** WebRTC RTCPeerConnection 的默认配置，例如受信任的 ICE server。 */
  rtcConfiguration?: WebRTCTransportDirectInit['rtcConfiguration']
  /** 新建 RTCDataChannel 的默认缓冲区、关闭和超时配置。 */
  dataChannel?: DataChannelOptions
}

/** 整体 Direct 拨号的取消和长期身份 pin。 */
export interface DialAuthenticatedWebRTCDirectOptions extends WebRTCDirectEndpointPin {
  /** 调用方取消信号；取消会终止本次拨号并清理监听。 */
  signal?: AbortSignal
  /** 整体拨号超时毫秒数，必须为正数；默认 15000。 */
  timeoutMs?: number
  /** DNS endpoint 的显式解析器；IP endpoint 不使用此字段。 */
  resolver?: WebRTCDirectResolver
}

/**
 * 解析并严格校验完整 WebRTC Direct multiaddr。
 *
 * certhash 可使用标准 multibase 输入，但对外统一输出 base64url multibase，
 * 使 parse/build 产生同一个规范地址。
 */
export function parseWebRTCDirectEndpoint (address: Multiaddr | string, pin?: WebRTCDirectEndpointPin): WebRTCDirectEndpoint {
  const parsed = parseAddress(address)
  const components = parsed.getComponents()

  checkComponentShape(components)

  const hostType = components[0]?.name
  const host = components[0]?.value
  if (!isHostType(hostType) || host == null || host === '' || !validateHost(hostType, host)) {
    throw endpointError('ERR_WEBRTC_DIRECT_ADDRESS', 'invalid WebRTC Direct host component')
  }

  const portValue = components[1]?.value
  const udpPort = parsePort(portValue)
  if (udpPort == null) {
    throw endpointError('ERR_WEBRTC_DIRECT_ADDRESS', 'UDP port must be an integer in 1..65535')
  }

  const certValue = components[3]?.value
  if (certValue == null || certValue === '') {
    throw endpointError('ERR_WEBRTC_DIRECT_CERTHASH', 'WebRTC Direct address has no certhash')
  }
  const cert = decodeCerthash(certValue)

  const peerValue = components[4]?.value
  if (peerValue == null || peerValue === '') {
    throw endpointError('ERR_WEBRTC_DIRECT_PEER_ID', 'WebRTC Direct address has no PeerId')
  }
  const peerId = parseSecp256k1PeerId(peerValue)
  const publicKey = publicKeyFromPeerId(peerId)

  const normalizedPin = validatePin(pin)
  if (normalizedPin.publicKey != null && !equalBytes(normalizedPin.publicKey, publicKey)) {
    throw endpointError('ERR_WEBRTC_DIRECT_PEER_ID', 'expected public key does not match address PeerId')
  }
  if (normalizedPin.peerId != null && !normalizedPin.peerId.equals(peerId)) {
    throw endpointError('ERR_WEBRTC_DIRECT_PEER_ID', 'expected PeerId does not match address PeerId')
  }

  const normalizedAddress = makeAddress(hostType, host, udpPort, cert.certhash, peerId)
  return {
    address: normalizedAddress,
    hostType,
    host,
    udpPort,
    certhash: cert.certhash,
    certhashDigest: new Uint8Array(cert.digest),
    peerId,
    publicKey: new Uint8Array(publicKey)
  }
}

/** 从主机、端口、证书指纹和业务身份构造规范 endpoint。 */
export function buildWebRTCDirectEndpoint (input: BuildWebRTCDirectEndpointInput): WebRTCDirectEndpoint {
  const pin: WebRTCDirectEndpointPin = { publicKey: input.publicKey, peerId: input.peerId }
  const normalizedPin = validatePin(pin, true)
  if (!isHostType(input.hostType) || input.host === '' || !validateHost(input.hostType, input.host)) {
    throw endpointError('ERR_WEBRTC_DIRECT_ADDRESS', 'hostType and host are invalid')
  }
  if (!Number.isSafeInteger(input.udpPort) || input.udpPort < 1 || input.udpPort > 65535) {
    throw endpointError('ERR_WEBRTC_DIRECT_ADDRESS', 'UDP port must be an integer in 1..65535')
  }
  const cert = decodeCerthash(input.certhash)
  const peerId = normalizedPin.peerId ?? peerIdFromPublicKey(publicKeyObject(normalizedPin.publicKey!))
  const publicKey = normalizedPin.publicKey ?? publicKeyFromPeerId(peerId)
  if (!equalBytes(publicKeyFromPeerId(peerId), publicKey)) {
    throw endpointError('ERR_WEBRTC_DIRECT_PEER_ID', 'public key and PeerId do not match')
  }
  return {
    address: makeAddress(input.hostType, input.host, input.udpPort, cert.certhash, peerId),
    hostType: input.hostType,
    host: input.host,
    udpPort: input.udpPort,
    certhash: cert.certhash,
    certhashDigest: new Uint8Array(cert.digest),
    peerId,
    publicKey: new Uint8Array(publicKey)
  }
}

/**
 * 在拨号前解析 DNS endpoint。
 *
 * 返回的 endpoint 会临时替换为 ip4/ip6，但保留 UDP、certhash 和 PeerId；
 * 原始 DNS 地址不会被修改，也不会从未认证远端自动学习新的证书指纹。
 */
export async function resolveWebRTCDirectEndpoint (
  endpoint: WebRTCDirectEndpoint,
  options: ResolveWebRTCDirectEndpointOptions = {}
): Promise<WebRTCDirectEndpoint> {
  const requestedHostType = endpoint.hostType
  if (requestedHostType === 'ip4' || requestedHostType === 'ip6') return endpoint
  if (options.signal?.aborted === true) {
    throw new WebRTCDirectError('ERR_WEBRTC_DIRECT_RESOLVE', 'resolve', 'WebRTC Direct DNS resolution was aborted', { cause: options.signal.reason })
  }
  if (options.resolver == null) {
    throw new WebRTCDirectError('ERR_WEBRTC_DIRECT_RESOLVE', 'resolve', 'DNS WebRTC Direct endpoint requires an injected resolver')
  }

  const signal = options.signal
  let removeAbortListener: (() => void) | undefined
  let abortFailure: Promise<never> | undefined
  if (signal != null) {
    abortFailure = new Promise<never>((_, reject) => {
      const onAbort = (): void => {
        reject(new WebRTCDirectError('ERR_WEBRTC_DIRECT_RESOLVE', 'resolve', 'WebRTC Direct DNS resolution was aborted', { cause: signal.reason }))
      }
      removeAbortListener = () => { signal.removeEventListener('abort', onAbort) }
      if (signal.aborted) onAbort()
      else signal.addEventListener('abort', onAbort, { once: true })
    })
  }

  try {
    const resolution = Promise.resolve().then(async () => {
      if (signal?.aborted === true) {
        throw new WebRTCDirectError('ERR_WEBRTC_DIRECT_RESOLVE', 'resolve', 'WebRTC Direct DNS resolution was aborted', { cause: signal.reason })
      }
      return await options.resolver!({
        host: endpoint.host,
        hostType: requestedHostType,
        signal: signal ?? new AbortController().signal
      })
    })
    const result = abortFailure == null ? await resolution : await Promise.race([resolution, abortFailure])
    const candidates = Array.isArray(result) ? result : [result]
    const resolved = candidates.find(candidate => isAllowedResolution(requestedHostType, candidate))
    if (resolved == null) {
      throw new Error('DNS resolver returned no IP address matching the requested address family')
    }
    return buildWebRTCDirectEndpoint({
      hostType: resolved.hostType,
      host: resolved.host,
      udpPort: endpoint.udpPort,
      certhash: endpoint.certhash,
      peerId: endpoint.peerId
    })
  } catch (error) {
    if (error instanceof WebRTCDirectError && error.code === 'ERR_WEBRTC_DIRECT_ADDRESS') {
      throw new WebRTCDirectError('ERR_WEBRTC_DIRECT_RESOLVE', 'resolve', 'DNS resolver returned an invalid IP address', { cause: error })
    }
    if (error instanceof WebRTCDirectError && error.code === 'ERR_WEBRTC_DIRECT_RESOLVE') throw error
    throw new WebRTCDirectError('ERR_WEBRTC_DIRECT_RESOLVE', 'resolve', 'DNS WebRTC Direct endpoint could not be resolved', { cause: error })
  } finally {
    removeAbortListener?.()
  }
}

/**
 * 创建只含 WebRTC Direct 出站 transport 的 libp2p host。
 * 浏览器端不能监听 UDP，因此此配置不会接受 listenAddrs。
 */
export async function createWebRTCDirectDialer (config: WebRTCDirectDialerConfig): Promise<Libp2p> {
  const { rtcConfiguration, dataChannel, ...hostConfig } = config
  return await createHost({
    ...hostConfig,
    transports: [webRTCDirect({ rtcConfiguration, dataChannel })]
  })
}

/**
 * 对单个完整 Direct 地址执行拨号，并在返回连接前完成 Noise 身份 pin。
 * 不做地址竞速、重试或 WebSocket fallback。
 */
export async function dialAuthenticatedWebRTCDirect (
  node: Pick<Libp2p, 'dial'>,
  endpoint: WebRTCDirectEndpoint,
  options: DialAuthenticatedWebRTCDirectOptions
): Promise<{ connection: Connection, authenticatedPeer: AuthenticatedPeer, endpoint: WebRTCDirectEndpoint }> {
  if (options == null || (options.publicKey == null && options.peerId == null)) {
    throw endpointError('ERR_WEBRTC_DIRECT_PEER_ID', 'dial requires an independent publicKey or peerId pin')
  }
  const normalizedEndpoint = parseWebRTCDirectEndpoint(endpoint.address, options)
  const timeoutMs = options.timeoutMs ?? DEFAULT_DIAL_TIMEOUT_MS
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new RangeError('timeoutMs must be a positive finite number')
  }

  const controller = new AbortController()
  let timedOut = false
  let externalAborted = false
  let timer: ReturnType<typeof setTimeout> | undefined
  let removeControllerAbortListener: (() => void) | undefined
  const onExternalAbort = (): void => {
    externalAborted = true
    controller.abort(options.signal?.reason ?? new DOMException('The operation was aborted', 'AbortError'))
  }
  if (options.signal?.aborted === true) onExternalAbort()
  else options.signal?.addEventListener('abort', onExternalAbort, { once: true })
  timer = setTimeout(() => {
    timedOut = true
    controller.abort(new DOMException('The operation timed out', 'TimeoutError'))
  }, timeoutMs)

  let connection: Connection | undefined
  let dialEndpoint = normalizedEndpoint
  try {
    if (controller.signal.aborted) {
      throw new WebRTCDirectError(
        'ERR_WEBRTC_DIRECT_TIMEOUT',
        'dial',
        timedOut ? `WebRTC Direct dial timed out after ${timeoutMs}ms` : 'WebRTC Direct dial was aborted',
        { cause: controller.signal.reason }
      )
    }
    const abortFailure = new Promise<never>((_, reject) => {
      const onControllerAbort = (): void => {
        reject(new WebRTCDirectError(
          'ERR_WEBRTC_DIRECT_TIMEOUT',
          'dial',
          timedOut ? `WebRTC Direct dial timed out after ${timeoutMs}ms` : 'WebRTC Direct dial was aborted',
          { cause: controller.signal.reason }
        ))
      }
      removeControllerAbortListener = () => { controller.signal.removeEventListener('abort', onControllerAbort) }
      if (controller.signal.aborted) onControllerAbort()
      else controller.signal.addEventListener('abort', onControllerAbort, { once: true })
    })
    dialEndpoint = await Promise.race([
      resolveWebRTCDirectEndpoint(normalizedEndpoint, { resolver: options.resolver, signal: controller.signal }),
      abortFailure
    ])
    const dialPromise = node.dial(dialEndpoint.address, { signal: controller.signal }).then(result => {
      if (controller.signal.aborted) {
        void closeConnectionQuietly(result, controller.signal.reason)
      }
      return result
    })
    connection = await Promise.race([dialPromise, abortFailure])
  } catch (error) {
    if (controller.signal.aborted || timedOut || externalAborted) {
      throw new WebRTCDirectError(
        'ERR_WEBRTC_DIRECT_TIMEOUT',
        'dial',
        timedOut ? `WebRTC Direct dial timed out after ${timeoutMs}ms` : 'WebRTC Direct dial was aborted',
        { cause: error }
      )
    }
    if (error instanceof WebRTCDirectError) throw error
    throw new WebRTCDirectError('ERR_WEBRTC_DIRECT_DIAL', 'dial', 'WebRTC Direct dial failed', { cause: error })
  } finally {
    if (timer != null) clearTimeout(timer)
    options.signal?.removeEventListener('abort', onExternalAbort)
    removeControllerAbortListener?.()
  }

  try {
    if (controller.signal.aborted) {
      await closeConnectionQuietly(connection, controller.signal.reason)
      throw new WebRTCDirectError('ERR_WEBRTC_DIRECT_TIMEOUT', 'dial', 'WebRTC Direct dial was aborted', { cause: controller.signal.reason })
    }
    const authenticatedPeer = authenticateConnection(connection, {
      publicKey: normalizedEndpoint.publicKey,
      peerId: normalizedEndpoint.peerId
    })
    return { connection, authenticatedPeer, endpoint: dialEndpoint }
  } catch (error) {
    await closeConnectionQuietly(connection, error)
    if (error instanceof WebRTCDirectError) throw error
    throw new WebRTCDirectError('ERR_WEBRTC_DIRECT_AUTH', 'authenticate', 'authenticated Noise identity does not match the endpoint pin', { cause: error })
  }
}

function parseAddress (input: Multiaddr | string): Multiaddr {
  try {
    return typeof input === 'string' ? multiaddr(input) : multiaddr(input.toString())
  } catch (error) {
    throw endpointError('ERR_WEBRTC_DIRECT_ADDRESS', 'address is not a valid multiaddr', error)
  }
}

function checkComponentShape (components: Component[]): void {
  if (components.length !== EXPECTED_COMPONENTS.length) {
    if (!components.some(component => component.name === 'certhash')) {
      throw endpointError('ERR_WEBRTC_DIRECT_CERTHASH', 'WebRTC Direct address is missing /certhash')
    }
    if (!components.some(component => component.name === 'p2p')) {
      throw endpointError('ERR_WEBRTC_DIRECT_PEER_ID', 'WebRTC Direct address is missing /p2p')
    }
    throw endpointError('ERR_WEBRTC_DIRECT_ADDRESS', 'WebRTC Direct address must have exactly five components')
  }
  const names = components.map((component, index) => index === 0 ? 'host' : component.name)
  if (names.some((name, index) => name !== EXPECTED_COMPONENTS[index])) {
    throw endpointError('ERR_WEBRTC_DIRECT_ADDRESS', 'WebRTC Direct address has an invalid component order or hybrid transport')
  }
}

function parsePort (value: string | undefined): number | undefined {
  if (value == null || !/^\d+$/.test(value)) return undefined
  const port = Number(value)
  return Number.isSafeInteger(port) && port >= 1 && port <= 65535 ? port : undefined
}

function isHostType (value: string | undefined): value is WebRTCDirectHostType {
  return value != null && HOST_TYPES.has(value as WebRTCDirectHostType)
}

function validateHost (hostType: WebRTCDirectHostType, host: string): boolean {
  if (host.length === 0 || /[\s\u0000-\u001f\u007f/]/u.test(host)) return false
  try {
    if (hostType === 'dns' || hostType === 'dns4' || hostType === 'dns6') return isValidDnsName(host)
    componentAddress(hostType, host)
    return true
  } catch {
    return false
  }
}

function isValidDnsName (host: string): boolean {
  if (host.length > 253 || host.startsWith('.') || host.endsWith('.') || host.includes('..')) return false
  return host.split('.').every(label =>
    label.length > 0 && label.length <= 63 &&
    /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/u.test(label)
  )
}

function componentAddress (name: string, value?: string): Multiaddr {
  const protocol = registry.getProtocol(name)
  return multiaddr([{
    code: protocol.code,
    name: protocol.name,
    ...(value == null ? {} : { value })
  }])
}

function isAllowedResolution (requestedType: 'dns' | 'dns4' | 'dns6', result: WebRTCDirectResolveResult | undefined): result is WebRTCDirectResolveResult {
  if (result == null || (result.hostType !== 'ip4' && result.hostType !== 'ip6') || typeof result.host !== 'string') return false
  if (requestedType === 'dns4' && result.hostType !== 'ip4') return false
  if (requestedType === 'dns6' && result.hostType !== 'ip6') return false
  return validateHost(result.hostType, result.host)
}

function decodeCerthash (value: string): { certhash: string, digest: Uint8Array } {
  try {
    // This is the same standard multibase decoder composition used by the
    // locked @libp2p/webrtc runtime; no base64url or varint is hand-written.
    // @ts-expect-error multibase decoder composition is not expressed in the package types.
    const decoder = Object.values(bases).map(base => base.decoder).reduce((left, right) => left.or(right))
    const raw = decoder.decode(value)
    const decoded = digest.decode(raw)
    if (decoded.code !== 0x12 || decoded.size !== 32) {
      throw new Error('certhash must be SHA2-256 with a 32-byte digest')
    }
    return { certhash: base64url.encode(decoded.bytes), digest: new Uint8Array(decoded.digest) }
  } catch (error) {
    throw endpointError('ERR_WEBRTC_DIRECT_CERTHASH', 'certhash cannot be decoded as SHA2-256/32', error)
  }
}

function parseSecp256k1PeerId (value: string): PeerId {
  try {
    const id = peerIdFromString(value)
    if (id.type !== 'secp256k1') throw new Error('PeerId key type is not secp256k1')
    publicKeyFromPeerId(id)
    return id
  } catch (error) {
    throw endpointError('ERR_WEBRTC_DIRECT_PEER_ID', 'PeerId is not a valid inline secp256k1 identity', error)
  }
}

function validatePin (pin?: WebRTCDirectEndpointPin, required = false): { publicKey?: Uint8Array, peerId?: PeerId } {
  if (required && (pin?.publicKey == null && pin?.peerId == null)) {
    throw endpointError('ERR_WEBRTC_DIRECT_PEER_ID', 'publicKey or peerId is required')
  }
  let publicKey: Uint8Array | undefined
  let peerId: PeerId | undefined
  try {
    if (pin?.publicKey != null) publicKey = validatePublicKey(pin.publicKey)
    if (pin?.peerId != null) {
      peerId = typeof pin.peerId === 'string' ? peerIdFromString(pin.peerId) : pin.peerId
      if (peerId.type !== 'secp256k1') throw new Error('PeerId key type is not secp256k1')
      publicKeyFromPeerId(peerId)
    }
  } catch (error) {
    throw endpointError('ERR_WEBRTC_DIRECT_PEER_ID', 'endpoint identity pin is invalid', error)
  }
  if (publicKey != null && peerId != null && !equalBytes(publicKeyFromPeerId(peerId), publicKey)) {
    throw endpointError('ERR_WEBRTC_DIRECT_PEER_ID', 'publicKey and peerId pin do not match')
  }
  return {
    publicKey: publicKey == null ? undefined : new Uint8Array(publicKey),
    peerId
  }
}

function makeAddress (hostType: WebRTCDirectHostType, host: string, udpPort: number, certhash: string, peerId: PeerId): Multiaddr {
  try {
    if (!validateHost(hostType, host)) throw new Error('host contains an invalid IP/DNS value')
    // Host is validated as one component first; the remaining components are
    // also created independently, so input cannot inject tcp/ws/tls suffixes.
    const hostComponent = multiaddr(`/${hostType}/${host}`).getComponents()[0]
    if (hostComponent == null) throw new Error('host component is missing')
    const address = multiaddr([hostComponent])
      .encapsulate(componentAddress('udp', String(udpPort)))
      .encapsulate(componentAddress('webrtc-direct'))
      .encapsulate(componentAddress('certhash', certhash))
      .encapsulate(componentAddress('p2p', peerId.toString()))
    checkComponentShape(address.getComponents())
    return address
  } catch (error) {
    throw endpointError('ERR_WEBRTC_DIRECT_ADDRESS', 'endpoint fields cannot form a multiaddr', error)
  }
}

function endpointError (code: WebRTCDirectErrorCode, message: string, cause?: unknown): WebRTCDirectError {
  return new WebRTCDirectError(code, 'validate', message, { cause })
}

function equalBytes (left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

async function closeConnectionQuietly (connection: Connection | undefined, reason: unknown): Promise<void> {
  if (connection == null) return
  const abort = connection.abort
  if (typeof abort === 'function') {
    try {
      abort.call(connection, reason instanceof Error ? reason : new Error('WebRTC Direct connection cleanup'))
      return
    } catch {
      // Fall through to bounded graceful close.
    }
  }
  try {
    await Promise.race([
      connection.close(),
      new Promise<void>(resolve => setTimeout(resolve, CONNECTION_CLOSE_TIMEOUT_MS))
    ])
  } catch {
    // The original dial/authentication failure remains the primary error.
  }
}

const MAX_DIAGNOSTICS = 24
const MAX_DIAGNOSTIC_LENGTH = 240
const MAX_DIAGNOSTIC_DEPTH = 4

function collectDiagnostics (root: unknown): string[] {
  const output: string[] = []
  const visited = new Set<object>()
  const visitCause = (value: Error, depth: number): void => {
    let cause: unknown
    try { cause = value.cause } catch { return }
    if (cause !== undefined) visit(cause, depth + 1)
  }
  const visit = (value: unknown, depth: number): void => {
    if (output.length >= MAX_DIAGNOSTICS) return
    if (depth > MAX_DIAGNOSTIC_DEPTH) {
      output.push('[diagnostics depth limit]')
      return
    }
    if (value != null && (typeof value === 'object' || typeof value === 'function')) {
      if (visited.has(value)) {
        output.push('[diagnostics cycle]')
        return
      }
      visited.add(value)
    }
    if (value instanceof AggregateError) {
      output.push(formatDiagnostic(value))
      for (const child of value.errors) visit(child, depth + 1)
      visitCause(value, depth)
    } else if (value instanceof Error) {
      output.push(formatDiagnostic(value))
      visitCause(value, depth)
    } else {
      output.push(sanitizeDiagnostic(String(value)))
    }
  }
  if (root !== undefined) visit(root, 0)
  return output
}

function formatDiagnostic (error: Error): string {
  return sanitizeDiagnostic(`${error.name}: ${error.message}`)
}

function sanitizeDiagnostic (value: string): string {
  const sanitized = value
    .replace(/-----BEGIN [^-]+-----[\s\S]*?-----END [^-]+-----/gi, '[redacted pem]')
    .replace(/\b(private\s*key|signature|sdp)\b/gi, '[redacted sensitive field]')
  return sanitized.length > MAX_DIAGNOSTIC_LENGTH ? `${sanitized.slice(0, MAX_DIAGNOSTIC_LENGTH)}…` : sanitized
}
