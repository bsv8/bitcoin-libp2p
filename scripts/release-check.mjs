import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const repoDir = resolve(fileURLToPath(new URL('..', import.meta.url)))
const typescriptDir = join(repoDir, 'typescript')
const readJson = path => JSON.parse(readFileSync(path, 'utf8'))
const run = (command, args, options = {}) => execFileSync(command, args, {
  cwd: options.cwd ?? repoDir,
  encoding: 'utf8',
  stdio: options.capture === true ? 'pipe' : 'inherit'
})

const versions = readJson(join(repoDir, 'release/versions.json'))
const packageJson = readJson(join(typescriptDir, 'package.json'))
const packageLock = readJson(join(typescriptDir, 'package-lock.json'))
const auditAcceptance = readJson(join(repoDir, 'release/npm-audit-risk-acceptance-0.2.0.json'))
const goMod = readFileSync(join(repoDir, 'go.mod'), 'utf8')

assert.equal(versions.schemaVersion, 1, 'unsupported release manifest schema')
assert.equal(versions.protocol.id, 'bitcoin-libp2p')
assert.equal(versions.protocol.version, 1)
assert.equal(versions.protocol.goModuleMajor, 0)
assert.equal(versions.packages.npm.name, 'bitcoin-libp2p')
assert.equal(packageJson.name, versions.packages.npm.name)
assert.equal(packageJson.version, versions.packages.npm.version)
assert.equal(packageLock.name, packageJson.name)
assert.equal(packageLock.version, packageJson.version)
assert.equal(packageLock.packages[''].name, packageJson.name)
assert.equal(packageLock.packages[''].version, packageJson.version)
assert.equal(auditAcceptance.schemaVersion, 1, 'unsupported npm audit acceptance schema')
assert.equal(auditAcceptance.releaseVersion, packageJson.version, 'npm audit acceptance is for another release')
assert.equal(auditAcceptance.decision, 'accepted-with-controls', 'npm audit risk has no controlled acceptance')
assert.equal(packageJson.dependencies[auditAcceptance.dependencyRoot.name], auditAcceptance.dependencyRoot.version, 'audited dependency version changed')
assert(auditAcceptance.assessedAt <= auditAcceptance.reviewBy, 'npm audit risk review dates are invalid')
assert(new Date().toISOString().slice(0, 10) <= auditAcceptance.reviewBy, `npm audit risk acceptance expired on ${auditAcceptance.reviewBy}`)

const goModule = goMod.match(/^module\s+(\S+)$/m)?.[1]
assert.equal(goModule, versions.packages.go.module)
assert.equal(versions.packages.go.version, versions.packages.npm.version)
assert.equal(versions.packages.go.tag, `v${versions.packages.go.version}`)
assert.match(versions.packages.go.version, /^0\.\d+\.\d+$/)

for (const relativePath of [
  'examples/02-typescript-hello/package-lock.json',
  'examples/04-remote-signer/typescript/package-lock.json',
  'examples/05-browser-worker-hello/package-lock.json'
]) {
  const lock = readJson(join(repoDir, relativePath))
  const localSdk = Object.values(lock.packages).find(value => value?.name === packageJson.name)
  assert.equal(localSdk?.version, packageJson.version, `${relativePath} has a stale local SDK version`)
}

for (const [subpath, directory] of [
  ['.', ''],
  ['./identity', 'identity'],
  ['./signer', 'signer'],
  ['./libp2p', 'libp2p'],
  ['./stream', 'stream'],
  ['./webrtc-direct', 'webrtc-direct']
]) {
  const exported = packageJson.exports[subpath]
  const prefix = directory === '' ? './dist/index' : `./dist/${directory}/index`
  assert.equal(exported?.types, `${prefix}.d.ts`, `${subpath} has no declaration export`)
  assert.equal(exported?.import, `${prefix}.js`, `${subpath} has no ESM export`)
}

console.log(`checking ${packageJson.name}@${packageJson.version} and ${goModule}@${versions.packages.go.tag}`)
run('npm', ['run', 'build'], { cwd: typescriptDir })
run('npm', ['test'], { cwd: typescriptDir })
run('npm', ['ls', '--omit=dev'], { cwd: typescriptDir })

