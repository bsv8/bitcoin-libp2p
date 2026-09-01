import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { UvarintFramingOptions } from '../src/stream/index.js'
import {
  DEFAULT_MAX_BUFFERED_BYTES,
  DEFAULT_MAX_BUFFERED_FRAMES,
  DEFAULT_MAX_INBOUND_FRAME_BYTES,
  encodeUvarintFrame,
  readUvarintFrames,
  writeUvarintFrame
} from '../src/stream/index.js'

type FixtureVector = {
  name: string
  payloadByteLength: number
  payloadHex?: string
  payloadPattern?: string
  prefixHex: string
}

type PayloadVector = {
  name: string
  payloadHex: string
}

type ChunkCase = {
  name: string
  frameNames: string[]
  chunkByteLengths: Array<number | 'all'>
  expectedFrameNames: string[]
}

type InvalidCase = {
  name: string
  inputHex: string
  code: 'ERR_FRAME_PREFIX' | 'ERR_FRAME_TOO_LARGE' | 'ERR_FRAME_BUFFER_FULL' | 'ERR_FRAME_TRUNCATED' | 'ERR_FRAME_STREAM'
}

type LimitCase = {
  name: string
  maxInboundFrameBytes: number
  frameName?: string
  inputHex?: string
  code: string
}

const fixture = JSON.parse(readFileSync(new URL('../../testdata/uvarint-framing-v1.json', import.meta.url), 'utf8')) as {
  fixedVectors: FixtureVector[]
  payloadVectors: PayloadVector[]
  chunkCases: ChunkCase[]
  invalidCases: InvalidCase[]
  limitCases: LimitCase[]
}

const fixedVectors = new Map(fixture.fixedVectors.map(vector => [vector.name, vector]))
const payloadVectors = new Map(fixture.payloadVectors.map(vector => [vector.name, vector]))

