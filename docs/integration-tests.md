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

V1.1 的浏览器入口还会断言完整 Direct endpoint（主机、UDP 端口、certhash 和 `/p2p`）
与独立 expected public key；`./scripts/test-browser-integration.sh` 默认使用 `acceptance`
（正式验收）模式执行 20 次
独立 Direct 正向场景，并执行错误端口、错误 certhash、错误地址 PeerId、错误 expected
public key 和外部 Abort 负向场景。每次失败都必须有结构化 `errorCode`/`errorStage`，且
`pendingSigners` 为 0；另外执行 DNS localhost 解析成功、DNS 不可用、真实 Go stream reset、
证书轮换旧地址拒绝/新地址成功。

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

默认 `acceptance` 模式要求 WebSocket 和 WebRTC Direct 各至少重复 20 次，不能通过环境变量
把正式验收静默缩短。只想快速诊断环境时应显式使用 `smoke`（冒烟）模式；最终总结会报告
真实模式与次数：

```text
BROWSER_TEST_MODE=smoke BROWSER_WEBSOCKET_REPEATS=1 BROWSER_DIRECT_REPEATS=1 \
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

## V1.1 验收记录（2026-08-27）

以下命令在本地锁定依赖上通过：

```text
go test ./...
go vet ./...
(cd typescript && npm test)
./scripts/test-integration.sh
./scripts/test-browser-integration.sh
./scripts/test-demos.sh --all
make release-check
```

其中 TypeScript 单元测试当前为 41 tests；WebSocket 和 WebRTC Direct 浏览器场景各完成 20/20 正向重复；错误端口/certhash 在拨号阶段
返回 `ERR_WEBRTC_DIRECT_DIAL/dial`，错误地址 PeerId/期望公钥返回
`ERR_WEBRTC_DIRECT_PEER_ID/validate`，DNS 不可用返回
`ERR_WEBRTC_DIRECT_RESOLVE/resolve`，外部取消返回 `ERR_WEBRTC_DIRECT_TIMEOUT/dial`。
公开 `resolveWebRTCDirectEndpoint()` 在 resolver 忽略取消信号时返回
`ERR_WEBRTC_DIRECT_RESOLVE/resolve`；整体 Direct dial 的 DNS resolver 超时则返回
`ERR_WEBRTC_DIRECT_TIMEOUT/dial` 且不调用 `node.dial()`。证书轮换场景保持
PeerId/Noise 身份不变，旧 certhash 测试使用新服务器的 host、UDP 端口和 PeerId，仅替换
certhash，并返回 `DIAL/dial`；新地址 PASS。真实 Go reset 被 `/stream` 转换为
`ERR_STREAM_ABORTED/stream`。没有 WebSocket fallback，所有场景报告 `pendingSigners=0`。
`make release-check` 同时验证 `0.2.0` 正式 tarball 的两个
新 subpath、声明、source map、运行时 import 和 TypeScript 消费者，并按
[`npm-audit-risk-acceptance-0.2.0.json`](../release/npm-audit-risk-acceptance-0.2.0.json)
精确核对限期接受的生产依赖 audit 结果。

The cross-process matrix is not accepted merely because an endpoint prints
`OK`. Each client result must be parsed and compared with the server's actual
PeerId, the expected compressed public key, and the `/p2p` address component.
SDK-to-SDK remote-signer cases must keep the test private key outside the host
process. Native controls must have an isolated dependency graph and must not
import or link this SDK, including its test echo package.

## V1 baseline acceptance record

On 2026-08-26 the final acceptance passed: the Go cancellation contract returns
after Context cancellation, the required SDK-to-native dial directions and
independent signer-lane normal/failure modes pass, and bundled full Chromium
passes WebSocket, WebRTC Direct, pending, exit, host-stop, and multi-stream
scenarios. The formal npm tarball includes its README, LICENSE, and source maps
while excluding integration and browser test assets.
