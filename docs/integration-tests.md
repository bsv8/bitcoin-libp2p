# Integration Tests

The default tests are intentionally single-process and offline:

```text
go test ./...
cd typescript && npm test
```

They do not start Chromium, Go/TypeScript cross-language services, or
long-running listeners. The explicit integration entry points are:

```text
./scripts/test-integration.sh
./scripts/test-browser-integration.sh
./scripts/test-demos.sh --quick
./scripts/test-demos.sh --all
```

The first command is reserved for the Go/TypeScript SDK and native libp2p
interop matrix, including the isolated `go-libp2p v0.45.0` native endpoint.
The second is reserved for real headless Chromium WebSocket and WebRTC Direct
scenarios driven by Playwright. It does not require a desktop, X11, Wayland, or
a system-installed Chromium executable. Both commands use local random ports,
bounded timeouts, cleanup traps, and no public network. They are not invoked by
ordinary tests and are not required CI jobs.

The Demo entry points are a separate developer-facing path:

- [`examples/README.md`](../examples/README.md) is the five-minute Hello path;
- `--quick` runs the same Go/TypeScript Demo programs in all four Hello
  combinations and does not start Chromium;
- `--all` adds the two process-separated signer examples, real Chromium
  WebSocket/WebRTC Direct, and the independent native Go/TypeScript endpoints.

Prepare the dependencies explicitly before running the Demo entry point; it
only checks them and does not run `npm ci` or access the registry. The formal
SDK tarball check in `--all` installs into a disposable directory with npm's
offline mode.

The Demo runner parses each JSON `ready`/`hello`/`failure`/`closed` event,
compares the authenticated public key, PeerId, `/p2p` component, response, and
two-stream result, and fails on timeout, pending signer requests, a live signer
PID, or leftover signer/host/browser work. It is not a
replacement for this document's stronger existing integration matrix.

Install the test-only browser once for the current Playwright version:

```text
cd typescript
npm ci
npx playwright install chromium
```

On a Linux environment that does not already have Chromium's shared-library
dependencies, an administrator or prepared development image can run:

```text
cd typescript
npx playwright install --with-deps chromium
```

Then execute the explicit browser suite from the repository root:

```text
./scripts/test-browser-integration.sh
```

Missing Playwright/Chromium is a clear test-environment failure, not a skipped
success. The browser test remains opt-in by command and is not added to the
ordinary test command or a mandatory CI workflow.

The Go SDK client endpoint removes the echoed test protocol from its local
peerstore before opening the test stream. This deliberately exercises the full
standard multistream-select exchange; the TypeScript client covers the
optimistic pre-negotiated path. It is an integration-test control choice, not
a wire-protocol change.

The browser bundle is built with:

```text
cd typescript && npm run build:browser
```

Playwright launches its bundled full Chromium with `headless: true` and
`channel: 'chromium'`, loads
`integration/browser/index.html`, uses a Worker-backed typed signer, and waits
for an explicit `PASS` result containing the authenticated public key and
PeerId. It also fails on page errors, console errors, navigation/test timeout,
Worker failure, or a non-PASS result. The
WebRTC Direct case uses the native Go v0.49 test endpoint because the upstream
Go WebRTC Direct constructor derives its DTLS certificate from
`PrivKey.Raw()`; the SDK's safe default remains TCP and any raw-reading
transport must be reviewed and explicitly injected by the caller.

The existing integration test application protocol is
`/bitcoin-libp2p/test/echo/1.0.0`. It sends a bounded byte payload and receives
the exact bytes back. It is not an identity protocol and is never registered by
either SDK host assembler. The developer Demo uses the separate
`/bitcoin-libp2p/demo/hello/1.0.0` protocol documented in
[`examples/protocol.md`](../examples/protocol.md).

The cross-process matrix is not accepted merely because an endpoint prints
`OK`. Each client result must be parsed and compared with the server's actual
PeerId, the expected compressed public key, and the `/p2p` address component.
SDK-to-SDK remote-signer cases must keep the test private key outside the host
process. Native controls must have an isolated dependency graph and must not
import or link this SDK, including its test echo package.

## Acceptance record

On 2026-08-26 the final acceptance passed: the Go cancellation contract returns
after Context cancellation, the required SDK-to-native dial directions and
independent signer-lane normal/failure modes pass, and bundled full Chromium
passes WebSocket, WebRTC Direct, pending, exit, host-stop, and multi-stream
scenarios. The formal npm tarball includes its README, LICENSE, and source maps
while excluding integration and browser test assets.
