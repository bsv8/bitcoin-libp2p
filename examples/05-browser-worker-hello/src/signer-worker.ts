/// <reference lib="webworker" />

// The raw test key is generated in this dedicated Worker. It is never sent to
// the Window, placed in the DOM, or included in a signer request.
import { multiaddr } from '@multiformats/multiaddr'
import { peerIdFromPublicKeyBytes, type PeerRecordInput } from '@bsv8/bitcoin-libp2p/identity'
import { LocalSigner } from '@bsv8/bitcoin-libp2p/signer'

type Request =
  | { id: number, purpose: 'noise-static-key', staticKey: Uint8Array }
  | { id: number, purpose: 'peer-record', peerIdPublicKey: Uint8Array, addresses: Uint8Array[], sequence: string }

type Mode = 'normal' | 'pending' | 'exit'
type Control = { event: 'configure', mode: Mode }

function createSigner (): LocalSigner {
  for (;;) {
    const raw = crypto.getRandomValues(new Uint8Array(32))
    try {
      return new LocalSigner(raw)
    } catch {
      // Retry the negligible invalid-scalar case rather than relaxing validation.
    }
  }
}

const signer = createSigner()
const scope = self as DedicatedWorkerGlobalScope
const publicKey = signer.publicKey()
scope.postMessage({ event: 'ready', publicKey }, [publicKey.buffer])
let mode: Mode = 'normal'

function recordFromRequest (request: Extract<Request, { purpose: 'peer-record' }>): PeerRecordInput {
  return {
    peerId: peerIdFromPublicKeyBytes(new Uint8Array(request.peerIdPublicKey)),
    addresses: request.addresses.map(bytes => multiaddr(new Uint8Array(bytes))),
    sequence: BigInt(request.sequence)
  }
}

scope.addEventListener('message', event => {
  const value = event.data as Request | Control
  if (value != null && 'event' in value && value.event === 'configure') {
    mode = value.mode
    return
  }
  const request = value as Request
  void (async () => {
    try {
      if (mode === 'pending') return
      if (mode === 'exit') {
        scope.postMessage({ event: 'closed', reason: 'teaching signer Worker exited' })
        scope.close()
        return
      }
      let signature: Uint8Array
      if (request.purpose === 'noise-static-key') {
        signature = await signer.signNoiseStaticKey(new Uint8Array(request.staticKey))
      } else if (request.purpose === 'peer-record') {
        signature = await signer.signPeerRecord(recordFromRequest(request))
      } else {
        throw new Error('unsupported signer purpose')
      }
      scope.postMessage({ id: request.id, ok: true, signature }, [signature.buffer])
    } catch (error) {
      scope.postMessage({ id: request.id, ok: false, error: error instanceof Error ? error.message : 'signing failed' })
    }
  })()
})
