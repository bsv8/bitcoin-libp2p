import { existsSync } from 'node:fs'
import { chromium } from '@playwright/test'

const EXPECTED_BUYER_PUBLIC_KEY = '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798'
const EXPECTED_SELLER_PUBLIC_KEY = '02c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5'
const EXPECTED_BUYER_PEER_ID = '16Uiu2HAm3cuhhRL2msUuLF62KRSfneFDx94RsuouyW25Ho42cFMq'
const EXPECTED_SELLER_PEER_ID = '16Uiu2HAm8kegYGp6XeybmZAuNcnLosyjsRwZ44yLgfEuqLqYL9zt'

function argument (name) {
  const index = process.argv.indexOf(name)
  return index < 0 ? undefined : process.argv[index + 1]
}

function positiveInteger (name, value, fallback) {
  if (value == null) return fallback
  const result = Number(value)
  if (!Number.isSafeInteger(result) || result <= 0) throw new Error(`${name} must be a positive integer`)
  return result
}

const httpPort = argument('--http-port')
const token = argument('--token')
const payloadBytes = positiveInteger('--payload-bytes', argument('--payload-bytes'), 16 * 1024 * 1024)
if (httpPort == null || token == null) throw new Error('--http-port and --token are required')

function urlFor (role, remote) {
  const url = new URL(`http://127.0.0.1:${httpPort}/`)
  url.searchParams.set('role', role)
  url.searchParams.set('token', token)
  url.searchParams.set('payloadBytes', String(payloadBytes))
  if (remote != null) {
    url.searchParams.set('remotePeerId', remote.peerId)
    url.searchParams.set('remotePublicKey', remote.publicKey)
  }
  return url
}

function observe (page, errors, consoleErrors) {
  page.on('pageerror', error => errors.push(error.message))
  page.on('console', message => {
    if (message.type() === 'error') consoleErrors.push(message.text())
  })
}

async function resultFor (page) {
  return await page.evaluate(() => ({ ...document.body.dataset }))
}

async function waitForStatus (page, expected) {
  await page.waitForFunction(status => document.body.dataset.status === status || document.body.dataset.status === 'FAIL', expected, { timeout: 180_000 })
  const result = await resultFor(page)
  if (result.status !== expected) throw new Error(`page status ${result.status}: ${JSON.stringify(result)}`)
  return result
}

let browser
let buyerContext
let sellerContext
let buyerPage
let sellerPage
const buyerErrors = []
const sellerErrors = []
const buyerConsoleErrors = []
const sellerConsoleErrors = []
try {
  const executablePath = process.env.CHROME_PATH ?? '/usr/bin/google-chrome'
  browser = await chromium.launch(existsSync(executablePath) ? { headless: true, executablePath } : { headless: true, channel: 'chromium' })
  buyerContext = await browser.newContext()
  sellerContext = await browser.newContext()
  buyerPage = await buyerContext.newPage()
  sellerPage = await sellerContext.newPage()
  observe(buyerPage, buyerErrors, buyerConsoleErrors)
  observe(sellerPage, sellerErrors, sellerConsoleErrors)
  await sellerPage.goto(urlFor('seller').toString(), { waitUntil: 'load', timeout: 15_000 })
  const sellerReady = await waitForStatus(sellerPage, 'READY')
  if (sellerReady.peerId !== EXPECTED_SELLER_PEER_ID || sellerReady.publicKey !== EXPECTED_SELLER_PUBLIC_KEY) throw new Error(`seller identity mismatch: ${JSON.stringify(sellerReady)}`)
  await buyerPage.goto(urlFor('buyer', { peerId: sellerReady.peerId, publicKey: sellerReady.publicKey }).toString(), { waitUntil: 'load', timeout: 15_000 })
  const buyerResult = await waitForStatus(buyerPage, 'PASS')
  const sellerResult = await waitForStatus(sellerPage, 'PASS')
  for (const [label, result] of [['buyer', buyerResult], ['seller', sellerResult]]) {
    if (result.role !== label || result.peerId !== (label === 'buyer' ? EXPECTED_BUYER_PEER_ID : EXPECTED_SELLER_PEER_ID) || result.publicKey !== (label === 'buyer' ? EXPECTED_BUYER_PUBLIC_KEY : EXPECTED_SELLER_PUBLIC_KEY)) throw new Error(`${label} identity assertion failed: ${JSON.stringify(result)}`)
    if (result.remoteAddr == null || !result.remoteAddr.includes('/webrtc/p2p/')) throw new Error(`${label} remote address assertion failed: ${JSON.stringify(result)}`)
    if (result.streams !== '2' || result.largeBytes !== String(payloadBytes) || result.cancelled !== '1' || result.pendingSigners !== '0' || result.noiseRequests !== '1') throw new Error(`${label} transport assertion failed: ${JSON.stringify(result)}`)
    if (result.largeHash == null || !/^[0-9a-f]{64}$/.test(result.largeHash)) throw new Error(`${label} hash assertion failed: ${JSON.stringify(result)}`)
  }
  if (buyerResult.largeHash !== sellerResult.largeHash) throw new Error('buyer and seller large hashes differ')
  for (const [label, pageErrors, consoleErrors] of [['buyer', buyerErrors, buyerConsoleErrors], ['seller', sellerErrors, sellerConsoleErrors]]) {
    if (pageErrors.length > 0) throw new Error(`${label} pageerror: ${pageErrors.join('; ')}`)
    if (consoleErrors.length > 0) throw new Error(`${label} console error: ${consoleErrors.join('; ')}`)
  }
  console.log(JSON.stringify({ transport: 'webrtc-interconnect', payloadBytes, buyer: buyerResult, seller: sellerResult }))
} catch (error) {
  if (error?.message?.includes('Executable doesn\'t exist') || error?.message?.includes('browserType.launch')) {
    console.error('Playwright Chromium is not installed. Run: cd typescript && npx playwright install chromium')
  }
  throw error
} finally {
  await buyerPage?.close().catch(() => {})
  await sellerPage?.close().catch(() => {})
  await buyerContext?.close().catch(() => {})
  await sellerContext?.close().catch(() => {})
  await browser?.close().catch(() => {})
}
