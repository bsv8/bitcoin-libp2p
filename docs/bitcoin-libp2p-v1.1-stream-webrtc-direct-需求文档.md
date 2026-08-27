# bitcoin-libp2p V1.1 Stream 与 WebRTC Direct SDK 扩展需求

> 状态：功能实现与本地验收完成，待提交后最终验收（2026-08-27）。
>
> 本文是 V1.1 新增公开 API 的长期需求真值。施工入口见
> [004 施工单](../施工单/20260827/004-bitcoin-libp2p-stream-webrtc-direct-sdk施工单.md)。
>
> V1 identity、PeerId、Noise、Identify、Yamux 和 typed signer 边界继续以
> [V1 需求与协议边界](bitcoin-libp2p-v1-需求文档.md)为准；本次不改变线上协议。

## 1. 背景与问题

V1 已经证明 Chromium TypeScript SDK 可以通过 WebSocket 和 WebRTC Direct 连接原生
Go libp2p。但下游业务接入时，仍需要重复处理两类容易试错的接缝：

1. TypeScript `Stream` 是可半关闭、带缓冲区的事件流。`message`、`end`、
   `remoteCloseWrite` 和 `close` 可以在不同顺序到达；消费者较晚挂载监听器时，
   还必须检查 `readableEnded`、`remoteWriteStatus` 和 `readBufferLength`。只等待单一
   结束事件会造成“对端已写回数据，浏览器仍超时”。
2. WebRTC Direct 不通过第三方交换 SDP，但依然在本地生成 SDP。客户端必须从
   multiaddr 中取得 IP/DNS、UDP 端口、DTLS `certhash` 和 libp2p `PeerId`。任一参数
   缺失、顺序错误或过期，都可能在底层表现为折叠的 `AggregateError` 或超时。

这两类问题属于版本相关的 libp2p 接入细节，不应让每个业务项目重新实验。

## 2. 核心决策

V1.1 在同一仓库增加两个独立公开能力，不创建新 npm 包：

```text
bitcoin-libp2p/stream          TypeScript 有界读流和半关闭辅助
bitcoin-libp2p/webrtc-direct   TypeScript WebRTC Direct endpoint 与认证拨号
webrtcdirect                   Go endpoint 解析、生成和身份校验 package
```

语言间不为形式对称而重复能力：

| 能力 | TypeScript | Go | 原因 |
|---|---|---|---|
| 有界读到对端半关闭 | SDK 封装 | 使用标准 `io.Reader` | Go 已有稳定的 EOF/半关闭语义 |
| Direct endpoint 解析/生成/校验 | SDK 封装 | SDK 封装 | 两端必须共享相同地址与身份规则 |
| Chromium Direct dial + Noise 身份 pin | SDK 封装 | 不新增封装 | 当前需求是浏览器出站直连 |
| Go Direct listener/transport | 不适用 | 业务显式装配 | 当前上游构造器可能读取 `PrivKey.Raw()` |

## 3. V1.1 目标

1. 业务不再复制 TypeScript `Stream` 事件竞态处理、字节合并和超时清理。
2. Go 与 TypeScript 对 WebRTC Direct multiaddr 使用同一严格结构和错误语义。
3. `certhash` 使用标准 multibase/multihash 库校验，不在业务代码中手写
   base64url 或 varint 解析。
4. WebRTC Direct 拨号在返回业务之前完成 secp256k1 public key/PeerId pin，
   身份不匹配时 fail closed 并关闭连接。
5. 将地址校验、解析、拨号和身份失败区分为稳定高层阶段，保留可安全诊断的
   底层 cause，不将所有失败压成一个超时。
6. 用真实 headless Chromium 与原生 Go WebRTC Direct endpoint 验证成功和负向矩阵。

## 4. 明确不做

V1.1 不负责：

- 修改 WebRTC、SDP、ICE、DTLS、Noise、Yamux 或 multiaddr wire；
- 实现 STUN/TURN 服务、NAT 穿透策略、防火墙探测或公网可达性保证；
- endpoint 发现、DNS 管理、重试、地址排序或 WebSocket 降级；
- 从未认证远端自动接受新 `certhash`；
- 推断或更改 WebRTC 证书过期时间；`certhash` 本身不包含过期时间；
- 业务消息分帧、JSON/Protobuf 编码、Protocol ID、响应语义和重放保护；
- 把 Go WebRTC Direct transport 强行接入 non-extractable identity adapter；
- 为长连推送或无限数据流使用“读到结束”辅助。

