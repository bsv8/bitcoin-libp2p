import type { Stream, StreamCloseEvent } from '@libp2p/interface'

/** 默认本地接收上限：1 MiB；不会写入 frame 或发送给对端。 */
export const DEFAULT_MAX_INBOUND_FRAME_BYTES = 1024 * 1024

/** 默认内部未消费字节上限：4 MiB；不会写入 frame 或发送给对端。 */
export const DEFAULT_MAX_BUFFERED_BYTES = 4 * 1024 * 1024

/** 默认内部未消费帧数上限：1024；不会写入 frame 或发送给对端。 */
export const DEFAULT_MAX_BUFFERED_FRAMES = 1024

/** uvarint 分帧层使用的稳定错误码。 */
export type StreamFrameErrorCode =
  | 'ERR_FRAME_PREFIX'
  | 'ERR_FRAME_TOO_LARGE'
  | 'ERR_FRAME_BUFFER_FULL'
  | 'ERR_FRAME_TRUNCATED'
  | 'ERR_FRAME_STREAM'

/**
 * uvarint Stream 分帧错误。
 *
 * `code` 用于稳定控制流；`cause` 只保留底层错误供本地诊断，不参与英文
 * 错误文本匹配。
 */
export class StreamFrameError extends Error {
  readonly code: StreamFrameErrorCode
  readonly cause: unknown

  constructor (code: StreamFrameErrorCode, message: string, options: { cause?: unknown } = {}) {
    super(message, { cause: options.cause })
    this.name = 'StreamFrameError'
    this.code = code
    this.cause = options.cause
  }
}

/** 将 payload 编码为一个独立的 `uvarint(byteLength) || payload` frame。 */
export function encodeUvarintFrame (payload: Uint8Array): Uint8Array {
  assertUint8Array(payload)
  const prefix = encodeUvarint(payload.byteLength)
  const frame = new Uint8Array(prefix.byteLength + payload.byteLength)
  frame.set(prefix)
  frame.set(payload, prefix.byteLength)
  return frame
}

/**
 * 编码并只调用一次 `stream.send`。
 * 返回值原样表示底层 Stream 是否仍可继续接收写入。
 */
export function writeUvarintFrame (stream: Stream, payload: Uint8Array): boolean {
  const frame = encodeUvarintFrame(payload)
  try {
    return stream.send(frame)
  } catch (cause) {
    throw new StreamFrameError('ERR_FRAME_STREAM', 'failed to send uvarint frame', { cause })
  }
}

export interface UvarintFramingOptions {
  /** 本地单个 payload 接收上限；只在创建 iterator 时读取，默认 1 MiB。 */
  maxInboundFrameBytes?: number
  /** 内部 raw buffer、部分 frame 和未消费 payload 的总字节上限，默认 4 MiB。 */
  maxBufferedBytes?: number
  /** 已完成但尚未交给业务的 payload 数量上限，默认 1024。 */
  maxBufferedFrames?: number
  /** 取消长期读取；取消后会清理 listener、等待队列和内部缓冲。 */
  signal?: AbortSignal
  /** 分帧、超限或底层 Stream 错误时是否 abort 当前 Stream；默认 true。 */
  abortStreamOnError?: boolean
}

/**
 * 持续读取一个 Stream 中的 uvarint frame。
 *
 * 该实现只注册一条 `message` listener，不使用 Stream 自带 async iterator。
 * 每次迭代只产生一个独立 payload；远端正常 EOF 且没有部分 frame 时结束。
 */
