# 007 bitcoin-libp2p 外部信令 WebRTC SDK 施工单

> 关联需求：[V1.3 外部信令 WebRTC 需求](../../docs/bitcoin-libp2p-v1.3-external-signaling-webrtc-需求文档.md)
>
> 状态：SDK 核心与协议中立双浏览器 E2E 已完成，随 0.3.1 完成发布准备；SatSubscription/ChannelProtocol 业务适配和 keymaster 迁移待施工（2026-09-26）。
>
> 目标：在 bitcoin-libp2p 内实现可注入外部信令的 libp2p WebRTC Transport；业务外壳使用 SatSubscription + ChannelProtocol 交换 SDP/ICE；SDK 不依赖业务服务。

## 1. 施工边界

- [x] 删除实验性 `@libp2p/circuit-relay-v2` 依赖和 lockfile 条目。
- [x] 不修改或依赖 SatSubscription、ChannelProtocol、keymaster 业务代码。
- [x] 不实现 TURN、Circuit Relay 或 WebSocket fallback。
- [x] 不把 `RTCPeerConnection` 暴露到 SDK 公开 API。

## 2. 公开 API

目标目录：`typescript/src/webrtc-interconnect/`。

- [x] 定义 `WebRTCInterconnectSignal`。
- [x] 定义 `WebRTCInterconnectSignalingAdapter` 和 envelope 接口。
- [x] 定义 transport factory 和现有 Host 拨号 dialer，接入标准 Noise/Yamux/Upgrader。
- [x] 定义连接身份 pin、AbortSignal、超时和稳定错误码。
- [x] 支持挂入已有 Host 的 `createWebRTCInterconnectDialer` 和 inbound/outbound `onConnection`。
- [x] 增加 `./webrtc-interconnect` package export、files、tsconfig include 和 README 入口。
- [x] 保持现有 `/webrtc-direct` API 和行为不变。

当前公开边界：

```ts
interface WebRTCInterconnectSignalingAdapter {
  send(signal: WebRTCInterconnectEnvelope): Promise<void> | void
  subscribe(listener: (signal: WebRTCInterconnectEnvelope) => void): () => void
}
```

适配器负责把 envelope 路由到外部消息服务；SDK 不导入 SatSubscription 或
ChannelProtocol，也不创建业务会话。

## 3. Transport 实现

- [x] 在 SDK 内部创建和管理 `RTCPeerConnection`。
- [x] 通过外部 adapter 发送/接收 offer、answer、ICE。
- [x] 将 WebRTC DataChannel 接入 libp2p Upgrader，产生标准 `Connection`。
- [x] 使用标准 Yamux 和业务 `Stream`，不增加应用层大帧分片。
- [x] 连接建立后移除 SDK 活动 session；业务外壳自行关闭 ChannelProtocol/SatSubscription 会话。
- [x] 取消、超时、身份失败和底层关闭必须幂等清理。
- [x] 连接地址和诊断能证明最终 transport 是 `/webrtc`。
- [x] DataChannel backpressure 使用 `bufferedamountlow` 和显式 drain 等待。

## 4. 信令校验

- [x] 校验 offer/answer/ICE/close 的类型、顺序和大小。
- [x] 支持 AbortSignal 和连接超时。
- [x] 不记录 SDP、ICE 或私有信令正文。
- [x] 将目标 PeerId/公钥 pin 绑定到实际连接，并由 Noise 完成身份握手。
- [x] 迟到、重复、过期和错误 attempt 的消息 fail closed。
- [x] 不在 SDK 内重试或降级连接。

## 5. 单元测试

文件：`typescript/test/webrtc-interconnect.test.ts`。

- [x] signal codec、大小和 malformed envelope 边界。
- [x] `/webrtc/p2p/<peer>` 地址构造与解析。
- [x] transport factory 不依赖 SatSubscription/ChannelProtocol/Circuit Relay。
- [x] Node 内存外部信令建立标准 libp2p Stream，并验证 1 MiB payload。
- [x] `npm test` 全部通过（74 tests）。
- [ ] 补齐独立的 timeout、abort、replay、late-signal 和 close 状态机负向测试。

## 6. 双浏览器大流量 E2E

新增：

- `typescript/src/integration/browser-interconnect.ts`
- `typescript/integration/browser-interconnect-runner.mjs`
- `integration/browser-interconnect-server.mjs`
- `scripts/test-browser-interconnect.sh`

- [x] 创建两个独立浏览器上下文、两个独立 WorkerSigner 身份。
- [x] 使用独立的外部 HTTP 信令 adapter 完成 SDP/ICE 交换。
- [x] 成功建立标准 libp2p `Connection`，双方 `remoteAddr` 包含 `/webrtc/p2p/`。
- [x] 使用 Noise 身份握手；不使用 TURN、Circuit Relay 或 WebSocket fallback。
- [x] 传输 16 MiB 和 64 MiB。
- [x] 校验双向数据、多个 stream、backpressure、半关闭、取消和 SHA-256。
- [x] 浏览器业务测试外壳不直接创建 `RTCPeerConnection` 或 DataChannel。
- [ ] 在 keymaster 中实现 SatSubscription + ChannelProtocol adapter，并重跑同一浏览器验收。

HTTP 信令服务只用于 SDK 协议边界测试，不替代业务 ChannelProtocol 的认证、
重放保护和订阅计费。

## 7. 验证命令

```sh
npm --prefix typescript test
npm --prefix typescript run build:browser
bash scripts/test-browser-interconnect.sh
BROWSER_INTERCONNECT_PAYLOAD_BYTES=16777216 bash scripts/test-browser-interconnect.sh
BROWSER_INTERCONNECT_PAYLOAD_BYTES=67108864 bash scripts/test-browser-interconnect.sh
```

已完成结果：

- `npm test`：6 个 test files、74 个 tests 全部通过。
- 1 MiB Node/外部信令互操作：通过。
- 16 MiB 双浏览器外部信令 E2E：通过。
- 64 MiB 双浏览器外部信令 E2E：通过。
- 16 MiB SHA-256：`341aacac661ccb210720bedaa9ead5d668fe5ea41a73532fc147c71e34040df1`。
- 64 MiB SHA-256：`281e519df3077b557c6b03f5da83c4e8d397219259615dd7c3308f89cae8f2a6`。

## 8. 完成标准

- [x] SDK 单测通过。
- [x] 协议中立双浏览器真实大流量 E2E 通过。
- [x] 无 Circuit Relay/TURN 依赖。
- [x] SDK 公共 API 不暴露裸 WebRTC。
- [x] 作为 V1.3 随 `0.3.1` 完成发布准备，变更已提交。
- [ ] SatSubscription/ChannelProtocol 业务 adapter E2E 通过。
- [ ] keymaster BitFS 迁移完成并通过真实 WOC E2E。