describe('uvarint framing byte contract', () => {
  it('matches every shared fixed length prefix and copies the payload', () => {
    for (const vector of fixture.fixedVectors) {
      const payload = fixedPayload(vector)
      const frame = encodeUvarintFrame(payload)
      expect(toHex(frame.subarray(0, vector.prefixHex.length / 2)), vector.name).toBe(vector.prefixHex)
      expect(frame.byteLength).toBe(vector.prefixHex.length / 2 + vector.payloadByteLength)
      const payloadOffset = vector.prefixHex.length / 2
      if (payload.byteLength <= 4096) {
        expect(frame.subarray(payloadOffset)).toEqual(payload)
      } else {
        expect(frame[payloadOffset]).toBe(payload[0])
        expect(frame[payloadOffset + 127]).toBe(payload[127])
        expect(frame[frame.length - 1]).toBe(payload[payload.length - 1])
      }
      if (payload.byteLength > 0) {
        payload[0] ^= 0xff
        expect(frame[payloadOffset]).not.toBe(payload[0])
      }
    }
  })

  it('encodes payload byteLength, sends one contiguous chunk, and preserves backpressure', () => {
    const stream = new FakeStream()
    stream.sendResult = false
    const payload = payloadBytes('utf8-chinese')
    const sent = writeUvarintFrame(stream as any, payload)

    expect(sent).toBe(false)
    expect(stream.sendCalls).toBe(1)
    expect(stream.sent).toHaveLength(1)
    expect(stream.sent[0]).toEqual(encodeUvarintFrame(payload))
    payload[0] ^= 0xff
    expect(stream.sent[0]).toEqual(encodeUvarintFrame(payloadBytes('utf8-chinese')))
  })

  it('reads binary payloads from all fixture chunk layouts', async () => {
    for (const chunkCase of fixture.chunkCases) {
      const stream = new FakeStream()
      const iterator = readUvarintFrames(stream as any)
      const pending = collect(iterator)
      const input = concat(chunkCase.frameNames.map(frameName => encodeUvarintFrame(namedPayload(frameName))))
      const chunks = split(input, chunkCase.chunkByteLengths)
      for (const chunk of chunks) {
        const source = new Uint8Array(chunk)
        stream.message(source)
        source.fill(0xee)
      }
      stream.remoteClose()
      const frames = await pending
      expect(frames.map(toHex), chunkCase.name).toEqual(chunkCase.expectedFrameNames.map(frameName => toHex(namedPayload(frameName))))
      expect(stream.listenerCount(), chunkCase.name).toBe(0)
    }
  })

  it('allows the exact default limit, but rejects one byte over it before payload allocation', async () => {
    expect(DEFAULT_MAX_INBOUND_FRAME_BYTES).toBe(1048576)
    const exact = fixture.limitCases.find(value => value.code === '')
    if (exact?.frameName == null) throw new Error('fixture exact-limit case is missing')
    const exactStream = new FakeStream()
    const exactIterator = readUvarintFrames(exactStream as any, {
      maxInboundFrameBytes: exact.maxInboundFrameBytes
    })
    const exactPending = exactIterator.next()
    const exactPayload = namedPayload(exact.frameName)
    const exactFrame = encodeUvarintFrame(exactPayload)
    exactStream.message(exactFrame)
    exactStream.remoteClose()
    const exactResult = await exactPending
    expect(exactResult.done).toBe(false)
    expect(exactResult.value.byteLength).toBe(exactPayload.byteLength)
    expect(exactResult.value[0]).toBe(exactPayload[0])
    expect(exactResult.value[exactResult.value.length - 1]).toBe(exactPayload[exactPayload.length - 1])
    await exactIterator.return?.()

    const tooLarge = fixture.limitCases.find(value => value.code === 'ERR_FRAME_TOO_LARGE')
    if (tooLarge?.inputHex == null) throw new Error('fixture over-limit case is missing')
    const tooLargeStream = new FakeStream()
    const iterator = readUvarintFrames(tooLargeStream as any, {
      maxInboundFrameBytes: tooLarge.maxInboundFrameBytes
    })
    const pending = iterator.next()
    tooLargeStream.message(fromHex(tooLarge.inputHex))
    await expect(pending).rejects.toMatchObject({ code: 'ERR_FRAME_TOO_LARGE' })
    expect(tooLargeStream.abortCalls).toBe(1)
    expect(tooLargeStream.payloadReadRequests).toBe(0)
    expect(tooLargeStream.listenerCount()).toBe(0)
  })

  it('bounds total buffered bytes before copying an incoming chunk', async () => {
    expect(DEFAULT_MAX_BUFFERED_BYTES).toBe(4 * 1024 * 1024)
    const exactStream = new FakeStream()
    const exactIterator = readUvarintFrames(exactStream as any, {
      maxBufferedBytes: 2,
      maxBufferedFrames: 8
    })
    const exactPending = exactIterator.next()
    exactStream.message(Uint8Array.from([1, 0xaa]))
    await expect(exactPending).resolves.toEqual({ done: false, value: Uint8Array.from([0xaa]) })
    expect(exactStream.abortCalls).toBe(0)
    await exactIterator.return?.()

    const fullStream = new FakeStream()
    const fullIterator = readUvarintFrames(fullStream as any, {
      maxBufferedBytes: 2,
      maxBufferedFrames: 8
    })
    const fullPending = fullIterator.next()
    fullStream.message(Uint8Array.from([1, 0xaa, 0xbb]))
    await expect(fullPending).rejects.toMatchObject({ code: 'ERR_FRAME_BUFFER_FULL' })
    expect(fullStream.abortCalls).toBe(1)
    expect(fullStream.listenerCount()).toBe(0)
    await expect(fullIterator.next()).rejects.toMatchObject({ code: 'ERR_FRAME_BUFFER_FULL' })
  })

  it('counts completed payload bytes already waiting in output', async () => {
    const stream = new FakeStream()
    const iterator = readUvarintFrames(stream as any, {
      maxBufferedBytes: 2,
      maxBufferedFrames: 8
    })
    const firstPending = iterator.next()
    stream.message(encodeUvarintFrame(Uint8Array.from([1])))
    await expect(firstPending).resolves.toEqual({ done: false, value: Uint8Array.from([1]) })
    stream.message(encodeUvarintFrame(Uint8Array.from([2])))
    stream.message(encodeUvarintFrame(Uint8Array.from([3])))
    await expect(iterator.next()).rejects.toMatchObject({ code: 'ERR_FRAME_BUFFER_FULL' })
    expect(stream.abortCalls).toBe(1)
    expect(stream.listenerCount()).toBe(0)
  })

  it('bounds queued frame count, including a large number of empty frames', async () => {
    expect(DEFAULT_MAX_BUFFERED_FRAMES).toBe(1024)
    const exactStream = new FakeStream()
    const exactIterator = readUvarintFrames(exactStream as any, {
      maxBufferedBytes: 64,
      maxBufferedFrames: 2
    })
    const firstPending = exactIterator.next()
    exactStream.message(Uint8Array.from([0, 0, 0]))
    await expect(firstPending).resolves.toEqual({ done: false, value: new Uint8Array() })
    await expect(exactIterator.next()).resolves.toEqual({ done: false, value: new Uint8Array() })
    await expect(exactIterator.next()).resolves.toEqual({ done: false, value: new Uint8Array() })
    await exactIterator.return?.()

    const fullStream = new FakeStream()
    const fullIterator = readUvarintFrames(fullStream as any, {
      maxBufferedBytes: 64,
      maxBufferedFrames: 2
    })
    const fullPending = fullIterator.next()
    fullStream.message(Uint8Array.from([0]))
    await expect(fullPending).resolves.toEqual({ done: false, value: new Uint8Array() })
    fullStream.message(Uint8Array.from([0, 0]))
    fullStream.message(Uint8Array.from([0]))
    await expect(fullIterator.next()).rejects.toMatchObject({ code: 'ERR_FRAME_BUFFER_FULL' })
    expect(fullStream.abortCalls).toBe(1)
    expect(fullStream.listenerCount()).toBe(0)
  })

  it('uses the options snapshot taken when the iterator is created', async () => {
    const stream = new FakeStream()
    const options = { maxInboundFrameBytes: 4, maxBufferedBytes: 2, maxBufferedFrames: 2 }
    const iterator = readUvarintFrames(stream as any, options)
    options.maxInboundFrameBytes = 1
    options.maxBufferedBytes = 1
    options.maxBufferedFrames = 1
    const pending = iterator.next()
    stream.message(encodeUvarintFrame(Uint8Array.from([1])))
    stream.remoteClose()
    await expect(pending).resolves.toEqual({ done: false, value: Uint8Array.from([1]) })
  })

  it('rejects invalid buffered limits synchronously when the iterator is created', () => {
    const invalidLimits: Array<['maxBufferedBytes' | 'maxBufferedFrames', number]> = [
      ['maxBufferedBytes', 0],
      ['maxBufferedBytes', -1],
      ['maxBufferedBytes', Number.NaN],
      ['maxBufferedBytes', 1.5],
      ['maxBufferedFrames', 0],
      ['maxBufferedFrames', -1],
      ['maxBufferedFrames', Number.NaN],
      ['maxBufferedFrames', 1.5]
    ]

    for (const [name, value] of invalidLimits) {
      const options = { [name]: value } as UvarintFramingOptions
      expect(() => readUvarintFrames(new FakeStream() as any, options), `${name}=${String(value)}`)
        .toThrowError(new RangeError(`${name} must be a positive safe integer`))
    }
  })

  for (const invalid of fixture.invalidCases) {
    it(`classifies ${invalid.name} with a stable code`, async () => {
      const stream = new FakeStream()
      const iterator = readUvarintFrames(stream as any)
      const pending = iterator.next()
      stream.message(fromHex(invalid.inputHex))
      if (invalid.code === 'ERR_FRAME_TRUNCATED') stream.remoteClose()
      await expect(pending).rejects.toMatchObject({ code: invalid.code })
      expect(stream.abortCalls).toBe(1)
      expect(stream.listenerCount()).toBe(0)
    })
  }

  it('classifies underlying close errors as stream errors and retains cause', async () => {
    const stream = new FakeStream()
    const iterator = readUvarintFrames(stream as any)
    const pending = iterator.next()
    const cause = new Error('transport failed')
    stream.errorClose(cause)
    await expect(pending).rejects.toMatchObject({ code: 'ERR_FRAME_STREAM', cause })
    expect(stream.listenerCount()).toBe(0)
  })

  it('cleans up and rejects pending reads when the stream is reset', async () => {
    const stream = new FakeStream()
    const iterator = readUvarintFrames(stream as any)
    const pending = iterator.next()
    const cause = new Error('stream reset')
    stream.reset(cause)
    await expect(pending).rejects.toMatchObject({ code: 'ERR_FRAME_STREAM', cause })
    expect(stream.abortCalls).toBe(1)
    expect(stream.listenerCount()).toBe(0)
  })

  it('supports external abort without leaving a pending promise or listener', async () => {
    const stream = new FakeStream()
    const controller = new AbortController()
    const iterator = readUvarintFrames(stream as any, {
      signal: controller.signal,
      abortStreamOnError: false
    })
    const pending = iterator.next()
    const reason = new Error('caller cancelled')
    controller.abort(reason)
    await expect(pending).rejects.toMatchObject({ code: 'ERR_FRAME_STREAM', cause: reason })
    expect(stream.abortCalls).toBe(0)
    expect(stream.listenerCount()).toBe(0)
    await expect(iterator.next()).rejects.toMatchObject({ code: 'ERR_FRAME_STREAM' })
  })

  it('can leave the stream open when the buffer limit fails', async () => {
    const stream = new FakeStream()
    const iterator = readUvarintFrames(stream as any, {
      maxBufferedBytes: 1,
      abortStreamOnError: false
    })
    const pending = iterator.next()
    stream.message(Uint8Array.from([1, 0xaa]))
    await expect(pending).rejects.toMatchObject({ code: 'ERR_FRAME_BUFFER_FULL' })
    expect(stream.abortCalls).toBe(0)
    expect(stream.listenerCount()).toBe(0)
  })

  it('cleans listeners, waiters, and buffered bytes when the iterator returns early', async () => {
    const stream = new FakeStream()
    const iterator = readUvarintFrames(stream as any)
    const pending = iterator.next()
    expect(stream.listenerCount()).toBe(4)
    await expect(iterator.return?.()).resolves.toEqual({ done: true, value: undefined })
    await expect(pending).resolves.toEqual({ done: true, value: undefined })
    expect(stream.listenerCount()).toBe(0)
    stream.message(encodeUvarintFrame(Uint8Array.from([1])))
    await expect(iterator.next()).resolves.toEqual({ done: true, value: undefined })
  })

  it('keeps a clean EOF distinct from a truncated frame', async () => {
    const emptyStream = new FakeStream()
    const emptyIterator = readUvarintFrames(emptyStream as any)
    const emptyPending = emptyIterator.next()
    emptyStream.remoteClose()
    await expect(emptyPending).resolves.toEqual({ done: true, value: undefined })
    expect(emptyStream.listenerCount()).toBe(0)

    const truncatedStream = new FakeStream()
    const truncatedIterator = readUvarintFrames(truncatedStream as any)
    const truncatedPending = truncatedIterator.next()
    truncatedStream.message(fromHex('80'))
    truncatedStream.remoteClose()
    await expect(truncatedPending).rejects.toMatchObject({ code: 'ERR_FRAME_TRUNCATED' })
  })

  it('accepts Uint8ArrayList-like message chunks without using a second iterator path', async () => {
    const stream = new FakeStream()
    const iterator = readUvarintFrames(stream as any)
    const pending = collect(iterator)
    const frame = encodeUvarintFrame(payloadBytes('binary-mixed'))
    stream.message({ byteLength: frame.byteLength, subarray: () => frame })
    frame.fill(0xaa)
    stream.remoteClose()
    await expect(pending).resolves.toEqual([payloadBytes('binary-mixed')])
    expect(stream.messageListenerAdds).toBe(1)
    expect(stream.listenerCount()).toBe(0)
  })
})