export function readUvarintFrames (stream: Stream, options: UvarintFramingOptions = {}): AsyncIterableIterator<Uint8Array> {
  const maxInboundFrameBytes = validateMaxInboundFrameBytes(options.maxInboundFrameBytes ?? DEFAULT_MAX_INBOUND_FRAME_BYTES)
  const maxBufferedBytes = validateMaxBufferedLimit(options.maxBufferedBytes ?? DEFAULT_MAX_BUFFERED_BYTES, 'maxBufferedBytes')
  const maxBufferedFrames = validateMaxBufferedLimit(options.maxBufferedFrames ?? DEFAULT_MAX_BUFFERED_FRAMES, 'maxBufferedFrames')
  const signal = options.signal
  const abortStreamOnError = options.abortStreamOnError ?? true

  type TerminalState = 'open' | 'done' | 'error'
  type Waiter = {
    resolve: (result: IteratorResult<Uint8Array>) => void
    reject: (reason: unknown) => void
  }

  let state: TerminalState = 'open'
  let started = false
  let streamEOF = false
  let terminalError: StreamFrameError | undefined
  let eofCheckScheduled = false
  let expectedPayloadLength: number | undefined
  let prefixBytes: number[] = []
  let bufferedBytes = 0
  let bufferedOutputBytes = 0
  const chunks: Uint8Array[] = []
  const output: Uint8Array[] = []
  const waiters: Waiter[] = []

  const cleanup = (): void => {
    if (!started) return
    stream.removeEventListener('message', onMessage)
    stream.removeEventListener('remoteCloseWrite', onRemoteCloseWrite)
    stream.removeEventListener('end', onEnd)
    stream.removeEventListener('close', onClose)
    signal?.removeEventListener('abort', onAbort)
  }

  const clearInput = (): void => {
    chunks.length = 0
    bufferedBytes = 0
    prefixBytes = []
    expectedPayloadLength = undefined
  }

  const totalBufferedBytes = (): number => prefixBytes.length + bufferedBytes + bufferedOutputBytes

  const failBufferFull = (message: string): void => {
    failWithCode('ERR_FRAME_BUFFER_FULL', message)
  }

  const canAcceptChunk = (byteLength: number): boolean => {
    if (byteLength < 0 || !Number.isSafeInteger(byteLength)) {
      failWithCode('ERR_FRAME_STREAM', 'stream emitted a chunk with an invalid byte length')
      return false
    }
    const current = totalBufferedBytes()
    if (byteLength > maxBufferedBytes || current > maxBufferedBytes - byteLength) {
      failBufferFull(`buffered framing bytes exceed local limit (${maxBufferedBytes})`)
      return false
    }
    return true
  }

  const canQueueFrame = (): boolean => {
    if (waiters.length === 0 && output.length >= maxBufferedFrames) {
      failBufferFull(`buffered framing frames exceed local limit (${maxBufferedFrames})`)
      return false
    }
    if (totalBufferedBytes() > maxBufferedBytes) {
      failBufferFull(`buffered framing bytes exceed local limit (${maxBufferedBytes})`)
      return false
    }
    return true
  }

  const resolveWaiters = (): void => {
    while (waiters.length > 0) {
      const waiter = waiters.shift()
      if (waiter == null) return
      if (output.length > 0 && state !== 'error') {
        const value = output.shift() as Uint8Array
        bufferedOutputBytes -= value.byteLength
        waiter.resolve({ done: false, value })
      } else if (state === 'done') {
        waiter.resolve({ done: true, value: undefined })
      } else if (terminalError != null) {
        waiter.reject(terminalError)
      } else {
        waiters.unshift(waiter)
        return
      }
    }
  }

  const finishDone = (discardOutput: boolean): void => {
    if (state !== 'open') {
      if (discardOutput) {
        output.length = 0
        bufferedOutputBytes = 0
      }
      clearInput()
      resolveWaiters()
      return
    }
    state = 'done'
    cleanup()
    clearInput()
    if (discardOutput) {
      output.length = 0
      bufferedOutputBytes = 0
    }
    resolveWaiters()
  }

  const fail = (error: StreamFrameError): void => {
    if (state !== 'open') return
    state = 'error'
    terminalError = error
    cleanup()
    clearInput()
    output.length = 0
    bufferedOutputBytes = 0
    const pending = waiters.splice(0)
    if (abortStreamOnError) {
      try {
        stream.abort(error)
      } catch {
        // Stream may already have transitioned to a terminal state.
      }
    }
    for (const waiter of pending) waiter.reject(error)
  }

  const failWithCode = (code: StreamFrameErrorCode, message: string, cause?: unknown): void => {
    fail(new StreamFrameError(code, message, { cause }))
  }

  const takeOutput = (): Uint8Array => {
    const value = output.shift()
    if (value == null) throw new Error('framing output queue underflow')
    bufferedOutputBytes -= value.byteLength
    return value
  }

  const takeByte = (): number => {
    const first = chunks[0]
    if (first == null) throw new Error('framing buffer underflow')
    const value = first[0]
    if (first.byteLength === 1) {
      chunks.shift()
    } else {
      chunks[0] = first.subarray(1)
    }
    bufferedBytes--
    return value
  }

  const takeBytes = (length: number): Uint8Array => {
    const value = new Uint8Array(length)
    let offset = 0
    while (offset < length) {
      const first = chunks[0]
      if (first == null) throw new Error('framing buffer underflow')
      const count = Math.min(first.byteLength, length - offset)
      value.set(first.subarray(0, count), offset)
      offset += count
      bufferedBytes -= count
      if (count === first.byteLength) chunks.shift()
      else chunks[0] = first.subarray(count)
    }
    return value
  }

  const emitFrame = (payload: Uint8Array): boolean => {
    if (!canQueueFrame()) return false
    if (waiters.length > 0) {
      const waiter = waiters.shift()
      if (waiter != null) waiter.resolve({ done: false, value: payload })
      return true
    }
    output.push(payload)
    bufferedOutputBytes += payload.byteLength
    return true
  }

  const appendOwnedChunk = (chunk: Uint8Array): void => {
    if (chunk.byteLength === 0) return
    chunks.push(chunk)
    bufferedBytes += chunk.byteLength
  }

  const parsePrefix = (): number | undefined => {
    if (prefixBytes.length === 0 || (prefixBytes[prefixBytes.length - 1] & 0x80) !== 0) return undefined
    if (prefixBytes.length > 10) {
      failWithCode('ERR_FRAME_PREFIX', 'uvarint prefix is too long')
      return undefined
    }

    const lastData = prefixBytes[prefixBytes.length - 1] & 0x7f
    if (prefixBytes.length > 1 && lastData === 0) {
      failWithCode('ERR_FRAME_PREFIX', 'uvarint prefix is not minimally encoded')
      return undefined
    }

    let value = 0n
    for (let index = 0; index < prefixBytes.length; index++) {
      value |= BigInt(prefixBytes[index] & 0x7f) << BigInt(index * 7)
    }
    if (value > BigInt(maxInboundFrameBytes)) {
      failWithCode('ERR_FRAME_TOO_LARGE', `declared payload length exceeds local limit (${maxInboundFrameBytes})`)
      return undefined
    }
    return Number(value)
  }

  const streamBufferedBytes = (): number => {
    const value = stream.readBufferLength
    return Number.isFinite(value) && value > 0 ? value : 0
  }

  const maybeFinish = (force: boolean = false): void => {
    if (state !== 'open' || !streamEOF || streamBufferedBytes() !== 0) return
    if (prefixBytes.length !== 0 || expectedPayloadLength != null || bufferedBytes !== 0) {
      failWithCode('ERR_FRAME_TRUNCATED', 'stream ended before a complete uvarint frame was received')
      return
    }
    if (!force && stream.status !== 'closed' && !stream.readableEnded && !eofCheckScheduled) {
      eofCheckScheduled = true
      queueMicrotask(() => {
        eofCheckScheduled = false
        maybeFinish(true)
      })
      return
    }
    finishDone(false)
  }

  const pump = (): void => {
    while (state === 'open') {
      if (expectedPayloadLength == null) {
        while (bufferedBytes > 0 && expectedPayloadLength == null) {
          const byte = takeByte()
          prefixBytes.push(byte)
          if (
            prefixBytes.length > 10 ||
            (prefixBytes.length === 10 && ((byte & 0x80) !== 0 || (byte & 0x7f) > 1))
          ) {
            failWithCode('ERR_FRAME_PREFIX', 'uvarint prefix is too long or overflows uint64')
            return
          }
          if ((byte & 0x80) === 0) {
            expectedPayloadLength = parsePrefix()
            prefixBytes = []
            if (state !== 'open') return
            if (expectedPayloadLength === 0) {
              if (!canQueueFrame()) return
              emitFrame(new Uint8Array())
              expectedPayloadLength = undefined
              resolveWaiters()
            }
          }
        }
      }

      if (state !== 'open') return
      // A prefix may legitimately span multiple message chunks. Stop here
      // until the next message instead of spinning while it is incomplete.
      if (expectedPayloadLength == null) {
        if (prefixBytes.length !== 0 || bufferedBytes === 0) break
        continue
      }
      if (bufferedBytes < expectedPayloadLength) break
      if (!canQueueFrame()) return
      emitFrame(takeBytes(expectedPayloadLength))
      expectedPayloadLength = undefined
      resolveWaiters()
    }
    maybeFinish()
  }

  const onMessage = (event: Event): void => {
    if (state !== 'open') return
    try {
      const data = (event as Event & { data: unknown }).data
      const declaredLength = chunkByteLength(data)
      if (!canAcceptChunk(declaredLength)) return
      const chunk = copyChunk(data)
      if (chunk.byteLength !== declaredLength) {
        failWithCode('ERR_FRAME_STREAM', 'stream emitted a chunk with an inconsistent byte length')
        return
      }
      appendOwnedChunk(chunk)
      pump()
    } catch (cause) {
      failWithCode('ERR_FRAME_STREAM', 'stream emitted an invalid message chunk', cause)
    }
  }

  const onRemoteCloseWrite = (): void => {
    streamEOF = true
    pump()
  }

  const onEnd = (): void => {
    if (isAbortedOrReset(stream.status)) {
      failWithCode('ERR_FRAME_STREAM', `stream ended in ${stream.status} state`)
      return
    }
    streamEOF = true
    pump()
    maybeFinish(true)
  }

  const onClose = (event: Event): void => {
    const closeEvent = event as StreamCloseEvent
    if (closeEvent.error != null || isAbortedOrReset(stream.status)) {
      failWithCode('ERR_FRAME_STREAM', 'stream closed with an error', closeEvent.error ?? new Error(`stream is ${stream.status}`))
      return
    }
    streamEOF = true
    pump()
    maybeFinish(true)
  }

  const onAbort = (): void => {
    failWithCode('ERR_FRAME_STREAM', 'stream frame read was aborted', signal?.reason)
  }

  const start = (): void => {
    if (started) return
    started = true
    try {
      stream.addEventListener('message', onMessage)
      stream.addEventListener('remoteCloseWrite', onRemoteCloseWrite)
      stream.addEventListener('end', onEnd)
      stream.addEventListener('close', onClose)
      signal?.addEventListener('abort', onAbort, { once: true })

      if (signal?.aborted === true) {
        onAbort()
        return
      }
      if (isAbortedOrReset(stream.status)) {
        failWithCode('ERR_FRAME_STREAM', `stream is already ${stream.status}`)
        return
      }
      if (stream.readableEnded || stream.remoteWriteStatus !== 'writable' || stream.status === 'closed') streamEOF = true
      pump()
    } catch (cause) {
      failWithCode('ERR_FRAME_STREAM', 'failed to attach stream frame listeners', cause)
    }
  }

  const next = (): Promise<IteratorResult<Uint8Array>> => {
    if (state === 'error') return Promise.reject(terminalError)
    if (output.length > 0) return Promise.resolve({ done: false, value: takeOutput() })
    if (state === 'done') return Promise.resolve({ done: true, value: undefined })
    start()
    if ((state as TerminalState) === 'error') return Promise.reject(terminalError)
    if (output.length > 0) return Promise.resolve({ done: false, value: takeOutput() })
    if ((state as TerminalState) === 'done') return Promise.resolve({ done: true, value: undefined })
    return new Promise<IteratorResult<Uint8Array>>((resolve, reject) => {
      waiters.push({ resolve, reject })
    })
  }

  const finishEarly = (): Promise<IteratorResult<Uint8Array>> => {
    finishDone(true)
    return Promise.resolve({ done: true, value: undefined })
  }

  const throwFromConsumer = (reason?: unknown): Promise<IteratorResult<Uint8Array>> => {
    const error = reason instanceof StreamFrameError
      ? reason
      : new StreamFrameError('ERR_FRAME_STREAM', 'stream frame iterator was terminated by the consumer', { cause: reason })
    fail(error)
    return Promise.reject(error)
  }

  const iterator: AsyncIterableIterator<Uint8Array> = {
    next,
    return: finishEarly,
    throw: throwFromConsumer,
    [Symbol.asyncIterator] () { return this }
  }
  return iterator
}

