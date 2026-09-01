import type { Stream, StreamCloseEvent, StreamMessageEvent } from '@libp2p/interface'

export {
  DEFAULT_MAX_BUFFERED_BYTES,
  DEFAULT_MAX_BUFFERED_FRAMES,
  DEFAULT_MAX_INBOUND_FRAME_BYTES,
  StreamFrameError,
  encodeUvarintFrame,
  readUvarintFrames,
  writeUvarintFrame
} from './framing.js'
export type { StreamFrameErrorCode, UvarintFramingOptions } from './framing.js'

/** `readStreamToEnd` 可返回的稳定错误码。 */
export type StreamIOErrorCode =
  | 'ERR_STREAM_TIMEOUT'
  | 'ERR_STREAM_ABORTED'
  | 'ERR_STREAM_TOO_LARGE'
  | 'ERR_STREAM_CLOSED'

/**
 * Stream 读操作错误。
 *
 * `code` 用于业务控制流；`cause` 和 `diagnostics` 只用于调试，不能作为
 * 稳定的错误分类依据。
 */
export class StreamIOError extends Error {
  readonly code: StreamIOErrorCode
  readonly diagnostics: readonly string[]

  constructor (code: StreamIOErrorCode, message: string, options: { cause?: unknown } = {}) {
    super(message, { cause: options.cause })
    this.name = 'StreamIOError'
    this.code = code
    this.diagnostics = collectDiagnostics(options.cause)
  }
}

/**
 * 读取一个 libp2p Stream 的全部远端响应。
 *
 * 该函数只使用 `message` 事件这一条消费路径；不会同时启动 async iterator，
 * 因此不会重复消费字节。远端半关闭后仍会等待读缓冲排空。
 */
