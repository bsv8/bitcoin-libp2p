# bitcoin-libp2p V1.3 外部信令 WebRTC 互联需求

> 状态：设计已确认，施工中（2026-09-25）。
>
> 本文是外部信令 WebRTC 能力的长期需求真值。施工入口见
> [007 施工单](../施工单/20260925/007-bitcoin-libp2p-external-signaling-webrtc-sdk施工单.md)。
>
> V1 的 identity、PeerId、Noise、Identify、Yamux、typed signer 和 stream 边界继续以
> [V1 需求](bitcoin-libp2p-v1-需求文档.md)为准。

## 1. 背景

浏览器之间的 WebRTC 需要交换 SDP 和 ICE。当前业务若直接创建
`RTCPeerConnection`，就会把 WebRTC 生命周期、DataChannel、错误处理和业务协议
混在一起，无法复用 libp2p 的 Host、Connection、Stream、身份和生命周期封装。

V1.3 要把 WebRTC 互联能力放进 `bitcoin-libp2p`：SDK 内部管理 WebRTC 和标准
libp2p 连接，上层只向 SDK 提供一个与具体消息服务无关的外部信令适配器。

## 2. 已确认的边界

- SatSubscription 是业务外壳的外部交换服务。
- ChannelProtocol 负责加密、身份验证、消息校验、重放保护和业务会话绑定。
- bitcoin-libp2p 不引用 SatSubscription、ChannelProtocol 或任何业务订阅频道。
- Circuit Relay 不参与地址交换、reservation 或 SDP/ICE 转发。
- TURN 不使用；只接受调用方传入的 STUN/ICE 配置。
- 裸 `RTCPeerConnection` 只能存在于 SDK 内部；业务代码只能使用标准 libp2p API。
- 一条业务会话只允许一个活动 WebRTC 连接；失败重试必须使用新的 attempt ID。

## 3. 目标架构

```text
SatSubscription + ChannelProtocol（外壳）
        │  WebRTCSignalingAdapter
        ▼
bitcoin-libp2p WebRTC Transport（SDK 内部 RTCPeerConnection）
        │  Noise / Yamux / Upgrader
        ▼
标准 libp2p Connection / Stream / Protocol
        ▼
BitFS 或其它业务协议
```

数据面和信令面分离：

1. 外壳通过 SatSubscription 发送 `offer`、`answer` 和 ICE candidate；
2. SDK 产生和消费 WebRTC 信令对象，但不决定消息如何传输；
3. WebRTC 建立后，信令会话关闭；
4. 业务数据只通过标准 libp2p Stream 传输，不再通过信令通道传输。

## 4. SDK 公开边界

SDK 提供与业务无关的外部信令接口。接口只处理带路由元数据的 opaque WebRTC
signal，不包含 SatSubscription 或 ChannelProtocol 类型。适配器由业务外壳实现，
负责把这些 envelope 放入 SatSubscription/ChannelProtocol；SDK 不创建业务会话：

```ts
interface WebRTCInterconnectSignalingAdapter {
  send(signal: WebRTCInterconnectEnvelope): Promise<void> | void
  subscribe(listener: (signal: WebRTCInterconnectEnvelope) => void): () => void
}

interface WebRTCInterconnectEnvelope {
  connectionId: string
  attemptId: string
  from: string
  to: string
  sequence: number
  expiresAtMs: number
  signal: WebRTCInterconnectSignal
}

type WebRTCInterconnectSignal =
  | { type: 'offer', sdp: string }
  | { type: 'answer', sdp: string }
  | { type: 'ice-candidate', candidate: WebRTCInterconnectIceCandidate | null }
  | { type: 'end-of-candidates' }
  | { type: 'close', reason?: string }
```

SDK 还必须提供：

- 外部信令 WebRTC transport factory；
- 可挂入已有 Host 的 dialer；
- 标准 `Libp2p` Host 的创建辅助；
- `/webrtc/p2p/<peer>` 地址和连接身份 pin；
- 可选 `onConnection` 观察 inbound/outbound 标准 `Connection`；
- 传输错误码、阶段、超时和可取消语义。

SDK 不导出或要求业务实现 `RTCPeerConnection`、DataChannel、SDP protobuf 或
Circuit Relay 配置。`RTCPeerConnection` 仅在 Transport 内部创建。

## 5. 信令协议职责

SDK 校验 envelope 和 WebRTC signal 的结构、顺序、大小、目标 PeerId、attemptId
和过期时间。下面的业务字段由外壳放入 ChannelProtocol 认证 envelope，SDK 不解析：

