import { describe, expect, it, vi } from 'vitest'
import { readStreamToEnd } from '../src/stream/index.js'

describe('readStreamToEnd', () => {
  it('reads messages before remote half-close and returns a copied buffer', async () => {
    const stream = new FakeStream()
    const pending = readStreamToEnd(stream as any)
    const source = Uint8Array.from([1, 2, 3])
    stream.message(source)
    stream.remoteClose()

    const output = await pending
    source[0] = 9
    expect(output).toEqual(Uint8Array.from([1, 2, 3]))
    expect(stream.listenerCount()).toBe(0)
  })

  it('waits for queued bytes after remoteCloseWrite', async () => {
    const stream = new FakeStream()
    const pending = readStreamToEnd(stream as any)
    stream.bufferedBytes = 3
    stream.remoteClose()
    stream.message(Uint8Array.from([7, 8, 9]))

    await expect(pending).resolves.toEqual(Uint8Array.from([7, 8, 9]))
  })

  it('observes already-ended state and supports an empty response', async () => {
    const stream = new FakeStream()
    stream.readableEnded = true
    stream.remoteWriteStatus = 'closed'

    await expect(readStreamToEnd(stream as any)).resolves.toEqual(new Uint8Array())
  })

  it('does not treat local close() as remote EOF', async () => {
    vi.useFakeTimers()
    try {
      const stream = new FakeStream()
      const pending = readStreamToEnd(stream as any, { timeoutMs: 20 })
      const result = pending.then(() => undefined, error => error)
      await stream.close()
      await vi.advanceTimersByTimeAsync(20)
      await expect(result).resolves.toMatchObject({ code: 'ERR_STREAM_TIMEOUT' })
      expect(stream.abortCalls).toBe(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('accepts Uint8ArrayList-like chunks and enforces maxBytes', async () => {
    const stream = new FakeStream()
    const pending = readStreamToEnd(stream as any, { maxBytes: 4 })
    stream.message({ subarray: () => Uint8Array.from([1, 2]) })
    stream.message(Uint8Array.from([3, 4]))
    stream.remoteClose()
    await expect(pending).resolves.toEqual(Uint8Array.from([1, 2, 3, 4]))

    const tooLarge = new FakeStream()
    const rejected = readStreamToEnd(tooLarge as any, { maxBytes: 3 })
    tooLarge.message(Uint8Array.from([1, 2, 3, 4]))
    await expect(rejected).rejects.toMatchObject({ code: 'ERR_STREAM_TOO_LARGE' })
    expect(tooLarge.abortCalls).toBe(1)
  })

  it('rejects reset and generic close errors, while collecting graceful close data', async () => {
    const graceful = new FakeStream()
    const gracefulPending = readStreamToEnd(graceful as any)
    graceful.message(Uint8Array.from([4, 5]))
    graceful.transportClose()
    await expect(gracefulPending).resolves.toEqual(Uint8Array.from([4, 5]))

    const reset = new FakeStream()
    const resetPending = readStreamToEnd(reset as any)
    reset.reset(new Error('remote reset'))
    await expect(resetPending).rejects.toMatchObject({ code: 'ERR_STREAM_ABORTED' })

    const closed = new FakeStream()
    const closedPending = readStreamToEnd(closed as any)
    closed.errorClose(new Error('transport failed'))
    await expect(closedPending).rejects.toMatchObject({ code: 'ERR_STREAM_CLOSED' })
  })

  it('does not turn a reset state into a clean EOF when EOF notification wins the race', async () => {
    const stream = new FakeStream()
    const pending = readStreamToEnd(stream as any)
    stream.remoteCloseWithReset()
    await expect(pending).rejects.toMatchObject({ code: 'ERR_STREAM_ABORTED' })
  })

  it('supports external abort and removes every listener', async () => {
    const stream = new FakeStream()
    const controller = new AbortController()
    const pending = readStreamToEnd(stream as any, { signal: controller.signal, abortStreamOnError: false })
    controller.abort(new Error('caller cancelled'))
    await expect(pending).rejects.toMatchObject({ code: 'ERR_STREAM_ABORTED' })
    expect(stream.abortCalls).toBe(0)
    expect(stream.listenerCount()).toBe(0)
  })
})

class FakeStream extends EventTarget {
  status: 'open' | 'closed' | 'aborted' | 'reset' = 'open'
  readableEnded = false
  remoteWriteStatus: 'writable' | 'closed' = 'writable'
  bufferedBytes = 0
  abortCalls = 0
  private listeners = new Map<string, number>()

  addEventListener (type: string, listener: EventListenerOrEventListenerObject | null, options?: boolean | AddEventListenerOptions): void {
    super.addEventListener(type, listener, options)
    this.listeners.set(type, (this.listeners.get(type) ?? 0) + 1)
  }

  removeEventListener (type: string, listener: EventListenerOrEventListenerObject | null, options?: boolean | EventListenerOptions): void {
    super.removeEventListener(type, listener, options)
    this.listeners.set(type, Math.max(0, (this.listeners.get(type) ?? 0) - 1))
  }

  send (): boolean { return true }

  get readBufferLength (): number { return this.bufferedBytes }

  async close (): Promise<void> {
    // This is deliberately local-only, matching libp2p Stream.close().
  }

  abort (error: Error): void {
    this.abortCalls++
    this.status = 'aborted'
    this.bufferedBytes = 0
    const event = new Event('close') as Event & { error?: Error }
    event.error = error
    this.dispatchEvent(event)
  }

  message (data: Uint8Array | { subarray: () => Uint8Array }): void {
    this.bufferedBytes = 0
    const event = new Event('message') as Event & { data: Uint8Array | { subarray: () => Uint8Array } }
    event.data = data
    this.dispatchEvent(event)
  }

  remoteClose (): void {
    this.remoteWriteStatus = 'closed'
    this.dispatchEvent(new Event('remoteCloseWrite'))
    this.readableEnded = this.bufferedBytes === 0
    if (this.readableEnded) this.dispatchEvent(new Event('end'))
  }

  remoteCloseWithReset (): void {
    this.status = 'reset'
    this.remoteWriteStatus = 'closed'
    this.dispatchEvent(new Event('remoteCloseWrite'))
    this.readableEnded = this.bufferedBytes === 0
    if (this.readableEnded) this.dispatchEvent(new Event('end'))
  }

  transportClose (): void {
    this.status = 'closed'
    this.bufferedBytes = 0
    this.dispatchEvent(new Event('close'))
  }

  reset (error: Error): void {
    this.status = 'reset'
    const event = new Event('close') as Event & { error?: Error }
    event.error = error
    this.dispatchEvent(event)
  }

  errorClose (error: Error): void {
    this.status = 'closed'
    const event = new Event('close') as Event & { error?: Error }
    event.error = error
    this.dispatchEvent(event)
  }

  listenerCount (): number {
    return [...this.listeners.values()].reduce((total, count) => total + count, 0)
  }
}
