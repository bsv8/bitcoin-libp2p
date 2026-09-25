// Browser integration worker. The test-only raw key lives in this worker,
// never in the Window that owns the libp2p host.
import { multiaddr } from '@multiformats/multiaddr'
import { peerIdFromPublicKeyBytes, hexToBytes } from '../identity/index.js'
import { LocalSigner, type TypedSigner } from '../signer/index.js'
import type { PeerRecordInput } from '../identity/index.js'

const TEST_ONLY_PRIVATE_KEYS = [
  '0000000000000000000000000000000000000000000000000000000000000001',
  '0000000000000000000000000000000000000000000000000000000000000002'
] as const
const signers = new Map<number, TypedSigner>(TEST_ONLY_PRIVATE_KEYS.map((key, index) => [index + 1, new LocalSigner(hexToBytes(key, 'ERR_INVALID_PRIVATE_KEY'))]))

interface PeerRecordWire {
  peerIdPublicKey: Uint8Array
  addresses: Uint8Array[]
  sequence: bigint
}

interface WorkerRequest {
  id: number
  purpose: 'noise' | 'peer-record'
  keyId?: 1 | 2
  scenario?: 'pending' | 'exit' | 'stop'
  input?: Uint8Array
  record?: PeerRecordWire
}

interface WorkerResponse {
  id: number
  ok: boolean
  signature?: Uint8Array
  error?: string
}

function recordFromWire (wire: PeerRecordWire): PeerRecordInput {
  const publicKey = new Uint8Array(wire.peerIdPublicKey)
  return {
    peerId: peerIdFromPublicKeyBytes(publicKey),
    addresses: wire.addresses.map(address => multiaddr(new Uint8Array(address))),
    sequence: wire.sequence
  }
}

const workerScope: any = self

workerScope.addEventListener('message', (event: MessageEvent) => {
  const request = event.data as WorkerRequest
  if (request == null || typeof request.id !== 'number') return
  void (async (): Promise<void> => {
    try {
      const signer = signers.get(request.keyId ?? 1)
      if (signer == null) throw new Error('unknown signer key')
      let signature: Uint8Array
      if (request.purpose === 'noise') {
        if (request.input == null) throw new Error('missing Noise input')
        if (request.scenario === 'pending') return
        if (request.scenario === 'exit') {
          workerScope.close?.()
          return
        }
        signature = await signer.signNoiseStaticKey(new Uint8Array(request.input))
      } else {
        if (request.record == null) throw new Error('missing Peer Record input')
        signature = await signer.signPeerRecord(recordFromWire(request.record))
      }
      workerScope.postMessage({ id: request.id, ok: true, signature }, [signature.buffer])
    } catch (error) {
      const response: WorkerResponse = {
        id: request.id,
        ok: false,
        error: error instanceof Error ? error.message : 'signing failed'
      }
      workerScope.postMessage(response)
    }
  })()
})
