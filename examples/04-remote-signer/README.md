# Demo 04：Remote Signer Hello

学习目标：让 Hello host 只持有 signer public key 和两个 typed 签名能力，把 raw 私钥留在独立 signer 进程；这里的 stdio JSONL 只是教学 IPC，不是 bitcoin-libp2p 的生产 RPC 标准。

## 进程关系

```text
host process: public key + typed signer client → bitcoin-libp2p host → Noise/Identify/Hello
signer child: raw LocalSigner → 仅处理 noise-static-key / peer-record → 返回 DER signature
E2E: host PID 与 signer PID 分离；两条 Hello stream 复用同一已认证连接。
```

## 前置环境

需要 Go 1.25+、Node.js 20+、npm，并在仓库根目录执行。Go host 需要先构建 sibling signer；TypeScript host 会自动启动同目录的 `dist/signer.js`：

```text
go build -o /tmp/bitcoin-libp2p-demo-signer ./examples/04-remote-signer/go/signer
npm ci --prefix typescript
npm run build --prefix typescript
npm ci --prefix examples/04-remote-signer/typescript
npm run build --prefix examples/04-remote-signer/typescript
```

## Server

Go host：

```text
go run ./examples/04-remote-signer/go/host --mode server \
  --signer-command /tmp/bitcoin-libp2p-demo-signer
```

TypeScript host：

```text
node examples/04-remote-signer/typescript/dist/host.js --mode server
```

两者的 `ready` JSON 都包含 host 的 `peerId`、signer public key、`hostPid`、`signerPid` 和监听地址；不会包含 raw key。

## Client

Go client（两端均可用 Go host）：

```text
go run ./examples/04-remote-signer/go/host --mode client \
  --dial <ready.address> --message "hello from remote signer" \
  --expect-peer-id <ready.peerId> --expect-public-key <ready.publicKey> \
  --signer-command /tmp/bitcoin-libp2p-demo-signer
```

TypeScript client（两端均可用 TypeScript host）：

```text
node examples/04-remote-signer/typescript/dist/host.js --mode client \
  --dial <ready.address> --message "hello from remote signer" \
  --expect-peer-id <ready.peerId> --expect-public-key <ready.publicKey>
```

成功的 `hello` JSON 除标准字段外会报告 `signerRequests`、`signerNoiseRequests`、`pendingSignerRequests` 和两组 PID；`ready.signerNoiseRequests` 必须为 0，成功后的 `hello.signerNoiseRequests` 必须恰好为 1，且 pending 为 0。两条业务 stream 复用同一条已认证连接，不应再次触发 Noise 签名。

## API 对照

Go 的 `processSigner` 实现 SDK `signer.Signer`，只序列化固定 purpose 后交给 `golibp2p.NewHost(HostConfig{Signer: ...})`；TypeScript 的 `ProcessSigner` 实现 `TypedSigner`，再交给 `createHost({ signer, transports: [tcp()] })`。两端 adapter 都按绑定公钥复验签名，主流程仍使用 `AuthenticatedPeerFromConn`/`authenticateConnection` 和两条 Hello stream。实现位于 [Go host](go/host/main.go)、[Go signer](go/signer/main.go)、[TS host](typescript/src/host.ts) 和 [TS signer](typescript/src/signer.ts)。

## 私钥边界

host 进程不构造 `LocalSigner`，不读取 raw key；raw key 只在 signer child 中随机生成且不打印。IPC 只允许 `noise-static-key` 和 `peer-record` 两种 typed request（以及 ready 中的 public key），不接受任意 bytes/digest/domain。生产环境应把同一个 typed interface 接到 Keymaster、Worker、HSM 或受保护服务，并自行负责 session/lease/权限；不要把本 Demo JSONL 当作跨语言协议。

## 错误与停止

`--signer-mode exit|reject|wrong-key` 会让 signer 退出、拒签或返回错误 key；`--signer-mode pending --sign-timeout-ms 300` 可观察有界超时，`--host-stop-after-ms 100` 可观察 stop 结束 pending。失败必须以非零返回且不能留下等待；Ctrl-C/SIGTERM 会先取消 host 请求，再关闭 host、stdin 和 signer 子进程。

## 对应 E2E

`./scripts/test-demos.sh --all` 覆盖 `go-remote-signer`、`typescript-remote-signer`，断言 PID 分离、连接前后 Noise 请求从 0 到恰好 1、两条业务 stream 不增加 Noise 请求以及 pending 为 0；另外覆盖 signer exit 和 host stop 的失败场景，要求 host 输出结构化 `failure` 事件、pending 为 0 且 signer PID 已退出。更完整的 reject/wrong-key 矩阵仍由既有 integration 入口负责。
