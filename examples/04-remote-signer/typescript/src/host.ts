// Demo 04 keeps the host flow readable while the raw private key stays in the
// sibling signer process. Its JSONL transport is local teaching code only.
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { tcp } from '@libp2p/tcp'
import { multiaddr } from '@multiformats/multiaddr'
import { authenticateConnection, createHost } from 'bitcoin-libp2p/libp2p'
import { peerIdFromPublicKeyBytes, peerRecordUnsigned, type PeerRecordInput } from 'bitcoin-libp2p/identity'
import type { TypedSigner } from 'bitcoin-libp2p/signer'
import { readStreamToEnd } from 'bitcoin-libp2p/stream'

const PROTOCOL = '/bitcoin-libp2p/demo/hello/1.0.0'
const MAX_MESSAGE = 1 << 10

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

interface Ready {
  event: 'ready'
  publicKey: string
  pid: number
}

interface Lifecycle {
  event: 'closed' | 'failure'
  error?: string
  hostPid: number
  signerPid: number
  signerRequests: number
  signerNoiseRequests: number
  pendingSignerRequests: number
}

class ProcessSigner implements TypedSigner {
  readonly #child: ChildProcessWithoutNullStreams
  readonly #pending = new Map<number, { resolve: (value: Uint8Array) => void, reject: (error: Error) => void, onAbort: () => void, signal?: AbortSignal }>()
  readonly #ready: Promise<void>
  #resolveReady!: () => void
  #rejectReady!: (error: Error) => void
  #buffer = ''
  #publicKey?: Uint8Array
  #nextID = 1
  #requests = 0
  #noiseRequests = 0
  #ended = false
  #readySettled = false
  #closePromise?: Promise<void>

