# bitcoin-libp2p

TypeScript 标准 libp2p secp256k1 identity SDK。host 只接收业务公钥和受保护的
`TypedSigner`，不会接收业务 raw 私钥。

当前 npm 正式版本为 `0.2.0`：

```sh
npm install bitcoin-libp2p@0.2.0
```

公开入口：

- `bitcoin-libp2p`：基础导出；
- `/identity`：公钥、PeerId 和 Signed Peer Record 辅助；
- `/signer`：受限 typed signer 接口与本地测试 signer；
- `/libp2p`：标准 host 组装和连接后的身份认证；
- `/stream`：有界、可取消的 Stream 读到对端半关闭；
- `/webrtc-direct`：严格 endpoint、certhash 校验和带身份 pin 的浏览器出站拨号。

## 最小 WebRTC Direct 调用

字段含义已经写在公开 TypeScript 声明中；下面的 `certhash` 是服务端当前 DTLS
证书指纹，`publicKey` 是独立于地址获得的长期业务公钥：

```ts
import { createWebRTCDirectDialer, dialAuthenticatedWebRTCDirect, parseWebRTCDirectEndpoint } from 'bitcoin-libp2p/webrtc-direct'
import { readStreamToEnd } from 'bitcoin-libp2p/stream'

const endpoint = parseWebRTCDirectEndpoint(serverAddress, { publicKey: expectedServerPublicKey })
const node = await createWebRTCDirectDialer({
  signer: protectedSigner,
  rtcConfiguration: { iceServers: [] } // WebRTC RTCPeerConnection 配置；按部署网络提供 STUN/TURN
})
const { connection } = await dialAuthenticatedWebRTCDirect(node, endpoint, {
  publicKey: expectedServerPublicKey,
  timeoutMs: 15_000
})
const stream = await connection.newStream('/your/protocol/1.0.0')
const response = readStreamToEnd(stream, { maxBytes: 1024 * 1024 })
stream.send(requestBytes)
await stream.close() // 只关闭本地写端，不代表远端响应已结束
const responseBytes = await response
```

`serverAddress` 必须是完整的
`/(ip4|ip6|dns|dns4|dns6)/host/udp/port/webrtc-direct/certhash/value/p2p/id`
地址。`certhash` 是传输层 DTLS 证书指纹，可能因证书轮换变化；`PeerId/publicKey`
是 Noise 认证的长期业务身份，两者不能互相替代。`dns/dns4/dns6` 地址必须在
`dialAuthenticatedWebRTCDirect` 中注入 `resolver`；解析成功后 SDK 只临时把 DNS
替换成匹配的 `ip4/ip6`，并保留原来的 UDP、certhash 和 PeerId。浏览器没有通用的
系统 DNS API，SDK 不内置公网 DNS 服务。Direct 不经过第三方交换 SDP，但浏览器和
服务端仍会在本地生成 SDP；SDK 不保证 UDP、NAT 或防火墙可达性。
证书变化后必须由受信发现配置提供新完整地址，SDK 不从未认证远端自动学习或替换
`certhash`，也不会自动降级为 WebSocket。

`readStreamToEnd` 适合有限响应，不适合长连接或无限推送。默认超时 15 秒、最大
响应 1 MiB；超时、取消、reset 和越界会 reject，并默认 abort 当前 stream。业务
逻辑应依据错误的 `code` 字段，不依据底层英文 message。

完整协议边界、字段说明、迁移清单和 Chromium/Go 验收命令见仓库中的
[V1.1 需求](../docs/bitcoin-libp2p-v1.1-stream-webrtc-direct-需求文档.md)、
[施工单](../施工单/20260827/004-bitcoin-libp2p-stream-webrtc-direct-sdk施工单.md)
和 [integration tests](../docs/integration-tests.md)。
