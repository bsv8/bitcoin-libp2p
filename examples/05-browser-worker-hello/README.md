# Demo 05：Browser Worker Hello

学习目标：在真实 Chromium Window 中使用 TypeScript SDK，让 raw 私钥只存在 dedicated Worker，并通过明确选择的 WebSocket 或 WebRTC Direct 连接独立原生 Go Hello server；它不是生产 Keymaster、会话或页面管理器。

## 进程关系

```text
Chromium Window: public key + Worker-backed TypedSigner proxy → SDK host → selected transport
signer Worker: random raw key + LocalSigner → 仅响应 noise-static-key / peer-record
native Go server: independent go-libp2p module → standard Noise/Yamux/Identify/Hello。
```

## 前置环境

需要 Node.js 20+、npm、Go 1.25+、Python 3（仅用于手工静态文件服务）。首次准备：

```text
npm ci --prefix typescript
npm run build --prefix typescript
npm ci --prefix examples/05-browser-worker-hello
npm run build --prefix examples/05-browser-worker-hello
npm run build:browser --prefix examples/05-browser-worker-hello
go -C examples/05-browser-worker-hello/server mod download
cd typescript && npx playwright install chromium
```

Playwright 缺少 Chromium 时，显式 E2E 会以非零失败并提示同一条安装命令；不会静默跳过。

## Server

一条命令启动独立原生 Go receiver 和静态页面，并打印可直接访问的 URL。WebSocket：

```text
./scripts/run-browser-demo.sh websocket
```

WebRTC Direct：

```text
./scripts/run-browser-demo.sh webrtc-direct
```

脚本默认使用 HTTP 8080 端口，也可以传第二个参数指定端口。它会打印 `ready.address` 和完整访问 URL；访问该 URL 即可看到 browser/remote PeerId、公钥、transport、请求、响应和状态。两个 bundle 需要先按前置环境构建。

## Browser client

浏览器代码由 [src/main.ts](src/main.ts) 加载 `/signer-worker.js`，Window 不接触 raw key：

由 `scripts/run-browser-demo.sh` 输出的 URL：

```text
http://127.0.0.1:8080/?addr=<URL 编码后的 ready.address>&transport=websocket
http://127.0.0.1:8080/?addr=<URL 编码后的 ready.address>&transport=webrtc-direct&expected-public-key=<ready.publicKey>
```

两种 transport 都应显示 `PASS`、`hello, browser hello` 和两条 stream；页面不会从 WebRTC Direct 自动降级为 WebSocket。

## API 对照

Window 的 `WorkerSigner` 实现 `TypedSigner`；WebSocket 使用 `createHost`，WebRTC Direct 使用 `createWebRTCDirectDialer` 和 `dialAuthenticatedWebRTCDirect`，并要求从 ready 元数据独立传入 `expected-public-key`。两种路径的响应读取都使用 `readStreamToEnd`。Worker 内使用 `LocalSigner` 执行两种 typed purpose，native Go 端只实现标准 libp2p stream handler。runner 用 full Chromium `headless: true`、`channel: 'chromium'` 检查 authenticated identity、页面错误、console error、crash 和 timeout。

## 私钥边界

raw TEST-ONLY key 只存在 Worker；Window、URL、DOM、console 和网络日志不输出它，Worker message 也不接受任意签名 payload。Demo 的 pending、Worker exit、Abort 和 host stop 场景都会验证 pending Promise 结束，并报告 `pendingSignerRequests: 0`；生产应用仍需自行实现 Keymaster 的 session、leader、lease 和 Vault lock，不能把这个 Worker 当成安全隔离的生产方案。

## 错误与停止

URL 缺少 `addr`、transport 拼写错误、拨号失败、认证失败或 Hello 响应不匹配都会显示 `FAIL`；页面错误不会被标为成功。Ctrl-C 停 Go server，关闭静态 HTTP server；页面退出会停止 libp2p node 和 Worker。浏览器测试依赖缺失时按前置环境安装 Chromium。

## 对应 E2E

`./scripts/test-demos.sh --all` 启动 [server/main.go](server/main.go) 的独立 Go endpoint，执行 `browser-websocket` 与 `browser-webrtc-direct` 成功场景，以及 WebSocket 下的 `pending`、`worker-exit`、`abort`、`host-stop` 失败场景；runner 使用 full Chromium，并断言 authenticated public key、PeerId、Hello 响应、两条 stream、`pendingSignerRequests: 0`、Worker 状态以及无 page/console/crash 错误。