function encodeUvarint (value: number): Uint8Array {
  const bytes: number[] = []
  let remaining = value
  do {
    let byte = remaining % 128
    remaining = Math.floor(remaining / 128)
    if (remaining !== 0) byte |= 0x80
    bytes.push(byte)
  } while (remaining !== 0)
  return Uint8Array.from(bytes)
}

function validateMaxInboundFrameBytes (value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError('maxInboundFrameBytes must be a positive safe integer')
  }
  return value
}

function validateMaxBufferedLimit (value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive safe integer`)
  }
  return value
}

function assertUint8Array (value: Uint8Array): void {
  if (!(value instanceof Uint8Array)) throw new TypeError('payload must be a Uint8Array')
}

function copyChunk (value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return new Uint8Array(value)
  if (typeof value !== 'object' || value == null) throw new TypeError('chunk is not a Uint8Array')
  const subarray = (value as { subarray?: unknown }).subarray
  if (typeof subarray !== 'function') throw new TypeError('chunk has no subarray()')
  const bytes = subarray.call(value) as unknown
  if (!(bytes instanceof Uint8Array)) throw new TypeError('subarray() did not return Uint8Array')
  return new Uint8Array(bytes)
}

function chunkByteLength (value: unknown): number {
  if (value instanceof Uint8Array) return value.byteLength
  if (typeof value !== 'object' || value == null) throw new TypeError('chunk is not a Uint8Array')
  const byteLength = (value as { byteLength?: unknown }).byteLength
  if (typeof byteLength !== 'number' || !Number.isSafeInteger(byteLength) || byteLength < 0) {
    throw new TypeError('chunk has no valid byteLength')
  }
  return byteLength
}

function isAbortedOrReset (status: string): boolean {
  return status === 'aborted' || status === 'reset'
}
