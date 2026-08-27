# Demo 06：Native libp2p Interop

学习目标：用不依赖本 SDK 的原生 Go/TypeScript libp2p server 证明 Hello wire 是标准 libp2p；它不复制 SDK adapter、typed signer 或认证 helper。

## 进程关系

```text
Go SDK client → standard Noise/Yamux/TCP → independent native TypeScript server
TypeScript SDK client → standard Noise/Yamux/TCP → independent native Go server
native-typescript/package.json 与 server/go.mod 都不引用 @bsv8/bitcoin-libp2p。
```

## 前置环境

需要 Go 1.25+、Node.js 20+、npm。在仓库根目录准备 SDK 和两个 endpoint：

```text
npm ci --prefix typescript
npm run build --prefix typescript
npm ci --prefix examples/02-typescript-hello
npm run build --prefix examples/02-typescript-hello
npm ci --prefix examples/06-native-interop/native-typescript
npm run build --prefix examples/06-native-interop/native-typescript
go -C examples/05-browser-worker-hello/server mod download
```

## Server

原生 TypeScript server：

```text
node examples/06-native-interop/native-typescript/dist/main.js --mode server
```

原生 Go server（复用 Demo 05 的独立 module，改用 TCP）：

```text
go run -C examples/05-browser-worker-hello/server . --mode server --transport tcp
```

两者都输出包含 `ready.address`、`peerId`、`publicKey` 和同一 Demo protocol 的 JSON；这些 server 不 import SDK。

## Client

Go SDK → native TypeScript：

```text
go run ./examples/01-go-hello --mode client \
  --dial <native-TS ready.address> --message "go sdk to native ts" \
  --expect-peer-id <native-TS ready.peerId> --expect-public-key <native-TS ready.publicKey>
```

TypeScript SDK → native Go：

```text
node examples/02-typescript-hello/dist/main.js --mode client \
  --dial <native-Go ready.address> --message "ts sdk to native go" \
  --expect-peer-id <native-Go ready.peerId> --expect-public-key <native-Go ready.publicKey>
```

SDK client 仍从 Noise 已认证 connection 取得远端公钥/PeerId，并在同一 connection 上打开两条 Hello stream。

## API 对照

原生 Go 直接使用 `libp2p.New`、`Identity`、Noise、Yamux、TCP 和 `SetStreamHandler`；原生 TypeScript 直接使用 `createLibp2p`、`tcp()`、`noise()`、`yamux()`、Identify 和 `node.handle`。SDK client 的对照 API 仍是 Demo 01 的 `AuthenticatedPeerFromConn` 与 Demo 02 的 `authenticateConnection`。实现见 [native TypeScript](native-typescript/src/main.ts) 和 [native Go](../05-browser-worker-hello/server/main.go)。

## 私钥边界

native endpoint 可以为自身 libp2p identity 生成临时 secp256k1 key，但不会复制 SDK 的 non-extractable adapter、typed signer 或业务身份协议；key 不输出。所有 endpoint 都是本机测试程序，不应拿示例 key 作为生产密钥管理方案。

## 错误与停止

无 `/p2p` 地址、认证 pin 不匹配、协议协商失败或响应错误会以非零退出；server 用 Ctrl-C、SIGTERM 或 EOF 停止。原生依赖图检查失败时整体 E2E 失败，不会用“输出 OK”掩盖依赖污染。

## 对应 E2E

`./scripts/test-demos.sh --all` 执行 `go-sdk-to-native-typescript` 和 `typescript-sdk-to-native-go`，比较 ready 与 hello 的公钥、PeerId、`/p2p` component、响应和两条 stream，并检查 Go module 与 native TypeScript package 的依赖隔离。