## 5. TypeScript Stream 公开语义

### 5.1 公开入口

`bitcoin-libp2p/stream` 至少导出：

```ts
interface ReadStreamToEndOptions {
  signal?: AbortSignal       // 取消信号；触发后结束等待并清理监听器
  timeoutMs?: number         // 读取超时毫秒数；正数；默认 15000
  maxBytes?: number          // 最大响应字节数；正数；默认 1 MiB
  abortStreamOnError?: boolean // 超时/取消/越界时是否 abort 当前 stream；默认 true
}

function readStreamToEnd(
  stream: Stream,
  options?: ReadStreamToEndOptions
): Promise<Uint8Array>
```

同时导出稳定错误类 `StreamIOError`：

| `code` | 中文含义 |
|---|---|
| `ERR_STREAM_TIMEOUT` | 在规定时间内未读到对端结束 |
| `ERR_STREAM_ABORTED` | 调用方取消或 stream 被 abort/reset |
| `ERR_STREAM_TOO_LARGE` | 收到字节数超过 `maxBytes` |
| `ERR_STREAM_CLOSED` | stream 带错误关闭，且不属于以上分类 |

### 5.2 必须保证的语义

- 只消费 stream 一次，不得同时使用 async iterator 和 `message` 监听造成重复字节；
- 接受 `Uint8Array` 以及具有 `subarray()` 的 `Uint8ArrayList` chunk，返回新的连续
  `Uint8Array`；
- 正确处理监听器注册前已到达的数据或结束状态，不永久等待已错过的事件；
- 本地 `stream.close()` 只关闭本地写端，不能被当作对端响应读完；
- 对端 `remoteCloseWrite`/`end` 到达后，必须等到 `readBufferLength === 0` 再完成；
- 无错误的全 stream `close` 可以作为无条件终止信号，但仍须收集已缓冲字节；
- 带 error 的 `close`、reset、超时、取消和越界全部 reject，不返回假完整的部分数据；
- resolve/reject 只发生一次，所有完成路径都清理 event listener、timer 和 abort listener；
- 空响应返回长度为 0 的 `Uint8Array`，是否允许空响应由业务协议决定。

### 5.3 推荐调用顺序

SDK 文档必须展示先建立读取等待，再写入并半关闭本地写端：

```ts
const response = readStreamToEnd(stream, { signal, maxBytes: 1024 * 1024 })
stream.send(request)
await stream.close({ signal }) // 只关闭本地写端
const bytes = await response
```

V1.1 不增加 `requestResponse()` 之类业务化组合 API，也不解码 UTF-8、JSON 或 Protobuf。

## 6. WebRTC Direct endpoint 规范

### 6.1 规范地址

V1.1 可拨号 endpoint 必须严格符合：

```text
/(ip4|ip6|dns|dns4|dns6)/<host>
/udp/<1..65535>
/webrtc-direct
/certhash/<multibase-multihash>
/p2p/<secp256k1-peer-id>
```

约束：

- 不接受缺失 UDP 端口、`certhash` 或 `/p2p` 的“部分地址”；
- 不接受组件顺序颠倒、重复组件、未知后缀，也不接受 WebRTC Direct 与 TCP/TLS/WS
  组合的 hybrid 地址；
- `certhash` 必须能被标准 multibase/multihash 解码；V1.1 只接受 SHA2-256
  multihash（code `0x12`、32 字节 digest）；
- `/p2p` 必须是可取回压缩 secp256k1 公钥的标准 PeerId；
- 如果调用方传入期望公钥或 PeerId，必须与地址 `/p2p` 逐字节一致；
- DNS 地址在 parse 阶段只做结构校验；DNS 解析、解析结果类型和可达性只能在 dial
  阶段验证。

### 6.2 两层身份不得混淆

```text
certhash        WebRTC DTLS 传输证书指纹，可随证书轮换变化
PeerId/publicKey libp2p Noise 认证的长期业务身份
```