export async function readStreamToEnd (stream: Stream, options: ReadStreamToEndOptions = {}): Promise<Uint8Array> {
  const timeoutMs = options.timeoutMs ?? 15_000
  const maxBytes = options.maxBytes ?? 1024 * 1024
  const abortStreamOnError = options.abortStreamOnError ?? true

  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new RangeError('timeoutMs must be a positive finite number')
  }
  if (!Number.isFinite(maxBytes) || maxBytes <= 0 || !Number.isSafeInteger(maxBytes)) {
    throw new RangeError('maxBytes must be a positive safe integer')
  }

  const chunks: Uint8Array[] = []
  let total = 0
  let remoteClosed = false
  let transportClosed = false
  let settled = false
  let timer: ReturnType<typeof setTimeout> | undefined

  return await new Promise<Uint8Array>((resolve, reject) => {
    const cleanup = (): void => {
      if (timer != null) clearTimeout(timer)
      options.signal?.removeEventListener('abort', onAbort)
      stream.removeEventListener('message', onMessage)
      stream.removeEventListener('remoteCloseWrite', onRemoteCloseWrite)
      stream.removeEventListener('end', onEnd)
      stream.removeEventListener('close', onClose)
    }

    const settle = (error?: StreamIOError): void => {
      if (settled) return
      if (error == null && (stream.status === 'aborted' || stream.status === 'reset')) {
        error = new StreamIOError('ERR_STREAM_ABORTED', `stream is ${stream.status}`)
      }
      settled = true
      cleanup()
      if (error != null) {
        if (abortStreamOnError) {
          try {
            stream.abort(error)
          } catch {
            // The stream may have closed between the error and the abort call.
          }
        }
        reject(error)
        return
      }

      const output = new Uint8Array(total)
      let offset = 0
      for (const chunk of chunks) {
        output.set(chunk, offset)
        offset += chunk.length
      }
      resolve(output)
    }

    const fail = (code: StreamIOErrorCode, message: string, cause?: unknown): void => {
      settle(new StreamIOError(code, message, { cause }))
    }

    const bufferedBytes = (): number => {
      const value = stream.readBufferLength
      return Number.isFinite(value) && value > 0 ? value : 0
    }

    const maybeFinish = (): void => {
      if (settled || (!remoteClosed && !transportClosed)) return
      // `end`/`remoteCloseWrite` may fire before the queued messages are
      // dispatched. Waiting for zero is what prevents a truncated response.
      if (bufferedBytes() !== 0) return
      settle()
    }

    const onMessage = (event: Event): void => {
      if (settled) return
      let chunk: Uint8Array
      try {
        chunk = copyChunk((event as StreamMessageEvent).data)
      } catch (error) {
        fail('ERR_STREAM_CLOSED', 'stream emitted an invalid message chunk', error)
        return
      }

      total += chunk.byteLength
      if (total > maxBytes) {
        fail('ERR_STREAM_TOO_LARGE', `stream response exceeded maxBytes (${maxBytes})`)
        return
      }
      chunks.push(chunk)
      maybeFinish()
    }

    const onRemoteCloseWrite = (): void => {
      remoteClosed = true
      maybeFinish()
    }

    const onEnd = (): void => {
      remoteClosed = true
      maybeFinish()
    }

    const onClose = (event: Event): void => {
      const closeEvent = event as StreamCloseEvent
      if (closeEvent.error != null) {
        const code = isResetOrAbort(closeEvent.error) || stream.status === 'aborted' || stream.status === 'reset'
          ? 'ERR_STREAM_ABORTED'
          : 'ERR_STREAM_CLOSED'
        fail(code, 'stream closed with an error', closeEvent.error)
        return
      }
      transportClosed = true
      maybeFinish()
    }

    const onAbort = (): void => {
      fail('ERR_STREAM_ABORTED', 'stream read was aborted', options.signal?.reason)
    }

    stream.addEventListener('message', onMessage)
    stream.addEventListener('remoteCloseWrite', onRemoteCloseWrite)
    stream.addEventListener('end', onEnd)
    stream.addEventListener('close', onClose)
    options.signal?.addEventListener('abort', onAbort, { once: true })

    timer = setTimeout(() => {
      fail('ERR_STREAM_TIMEOUT', `stream did not reach EOF within ${timeoutMs}ms`)
    }, timeoutMs)

    // Events may have fired before the consumer attached its listeners. These
    // state checks close that race without treating local close() as EOF.
    if (stream.status === 'aborted' || stream.status === 'reset') {
      fail('ERR_STREAM_ABORTED', `stream is already ${stream.status}`)
      return
    }
    if (stream.readableEnded || stream.remoteWriteStatus !== 'writable') remoteClosed = true
    if (stream.status === 'closed') transportClosed = true
    if (options.signal?.aborted === true) {
      onAbort()
      return
    }
    maybeFinish()
  })
}

export interface ReadStreamToEndOptions {
  /** 取消信号；触发后结束等待并清理监听器。 */
  signal?: AbortSignal
  /** 读取超时毫秒数，必须为正数；默认 15000。 */
  timeoutMs?: number
  /** 最大响应字节数，必须为正安全整数；默认 1 MiB。 */
  maxBytes?: number
  /** 超时、取消或越界时是否 abort 当前 stream；默认 true。 */
  abortStreamOnError?: boolean
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

function isResetOrAbort (error: Error): boolean {
  return /reset|abort/i.test(error.name)
}

const MAX_DIAGNOSTICS = 16
const MAX_DIAGNOSTIC_LENGTH = 240
const MAX_DIAGNOSTIC_DEPTH = 4

function collectDiagnostics (root: unknown): string[] {
  const output: string[] = []
  const visited = new Set<object>()

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
      return
    }
    if (value instanceof Error) {
      output.push(formatDiagnostic(value))
      visitCause(value, depth)
      return
    }
    output.push(sanitizeDiagnostic(String(value)))
  }

  const visitCause = (value: Error, depth: number): void => {
    let cause: unknown
    try {
      cause = value.cause
    } catch {
      return
    }
    if (cause !== undefined) visit(cause, depth + 1)
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
  return sanitized.length > MAX_DIAGNOSTIC_LENGTH
    ? `${sanitized.slice(0, MAX_DIAGNOSTIC_LENGTH)}…`
    : sanitized
}
