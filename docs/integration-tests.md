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
./scripts/test-browser-interconnect.sh
./scripts/test-demos.sh --quick
./scripts/test-demos.sh --all
```

## V1.3 外部信令 WebRTC 验收

外部信令 WebRTC 互联的浏览器验收由以下入口执行；它使用两个独立浏览器上下文、两个独立
WorkerSigner 身份和一个独立的外部 HTTP 信令 adapter，只用于 SDK 协议边界测试：

```text
./scripts/test-browser-interconnect.sh
BROWSER_INTERCONNECT_PAYLOAD_BYTES=16777216 ./scripts/test-browser-interconnect.sh
BROWSER_INTERCONNECT_PAYLOAD_BYTES=67108864 ./scripts/test-browser-interconnect.sh
```

默认 payload 是 16 MiB，`64 MiB` 是发布验收规模。`BROWSER_INTERCONNECT_REPEATS` 控制
重复次数。验收成功要求：双方通过 Noise 身份握手得到标准 libp2p `Connection`，
`connection.remoteAddr` 包含 `/webrtc/p2p/`，并校验双向数据、多个 stream、backpressure、
半关闭、取消和 SHA-256。不使用 Circuit Relay、TURN 或 WebSocket fallback；浏览器业务测试
外壳不直接创建 `RTCPeerConnection` 或 DataChannel。

HTTP 信令服务不是业务认证方案。keymaster 的 SatSubscription + ChannelProtocol adapter
与真实 WOC E2E 仍是未关闭的业务验收项。

## V1.2 uvarint framing 验收

通用分帧的跨语言验收由以下入口执行；它不会启动 Chromium 或访问外部网络：

```text
node scripts/test-framing-integration.mjs
```

`./scripts/test-integration.sh` 会先构建 TypeScript integration，再自动调用上面的入口，
并额外运行 Go SDK ↔ TypeScript SDK 的真实长连接场景。每条 framing Stream 在同一条连接上
交换小 payload、中文 UTF-8 字节和 128 KiB payload；只有最后一条消息后才关闭本地写端。

跨语言脚本输出一行结构化 JSON，字段含义如下：

| 字段 | 中文含义 |
|---|---|
| `event` | 验收事件名称；`uvarint-framing-cross-language` 表示跨语言结果 |
| `vectors` | 参与 Go/TypeScript 编码互解的 payload 数量 |
| `byteExact` | 两端 frame 字节是否逐字节一致 |
| `invalidCases` | 非法前缀、截断和超限输入的稳定错误分类 |
| `maxInboundFrameBytes` | 仅本地检查的接收上限；不会进入 frame 或发送给对端 |

浏览器验收 `./scripts/test-browser-integration.sh` 的成功场景还会在原有两条有限响应
Stream 之外，显式使用 `bitcoin-libp2p/stream` 交换 3 条 framing 消息，因此 WebSocket
和 WebRTC Direct 都覆盖同义 framing。浏览器结果中的 `framingFrames` 是收到的完整
payload 数量，必须为 `3`；`streams` 仍表示原有有限响应 Stream 数量，必须为 `2`。

SSP 等上层协议的边界示例：

```text
业务 Protocol ID：/ssp/1.0.0                 # 由 SSP 定义
Stream framing：bitcoin-libp2p uvarint       # 由本 SDK 实现
本地接收上限：1 MiB                           # 本地检查，不发给对端
payload：完整 SSP Wire                        # 由 SSP 解码和校验
```

framing 层不 import SSP、不解码业务 payload，也不把 `readStreamToEnd` 用作长期多消息
Stream 的替代品。

## V1.3 验收记录（2026-09-26）

0.3.1 发布准备的全量回归已通过：

```text
go test ./...
go vet ./...
(cd typescript && npm test)                       # 6 files, 74 tests
node scripts/test-framing-integration.mjs         # vectors=10, byteExact=true
./scripts/test-browser-integration.sh             # acceptance：WebSocket 20/20、Direct 20/20 + 负向矩阵
./scripts/test-demos.sh --all                     # 20 scenarios，含 native interop 与失败场景
./scripts/test-browser-interconnect.sh            # 16 MiB 双浏览器外部信令
BROWSER_INTERCONNECT_PAYLOAD_BYTES=67108864 ./scripts/test-browser-interconnect.sh   # 64 MiB 发布验收
node scripts/release-check.mjs                    # 0.3.1 发布门禁通过
```

V1.3 外部信令 WebRTC 验收结果：16 MiB 与 64 MiB 双浏览器 E2E 均 PASS，双方
`remoteAddr` 为 `/webrtc/p2p/<peer>`，`streams=2`、`cancelled=1`、`pendingSigners=0`，
SHA-256 分别为 `341aacac661ccb210720bedaa9ead5d668fe5ea41a73532fc147c71e34040df1` 与
`281e519df3077b557c6b03f5da83c4e8d397219259615dd7c3308f89cae8f2a6`。

本批次同时关闭三个发布阻塞问题：

1. `webrtc-interconnect` 曾 import 未声明的 `@libp2p/utils`，只因传递依赖被提升才能解析；
   已补为精确版本直接依赖，删除未使用的 `uint8arraylist` import，并在发布门禁中新增
   「正式 `dist` 的每条裸模块说明符必须是已声明依赖或 Node.js 内置模块」检查。
2. `node-datachannel@0.33.1` 声明了上游从未发布的可选依赖
   `@node-datachannel/android-arm64@0.33.1`，导致 `npm ci` 直接失败、`make release-check`
   无法执行；已升到 `0.33.4`（`@libp2p/webrtc` 声明的 `^0.33.0` 区间内），三个 example
   lockfile 同步修正。
3. 完整 `npm audit` 从 0.3.0 的 7 个 high 收敛到 1 个 high，已重新审查并记录在
   [0.3.1 npm audit 限期风险接受](../release/npm-audit-risk-acceptance-0.3.1.json)。

未执行 npm publish、Go tag 创建或远程 push。

环境注意：`./scripts/test-browser-integration.sh` 硬依赖 `rg`（ripgrep）读取服务端 READY
行，缺失时会静默等待到超时而不是立即报错；`make` 与 ripgrep 都不在
[examples/README.md](../examples/README.md) 的依赖清单里。Playwright 浏览器版本必须与
`playwright-core` 的 `browsers.json` 匹配，升级后需重新执行 `npx playwright install chromium`。
`./scripts/test-browser-interconnect.sh` 在 Playwright 浏览器缺失时会回退到
`CHROME_PATH` 或 `/usr/bin/google-chrome`，其结果可能来自系统 Chrome 而非 Playwright
自带的 Chromium。

## V1.2 验收记录（2026-09-01）

A08 全量回归已通过：

```text
go test ./...
go test -race ./...
go vet ./...
(cd typescript && npm test)                 # 5 files, 63 tests
node scripts/test-framing-integration.mjs   # vectors=10, byteExact=true
./scripts/test-integration.sh
./scripts/test-browser-integration.sh      # WebSocket/Direct 各 20/20
./scripts/test-demos.sh --all
(cd typescript && npm pack --dry-run)       # 0.3.0 tarball 含 /stream JS、声明和 source map
make release-check                           # 0.3.0 发布门禁通过
```

跨语言非法输入分类、默认 1 MiB 上限、Go 并发写、TypeScript 拆包/粘包/多 frame、EOF、
reset、取消和 listener/buffer 清理均通过。真实 SDK 集成在同一条 Stream 上交换小 payload、
中文 UTF-8 payload 和 128 KiB payload；浏览器 WebSocket 与 WebRTC Direct 成功场景均报告
`framingFrames=3`。TypeScript reader 还验证默认 4 MiB/1024 帧的未消费队列上限、
`ERR_FRAME_BUFFER_FULL`、options 快照和 `abortStreamOnError: false` 清理路径。未执行
npm publish、Go tag 创建或远程 push。

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

其中 V1.1 当时 TypeScript 单元测试为 41 tests；WebSocket 和 WebRTC Direct 浏览器场景各完成 20/20 正向重复；错误端口/certhash 在拨号阶段
返回 `ERR_WEBRTC_DIRECT_DIAL/dial`，错误地址 PeerId/期望公钥返回
`ERR_WEBRTC_DIRECT_PEER_ID/validate`，DNS 不可用返回
`ERR_WEBRTC_DIRECT_RESOLVE/resolve`，外部取消返回 `ERR_WEBRTC_DIRECT_TIMEOUT/dial`。
公开 `resolveWebRTCDirectEndpoint()` 在 resolver 忽略取消信号时返回
`ERR_WEBRTC_DIRECT_RESOLVE/resolve`；整体 Direct dial 的 DNS resolver 超时则返回
`ERR_WEBRTC_DIRECT_TIMEOUT/dial` 且不调用 `node.dial()`。证书轮换场景保持
PeerId/Noise 身份不变，旧 certhash 测试使用新服务器的 host、UDP 端口和 PeerId，仅替换
certhash，并返回 `DIAL/dial`；新地址 PASS。真实 Go reset 被 `/stream` 转换为
`ERR_STREAM_ABORTED/stream`。没有 WebSocket fallback，所有场景报告 `pendingSigners=0`。
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