SDK 必须同时校验两层，但不得用一层替代另一层。`certhash` 是 WebRTC Direct
Noise prologue 绑定的输入；错误指纹必须 fail closed。

## 7. TypeScript WebRTC Direct 公开 API

`bitcoin-libp2p/webrtc-direct` 至少导出以下概念；实现时可细化 TypeScript
type，但不得改变字段语义：

```ts
interface WebRTCDirectEndpoint {
  address: Multiaddr             // 规范化完整拨号地址
  hostType: 'ip4' | 'ip6' | 'dns' | 'dns4' | 'dns6' // 主机组件类型
  host: string                   // IP 或 DNS 名称
  udpPort: number                // UDP 端口，1..65535
  certhash: string               // 规范 multibase 证书指纹
  certhashDigest: Uint8Array     // 32 字节 SHA2-256 digest 拷贝
  peerId: PeerId                 // 地址声明的 secp256k1 PeerId
  publicKey: Uint8Array          // 从 PeerId 取回的 33 字节压缩公钥
}

interface WebRTCDirectEndpointPin {
  publicKey?: Uint8Array         // 期望业务公钥
  peerId?: PeerId | string       // 期望 PeerId
}

interface BuildWebRTCDirectEndpointInput {
  hostType: 'ip4' | 'ip6' | 'dns' | 'dns4' | 'dns6' // 主机组件类型
  host: string                   // IP 或 DNS 名称
  udpPort: number                // UDP 监听端口，1..65535
  certhash: string               // 服务端当前 DTLS 证书指纹
  publicKey?: Uint8Array         // 业务公钥；可用于派生 PeerId
  peerId?: PeerId | string       // 地址 PeerId；与 publicKey 至少提供一个
}

interface DialAuthenticatedWebRTCDirectOptions extends WebRTCDirectEndpointPin {
  signal?: AbortSignal           // 调用方取消信号
  timeoutMs?: number             // 整体拨号超时毫秒数；默认 15000
  resolver?: WebRTCDirectResolver // DNS 解析器；浏览器端必须由调用方注入
}

interface WebRTCDirectResolver {
  (input: {
    host: string                // 原始 DNS 名称
    hostType: 'dns' | 'dns4' | 'dns6' // 原始 DNS 地址族约束
    signal: AbortSignal         // 整体拨号取消信号
  }): Promise<{
    hostType: 'ip4' | 'ip6'    // 解析结果地址族
    host: string               // 解析结果 IP 地址
  } | readonly {
    hostType: 'ip4' | 'ip6'
    host: string
  }[]
}

parseWebRTCDirectEndpoint(address, pin?): WebRTCDirectEndpoint
buildWebRTCDirectEndpoint(input: BuildWebRTCDirectEndpointInput): WebRTCDirectEndpoint
resolveWebRTCDirectEndpoint(endpoint, options?): Promise<WebRTCDirectEndpoint>
createWebRTCDirectDialer(config): Promise<Libp2p>
dialAuthenticatedWebRTCDirect(
  node,
  endpoint,
  options: DialAuthenticatedWebRTCDirectOptions
): Promise<{
  connection: Connection
  authenticatedPeer: AuthenticatedPeer
  endpoint: WebRTCDirectEndpoint
}>
```

### 7.1 `createWebRTCDirectDialer`

- 复用现有 `createHost` 的 non-extractable identity、Noise、Yamux、Identify 和生命周期；
- transport 固定为当前锁定版本的 `webRTCDirect()`，不同时注入 WebSocket；
- 接受 `signer`、`signTimeoutMs`、`connectionGater`、`rtcConfiguration`、`dataChannel`
  和 `start` 等必要透传配置，每个字段必须有中文说明；
- 浏览器端不提供 WebRTC Direct listen 能力；
- DNS endpoint 在 dial 前必须通过 `resolveWebRTCDirectEndpoint` 显式解析；浏览器端
  由调用方注入 resolver，SDK 不访问公网 DNS 服务。`dns4/dns6` 结果若地址族不匹配，
  或 resolver 没有结果，必须返回 `ERR_WEBRTC_DIRECT_RESOLVE/resolve`；
