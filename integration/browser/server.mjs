import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { extname, join, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = normalize(process.argv[2] ?? join(fileURLToPath(new URL('.', import.meta.url)), '../../typescript/dist/integration'))
const html = normalize(join(fileURLToPath(new URL('.', import.meta.url)), 'index.html'))
const port = Number(process.argv[3] ?? 0)
const types = { '.html': 'text/html', '.js': 'text/javascript', '.map': 'application/json' }

const server = createServer(async (request, response) => {
  try {
    const pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname
    const path = pathname === '/' ? html : join(root, normalize(pathname).replace(/^\/+/, ''))
    const body = await readFile(path)
    response.writeHead(200, { 'content-type': types[extname(path)] ?? 'application/octet-stream' })
    response.end(body)
  } catch {
    response.writeHead(404)
    response.end('not found')
  }
})

server.listen(port, '127.0.0.1', () => {
  const address = server.address()
  if (typeof address === 'object' && address != null) console.log(`READY ${address.port}`)
})