const latestAuditedDependency = JSON.parse(run('npm', ['view', auditAcceptance.dependencyRoot.name, 'version', '--json'], {
  cwd: typescriptDir,
  capture: true
}))
assert.equal(latestAuditedDependency, auditAcceptance.dependencyRoot.latestStableAtAssessment, `${auditAcceptance.dependencyRoot.name} has a new stable version; renew the risk review`)

const auditResult = spawnSync('npm', ['audit', '--json'], {
  cwd: typescriptDir,
  encoding: 'utf8',
  stdio: 'pipe'
})
assert.equal(auditResult.error, undefined, `npm audit could not start: ${auditResult.error?.message ?? ''}`)
assert([0, 1].includes(auditResult.status), `npm audit failed with status ${auditResult.status}: ${auditResult.stderr}`)
const auditReport = JSON.parse(auditResult.stdout)
const actualAuditPackages = Object.keys(auditReport.vulnerabilities ?? {}).sort()
const acceptedAuditPackages = [...auditAcceptance.acceptedAudit.packages].sort()
assert.deepEqual(actualAuditPackages, acceptedAuditPackages, 'npm audit package set changed; renew the risk review')
assert.equal(auditReport.metadata?.vulnerabilities?.critical, auditAcceptance.acceptedAudit.critical, 'critical vulnerability count changed')
assert.equal(auditReport.metadata?.vulnerabilities?.high, auditAcceptance.acceptedAudit.high, 'high vulnerability count changed')
for (const packageName of actualAuditPackages) {
  assert.equal(auditReport.vulnerabilities[packageName].severity, 'high', `${packageName} no longer matches the accepted severity`)
}
console.log(`accepted npm audit risk: ${actualAuditPackages.length} high packages, review by ${auditAcceptance.reviewBy}`)

const forbiddenRuntimeImports = ['react-native-webrtc', 'react-native', 'metro', 'image-size']
const runtimeFiles = []
const collectRuntimeFiles = directory => {
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry)
    if (statSync(path).isDirectory()) collectRuntimeFiles(path)
    else if (/\.(?:js|d\.ts)$/.test(entry)) runtimeFiles.push(path)
  }
}
collectRuntimeFiles(join(typescriptDir, 'dist'))
for (const path of runtimeFiles) {
  const source = readFileSync(path, 'utf8')
  for (const dependency of forbiddenRuntimeImports) {
    assert(!source.includes(`from '${dependency}'`) && !source.includes(`from \"${dependency}\"`), `formal runtime directly imports accepted-risk dependency ${dependency} in ${path}`)
  }
}