- resolver 只把 DNS 临时替换为 `ip4/ip6`，不得修改 UDP、certhash 或业务 PeerId；
- `@libp2p/webrtc` 因成为公开 runtime 路径必须进入 npm `dependencies`，不得继续只放
  `devDependencies`。

### 7.2 `dialAuthenticatedWebRTCDirect`

- options 必须至少传入 `publicKey` 或 `peerId` 之一；只信任地址自报 PeerId 不算
  业务 pin；
- 先静态校验 endpoint，再使用单个完整 Direct multiaddr 拨号，不做地址集合竞速、
  重试或 WebSocket fallback；
- 支持调用方 `AbortSignal` 与正数 `timeoutMs`，两者合并；默认拨号超时
  15 秒；
- dial 成功后立即调用现有 `authenticateConnection`再次校验实际 Noise 身份；
- 地址 PeerId、期望 pin 与实际 Noise 身份三者任一不一致，关闭该连接后 reject；
- 失败时不停止整个 host，不变更 signer 身份，不自动替换地址。

## 8. Go `webrtcdirect` 公开语义

Go 新增根 module 下的 `webrtcdirect` package，提供与 TypeScript 同义的：

```go
type Endpoint struct {
    Addr           multiaddr.Multiaddr // 规范化完整地址
    HostType       string              // ip4/ip6/dns/dns4/dns6
    Host           string              // IP 或 DNS 名称
    UDPPort        uint16              // UDP 端口
    Certhash       string              // multibase 证书指纹
    CerthashDigest []byte              // SHA2-256 digest 拷贝
    PeerID         peer.ID             // secp256k1 PeerId
    PublicKey      []byte              // 33 字节压缩公钥拷贝
}

func ParseEndpoint(address string, pin *EndpointPin) (*Endpoint, error)
func BuildEndpoint(input EndpointInput) (*Endpoint, error)
```

Go 与 TypeScript 必须共用测试向量，对相同输入给出相同的规范地址、PeerId、
public key、certhash digest 和失败分类。Go package 不构造 host，不包装
go-libp2p WebRTC transport，不读取 identity raw private key。

## 9. WebRTC Direct 错误与诊断

TypeScript `WebRTCDirectError` 和 Go sentinel/error wrapping 必须稳定区分：

| `code` | `stage` | 中文含义 |
|---|---|---|
| `ERR_WEBRTC_DIRECT_ADDRESS` | `validate` | multiaddr 结构、主机、端口或组件顺序错误 |
| `ERR_WEBRTC_DIRECT_CERTHASH` | `validate` | certhash 缺失、无法解码或算法/长度不支持 |
| `ERR_WEBRTC_DIRECT_PEER_ID` | `validate` | PeerId 非 secp256k1 或与公钥/pin 不一致 |
| `ERR_WEBRTC_DIRECT_RESOLVE` | `resolve` | DNS 解析失败或未产生可拨号 IP |
| `ERR_WEBRTC_DIRECT_TIMEOUT` | `dial` | 拨号在 timeout/signal 约束内未完成 |
| `ERR_WEBRTC_DIRECT_DIAL` | `dial` | ICE/DTLS/Noise/transport 底层失败，但上游未给出可靠更细阶段 |
| `ERR_WEBRTC_DIRECT_AUTH` | `authenticate` | 已建连，但实际 Noise 身份与 pin 不一致 |

诊断要求：

- 对 `AggregateError` 递归展开子 cause，生成有界的诊断列表，不丢失最内层错误；
- 只有上游提供可靠机器可读标识时，才能细分 ICE、DTLS 或 Noise；不得根据英文
  message 模糊匹配后对外宣称精确阶段；
- 默认错误不输出 SDP、完整签名请求、签名、私钥或未脱敏的远端数据；
- 错误保留 `cause`以便开发调试，稳定业务逻辑只依赖 `code` 和 `stage`。

## 10. 证书轮换与信任边界

- WebRTC Direct listener 证书变化时，完整 multiaddr 也会变化；旧 `certhash` 继续失败是
  正确的 fail-closed 行为；
