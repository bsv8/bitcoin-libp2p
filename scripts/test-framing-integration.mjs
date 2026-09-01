import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const repoDir = resolve(fileURLToPath(new URL('..', import.meta.url)))
const fixture = JSON.parse(readFileSync(join(repoDir, 'testdata/uvarint-framing-v1.json'), 'utf8'))
const goBinaryDirectory = mkdtempSync(join(tmpdir(), 'bitcoin-libp2p-framing-'))
const goBinary = join(goBinaryDirectory, 'framing-go')
const tsBinary = join(repoDir, 'typescript/dist-integration/integration/framing.js')

function fromHex (value) {
  const clean = value.replaceAll(' ', '')
  const output = new Uint8Array(clean.length / 2)
  for (let index = 0; index < output.length; index++) output[index] = Number.parseInt(clean.slice(index * 2, index * 2 + 2), 16)
  return output
}

function toHex (value) {
  return [...value].map(byte => byte.toString(16).padStart(2, '0')).join('')
}

function payloadOf (vector) {
  if (vector.payloadHex != null) return vector.payloadHex
  const payload = new Uint8Array(vector.payloadByteLength)
  if (vector.payloadPattern === 'incrementing-byte') {
    for (let index = 0; index < payload.length; index++) payload[index] = index & 0xff
  }
  return toHex(payload)
}

function runJson (command, args, value) {
  const output = execFileSync(command, args, {
    cwd: repoDir,
    input: `${JSON.stringify(value)}\n`,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024
  }).trim()
  return JSON.parse(output)
}

try {
  execFileSync('go', ['build', '-o', goBinary, './integration/framing-go'], {
    cwd: repoDir,
    stdio: 'inherit'
  })

  const payloads = [
    ...fixture.fixedVectors.map(payloadOf),
    ...fixture.payloadVectors.map(value => value.payloadHex)
  ]
  const goEncoded = runJson(goBinary, ['-mode', 'encode'], { payloads })
  const tsDecoded = runJson('node', [tsBinary, '--mode', 'decode'], { chunks: goEncoded.frames })
  assert.deepEqual(tsDecoded, { event: 'decoded', payloads })

  const tsEncoded = runJson('node', [tsBinary, '--mode', 'encode'], { payloads })
  const goDecoded = runJson(goBinary, ['-mode', 'decode'], { chunks: tsEncoded.frames })
  assert.deepEqual(goDecoded, { event: 'decoded', payloads })
  assert.deepEqual(tsEncoded, goEncoded, 'Go and TypeScript frame bytes differ')

  const invalidResults = []
  for (const invalid of fixture.invalidCases) {
    const request = { chunks: [invalid.inputHex] }
    const goResult = runJson(goBinary, ['-mode', 'decode'], request)
    const tsResult = runJson('node', [tsBinary, '--mode', 'decode'], request)
    assert.equal(goResult.code, invalid.code, `Go classified ${invalid.name} incorrectly`)
    assert.equal(tsResult.code, invalid.code, `TypeScript classified ${invalid.name} incorrectly`)
    invalidResults.push({ name: invalid.name, code: invalid.code })
  }
  const overLimit = fixture.limitCases.find(value => value.code === 'ERR_FRAME_TOO_LARGE')
  assert(overLimit?.inputHex != null)
  const limitRequest = { chunks: [overLimit.inputHex], maxInboundFrameBytes: overLimit.maxInboundFrameBytes }
  const goLimit = runJson(goBinary, ['-mode', 'decode'], limitRequest)
  const tsLimit = runJson('node', [tsBinary, '--mode', 'decode'], limitRequest)
  assert.equal(goLimit.code, overLimit.code)
  assert.equal(tsLimit.code, overLimit.code)
  invalidResults.push({ name: overLimit.name, code: overLimit.code })

  console.log(JSON.stringify({
    event: 'uvarint-framing-cross-language',
    vectors: payloads.length,
    byteExact: true,
    invalidCases: invalidResults,
    maxInboundFrameBytes: 1048576
  }))
} finally {
  rmSync(goBinaryDirectory, { recursive: true, force: true })
}
