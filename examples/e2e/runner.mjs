import { createRequire } from 'node:module'
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { spawn, spawnSync } from 'node:child_process'

const root = resolve(new URL('../..', import.meta.url).pathname)
const args = process.argv.slice(2)
const mode = args.includes('--all') ? 'all' : args.includes('--quick') ? 'quick' : undefined
const buildDir = valueAfter('--build-dir') ?? join(root, '.demo-build')
const packageTarball = valueAfter('--sdk-tarball')

if (mode == null) {
  process.stderr.write('usage: node examples/e2e/runner.mjs --quick|--all --build-dir <dir>\n')
  process.exit(2)
}

const paths = {
  goHello: join(buildDir, 'go-hello'),
  goRemoteHost: join(buildDir, 'go-remote-host'),
  goRemoteSigner: join(buildDir, 'go-remote-signer'),
  nativeGo: join(buildDir, 'native-go-server'),
  tsHello: join(root, 'examples/02-typescript-hello/dist/main.js'),
  tsRemoteHost: join(root, 'examples/04-remote-signer/typescript/dist/host.js'),
  tsNative: join(root, 'examples/06-native-interop/native-typescript/dist/main.js'),
  browserIndex: join(root, 'examples/05-browser-worker-hello/index.html'),
  browserBundle: join(root, 'examples/05-browser-worker-hello/dist/browser.js'),
  browserWorker: join(root, 'examples/05-browser-worker-hello/dist/signer-worker.js'),
  nativeTSDir: join(root, 'examples/06-native-interop/native-typescript'),
  nativeGoDir: join(root, 'examples/05-browser-worker-hello/server')
}

for (const [name, path] of Object.entries(paths)) {
  if (name.endsWith('Dir')) continue
  if (mode === 'quick' && !['goHello', 'tsHello'].includes(name)) continue
  if (!existsSync(path)) throw new Error(`missing demo build asset ${name}: ${path}`)
}

const managedProcesses = new Set()
const cleanupTasks = new Set()
let cleanupPromise
let terminationPromise

function registerCleanup (task) {
  cleanupTasks.add(task)
  return () => cleanupTasks.delete(task)
}

async function cleanupAll () {
  cleanupPromise ??= (async () => {
    const tasks = [...cleanupTasks]
    await Promise.allSettled(tasks.map(task => task()))
    cleanupTasks.clear()
    await ManagedProcess.stopAll()
  })()
  return cleanupPromise
}

class ManagedProcess {
  constructor (label, command, commandArgs, options = {}) {
    this.label = label
    this.command = command
    this.commandArgs = commandArgs
    this.stdout = ''
    this.stderr = ''
    this.lines = []
    this.waiters = []
    this.closed = false
    managedProcesses.add(this)
    this.child = spawn(command, commandArgs, {
      cwd: options.cwd ?? root,
      env: { ...process.env, ...(options.env ?? {}) },
      detached: true,
      stdio: ['pipe', 'pipe', 'pipe']
    })
    this.exitPromise = new Promise(resolve => {
      let settled = false
      const finish = result => {
        if (settled) return
        settled = true
        this.closed = true
        managedProcesses.delete(this)
        this.#rejectWaiters(new Error(`${this.label} exited (${result.code ?? result.signal ?? 'unknown'})`))
        resolve(result)
      }
      this.child.once('close', (code, signal) => finish({ code, signal }))
      this.child.once('error', error => finish({ code: null, signal: null, error }))
    })
    this.child.stdout.setEncoding('utf8')
    this.child.stderr.setEncoding('utf8')
    this.child.stdout.on('data', chunk => this.#onStdout(String(chunk)))
    this.child.stderr.on('data', chunk => { this.stderr += String(chunk) })
  }

  #onStdout (chunk) {
    this.stdout += chunk
    const pieces = this.stdout.split('\n')
    this.stdout = pieces.pop() ?? ''
    for (const raw of pieces) {
      if (raw.trim() === '') continue
      let value
      try {
        value = JSON.parse(raw)
      } catch {
        this.lines.push({ raw, value: undefined })
        continue
      }
      this.lines.push({ raw, value })
      for (const waiter of [...this.waiters]) {
        if (!waiter.predicate(value)) continue
        this.waiters = this.waiters.filter(item => item !== waiter)
        clearTimeout(waiter.timer)
        waiter.resolve(value)
      }
    }
  }