const temporaryDir = mkdtempSync(join(tmpdir(), 'bitcoin-libp2p-release-'))
try {
  const packOutput = run('npm', ['pack', '--json', '--pack-destination', temporaryDir], {
    cwd: typescriptDir,
    capture: true
  })
  const packResult = JSON.parse(packOutput)[0]
  assert.equal(packResult.name, packageJson.name)
  assert.equal(packResult.version, packageJson.version)

  const fileNames = new Set(packResult.files.map(file => file.path))
  for (const required of [
    'LICENSE',
    'README.md',
    'package.json',
    'dist/index.js',
    'dist/index.d.ts',
    'dist/identity/index.js',
    'dist/identity/index.d.ts',
    'dist/signer/index.js',
    'dist/signer/index.d.ts',
    'dist/libp2p/index.js',
    'dist/libp2p/index.d.ts',
    'dist/stream/index.js',
    'dist/stream/index.d.ts',
    'dist/stream/index.js.map',
    'dist/stream/index.d.ts.map',
    'dist/webrtc-direct/index.js',
    'dist/webrtc-direct/index.d.ts',
    'dist/webrtc-direct/index.js.map',
    'dist/webrtc-direct/index.d.ts.map'
  ]) {
    assert(fileNames.has(required), `formal npm tarball is missing ${required}`)
  }
  for (const fileName of fileNames) {
    assert(!/^(src|test|tests|integration|examples|dist-integration)\//.test(fileName), `formal npm tarball leaks ${fileName}`)
  }

  const tarball = join(temporaryDir, packResult.filename)
  const consumerDir = join(temporaryDir, 'consumer')
  mkdirSync(consumerDir)
  writeFileSync(join(consumerDir, 'package.json'), JSON.stringify({
    name: 'bitcoin-libp2p-release-consumer',
    private: true,
    type: 'module'
  }, null, 2))
  run('npm', [
    'install', '--prefer-offline', '--ignore-scripts', '--no-audit', '--no-fund',
    '--package-lock=false', '--prefix', consumerDir, tarball
  ], { cwd: temporaryDir })

  writeFileSync(join(consumerDir, 'runtime.mjs'), `
import { createHost } from 'bitcoin-libp2p'
import { bytesToHex } from 'bitcoin-libp2p/identity'
import { LocalSigner } from 'bitcoin-libp2p/signer'
import { authenticateConnection } from 'bitcoin-libp2p/libp2p'
import { readStreamToEnd } from 'bitcoin-libp2p/stream'
import { buildWebRTCDirectEndpoint, parseWebRTCDirectEndpoint } from 'bitcoin-libp2p/webrtc-direct'
if (typeof createHost !== 'function') throw new Error('root export is unavailable')
if (typeof bytesToHex !== 'function') throw new Error('identity export is unavailable')
if (typeof LocalSigner !== 'function') throw new Error('signer export is unavailable')
if (typeof authenticateConnection !== 'function') throw new Error('libp2p export is unavailable')
if (typeof readStreamToEnd !== 'function') throw new Error('stream export is unavailable')
if (typeof buildWebRTCDirectEndpoint !== 'function' || typeof parseWebRTCDirectEndpoint !== 'function') throw new Error('webrtc-direct export is unavailable')
`)
  run('node', ['runtime.mjs'], { cwd: consumerDir })

  writeFileSync(join(consumerDir, 'consumer.ts'), `
import { createHost } from 'bitcoin-libp2p'
import { bytesToHex, type BytesLike } from 'bitcoin-libp2p/identity'
import { LocalSigner, type TypedSigner } from 'bitcoin-libp2p/signer'
import { authenticateConnection, type HostConfig } from 'bitcoin-libp2p/libp2p'
import { readStreamToEnd, type ReadStreamToEndOptions } from 'bitcoin-libp2p/stream'
import { buildWebRTCDirectEndpoint, type BuildWebRTCDirectEndpointInput, type WebRTCDirectEndpoint } from 'bitcoin-libp2p/webrtc-direct'
const bytes: BytesLike = new Uint8Array()
const signer: TypedSigner = new LocalSigner(new Uint8Array(32).fill(1))
const config: HostConfig = { signer, start: false }
const endpointInput: BuildWebRTCDirectEndpointInput = { hostType: 'dns', host: 'example.test', udpPort: 443, certhash: 'uEiAAAQIDBAUGBwgJCgsMDQ4PEBESExQVFhcYGRobHB0eHw', publicKey: new Uint8Array(33) }
const endpoint: WebRTCDirectEndpoint | undefined = undefined
const options: ReadStreamToEndOptions = { timeoutMs: 15000, maxBytes: 1024 }
void [createHost, bytesToHex(bytes.subarray()), authenticateConnection, readStreamToEnd, buildWebRTCDirectEndpoint, config, endpointInput, endpoint, options]
`)
  writeFileSync(join(consumerDir, 'tsconfig.json'), JSON.stringify({
    compilerOptions: {
      target: 'ES2022',
      module: 'NodeNext',
      moduleResolution: 'NodeNext',
      strict: true,
      noEmit: true,
      skipLibCheck: true
    },
    include: ['consumer.ts']
  }, null, 2))
  run(join(typescriptDir, 'node_modules/.bin/tsc'), ['-p', 'tsconfig.json'], { cwd: consumerDir })
} finally {
  rmSync(temporaryDir, { recursive: true, force: true })
}

console.log('release-check passed')