function fixedPayload (vector: FixtureVector): Uint8Array {
  if (vector.payloadHex != null) return fromHex(vector.payloadHex)
  const payload = new Uint8Array(vector.payloadByteLength)
  if (vector.payloadPattern === 'incrementing-byte') {
    for (let index = 0; index < payload.length; index++) payload[index] = index & 0xff
  }
  return payload
}

function namedPayload (name: string): Uint8Array {
  const fixed = fixedVectors.get(name)
  if (fixed != null) return fixedPayload(fixed)
  return payloadBytes(name)
}

function payloadBytes (name: string): Uint8Array {
  const vector = payloadVectors.get(name)
  if (vector == null) throw new Error(`fixture payload ${name} is missing`)
  return fromHex(vector.payloadHex)
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

function concat (values: Uint8Array[]): Uint8Array {
  const output = new Uint8Array(values.reduce((total, value) => total + value.byteLength, 0))
  let offset = 0
  for (const value of values) {
    output.set(value, offset)
    offset += value.byteLength
  }
  return output
}

function split (input: Uint8Array, lengths: Array<number | 'all'>): Uint8Array[] {
  if (lengths.length === 1 && lengths[0] === 'all') return [new Uint8Array(input)]
  const output: Uint8Array[] = []
  let offset = 0
  for (const length of lengths) {
    if (length === 'all') throw new Error('all must be the only chunk length')
    output.push(input.slice(offset, offset + length))
    offset += length
  }
  if (offset !== input.byteLength) throw new Error(`fixture chunks cover ${offset}/${input.byteLength} bytes`)
  return output
}

async function collect (iterator: AsyncIterableIterator<Uint8Array>): Promise<Uint8Array[]> {
  const output: Uint8Array[] = []
  for await (const value of iterator) output.push(value)
  return output
}

class FakeStream extends EventTarget {
  status: 'open' | 'closed' | 'aborted' | 'reset' = 'open'
  readableEnded = false
  remoteWriteStatus: 'writable' | 'closed' = 'writable'
  bufferedBytes = 0
  abortCalls = 0
  sendCalls = 0
  sendResult = true
  sent: Uint8Array[] = []
  payloadReadRequests = 0
  messageListenerAdds = 0
  private listeners = new Map<string, number>()

  addEventListener (type: string, listener: EventListenerOrEventListenerObject | null, options?: boolean | AddEventListenerOptions): void {
    super.addEventListener(type, listener, options)
    this.listeners.set(type, (this.listeners.get(type) ?? 0) + 1)
    if (type === 'message') this.messageListenerAdds++
  }

  removeEventListener (type: string, listener: EventListenerOrEventListenerObject | null, options?: boolean | EventListenerOptions): void {
    super.removeEventListener(type, listener, options)
    this.listeners.set(type, Math.max(0, (this.listeners.get(type) ?? 0) - 1))
  }

  send (data: Uint8Array): boolean {
    this.sendCalls++
    this.sent.push(new Uint8Array(data))
    return this.sendResult
  }

  get readBufferLength (): number { return this.bufferedBytes }

  async close (): Promise<void> {}

  abort (error: Error): void {
    this.abortCalls++
    this.status = 'aborted'
    this.bufferedBytes = 0
    const event = new Event('close') as Event & { error?: Error }
    event.error = error
    this.dispatchEvent(event)
  }

  message (data: Uint8Array | { byteLength: number, subarray: () => Uint8Array }): void {
    this.bufferedBytes = 0
    const event = new Event('message') as Event & { data: Uint8Array | { byteLength: number, subarray: () => Uint8Array } }
    event.data = data
    this.dispatchEvent(event)
  }

  remoteClose (): void {
    this.remoteWriteStatus = 'closed'
    this.dispatchEvent(new Event('remoteCloseWrite'))
    this.readableEnded = this.bufferedBytes === 0
    if (this.readableEnded) this.dispatchEvent(new Event('end'))
  }

  errorClose (error: Error): void {
    this.status = 'closed'
    const event = new Event('close') as Event & { error?: Error }
    event.error = error
    this.dispatchEvent(event)
  }

  reset (error: Error): void {
    this.status = 'reset'
    this.bufferedBytes = 0
    const event = new Event('close') as Event & { error?: Error }
    event.error = error
    this.dispatchEvent(event)
  }

  listenerCount (): number {
    return [...this.listeners.values()].reduce((total, count) => total + count, 0)
  }
}
