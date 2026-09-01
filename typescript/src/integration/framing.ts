// Test-only JSON adapter for cross-language uvarint framing checks. It is not
// part of the published SDK runtime.
import { readFileSync } from 'node:fs'
import { encodeUvarintFrame, readUvarintFrames } from '../stream/index.js'

type Request = {
  payloads?: string[]
  frames?: string[]
  chunks?: string[]
  input?: string
  maxInboundFrameBytes?: number
}

type Response = {
  event: 'encoded' | 'decoded' | 'error'
  frames?: string[]
  payloads?: string[]
  code?: string
}

async function main (): Promise<void> {
  const input = JSON.parse(readFileSync(0, 'utf8')) as Request
  const modeIndex = process.argv.indexOf('--mode')
  const mode = modeIndex >= 0 ? (process.argv[modeIndex + 1] ?? 'encode') : 'encode'

  if (mode === 'encode') {
    emit({
      event: 'encoded',
      frames: (input.payloads ?? []).map(value => toHex(encodeUvarintFrame(fromHex(value))))
    })
  } else if (mode === 'decode' || mode === 'invalid') {
    await decode(mode === 'invalid' ? { ...input, chunks: [input.input ?? ''] } : input)
  } else {
    throw new Error(`unsupported mode ${mode}`)
  }
}

async function decode (request: Request): Promise<void> {
  const stream = new CLIStream()
  const iterator = readUvarintFrames(stream as any, {
    maxInboundFrameBytes: request.maxInboundFrameBytes,
    abortStreamOnError: false
  })
  const pending = collect(iterator)
  for (const chunk of request.chunks ?? request.frames ?? []) stream.message(fromHex(chunk))
  stream.remoteClose()
  try {
    emit({ event: 'decoded', payloads: (await pending).map(toHex) })
  } catch (error) {
    emit({ event: 'error', code: stableCode(error) })
  }
}

async function collect (iterator: AsyncIterableIterator<Uint8Array>): Promise<Uint8Array[]> {
  const output: Uint8Array[] = []
  for await (const value of iterator) output.push(value)
  return output
}

function stableCode (error: unknown): string {
  if (typeof error === 'object' && error != null && 'code' in error) {
    const code = (error as { code?: unknown }).code
    if (typeof code === 'string') return code
  }
  return 'UNKNOWN'
}

function fromHex (value: string): Uint8Array {
  const clean = value.replaceAll(' ', '')
  if (clean.length % 2 !== 0) throw new Error(`odd hex length: ${value}`)
  const output = new Uint8Array(clean.length / 2)
  for (let index = 0; index < output.length; index++) output[index] = Number.parseInt(clean.slice(index * 2, index * 2 + 2), 16)
  return output
}

function toHex (value: Uint8Array): string {
  return [...value].map(byte => byte.toString(16).padStart(2, '0')).join('')
}

function emit (value: Response): void {
  process.stdout.write(`${JSON.stringify(value)}\n`)
}

class CLIStream extends EventTarget {
  status: 'open' | 'closed' | 'aborted' | 'reset' = 'open'
  readableEnded = false
  remoteWriteStatus: 'writable' | 'closed' = 'writable'
  readBufferLength = 0

  send (): boolean { return true }
  async close (): Promise<void> {}
  abort (): void { this.status = 'aborted' }

  message (data: Uint8Array): void {
    const event = new Event('message') as Event & { data?: Uint8Array }
    event.data = data
    this.dispatchEvent(event)
  }

  remoteClose (): void {
    this.remoteWriteStatus = 'closed'
    this.dispatchEvent(new Event('remoteCloseWrite'))
    this.readableEnded = true
    this.dispatchEvent(new Event('end'))
  }
}

await main()
