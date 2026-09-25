# bitcoin-libp2p

`bitcoin-libp2p` 使用 Bitcoin 业务 secp256k1 私钥作为标准 libp2p 长期身份私钥，
让业务公钥、libp2p 身份公钥与 PeerId 保持确定性一致。

本项目不是私有 libp2p 实现，不修改 PeerId、Noise、Identify、Yamux 或业务 stream
的线上协议。未使用本 SDK 的原生 libp2p 节点，只要采用兼容的标准协议栈和业务
Protocol ID，也可以直接握手与通信。

当前仓库已完成 V1 实现并通过最终验收。remote signer 取消契约、规定拨号方向、独立 signer
失败场景和可追踪交付边界均已按整改施工单关闭：

- [V1 需求与协议边界](docs/bitcoin-libp2p-v1-需求文档.md)
- [V1 SDK 一次性施工单](施工单/20260826/001-bitcoin-libp2p-v1-sdk一次性施工单.md)
- [V1 审计整改施工单](施工单/20260826/002-bitcoin-libp2p-v1-审计整改施工单.md)

V1.1 已实现 Stream 和 WebRTC Direct 的 SDK 封装。`0.2.0` 已发布，是不可修改的 V1.1
基线：

- [V1.1 Stream 与 WebRTC Direct SDK 扩展需求](docs/bitcoin-libp2p-v1.1-stream-webrtc-direct-需求文档.md)
- [004 Stream 与 WebRTC Direct SDK 施工单](施工单/20260827/004-bitcoin-libp2p-stream-webrtc-direct-sdk施工单.md)

V1.2 已在 Go/TypeScript 增加通用 uvarint Stream 分帧，双语言包版本为 `0.3.0`，
已发布，是不可修改的 V1.2 基线。
发送 API 只接收 payload 并自动计算原始字节长度；最大接收长度只是本地安全检查，
不发送给对端、不握手、不协商：

- [V1.2 uvarint Stream 分帧需求](docs/bitcoin-libp2p-v1.2-uvarint-stream-framing-需求文档.md)
- [005 uvarint Stream 分帧施工单](施工单/20260901/005-bitcoin-libp2p-uvarint-stream-framing施工单.md)
- [006 TypeScript 接收队列安全整改施工单](施工单/20260901/006-TypeScript-uvarint接收队列安全整改施工单.md)

V1.3 新增 `/webrtc-interconnect`：SDK 内部管理 `RTCPeerConnection` 和 DataChannel，业务
外壳只提供一个与消息服务无关的外部信令 adapter，换来标准 libp2p `Connection`/`Stream`。
不引用 SatSubscription、ChannelProtocol 或 Circuit Relay，不实现 TURN 与 WebSocket
fallback。双浏览器大流量外部信令 E2E 是硬门槛：

- [V1.3 外部信令 WebRTC 需求](docs/bitcoin-libp2p-v1.3-external-signaling-webrtc-需求文档.md)
- [007 外部信令 WebRTC SDK 施工单](施工单/20260925/007-bitcoin-libp2p-external-signaling-webrtc-sdk施工单.md)

## 可运行 Demo

从 [examples/README.md](examples/README.md) 开始可在约五分钟内跑通 Go 或 TypeScript Hello，
再用另一语言 client 交叉连接。Demo-only Hello protocol、Remote Signer、Browser Worker 和
native libp2p 对照端都在该入口中；它们使用正式 SDK public exports，不会被打进 SDK 包。

```text
./scripts/test-demos.sh --quick   # Go/TS 同语言与交叉 Hello，不卡 Chromium
./scripts/test-demos.sh --all     # Remote Signer、真实 Chromium、native interop 与失败场景
```

完整的独立 integration 与浏览器回归仍见 [integration test 说明](docs/integration-tests.md)，
不会由普通 `go test ./...` 或 `cd typescript && npm test` 自动启动。
首次运行前请按 [examples/README.md](examples/README.md) 准备各 Demo 依赖；测试入口只检查依赖，
不会在源码目录执行 npm 安装或访问 registry。

Go SDK 的模块路径为 `github.com/bsv8/bitcoin-libp2p`，TypeScript 包名为
`bitcoin-libp2p`。两端都采用私钥分离模型：SDK 只取得业务公钥和两个
受限的 typed 签名能力，不负责保存、传输或管理业务私钥。