- SDK 只解析和校验调用方提供的 endpoint，不提供“向失败远端询问新 certhash”的逻辑；
- 长期 endpoint 可以由服务端持久化 WebRTC 证书，或由业务通过受信配置/由长期
  业务身份签名的发现清单更新；两者都不属于本次 SDK API；
- endpoint 更新不允许改变期望业务 public key/PeerId；业务身份轮换继续遵守
  V1 关闭旧 host/连接后重建的规则。

## 11. 测试基线

### 11.1 Stream 单元测试

可控 fake stream 必须覆盖：

- 先 `message` 后 `remoteCloseWrite/end`；
- 先标记 `readableEnded` 再调用 helper；
- `remoteCloseWrite` 到达时 `readBufferLength > 0`，后续排空才完成；
- 全 `close` 无 error、带 error、reset/abort；
- `Uint8ArrayList`、多 chunk、空响应和恰好 `maxBytes`；
- 超过 `maxBytes`、超时、外部 AbortSignal、超时与结束同 tick 竞态；
- 所有路径只 settle 一次且监听器/timer 全部清理。

### 11.2 Endpoint 共享向量

Go/TypeScript 共用 JSON 向量，至少覆盖：

- ip4、ip6、dns、dns4、dns6 的规范地址；
- 正确 SHA2-256 certhash 的 digest 和规范化结果；
- 缺少/零/超范围 UDP 端口；
- 缺少、截断、错 multibase、错 multihash code、错 digest 长度的 certhash；
- 缺少/非 secp256k1/错 PeerId，以及 public key/PeerId/address 三者不一致；
- 顺序颠倒、重复组件、WebSocket hybrid 和未知后缀。

### 11.3 真实集成测试

使用锁定版本的真实 headless Chromium 与原生 Go v0.49 WebRTC Direct endpoint：

1. 动态获取服务端实际发布的带 certhash/PeerId 地址；
2. SDK 解析该地址并与预期服务端公钥绑定；
3. `createWebRTCDirectDialer` + `dialAuthenticatedWebRTCDirect` 完成 DTLS、Noise 和业务 pin；
4. 同一连接上至少两条 stream 使用 `readStreamToEnd` 完成小响应与 128 KiB 响应；
5. 独立负向场景覆盖 wrong port、wrong certhash、wrong address PeerId、wrong expected
   public key/PeerId、旧 certhash、dial timeout/Abort 和对端 stream reset；
6. 每个失败场景断言稳定 `code`/`stage`、无 fallback、无 pending Promise、流/连接/浏览器/
   Go 子进程全部清理。

公网 UDP、外部 DNS 和真实 NAT 不纳入默认可重复测试；本机测试只证明 SDK 和标准
wire，不宣称证明任意部署网络可达。

## 12. 版本、发布与迁移

- 已完成的 Go/npm `0.1.0` 保持不变，不重发、不改 tag；
- 本次是新增公开 package/subpath 的完整能力批次，目标双语言版本为 `0.2.0`；
- Go/npm 继续同批次发布，不做部分发布；
- npm tarball 必须包含 `/stream` 和 `/webrtc-direct` 的 JavaScript、声明和 source map，不包含
  Playwright、integration bundle、测试 endpoint 或测试私钥；
- 下游迁移只替换重复的 stream 读取和 Direct endpoint/dial 接缝；Supplier 地址
  存储、transport fallback、证书更新 UI 和业务协议保持在下游。

## 13. V1.1 完成定义

只有以下条件同时满足，才能将本需求改为“已完成”：

- TypeScript 业务不再需要自行组合 Stream 四类结束事件；
- Go/TypeScript endpoint 共享向量全部通过，失败分类一致；
- Chromium 只使用 WebRTC Direct 完整地址完成认证拨号，不自动降级；
- 正确参数可稳定通过，错误端口、certhash、PeerId、public key 稳定 fail closed；
- 超时、Abort、stream reset、错身份和浏览器关闭路径无未决 Promise 或资源泄漏；
- Go WebRTC transport 的 raw-key 限制没有被伪造私钥或放宽 signer 边界规避；
- README、Demo、公开 exports、类型声明、发布包和测试的口径一致；
- `0.2.0` 发布门禁通过，且未新增强制 CI workflow。
