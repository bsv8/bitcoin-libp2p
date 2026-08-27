# Demo 01：Go Hello

学习目标：用 Go SDK 创建标准 libp2p host、注册应用自己的 Hello handler、认证远端连接并在同一连接上完成两条 stream；它不介绍生产配置、重连或钱包业务。

## 进程关系

```text
Go server: 临时 LocalSigner → golibp2p.NewHost → Noise/Yamux/Identify → Hello handler
Go client: 临时 LocalSigner → Connect → AuthenticatedPeerFromConn → 两条 Hello stream
业务 payload 只有 UTF-8 文本；身份来自已经认证的 libp2p connection。
```

## 前置环境

需要 Go 1.25+，并在仓库根目录执行命令。SDK 模块是当前主 module；不需要额外服务或公网。

## Server

```text
go run ./examples/01-go-hello --mode server
```

复制输出 JSON 的 `address`、`peerId` 和 `publicKey`。server 只有监听和 handler 注册完成后才输出 `event: "ready"`。

## Client

```text
go run ./examples/01-go-hello --mode client \
  --dial <ready.address> \
  --message "hello from go" \
  --expect-peer-id <ready.peerId> \
  --expect-public-key <ready.publicKey>
```

预期输出是一行 JSON，形如：

```json
{"event":"hello","demo":"go-hello","language":"go","remotePeerId":"<server peerId>","remotePublicKey":"02...","remoteAddress":"<dial address>","addressPeerId":"<server peerId>","request":"hello from go","response":"hello, hello from go","streams":2}
```

## API 对照

`newDemoSigner` 生成临时 `signer.LocalSigner`；`golibp2p.NewHost(HostConfig{...})` 组装标准 identity、Noise、Yamux 和 Identify；`installHello` 由应用调用 `SetStreamHandler`；client 使用 `h.Connect`、`AuthenticatedPeerFromConn`、可选 `NewPin`，再用 `h.NewStream`、`Write`、`CloseWrite` 和读取响应完成两次 round trip。主流程见 [main.go](main.go)。

## 私钥边界

源码在 signer 创建处明确标注：`LocalSigner` 只适合 Demo、测试或可信单进程程序。raw 私钥随机生成、不写入 JSON、不打印；生产 host 不应复制业务私钥，需使用 typed signer 时请看 [Demo 04](../04-remote-signer/README.md)。Hello payload 也不应自报 PeerId 或公钥。

## 错误与停止

空消息、非法 UTF-8 或超过 1 KiB 会重置当前 stream，不会关闭 host。错误写 stderr 并返回非零；client 完成后自动关闭，server 用 Ctrl-C、SIGTERM 或关闭 stdin 退出并回收监听端口。 `--expect-*` 不匹配会失败。

## 对应 E2E

`./scripts/test-demos.sh --quick` 使用这个文件中的同一可执行程序覆盖 `go-to-go`，并把它与 Demo 02 组合覆盖 `go-to-typescript`、`typescript-to-go`；每项解析 `ready`/`hello` JSON，比较认证公钥、PeerId、`/p2p` 地址、响应和两条 stream。