  private constructor (child: ChildProcessWithoutNullStreams) {
    this.#child = child
    this.#ready = new Promise<void>((resolve, reject) => {
      this.#resolveReady = resolve
      this.#rejectReady = reject
    })
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', chunk => this.#onData(String(chunk)))
    child.on('error', error => this.#end(error))
    child.on('exit', (code, signal) => this.#end(new Error(`signer child exited (${code ?? signal ?? 'unknown'})`)))
  }

  static start (mode: string): ProcessSigner {
    const signerPath = fileURLToPath(new URL('./signer.js', import.meta.url))
    const child = spawn(process.execPath, [signerPath, '--mode', mode], { stdio: ['pipe', 'pipe', 'pipe'] })
    child.stderr.on('data', chunk => process.stderr.write(String(chunk)))
    return new ProcessSigner(child)
  }

  async ready (): Promise<void> { await this.#ready }

  publicKey (): Uint8Array {
    if (this.#publicKey == null) throw new Error('signer child is not ready')
    return new Uint8Array(this.#publicKey)
  }

  get pid (): number {
    if (this.#child.pid == null) throw new Error('signer child has no PID')
    return this.#child.pid
  }

  get requests (): number { return this.#requests }
  get noiseRequests (): number { return this.#noiseRequests }
  get pendingCount (): number { return this.#pending.size }

  signNoiseStaticKey (staticKey32: Uint8Array, signal?: AbortSignal): Promise<Uint8Array> {
    if (staticKey32.length !== 32) return Promise.reject(new Error('Noise static key must be 32 bytes'))
    return this.#request({ purpose: 'noise-static-key', staticKeyHex: bytesToHex(staticKey32) }, signal)
  }

  signPeerRecord (record: PeerRecordInput, signal?: AbortSignal): Promise<Uint8Array> {
    const publicKey = record.peerId.publicKey?.raw
    if (publicKey == null) return Promise.reject(new Error('peer record has no inline public key'))
    const expected = peerIdFromPublicKeyBytes(this.publicKey())
    peerRecordUnsigned(record, expected)
    return this.#request({
      purpose: 'peer-record', peerId: record.peerId.toString(),
      addresses: record.addresses.map(address => address.toString()), sequence: record.sequence.toString()
    }, signal)
  }

  async close (): Promise<void> {
    if (this.#closePromise != null) return this.#closePromise
    this.#closePromise = (async () => {
      this.#end(new Error('signer child stopped'))
      this.#child.stdin.destroy()
      if (this.#child.exitCode == null && this.#child.signalCode == null) this.#child.kill('SIGTERM')
      await Promise.race([
        new Promise<void>(resolve => this.#child.once('close', () => resolve())),
        new Promise<void>(resolve => setTimeout(resolve, 2_000))
      ])
      if (this.#child.exitCode == null && this.#child.signalCode == null) this.#child.kill('SIGKILL')
    })()
    return this.#closePromise
  }

  #request (request: Omit<Request, 'id'>, signal?: AbortSignal): Promise<Uint8Array> {
    if (signal?.aborted === true) return Promise.reject(reasonOf(signal))
    const id = this.#nextID++
    return new Promise<Uint8Array>((resolve, reject) => {
      const onAbort = (): void => {
        this.#pending.delete(id)
        reject(reasonOf(signal))
      }
      this.#pending.set(id, { resolve, reject, onAbort, signal })
      signal?.addEventListener('abort', onAbort, { once: true })
      try {
        this.#child.stdin.write(`${JSON.stringify({ ...request, id })}\n`)
      } catch (error) {
        this.#pending.delete(id)
        signal?.removeEventListener('abort', onAbort)
        reject(error instanceof Error ? error : new Error('failed to write signer request'))
      }
    })
  }

  #onData (chunk: string): void {
    if (this.#ended) return
    this.#buffer += chunk
    for (;;) {
      const newline = this.#buffer.indexOf('\n')
      if (newline < 0) return
      const line = this.#buffer.slice(0, newline)
      this.#buffer = this.#buffer.slice(newline + 1)
      try {
        const value = JSON.parse(line) as Ready & Response
        if (!this.#readySettled) {
          if (value.event !== 'ready' || value.publicKey == null) throw new Error('malformed signer ready event')
          this.#publicKey = validatePublicKeyHex(value.publicKey)
          this.#readySettled = true
          this.#resolveReady()
        } else {
          this.#onResponse(value)
        }
      } catch (error) {
        this.#end(error instanceof Error ? error : new Error('malformed signer response'))
      }
    }
  }

  #onResponse (response: Response): void {
    const pending = this.#pending.get(response.id)
    if (pending == null) return
    this.#pending.delete(response.id)
    pending.signal?.removeEventListener('abort', pending.onAbort)
    this.#requests = response.requests ?? this.#requests
    this.#noiseRequests = response.noiseRequests ?? this.#noiseRequests
    if (!response.ok || response.signatureDer == null) {
      pending.reject(new Error(response.error ?? 'signer rejected request'))
      return
    }
    try {
      pending.resolve(hexToBytes(response.signatureDer))
    } catch {
      pending.reject(new Error('signer returned malformed signature'))
    }
  }

  #end (error: Error): void {
    if (this.#ended) return
    this.#ended = true
    if (!this.#readySettled) {
      this.#readySettled = true
      this.#rejectReady(error)
    }
    for (const pending of this.#pending.values()) {
      pending.signal?.removeEventListener('abort', pending.onAbort)
      pending.reject(error)
    }
    this.#pending.clear()
  }
}

async function main (): Promise<void> {
  const mode = option('--mode') ?? 'server'
  if (mode !== 'server' && mode !== 'client') throw new Error('--mode must be server or client')
  let signer: ProcessSigner | undefined
  let node: Awaited<ReturnType<typeof createHost>> | undefined
  let failure: Error | undefined
  let closePromise: Promise<void> | undefined
  let close: (() => Promise<void>) | undefined
  let onSignal: (() => void) | undefined
  try {
    signer = ProcessSigner.start(option('--signer-mode') ?? 'normal')
    await signer.ready()
    node = await createHost({
      signer,
      listenAddrs: mode === 'server' ? [multiaddr(option('--listen') ?? '/ip4/127.0.0.1/tcp/0')] : [],
      transports: [tcp()],
      signTimeoutMs: positiveNumber(option('--sign-timeout-ms'))
    })
    const abort = new AbortController()
    close = async (): Promise<void> => {
      closePromise ??= (async () => {
        abort.abort(new Error('host stopped'))
        await node?.stop()
        await signer?.close()
      })()
      await closePromise
    }
    onSignal = (): void => {
      process.exitCode = 130
      process.stdin.destroy()
      void close?.()
    }
    process.once('SIGINT', onSignal)
    process.once('SIGTERM', onSignal)
    await node.handle(PROTOCOL, async stream => {
      const input = await readStreamToEnd(stream)
      if (input.length === 0 || input.length > MAX_MESSAGE || !isUtf8(input)) {
        stream.abort(new Error('invalid Hello message'))
        return
      }
      stream.send(new TextEncoder().encode(`hello, ${new TextDecoder().decode(input)}`))
      await stream.close()
    })
    if (mode === 'server') {
      const listen = node.getMultiaddrs()[0]?.decapsulateCode(421)
      if (listen == null) throw new Error('host did not listen')
      emit({
        event: 'ready', demo: 'typescript-remote-signer', language: 'typescript',
        peerId: node.peerId.toString(), publicKey: bytesToHex(signer.publicKey()),
        address: listen.encapsulate(multiaddr(`/p2p/${node.peerId.toString()}`)).toString(), protocol: PROTOCOL,
        hostPid: process.pid, signerPid: signer.pid, signerRequests: signer.requests,
        signerNoiseRequests: signer.noiseRequests, pendingSignerRequests: signer.pendingCount
      })
      await waitForStop()
      return
    }

    const dialValue = option('--dial')
    if (dialValue == null) throw new Error('--dial is required in client mode')
    const message = option('--message') ?? 'hello'
    const encoded = new TextEncoder().encode(message)
    if (encoded.length === 0 || encoded.length > MAX_MESSAGE || !isUtf8(encoded)) throw new Error(`--message must be non-empty valid UTF-8 of at most ${MAX_MESSAGE} bytes`)
    const remoteAddress = multiaddr(dialValue)
    const addressPeerId = remoteAddress.getComponents().find(component => component.name === 'p2p')?.value
    if (addressPeerId == null) throw new Error('--dial must contain a /p2p component')
    const stopAfter = positiveNumber(option('--host-stop-after-ms'))
    let stopTimer: ReturnType<typeof setTimeout> | undefined
    if (stopAfter != null) stopTimer = setTimeout(() => { void close?.() }, stopAfter)
    const signerNoiseRequestsBefore = signer.noiseRequests
    const connection = await node.dial(remoteAddress, { signal: AbortSignal.any([abort.signal, AbortSignal.timeout(15_000)]) })
    const authenticated = authenticateConnection(connection, {
      peerId: option('--expect-peer-id'),
      publicKey: option('--expect-public-key') == null ? undefined : hexToBytes(option('--expect-public-key') as string)
    })
    for (let streamNumber = 0; streamNumber < 2; streamNumber++) {
      const stream = await connection.newStream(PROTOCOL, { signal: AbortSignal.any([abort.signal, AbortSignal.timeout(15_000)]) })
      const responsePromise = readStreamToEnd(stream)
      stream.send(encoded)
      await stream.close()
      const response = new TextDecoder('utf-8', { fatal: true }).decode(await responsePromise)
      if (response !== `hello, ${message}`) throw new Error('Hello response did not match')
    }
    if (stopTimer != null) clearTimeout(stopTimer)
    emit({
      event: 'hello', demo: 'typescript-remote-signer', language: 'typescript',
      remotePeerId: authenticated.peerId.toString(), remotePublicKey: bytesToHex(authenticated.publicKey),
      remoteAddress: remoteAddress.toString(), addressPeerId, request: message, response: `hello, ${message}`, streams: 2,
      hostPid: process.pid, signerPid: signer.pid, signerRequests: signer.requests,
      signerNoiseRequestsBefore,
      signerNoiseRequests: signer.noiseRequests, pendingSignerRequests: signer.pendingCount
    })
    await close()
  } catch (error) {
    failure = error instanceof Error ? error : new Error(String(error))
    throw failure
  } finally {
    if (onSignal != null) {
      process.removeListener('SIGINT', onSignal)
      process.removeListener('SIGTERM', onSignal)
    }
    if (close != null) await close().catch(() => {})
    else {
      if (node != null) await Promise.resolve(node.stop()).catch(() => {})
      if (signer != null) await signer.close().catch(() => {})
    }
    if (signer != null) {
      const lifecycle: Lifecycle = {
        event: failure == null ? 'closed' : 'failure',
        ...(failure == null ? {} : { error: failure.message }),
        hostPid: process.pid, signerPid: signer.pid, signerRequests: signer.requests,
        signerNoiseRequests: signer.noiseRequests, pendingSignerRequests: signer.pendingCount
      }
      try { emit(lifecycle) } catch {}
    }
  }
}

function validatePublicKeyHex (value: string): Uint8Array {
  const key = hexToBytes(value)
  if (key.length !== 33 || (key[0] !== 2 && key[0] !== 3)) throw new Error('signer public key is invalid')
  return key
}

function positiveNumber (value: string | undefined): number | undefined {
  if (value == null) return undefined
  const number = Number(value)
  if (!Number.isFinite(number) || number <= 0) throw new Error('numeric option must be positive')
  return number
}

function option (name: string): string | undefined {
  const index = process.argv.indexOf(name)
  return index < 0 ? undefined : process.argv[index + 1]
}

function reasonOf (signal?: AbortSignal): Error {
  return signal?.reason instanceof Error ? signal.reason : new DOMException('The operation was aborted', 'AbortError')
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

function isUtf8 (value: Uint8Array): boolean {
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(value)
    return true
  } catch {
    return false
  }
}

async function waitForStop (): Promise<void> {
  await new Promise<void>(resolve => {
    const input = createInterface({ input: process.stdin })
    input.once('close', () => { input.close(); resolve() })
  })
}

function emit (value: object): void { process.stdout.write(`${JSON.stringify(value)}\n`) }

void main().catch(error => {
  process.stderr.write(`fatal: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
})
