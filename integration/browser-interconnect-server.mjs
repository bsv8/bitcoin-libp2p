import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { extname, join, normalize, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const integrationRoot = resolve(process.argv[2] ?? join(fileURLToPath(new URL('.', import.meta.url)), '../../typescript/dist-integration'))
const html = resolve(fileURLToPath(new URL('./browser/interconnect.html', import.meta.url)))
const port = Number(process.argv[3] ?? 0)
const token = process.env.BROWSER_INTERCONNECT_TOKEN ?? ''
const types = { '.html': 'text/html', '.js': 'text/javascript', '.map': 'application/json' }
const signals = new Map()
let nextSignalId = 1

function authorized (request) {
  return token !== '' && request.headers['x-interconnect-token'] === token
}

function json (response, status, value) {
  response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
  response.end(JSON.stringify(value))
}

async function body (request) {
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    size += chunk.length
    if (size > 1024 * 1024) throw new Error('signal body too large')
    chunks.push(chunk)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    if (url.pathname === '/signals') {
      if (!authorized(request)) return json(response, 401, { error: 'unauthorized' })
      if (request.method === 'GET') {
        const to = url.searchParams.get('to') ?? ''
        const after = Number(url.searchParams.get('after') ?? '0')
        if (!Number.isSafeInteger(after) || after < 0) return json(response, 400, { error: 'invalid cursor' })
        const deadline = Date.now() + 10_000
        let pending = signals.get(to) ?? []
        while (!pending.some(signal => signal.id > after) && Date.now() < deadline) {
          await new Promise(resolve => setTimeout(resolve, 50))
          pending = signals.get(to) ?? []
        }
        return json(response, 200, {
          cursor: nextSignalId - 1,
          signals: pending.filter(signal => signal.id > after)
        })
      }
      if (request.method !== 'POST') return json(response, 405, { error: 'method not allowed' })
      const signal = await body(request)
      if (signal == null || typeof signal.to !== 'string' || typeof signal.connectionId !== 'string' || typeof signal.attemptId !== 'string' || typeof signal.from !== 'string' || !Number.isSafeInteger(signal.sequence) || !Number.isFinite(signal.expiresAtMs) || signal.expiresAtMs <= Date.now() || signal.signal == null || typeof signal.signal.type !== 'string') {
        return json(response, 400, { error: 'invalid signal' })
      }
      const stored = { ...signal, id: nextSignalId++ }
      const pending = signals.get(signal.to) ?? []
      pending.push(stored)
      signals.set(signal.to, pending)
      response.writeHead(204)
      response.end()
      return
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.writeHead(405)
      response.end()
      return
    }
    const pathname = url.pathname === '/' ? html : resolve(integrationRoot, `.${normalize(url.pathname)}`)
    if (pathname !== html && !pathname.startsWith(`${integrationRoot}${sep}`)) {
      response.writeHead(404)
      response.end('not found')
      return
    }
    const content = await readFile(pathname)
    response.writeHead(200, { 'content-type': types[extname(pathname)] ?? 'application/octet-stream', 'cache-control': 'no-store' })
    response.end(request.method === 'HEAD' ? undefined : content)
  } catch (error) {
    response.writeHead(400)
    response.end(error instanceof Error ? error.message : 'bad request')
  }
})

server.listen(port, '127.0.0.1', () => {
  const address = server.address()
  if (typeof address === 'object' && address != null) console.log(`READY ${address.port}`)
})