  waitFor (predicate, timeoutMs) {
    for (const line of this.lines) {
      if (line.value != null && predicate(line.value)) return Promise.resolve(line.value)
    }
    return new Promise((resolvePromise, reject) => {
      const waiter = {
        predicate,
        resolve: resolvePromise,
        reject,
        timer: setTimeout(() => {
          this.waiters = this.waiters.filter(item => item !== waiter)
          reject(new Error(`${this.label} did not emit the expected JSON event within ${timeoutMs}ms`))
        }, timeoutMs)
      }
      this.waiters.push(waiter)
    })
  }

  async wait (timeoutMs) {
    let timer
    try {
      return await Promise.race([
        this.exitPromise,
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${this.label} did not exit within ${timeoutMs}ms`)), timeoutMs) })
      ])
    } finally {
      clearTimeout(timer)
    }
  }

  async stop () {
    if (this.closed) return
    this.#rejectWaiters(new Error(`${this.label} was stopped`))
    try { process.kill(-this.child.pid, 'SIGTERM') } catch { this.child.kill('SIGTERM') }
    try {
      await this.wait(3_000)
    } catch {
      try { process.kill(-this.child.pid, 'SIGKILL') } catch { this.child.kill('SIGKILL') }
      await this.wait(2_000).catch(() => {})
    }
  }

  #rejectWaiters (error) {
    for (const waiter of this.waiters) {
      clearTimeout(waiter.timer)
      waiter.reject(error)
    }
    this.waiters = []
  }

  static async stopAll () {
    for (let attempt = 0; attempt < 2 && managedProcesses.size > 0; attempt++) {
      await Promise.allSettled([...managedProcesses].map(process => process.stop()))
    }
  }

  closeInput () { this.child.stdin.end() }

  diagnostic () {
    return `${this.label}\nstdout:\n${this.stdout}\nparsed:\n${this.lines.map(line => line.raw).join('\n')}\nstderr:\n${this.stderr}`
  }
}

function assertNoManagedProcesses (context) {
  if (managedProcesses.size === 0) return
  const labels = [...managedProcesses].map(process => process.label).join(', ')
  throw new Error(`${context}: managed process registry is not empty (${labels})`)
}

function processExists (pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error?.code === 'EPERM'
  }
}

async function assertProcessExited (pid, context, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs
  while (processExists(pid) && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  if (processExists(pid)) throw new Error(`${context}: signer PID ${pid} is still alive`)
}

function asError (reason) {
  return reason instanceof Error ? reason : new Error(String(reason))
}

function requestTermination (exitCode, reason) {
  terminationPromise ??= (async () => {
    if (reason != null) process.stderr.write(`${asError(reason).stack ?? asError(reason).message}\n`)
    await cleanupAll()
    try { assertNoManagedProcesses('runner signal cleanup') } catch (error) {
      process.stderr.write(`${asError(error).message}\n`)
      exitCode = 1
    }
    process.exit(exitCode)
  })()
  return terminationPromise
}

process.on('SIGINT', () => { void requestTermination(130) })
process.on('SIGTERM', () => { void requestTermination(143) })
process.on('uncaughtException', error => { void requestTermination(1, error) })
process.on('unhandledRejection', reason => { void requestTermination(1, reason) })

async function runHelloScenario (scenario, serverSpec, clientSpec, options = {}) {
  let server
  let client
  let ready
  try {
    server = start(serverSpec)
    ready = await server.waitFor(value => value.event === 'ready', options.serverTimeout ?? 20_000)
    client = start(clientSpec(ready))
    const hello = await client.waitFor(value => value.event === 'hello', options.clientTimeout ?? 20_000)
    const result = await client.wait(options.clientExitTimeout ?? 5_000)
    if (result.code !== 0) throw new Error(`${scenario} client exited with ${result.code ?? result.signal}`)
    assertHello(scenario, ready, hello, options.message ?? hello.request)
    if (options.extraAssert != null) options.extraAssert(ready, hello)
    pass(scenario, { server: identityOf(ready), client: hello, result: 'hello' })
    return { ready, hello }
  } catch (error) {
    throw withDiagnostics(`${scenario} failed: ${error instanceof Error ? error.message : String(error)}`, server, client)
  } finally {
    await client?.stop()
    await server?.stop()
    assertNoManagedProcesses(`${scenario} cleanup`)
  }
}

async function runExpectedFailure (scenario, clientSpec, serverSpec) {
  let server
  let client
  let lifecycle
  try {
    server = start(serverSpec)
    const ready = await server.waitFor(value => value.event === 'ready', 20_000)
    client = start(clientSpec(ready))
    const result = await client.wait(8_000)
    if (result.code === 0) throw new Error('failure scenario unexpectedly exited successfully')
    if (client.lines.some(line => line.value?.event === 'hello')) throw new Error('failure scenario emitted a successful hello')
    lifecycle = client.lines.map(line => line.value).find(value => value?.event === 'failure' || value?.event === 'closed')
    if (lifecycle?.event !== 'failure') throw new Error('failure scenario did not emit a structured failure event')
    if (lifecycle.pendingSignerRequests !== 0) throw new Error('failure scenario left pending signer requests')
    if (!Number.isInteger(lifecycle.hostPid) || !Number.isInteger(lifecycle.signerPid) || lifecycle.hostPid <= 0 || lifecycle.signerPid <= 0) {
      throw new Error('failure scenario emitted invalid process metadata')
    }
    if (lifecycle.hostPid === lifecycle.signerPid) throw new Error('failure scenario signer is not a separate process')
    await assertProcessExited(lifecycle.signerPid, `${scenario} cleanup`)
    pass(scenario, { server: identityOf(ready), exitCode: result.code, failure: lifecycle })
  } catch (error) {
    throw withDiagnostics(`${scenario} failed: ${error instanceof Error ? error.message : String(error)}`, server, client)
  } finally {
    await client?.stop()
    await server?.stop()
    assertNoManagedProcesses(`${scenario} cleanup`)
  }
}

function start (spec) {
  return new ManagedProcess(spec.label, spec.command, spec.args, { cwd: spec.cwd, env: spec.env })
}

function goSpec (label, binary, extra = []) {
  return { label, command: binary, args: extra }
}

function nodeSpec (label, script, extra = [], cwd = root) {
  return { label, command: process.execPath, args: [script, ...extra], cwd }
}

function helloClientArgs (ready, message) {
  return ['--mode', 'client', '--dial', ready.address, '--message', message, '--expect-peer-id', ready.peerId, '--expect-public-key', ready.publicKey]
}

function assertHello (scenario, ready, hello, message) {
  if (hello.remotePeerId !== ready.peerId) throw new Error(`${scenario}: remote PeerId mismatch`)
  if (hello.remotePublicKey !== ready.publicKey) throw new Error(`${scenario}: authenticated public key mismatch`)
  if (hello.addressPeerId !== p2pOf(ready.address)) throw new Error(`${scenario}: /p2p address component mismatch`)
  if (p2pOf(hello.remoteAddress) !== p2pOf(ready.address)) throw new Error(`${scenario}: client dial address mismatch`)
  if (hello.request !== message || hello.response !== `hello, ${message}` || hello.streams !== 2) {
    throw new Error(`${scenario}: Hello payload assertion failed`)
  }
}

function identityOf (ready) {
  return { peerId: ready.peerId, publicKey: ready.publicKey, address: ready.address }
}

function p2pOf (address) {
  const match = /\/p2p\/([^/]+)$/.exec(address ?? '')
  if (match == null) throw new Error(`address has no terminal /p2p component: ${address}`)
  return match[1]
}

function assertRemoteSigner (ready, hello) {
  if (ready.hostPid === ready.signerPid || hello.hostPid === hello.signerPid) throw new Error('remote signer does not have a separate process')
  if (ready.signerNoiseRequests !== 0 || hello.signerNoiseRequestsBefore !== 0 || hello.signerNoiseRequests !== 1) throw new Error('remote signer Noise request count was not exactly one')
  if (hello.signerRequests < 1) throw new Error('signer child did not receive a signing request')
  if (hello.pendingSignerRequests !== 0) throw new Error('signer request remained pending after Hello')
  if (hello.signerPid <= 0 || hello.hostPid <= 0) throw new Error('remote signer process metadata is invalid')
}

function withDiagnostics (message, server, client) {
  const details = [message]
  if (server != null) details.push(server.diagnostic())
  if (client != null) details.push(client.diagnostic())
  return new Error(details.join('\n\n'))
}

function pass (scenario, details) {
  process.stdout.write(`${JSON.stringify({ event: 'scenario', scenario, status: 'passed', ...details })}\n`)
}

async function runBrowserScenario (transport, nativeServerBinary, httpServer, failure) {
  let server
  let browser
  let unregisterBrowser
  const scenario = failure == null ? `browser-${transport}` : `browser-${failure}`
  try {
    server = start(goSpec(`native-go-${transport}`, nativeServerBinary, ['--mode', 'server', '--transport', transport]))
    const ready = await server.waitFor(value => value.event === 'ready', 20_000)
    const browserURL = new URL(httpServer.url)
    browserURL.searchParams.set('transport', transport)
    browserURL.searchParams.set('addr', ready.address)
    if (failure != null) browserURL.searchParams.set('failure', failure)
    const { chromium } = playwright()
    try {
      browser = await chromium.launch({ headless: true, channel: 'chromium' })
    } catch (error) {
      if (String(error).includes('Executable') || String(error).includes('browserType.launch')) {
        throw new Error('Playwright Chromium is not installed. Run: cd typescript && npx playwright install chromium')
      }
      throw error
    }
    unregisterBrowser = registerCleanup(async () => { await browser?.close().catch(() => {}) })
    const context = await browser.newContext()
    const page = await context.newPage()
    const pageErrors = []
    const consoleErrors = []
    let crashed = false
    page.on('pageerror', error => pageErrors.push(error.message))
    page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text()) })
    page.on('crash', () => { crashed = true })
    try {
      await page.goto(browserURL.toString(), { waitUntil: 'load', timeout: 15_000 })
      await page.waitForFunction(() => document.body.dataset.status === 'PASS' || document.body.dataset.status === 'FAIL', null, { timeout: 30_000 })
      const result = await page.evaluate(() => ({ ...document.body.dataset }))
      if (crashed) throw new Error('browser page crashed')
      if (pageErrors.length > 0) throw new Error(`pageerror: ${pageErrors.join('; ')}`)
      if (consoleErrors.length > 0) throw new Error(`console error: ${consoleErrors.join('; ')}`)
      if (failure == null) {
        if (result.status !== 'PASS' || result.remotePeerId !== ready.peerId || result.remotePublicKey !== ready.publicKey || result.transport !== transport || result.response !== 'hello, browser hello' || result.streams !== '2' || result.pendingSignerRequests !== '0' || result.noiseRequests !== '1') {
          throw new Error(`browser result assertion failed: ${JSON.stringify(result)}`)
        }
      } else {
        const expectedWorkerState = failure === 'worker-exit' ? 'closed' : 'stopped'
        if (result.status !== 'FAIL' || result.event !== 'failure' || result.failure !== failure || result.pendingSignerRequests !== '0' || result.noiseRequests !== '1' || result.workerState !== expectedWorkerState) {
          throw new Error(`browser failure assertion failed: ${JSON.stringify(result)}`)
        }
      }
      pass(scenario, { server: identityOf(ready), browser: result })
    } finally {
      await page.close().catch(() => {})
      await context.close().catch(() => {})
    }
  } catch (error) {
    throw withDiagnostics(`${scenario} failed: ${error instanceof Error ? error.message : String(error)}`, server, undefined)
  } finally {
    unregisterBrowser?.()
    await browser?.close().catch(() => {})
    await server?.stop()
    assertNoManagedProcesses(`${scenario} cleanup`)
  }
}

function playwright () {
  try {
    return createRequire(join(root, 'typescript/package.json'))('@playwright/test')
  } catch (error) {
    throw new Error(`Playwright is not installed. Run: npm ci --prefix typescript (${error instanceof Error ? error.message : String(error)})`)
  }
}

async function startStaticServer () {
  const server = createServer(async (request, response) => {
    try {
      const pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname
      if (pathname === '/favicon.ico') {
        response.writeHead(204)
        response.end()
        return
      }
      const file = pathname === '/'
        ? paths.browserIndex
        : pathname === '/browser.js'
          ? paths.browserBundle
          : pathname === '/signer-worker.js'
            ? paths.browserWorker
            : undefined
      if (file == null) {
        response.writeHead(404); response.end('not found'); return
      }
      const body = await readFile(file)
      const contentType = file.endsWith('.html') ? 'text/html' : 'text/javascript'
      response.writeHead(200, { 'content-type': contentType })
      response.end(body)
    } catch {
      response.writeHead(404); response.end('not found')
    }
  })
  await new Promise((resolvePromise, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolvePromise)
  })
  const address = server.address()
  let closePromise
  const close = async () => {
    closePromise ??= new Promise(resolvePromise => server.close(() => resolvePromise()))
    await closePromise
  }
  const unregister = registerCleanup(close)
  return {
    server,
    url: `http://127.0.0.1:${typeof address === 'object' && address != null ? address.port : 0}/`,
    close: async () => {
      unregister()
      await close()
    }
  }
}

function checkNativeIsolation () {
  const packageFile = JSON.parse(readFileSync(join(paths.nativeTSDir, 'package.json'), 'utf8'))
  const dependencies = { ...(packageFile.dependencies ?? {}), ...(packageFile.devDependencies ?? {}) }
  if (dependencies['@bsv8/bitcoin-libp2p'] != null) throw new Error('native TypeScript package depends on the SDK')
  const source = readFileSync(join(paths.nativeTSDir, 'src/main.ts'), 'utf8')
  if (source.includes('@bsv8/bitcoin-libp2p')) throw new Error('native TypeScript source imports the SDK')
  const result = spawnSync('go', ['list', '-deps', '.'], { cwd: paths.nativeGoDir, encoding: 'utf8' })
  if (result.status !== 0) throw new Error(`native Go dependency graph failed: ${result.stderr}`)
  if (/^github\.com\/bsv8\/bitcoin-libp2p(?:$|\/(?:identity|signer|golibp2p))/m.test(result.stdout)) throw new Error('native Go dependency graph imports the SDK')
}

async function main () {
  const message = 'hello from demo'

  await runHelloScenario('go-to-go', goSpec('go-to-go-server', paths.goHello, ['--mode', 'server']), ready => goSpec('go-to-go-client', paths.goHello, helloClientArgs(ready, message)), { message })
  await runHelloScenario('typescript-to-typescript', nodeSpec('ts-to-ts-server', paths.tsHello, ['--mode', 'server'], join(root, 'examples/02-typescript-hello')), ready => nodeSpec('ts-to-ts-client', paths.tsHello, helloClientArgs(ready, message), join(root, 'examples/02-typescript-hello')), { message })
  await runHelloScenario('go-to-typescript', nodeSpec('ts-server', paths.tsHello, ['--mode', 'server'], join(root, 'examples/02-typescript-hello')), ready => goSpec('go-client', paths.goHello, helloClientArgs(ready, message)), { message })
  await runHelloScenario('typescript-to-go', goSpec('go-server', paths.goHello, ['--mode', 'server']), ready => nodeSpec('ts-client', paths.tsHello, helloClientArgs(ready, message), join(root, 'examples/02-typescript-hello')), { message })

  if (mode === 'all') {
    if (packageTarball == null || !existsSync(packageTarball)) throw new Error('runner --all requires an existing --sdk-tarball from npm pack')
    await runHelloScenario('go-remote-signer', goSpec('go-remote-server', paths.goRemoteHost, ['--mode', 'server', '--signer-command', paths.goRemoteSigner]), ready => goSpec('go-remote-client', paths.goRemoteHost, [...helloClientArgs(ready, message), '--signer-command', paths.goRemoteSigner]), { message, extraAssert: assertRemoteSigner })
    await runHelloScenario('typescript-remote-signer', nodeSpec('ts-remote-server', paths.tsRemoteHost, ['--mode', 'server'], join(root, 'examples/04-remote-signer/typescript')), ready => nodeSpec('ts-remote-client', paths.tsRemoteHost, helloClientArgs(ready, message), join(root, 'examples/04-remote-signer/typescript')), { message, extraAssert: assertRemoteSigner })

    const failureTarget = goSpec('failure-target', paths.goHello, ['--mode', 'server'])
    await runExpectedFailure('go-remote-signer-exit', ready => goSpec('go-remote-exit', paths.goRemoteHost, [...helloClientArgs(ready, message), '--signer-command', paths.goRemoteSigner, '--signer-mode', 'exit', '--sign-timeout-ms', '1000']), failureTarget)
    await runExpectedFailure('go-remote-signer-host-stop', ready => goSpec('go-remote-stop', paths.goRemoteHost, [...helloClientArgs(ready, message), '--signer-command', paths.goRemoteSigner, '--signer-mode', 'pending', '--sign-timeout-ms', '1000', '--host-stop-after-ms', '100']), failureTarget)
    await runExpectedFailure('typescript-remote-signer-exit', ready => nodeSpec('ts-remote-exit', paths.tsRemoteHost, [...helloClientArgs(ready, message), '--signer-mode', 'exit', '--sign-timeout-ms', '1000'], join(root, 'examples/04-remote-signer/typescript')), failureTarget)
    await runExpectedFailure('typescript-remote-signer-host-stop', ready => nodeSpec('ts-remote-stop', paths.tsRemoteHost, [...helloClientArgs(ready, message), '--signer-mode', 'pending', '--sign-timeout-ms', '1000', '--host-stop-after-ms', '100'], join(root, 'examples/04-remote-signer/typescript')), failureTarget)

    const httpServer = await startStaticServer()
    try {
      await runBrowserScenario('websocket', paths.nativeGo, httpServer)
      await runBrowserScenario('webrtc-direct', paths.nativeGo, httpServer)
      await runBrowserScenario('websocket', paths.nativeGo, httpServer, 'pending')
      await runBrowserScenario('websocket', paths.nativeGo, httpServer, 'worker-exit')
      await runBrowserScenario('websocket', paths.nativeGo, httpServer, 'abort')
      await runBrowserScenario('websocket', paths.nativeGo, httpServer, 'host-stop')
    } finally {
      await httpServer.close()
    }

    await runHelloScenario('go-sdk-to-native-typescript', nodeSpec('native-ts-server', paths.tsNative, ['--mode', 'server'], paths.nativeTSDir), ready => goSpec('go-sdk-client', paths.goHello, helloClientArgs(ready, message)), { message })
    await runHelloScenario('typescript-sdk-to-native-go', goSpec('native-go-server', paths.nativeGo, ['--mode', 'server', '--transport', 'tcp']), ready => nodeSpec('ts-sdk-client', paths.tsHello, helloClientArgs(ready, message), join(root, 'examples/02-typescript-hello')), { message })
    checkNativeIsolation()
    pass('native-isolation', { result: 'independent dependency graphs' })
  }
  assertNoManagedProcesses('runner summary')
  if (cleanupTasks.size !== 0) throw new Error('runner summary: cleanup task registry is not empty')
  process.stdout.write(`${JSON.stringify({ event: 'summary', status: 'passed', mode, managedProcesses: managedProcesses.size, cleanupTasks: cleanupTasks.size })}\n`)
}

function valueAfter (name) {
  const index = args.indexOf(name)
  return index < 0 ? undefined : args[index + 1]
}

try {
  await main()
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`)
  process.exitCode = 1
} finally {
  await cleanupAll()
  try {
    assertNoManagedProcesses('runner final cleanup')
    if (cleanupTasks.size !== 0) throw new Error('runner final cleanup: cleanup task registry is not empty')
  } catch (error) {
    process.stderr.write(`${asError(error).message}\n`)
    process.exitCode = 1
  }
}
