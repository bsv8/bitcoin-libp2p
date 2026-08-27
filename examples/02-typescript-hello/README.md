# Demo 02：TypeScript Hello

学习目标：用公开包 `bitcoin-libp2p` 重现 Go Hello 的 host、认证和双 stream 流程；它不使用底层 `createLibp2p`，也不引入 Web 框架或通用配置层。

## 进程关系

```text
TypeScript server: 临时 LocalSigner → createHost({ transports: [tcp()] }) → Hello handler
TypeScript client: createHost → dial → authenticateConnection → 两条 Hello stream
Node 进程只消费 SDK 的公开 root/subpath exports；业务 payload 不携带身份。
```

## 前置环境

需要 Node.js 20+、npm。先在仓库根目录构建 SDK，再安装本 Demo 的固定 lockfile：

```text
npm ci --prefix typescript
npm run build --prefix typescript
npm ci --prefix examples/02-typescript-hello
npm run build --prefix examples/02-typescript-hello
```

## Server

```text
node examples/02-typescript-hello/dist/main.js --mode server
```

复制 `ready` JSON 的 `address`、`peerId` 和 `publicKey`。

## Client

```text
node examples/02-typescript-hello/dist/main.js --mode client \
  --dial <ready.address> \
  --message "hello from typescript" \
  --expect-peer-id <ready.peerId> \
  --expect-public-key <ready.publicKey>
```

预期输出是一行 JSON：

```json
{"event":"hello","demo":"typescript-hello","language":"typescript","remotePeerId":"<server peerId>","remotePublicKey":"02...","remoteAddress":"<dial address>","addressPeerId":"<server peerId>","request":"hello from typescript","response":"hello, hello from typescript","streams":2}
```

## API 对照

`new LocalSigner(randomPrivateKey())` 只生成 Demo identity；`createHost` 负责 SDK 的标准 host 组装，应用显式注入 `tcp()`；`node.handle` 注册应用协议；client 使用 `node.dial`、`authenticateConnection` 和 `newStream`。 `finally` 中的 `node.stop()` 是示例的一部分。实现见 [src/main.ts](src/main.ts)。

E2E 会先 `npm pack` 正式 SDK，再把 tarball 离线安装进临时消费者目录，验证 `bitcoin-libp2p` 公开 exports 与声明可被消费者解析；Demo 自身不会进入 SDK tarball。

## 私钥边界

`LocalSigner` 仅适合 Demo、测试或可信单进程程序。随机 raw key 只存于当前 Node 进程的 signer，不写 stdout/日志；生产 Window/host 不应取得业务私钥，应把两个 typed signer 方法连接到受保护运行位置。不要相信业务响应中的身份字段，始终使用 `authenticateConnection` 的结果。

## 错误与停止

空消息、非法 UTF-8 或超过 1 KiB 会 reset 当前 stream；fatal 错误写 stderr 并以非零退出。server 按 Ctrl-C、SIGTERM 或 EOF 关闭，client 在 `finally` 停止节点；拨号、pin 或响应不匹配都会失败。

## 对应 E2E

`./scripts/test-demos.sh --quick` 使用这里构建出的 `dist/main.js` 覆盖 `typescript-to-typescript`，并与 Demo 01 复用同一源码完成 `go-to-typescript` 和 `typescript-to-go`。四个场景都在同一连接上开两条 stream。