- `requestId`：一次购买或文件请求；
- `sessionId`：BitFS/业务会话；
- sender/receiver PeerId 的业务授权关系；
- 目标业务公钥或独立 pin；
- 消息 ID、创建时间、重放窗口；
- ChannelProtocol 的认证 envelope。

外壳必须拒绝：未知会话、目标不匹配、过期消息、重复消息、错误角色、过大 SDP/ICE
和连接完成后的迟到信令。SDK 对收到的 envelope 做同样的结构校验；信令正文不得
进入普通日志。

## 6. 连接状态机

- initiator 创建 offer 并发送；
- responder 收到 offer 后创建 answer；
- 双方交换 ICE，直到 `end-of-candidates` 或 WebRTC connected；
- 只有收到合法 answer 的 initiator 才能完成 outbound upgrade；
- responder 只有在收到合法 offer 后才能完成 inbound upgrade；
- 连接成功后 SDK 移除活动 session 并忽略迟到信令；业务外壳关闭自己的
  ChannelProtocol/SatSubscription 会话；
- 取消、超时、身份不匹配和连接失败都关闭底层 PeerConnection，不自动降级到 WebSocket、Relay 或 TURN；
- 重新连接必须使用新的 `attemptId`，不复用旧 SDP、旧 ICE 或旧连接状态。

## 7. 身份与数据安全

- WebRTC transport 最终必须产生标准 libp2p `Connection`。
- DataChannel 进入现有 Noise/Yamux Upgrader；SDK 不关闭 Noise 身份握手，也不把
  `skipEncryption`/`skipProtection` 作为生产默认值。
- 业务目标 PeerId 不能只从 SDP 或信令正文自报取得，必须由外壳提供独立 pin。
- SDK 在连接交给业务前再次校验目标身份。
- SDP/ICE 适配器只负责交换握手信息，不负责业务授权。
- 所有 stream 继续使用 libp2p 的连接生命周期和 stream mux；SDK 不新增应用层大帧分片。
- 现有 `go-bitfs/transport` 或 `bitcoin-libp2p/stream` 负责业务帧边界。

## 8. STUN 与网络约束

- SDK 接受 `rtcConfiguration`，由外壳传入现有 STUN 配置。
- SDK 不读取业务设置，不硬编码 STUN，不接受 TURN fallback。
- STUN 不可用或 NAT 穿透失败时返回稳定连接错误；不得静默改走其他 transport。
- 浏览器 E2E 必须验证使用 WebRTC transport，不能只验证 WebSocket 可用。

## 9. 验收标准

### SDK 单元测试

- 信令状态机的 offer/answer/ICE 顺序；
- 超时、取消、迟到消息和连接关闭；
- SDP/ICE 大小限制和 malformed signal；
- 目标身份 pin 失败时关闭连接；
- 旧 attempt 的消息不能污染新 attempt。

### 双浏览器真实 E2E

SDK 层集成验收使用两个独立浏览器上下文、两个独立身份和独立的外部信令
adapter；keymaster 业务验收必须把同一 adapter 接到 SatSubscription +
ChannelProtocol，不能把 HTTP 测试 relay 当作业务认证：

- 不使用 Circuit Relay，不使用 TURN，只传入配置的 STUN；
- 通过外部 adapter 交换 SDP/ICE；
- 成功后得到标准 libp2p `Connection`；
- `connection.remoteAddr` 包含 `/webrtc`；
- 通过 `Connection.newStream()` 传输至少 16 MiB；发布验收传输 64 MiB；
- 双向、多个 stream/frame、backpressure、半关闭和取消均通过；
- 两端比对字节数和 SHA-256；
- 浏览器业务代码不直接访问 `RTCPeerConnection` 或 DataChannel。

单元测试通过不等于 WebRTC 互联验收完成；双浏览器大流量 E2E 是硬门槛。

## 10. 明确不做

- 不在 bitcoin-libp2p 内引用 SatSubscription 或 ChannelProtocol；
- 不实现业务订阅、收费、消息持久化或业务重试；
- 不实现 TURN、Circuit Relay 或 WebSocket fallback；
- 不把裸 WebRTC API暴露给 keymaster 业务层；
- 不在本版本自动迁移通话、文件传输等其它 plugin-webrtc 业务；它们可以复用同一
  SDK Transport，但各自负责协议和信令适配。
