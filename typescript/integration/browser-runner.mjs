import { chromium } from '@playwright/test'

const expectedPeerId = '16Uiu2HAmB8C2R7pBJu1z2u1gno7aXcbtkoUzrknTFN2EBLjRavKP'
const expectedPublicKey = '02e940822d4e7a09ce013bed4fa812e92f22b0ed1fa2d1ad06ae0406680da1cc46'
const expectedDirectFailures = {
  'wrong-port': ['ERR_WEBRTC_DIRECT_DIAL', 'dial'],
  'wrong-certhash': ['ERR_WEBRTC_DIRECT_DIAL', 'dial'],
  'wrong-address-peer-id': ['ERR_WEBRTC_DIRECT_PEER_ID', 'validate'],
  'wrong-public-key': ['ERR_WEBRTC_DIRECT_PEER_ID', 'validate'],
  abort: ['ERR_WEBRTC_DIRECT_TIMEOUT', 'dial'],
  'dns-unavailable': ['ERR_WEBRTC_DIRECT_RESOLVE', 'resolve'],
  'old-certhash': ['ERR_WEBRTC_DIRECT_DIAL', 'dial'],
  'stream-reset': ['ERR_STREAM_ABORTED', 'stream']
}
const directSuccessScenarios = new Set(['dns-localhost'])

function argument (name) {
  const index = process.argv.indexOf(name)
  return index < 0 ? undefined : process.argv[index + 1]
}

const transport = argument('--transport')
const address = argument('--addr')
const httpPort = argument('--http-port')
const scenario = argument('--scenario')
if (transport == null || address == null || httpPort == null) throw new Error('--transport, --addr and --http-port are required')

const addressPeerId = address.match(/\/p2p\/([^/]+)$/)?.[1]
if (scenario !== 'wrong-address-peer-id' && addressPeerId !== expectedPeerId) throw new Error(`dial address PeerId mismatch: ${addressPeerId ?? ''}`)

const url = new URL(`http://127.0.0.1:${httpPort}/`)
url.searchParams.set('transport', transport)
url.searchParams.set('addr', address)
url.searchParams.set('expected-public-key', expectedPublicKey)
if (scenario != null) url.searchParams.set('failure', scenario)

let browser
let context
let page
const pageErrors = []
const consoleErrors = []
let browserCrashed = false
try {
  browser = await chromium.launch({ headless: true, channel: 'chromium' })
  context = await browser.newContext()
  page = await context.newPage()
  page.on('pageerror', error => pageErrors.push(error.message))
  page.on('console', message => {
    if (message.type() === 'error') consoleErrors.push(message.text())
  })
  page.on('crash', () => { browserCrashed = true })
  await page.goto(url.toString(), { waitUntil: 'load', timeout: 15_000 })
  await page.waitForFunction(() => document.body.dataset.status != null, null, { timeout: 25_000 })
  const result = await page.evaluate(() => ({ ...document.body.dataset }))
  if (browserCrashed) throw new Error('browser page crashed')
  if (pageErrors.length > 0) throw new Error(`pageerror: ${pageErrors.join('; ')}`)
  if (consoleErrors.length > 0) throw new Error(`console error: ${consoleErrors.join('; ')}`)

  if (scenario == null || (transport === 'webrtc-direct' && directSuccessScenarios.has(scenario))) {
    if (result.status !== 'PASS' || result.peerId !== expectedPeerId || result.publicKey !== expectedPublicKey || result.noiseRequests !== '1' || result.streams !== '2' || result.pendingSigners !== '0') {
      throw new Error(`browser result assertion failed: ${JSON.stringify(result)}`)
    }
    if (transport === 'webrtc-direct') {
      const expectedPort = address.match(/\/udp\/([0-9]+)\//)?.[1]
      if (result.endpointAddress !== address || result.endpointHost !== '127.0.0.1' || result.endpointPort !== expectedPort || !result.endpointCerthash || result.endpointPeerId !== expectedPeerId) {
        throw new Error(`browser direct endpoint assertion failed: ${JSON.stringify(result)}`)
      }
    }
  } else if (result.status !== 'PASS_FAILURE' || result.scenario !== scenario || result.pendingSigners !== '0') {
    throw new Error(`browser failure assertion failed: ${JSON.stringify(result)}`)
  } else if (transport === 'webrtc-direct') {
    const expected = expectedDirectFailures[scenario]
    if (expected == null || result.errorCode !== expected[0] || result.errorStage !== expected[1]) {
      throw new Error(`browser direct failure classification mismatch: ${JSON.stringify({ expected, actual: result })}`)
    }
  }
  console.log(JSON.stringify({ transport, scenario: scenario ?? 'success', ...result }))
} catch (error) {
  if (error?.message?.includes('Executable doesn\'t exist') || error?.message?.includes('browserType.launch')) {
    console.error('Playwright Chromium is not installed. Run: cd typescript && npx playwright install chromium')
  }
  throw error
} finally {
  await page?.close().catch(() => {})
  await context?.close().catch(() => {})
  await browser?.close().catch(() => {})
}