当前双语言包版本为 `0.3.1`：

```text
# 发布后再安装：
go get github.com/bsv8/bitcoin-libp2p@v0.3.1
npm install bitcoin-libp2p@0.3.1
```

## uvarint Stream 分帧最小用法

分帧格式是 `uvarint(payload 原始字节数) || payload`。分帧层只恢复消息边界，不解码
CBOR、JSON、Protobuf 或 SSP；`maxInboundFrameBytes`（本地单条 payload 接收上限）只在
初始化时设置，默认 `1 MiB`。

```go
import "github.com/bsv8/bitcoin-libp2p/streamio"

framer, err := streamio.NewUvarintFramer(stream) // 默认本地接收上限 1 MiB
if err != nil { /* 处理初始化错误 */ }
_ = framer.WriteFrame(sspWire)                  // 只传 payload，SDK 自动计算 len
wire, err := framer.ReadFrame()                 // 返回不含前缀的完整 payload
```

```ts
import { readUvarintFrames, writeUvarintFrame } from 'bitcoin-libp2p/stream'

writeUvarintFrame(stream, sspWire) // 只传 payload，SDK 自动使用 byteLength
for await (const wire of readUvarintFrames(stream)) {
  // wire 是一条完整原始 payload；Protocol ID/SSP/CBOR 由上层负责
}
```

TypeScript framing options 的字段含义：`maxInboundFrameBytes` 是单条 payload 的本地接收上限，
`maxBufferedBytes` 是 reader 持有的未消费字节总上限，`maxBufferedFrames` 是已完成未消费帧数上限，
`signal` 是长期读取的取消信号，`abortStreamOnError` 是分帧错误时是否 abort Stream；默认分别为
`1 MiB`、`4 MiB`、`1024`、不设置、`true`。

版本清单、发布门禁和发布顺序见 [双语言发布说明](release/README.md)。

```go
localSigner, _ := signer.NewLocalSigner(testOnlyKey) // TEST-ONLY；生产实现应连接受保护 signer
h, err := golibp2p.NewHost(golibp2p.HostConfig{
    Signer: localSigner,
    ListenAddrs: listenAddrs,
})
```

```ts
const signer: TypedSigner = new MyProtectedSigner() // 只实现 publicKey 与两个 typed 方法
const node = await createHost({ signer, transports: [webSockets()] })
```

适配器使用原生 libp2p 的 secp256k1 PeerId、Noise、Identify、Signed Peer Record 和
Yamux；`Raw/raw` 明确不可提取，签名结果在交给上游前以绑定公钥复验。Noise 负责
加密与握手，业务 secp256k1 key 只作为长期身份和受限身份签名 authority，不承载钱包、
交易或业务消息签名。

已支持：secp256k1 identity、标准 TCP/WebSocket/可注入 transport、浏览器 WebRTC Direct
出站拨号、外部信令 WebRTC 互联、严格 endpoint/certhash 校验、有界 Stream 读取、
uvarint Stream 分帧、标准 Noise/Yamux/Identify、Signed Peer Record、
authenticated remote public key 与 pin。未支持且有意留在
调用方：Worker leader/session/lease、Vault/HSM/gRPC 协议、业务 envelope、钱包和交易签名。

普通测试与跨进程测试分离：

```text
go test ./...
(cd typescript && npm test)
./scripts/test-integration.sh
./scripts/test-browser-integration.sh                 # acceptance：WebSocket/Direct 各至少 20 次 + 负向矩阵
./scripts/test-browser-interconnect.sh                # V1.3：双浏览器外部信令 WebRTC，16 MiB
BROWSER_INTERCONNECT_PAYLOAD_BYTES=67108864 ./scripts/test-browser-interconnect.sh   # 发布验收 64 MiB
./scripts/test-demos.sh --all
(cd typescript && npm pack --dry-run)                 # 发布前检查正式 tarball
make release-check
```

前两项离线且不会启动长期服务；中间三项是显式集成入口，使用本机随机端口和测试 key；
倒数第二项检查正式 npm tarball，最后一项是发布门禁。浏览器入口由 Playwright 启动真实
headless Chromium，不要求桌面或系统预装 Chromium。测试 signer 的 raw 私钥只在 Worker 中，
不能照搬到生产 Window 或 host。依赖升级后应重新安装对应 Playwright Chromium 并执行全部
验收命令。
