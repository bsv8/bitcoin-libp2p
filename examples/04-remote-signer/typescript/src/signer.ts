// Teaching-only child process for Demo 04. The channel is deliberately
// limited to the two SDK typed purposes and is not a production RPC contract.
import { randomBytes } from 'node:crypto'
import { createInterface } from 'node:readline'
import { multiaddr } from '@multiformats/multiaddr'
import { LocalSigner, type TypedSigner } from 'bitcoin-libp2p/signer'
import { parsePeerId, type PeerRecordInput } from 'bitcoin-libp2p/identity'

type Mode = 'normal' | 'pending' | 'exit' | 'reject' | 'wrong-key'

interface Request {
  id: number
  purpose: 'noise-static-key' | 'peer-record'
  staticKeyHex?: string
  peerId?: string
  addresses?: string[]
  sequence?: string
}

interface Response {
  id: number
  ok: boolean
  signatureDer?: string
  error?: string
  requests?: number
  noiseRequests?: number
}

function randomSigner (): LocalSigner {
  for (;;) {
    const raw = new Uint8Array(randomBytes(32))
    try {
      return new LocalSigner(raw)
    } catch {
      // Preserve the SDK's strict scalar validation without a fixed test key.
    }
  }
}

async function main (): Promise<void> {
  const mode = (argument('--mode') ?? 'normal') as Mode
  if (!['normal', 'pending', 'exit', 'reject', 'wrong-key'].includes(mode)) throw new Error(`unsupported signer mode ${mode}`)
  const signer = randomSigner()
  const wrongSigner = randomSigner()
  write({ event: 'ready', publicKey: bytesToHex(signer.publicKey()), pid: process.pid })

  let requests = 0
  let noiseRequests = 0
  const input = createInterface({ input: process.stdin })
  for await (const line of input) {
    let request: Request
    try {
      request = JSON.parse(line) as Request
    } catch {
      write({ id: 0, ok: false, error: 'malformed signer request' })
      continue
    }
    requests++
    if (request.purpose === 'noise-static-key') noiseRequests++
    if (mode === 'pending') await new Promise<void>(() => {})
    if (mode === 'exit') process.exit(42)
    if (mode === 'reject') {
      write({ id: request.id, ok: false, error: 'teaching signer rejected request', requests, noiseRequests })
      continue
    }
    try {
      const active: TypedSigner = mode === 'wrong-key' ? wrongSigner : signer
      const signature = await signRequest(active, request)
      write({ id: request.id, ok: true, signatureDer: bytesToHex(signature), requests, noiseRequests })
    } catch (error) {
      write({ id: request.id, ok: false, error: error instanceof Error ? error.message : 'signing failed', requests, noiseRequests })
    }
  }
}

async function signRequest (signer: TypedSigner, request: Request): Promise<Uint8Array> {
  if (request.purpose === 'noise-static-key') {
    if (request.staticKeyHex == null) throw new Error('Noise static key is missing')
    const staticKey = hexToBytes(request.staticKeyHex)
    if (staticKey.length !== 32) throw new Error('Noise static key must be 32 bytes')
    return signer.signNoiseStaticKey(staticKey)
  }
  if (request.purpose !== 'peer-record' || request.peerId == null || request.addresses == null || request.sequence == null) {
    throw new Error('incomplete peer record request')
  }
  const record: PeerRecordInput = {
    peerId: parsePeerId(request.peerId),
    addresses: request.addresses.map(value => multiaddr(value)),
    sequence: BigInt(request.sequence)
  }
  return signer.signPeerRecord(record)
}

function argument (name: string): string | undefined {
  const index = process.argv.indexOf(name)
  return index < 0 ? undefined : process.argv[index + 1]
}

function hexToBytes (value: string): Uint8Array {
  if (value.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(value)) throw new Error('hex value is malformed')
  const output = new Uint8Array(value.length / 2)
  for (let index = 0; index < output.length; index++) output[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16)
  return output
}

function bytesToHex (value: Uint8Array): string {
  return Array.from(value, byte => byte.toString(16).padStart(2, '0')).join('')
}

function write (value: object): void {
  process.stdout.write(`${JSON.stringify(value)}\n`)
}

void main().catch(error => {
  process.stderr.write(`signer: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
})
