import type {
  AbortOptions,
  Connection,
  Libp2p,
  PeerId,
  Secp256k1PrivateKey,
  ServiceMap,
  StreamMuxerFactory,
  Transport
} from '@libp2p/interface'
import type { Multiaddr } from '@multiformats/multiaddr'
import { createLibp2p, type Libp2pOptions, type ServiceFactoryMap } from 'libp2p'
import { identify, identifyPush } from '@libp2p/identify'
import { noise } from '@chainsafe/libp2p-noise'
import { yamux } from '@chainsafe/libp2p-yamux'
import { webSockets } from '@libp2p/websockets'
import { peerIdFromPublicKey } from '@libp2p/peer-id'
import {
  IdentityError,
  publicKeyFromPeerId,
  publicKeyObject,
  toBytes,
  validatePublicKey,
  type BytesLike
} from '../identity/index.js'
import { SignerError, signerPublicKey, verifyDER, type TypedSigner } from '../signer/index.js'
import { parsePeerRecordUnsigned } from '../identity/index.js'

const NOISE_PREFIX = new TextEncoder().encode('noise-libp2p-static-key:')

export class NonExtractableError extends Error {
  readonly code = 'ERR_NON_EXTRACTABLE'

  constructor () {
    super('identity private key is non-extractable')
    this.name = 'NonExtractableError'
  }
}

export class IdentityClosedError extends Error {
  readonly code = 'ERR_IDENTITY_CLOSED'

  constructor () {
    super('identity signer lifecycle is closed')
    this.name = 'IdentityClosedError'
  }
}

export interface IdentityAdapterOptions {
  signTimeoutMs?: number
}

export const DEFAULT_SIGN_TIMEOUT_MS = 5000

/** The private-key shape consumed by js-libp2p without containing raw key material. */
export class NonExtractablePrivateKey implements Secp256k1PrivateKey {
  readonly type = 'secp256k1' as const
  readonly publicKey: ReturnType<typeof publicKeyObject>
  readonly #signer: TypedSigner
  readonly #publicKeyBytes: Uint8Array
  readonly #peerId: PeerId
  readonly #lifecycle = new AbortController()
  readonly #signTimeoutMs: number

  constructor (signer: TypedSigner, options: IdentityAdapterOptions = {}) {
    this.#publicKeyBytes = signerPublicKey(signer)
    this.publicKey = publicKeyObject(this.#publicKeyBytes)
    this.#peerId = peerIdFromPublicKey(this.publicKey)
    this.#signer = signer
    this.#signTimeoutMs = options.signTimeoutMs != null && options.signTimeoutMs > 0
      ? options.signTimeoutMs
      : DEFAULT_SIGN_TIMEOUT_MS
  }

  get raw (): Uint8Array {
    throw new NonExtractableError()
  }

  #abortable<T> (promise: Promise<T>, signal?: AbortSignal): Promise<T> {
    if (signal == null) return promise
    if (signal.aborted) return Promise.reject(signal.reason ?? new DOMException('The operation was aborted', 'AbortError'))
    return new Promise<T>((resolve, reject) => {
      const onAbort = (): void => {
        signal.removeEventListener('abort', onAbort)
        reject(signal.reason ?? new DOMException('The operation was aborted', 'AbortError'))
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

  equals (key?: any): boolean {
    return key?.publicKey?.equals?.(this.publicKey) === true
  }

  // Cancels adapter-owned signer waits. A remote signer may still finish its
  // physical operation; any late response is ignored by the adapter.
  close (): void {
    if (!this.#lifecycle.signal.aborted) this.#lifecycle.abort(new IdentityClosedError())
  }

  #operationSignal (parent?: AbortSignal): { signal: AbortSignal, dispose: () => void } {
    const controller = new AbortController()
    const abort = (signal: AbortSignal, fallback: Error): void => {
      if (!signal.aborted) return
      if (!controller.signal.aborted) controller.abort(signal.reason ?? fallback)
    }
    const onLifecycleAbort = (): void => { abort(this.#lifecycle.signal, new IdentityClosedError()) }
    const onParentAbort = (): void => {
      if (parent != null) abort(parent, new DOMException('The operation was aborted', 'AbortError'))
    }
    this.#lifecycle.signal.addEventListener('abort', onLifecycleAbort, { once: true })
    parent?.addEventListener('abort', onParentAbort, { once: true })
    const timer = setTimeout(() => {
      if (!controller.signal.aborted) controller.abort(new SignerError('ERR_SIGN_TIMEOUT', 'signer operation timed out'))
    }, this.#signTimeoutMs)
    onLifecycleAbort()
    onParentAbort()
    return {
      signal: controller.signal,
      dispose: () => {
        clearTimeout(timer)
        this.#lifecycle.signal.removeEventListener('abort', onLifecycleAbort)
        parent?.removeEventListener('abort', onParentAbort)
        if (!controller.signal.aborted) controller.abort()
      }
    }
  }

  async sign (data: BytesLike, options?: AbortOptions): Promise<Uint8Array> {
    const bytes = toBytes(data)
    const operation = this.#operationSignal(options?.signal)
    const signal = operation.signal
    try {
      const prefixLength = NOISE_PREFIX.length
      let signature: Uint8Array
      if (bytes.length >= prefixLength && bytes.subarray(0, prefixLength).every((value, index) => value === NOISE_PREFIX[index])) {
        if (bytes.length !== prefixLength + 32) {
          throw new SignerError('ERR_INVALID_SIGNER_INPUT', 'Noise payload length is invalid')
        }
        signature = await this.#abortable(this.#signer.signNoiseStaticKey(bytes.slice(prefixLength), signal), signal)
      } else if (bytes.length === prefixLength + 32) {
        const prefix = bytes.subarray(0, prefixLength)
        if (!prefix.every((value, index) => value === NOISE_PREFIX[index])) throw new SignerError('ERR_INVALID_SIGNER_INPUT', 'Noise payload prefix is invalid')
        throw new SignerError('ERR_UNSUPPORTED_SIGNER_PURPOSE', 'signing purpose is not supported')
      } else {
        let record
        try {
          record = parsePeerRecordUnsigned(bytes, this.#peerId)
        } catch {
          throw new SignerError('ERR_UNSUPPORTED_SIGNER_PURPOSE', 'signing purpose is not supported')
        }
        signature = await this.#abortable(this.#signer.signPeerRecord(record, signal), signal)
      }

      const activePublicKey = signerPublicKey(this.#signer)
      if (!activePublicKey.every((value, index) => value === this.#publicKeyBytes[index])) {
        throw new SignerError('ERR_SIGNER_PUBLIC_KEY', 'active signer public key changed')
      }
      await verifyDER(this.#publicKeyBytes, bytes, signature, signal)
      return new Uint8Array(signature)
    } finally {
      operation.dispose()
    }
  }

  get peerId (): PeerId {
    return this.#peerId
  }

  get publicKeyBytes (): Uint8Array {
    return new Uint8Array(this.#publicKeyBytes)
  }
}

export function createIdentityAdapter (signer: TypedSigner, options?: IdentityAdapterOptions): NonExtractablePrivateKey {
  return new NonExtractablePrivateKey(signer, options)
}

export interface HostConfig {
  /** 业务公钥与受限 typed 签名能力；不会向 host 暴露 raw 私钥。 */
  signer: TypedSigner
  /** host 要监听的完整 multiaddr；浏览器出站 host 通常留空。 */
  listenAddrs?: Multiaddr[]
  /** 应用显式选择的 libp2p transport 列表。 */
  transports?: Array<(components: any) => Transport>
  /** 额外的 stream muxer；默认始终包含 Yamux。 */
  streamMuxers?: Array<(components: any) => StreamMuxerFactory>
  /** 额外 libp2p service；默认始终包含 Identify 与 Identify Push。 */
  services?: ServiceFactoryMap<ServiceMap>
  /** 连接准入策略，例如限制可拨号的地址。 */
  connectionGater?: Libp2pOptions['connectionGater']
  /** signer 单次操作超时毫秒数；必须为正数，否则使用默认值。 */
  signTimeoutMs?: number
  /** 是否在创建后立即启动 host。 */
  start?: boolean
}

// This is a thin standard-libp2p assembler. Noise, Yamux, Identify and
// Identify Push are always installed; applications own transports and stream
// protocol handlers.
export async function createHost (config: HostConfig): Promise<Libp2p> {
  const identity = createIdentityAdapter(config.signer, { signTimeoutMs: config.signTimeoutMs })
  const options: Libp2pOptions = {
    privateKey: identity,
    addresses: { listen: (config.listenAddrs ?? []).map(address => address.toString()) },
    transports: config.transports ?? [webSockets()],
    streamMuxers: [yamux(), ...(config.streamMuxers ?? [])],
    connectionEncrypters: [noise()],
    connectionGater: config.connectionGater,
    services: {
      identify: identify(),
      identifyPush: identifyPush(),
      ...(config.services ?? {})
    },
    start: config.start
  }
  let node: Libp2p
  try {
    node = await createLibp2p(options)
  } catch (error) {
    identity.close()
    throw error
  }
  const originalStop = node.stop.bind(node)
  let stopPromise: Promise<void> | undefined
  Object.defineProperty(node, 'stop', {
    configurable: true,
    writable: true,
    value: (): Promise<void> => {
      stopPromise ??= (async () => {
        identity.close()
        await originalStop()
      })()
      return stopPromise
    }
  })
  return node
}

export interface AuthenticatedPeer {
  publicKey: Uint8Array
  peerId: PeerId
  remoteAddr?: Multiaddr
}

export interface PeerPin {
  publicKey?: Uint8Array
  peerId?: PeerId | string
}

export function authenticateConnection (connection: Connection, pin?: PeerPin): AuthenticatedPeer {
  const peerId = connection.remotePeer
  if (peerId.type !== 'secp256k1') {
    throw new IdentityError('ERR_INVALID_PUBLIC_KEY', 'authenticated peer is not secp256k1')
  }
  const publicKey = publicKeyFromPeerId(peerId)
  if (pin?.publicKey != null && !validatePublicKey(pin.publicKey).every((value, index) => value === publicKey[index])) {
    throw new IdentityError('ERR_PEER_ID_MISMATCH', 'authenticated public key pin does not match')
  }
  if (pin?.peerId != null) {
    const expected = typeof pin.peerId === 'string' ? pin.peerId : pin.peerId
    if (typeof expected === 'string' ? !peerId.equals(expected) : !peerId.equals(expected)) {
      throw new IdentityError('ERR_PEER_ID_MISMATCH', 'authenticated peer id pin does not match')
    }
  }
  return {
    publicKey,
    peerId,
    remoteAddr: connection.remoteAddr
  }
}
