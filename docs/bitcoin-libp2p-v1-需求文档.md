# bitcoin-libp2p V1 需求与协议边界

> 状态：设计冻结；V1 已完成最终验收。
>
> 本文是 V1 的长期需求真值。实现、测试和使用文档不得引入与本文冲突的第二套身份模型。

## 1. 背景

`bsv8-gateway` 与 `keymaster.cc` 都需要让业务 secp256k1 身份同时成为 libp2p
节点身份：业务公钥能够确定性派生 PeerId，对端通过标准 libp2p 安全握手认证出的
公钥就是业务身份。

两个项目的运行环境不同：

- Go 服务端可以在本机进程直接使用业务私钥；
- Keymaster 的浏览器 Window 不允许取得 SharedWorker/Vault 中的 raw 私钥，只能调用
  受限签名能力。

本项目采用更严格、也更通用的私钥分离模型：Go 与 TypeScript SDK 都围绕“公开身份材料
与强类型受限 signer”设计。本地内存私钥、Worker、HSM 或远程签名服务只是 signer 的不同实现。

## 2. 核心结论

`bitcoin-libp2p` 是标准 libp2p 的身份配置规范与 SDK，不是新的线上协议，也不是 libp2p fork。

V1 固定以下关系：

```text
业务 secp256k1 私钥
  └── 业务压缩公钥
        └── 标准 libp2p PeerId
```

业务私钥作为 libp2p 长期 identity key，只负责标准 libp2p 身份签名。Noise 的 X25519
密钥交换、会话密钥派生和数据加解密仍由原生 libp2p 实现负责，不能交给业务 signer，
也不能从业务私钥派生 Noise 私钥。

## 3. V1 目标

1. 提供 Go SDK 与 TypeScript SDK，冻结相同的身份、签名和错误语义。
2. 支持 raw 私钥不进入 libp2p host 所在运行时的私钥分离模型。
3. 使用标准 secp256k1 libp2p identity、PeerId、Noise、Identify、Yamux 和 stream。
4. 让 Go SDK、TypeScript SDK 与未依赖本 SDK 的原生 libp2p 节点自然互通。
5. 提供固定跨语言向量和可按需运行的跨进程、浏览器集成测试。
6. 让连接层认证出的远端公钥成为业务身份真值，避免信任报文自报身份。

## 4. 明确不做

V1 不负责：

- 修改或复制实现 libp2p、Noise、Identify、Yamux；
- 新增 `/bitcoin-libp2p/...` 身份握手 Protocol ID；
- 私钥文件、密码、Vault、Worker lease、gRPC 或 HSM 通信协议；
- Bitcoin 地址、WIF、P2PKH、交易签名、多签和钱包能力；
- 业务消息壳、消息重放缓存、业务授权、计费和应用级幂等；
- DHT、mDNS、pubsub、bootstrap、连接重试和 peer 发现策略；
- 替业务项目决定 transport、监听地址和业务 Protocol ID；
- 为兼容旧实现保留 Ed25519/业务 secp256k1 双轨身份。

## 5. 身份模型

### 5.1 私钥

- 算法固定为 secp256k1；
- 二进制输入固定为 32 字节大端标量；
- 数值必须在 `1..n-1`；
- 全零、等于曲线阶 `n`、大于 `n`、错误长度全部拒绝；
- SDK 核心接口不使用 WIF 或网络相关 Bitcoin 地址作为身份输入。

### 5.2 公钥

- 业务身份的规范二进制形态是 33 字节 SEC1 压缩公钥；
- 第一个字节必须是 `0x02` 或 `0x03`，且必须能解析为有效曲线点；
- 配置和日志可以使用 66 字符小写 hex，但 SDK 内部真值使用 bytes；
- 公钥是业务主身份，PeerId 是公钥的标准 libp2p 派生标识。

### 5.3 PeerId

- 必须调用原生 libp2p 公钥编码与 PeerId API 派生；
- 禁止自行拼接 protobuf、multihash 或 Base58 字符串；
- 同一压缩公钥在 Go 与 TypeScript 中必须得到完全相同的 PeerId；
- 如果配置同时提供公钥、PeerId 和带 `/p2p/<peer-id>` 的 multiaddr，三者必须一致。

### 5.4 身份轮换

业务私钥变化意味着业务公钥和 PeerId 同时变化。V1 将其视为新身份，不设计旧新身份
证书、别名、自动迁移或运行中热切换。调用方必须关闭旧 host 和连接，再以新身份重建。

## 6. 原生 libp2p 兼容性

V1 线上只使用标准 libp2p 协议：

- 标准 secp256k1 identity 与 PeerId；
- 标准 Noise 安全传输；
- 标准 Identify，包括标准 Signed Peer Record；
- 标准 Yamux；
- 调用方提供的标准 transport 与业务 stream Protocol ID。

未安装 `bitcoin-libp2p` 的原生节点，只要配置 secp256k1 identity、Noise 和相同业务
Protocol ID，就能握手和双向通信。原生节点可以使用本地完整私钥；线上结果必须与 SDK
的私钥分离实现一致。

原生 Ed25519/RSA 节点仍可能完成标准 libp2p Noise 握手，但不能映射为 Bitcoin 业务身份。
SDK 的业务身份认证入口必须返回明确的 `unsupported key type`，由调用方关闭连接。这是
身份策略拒绝，不是私有协议或 wire 不兼容。

## 7. 私钥分离与受限 signer

### 7.1 总体边界

SDK 只依赖：

```text
公开材料：33 字节业务公钥
签名能力：固定用途、结构化入参、DER 输出
```

SDK 不得要求 signer 暴露 raw 私钥。Go 与 TypeScript 的原生 libp2p private-key adapter
必须满足上游所需的公钥、类型、比较和签名接缝；任何 raw 私钥读取都必须返回明确的
non-extractable 错误，不能返回真实、空、全零或伪造私钥。

### 7.2 Noise static key 签名

signer 的业务接口只接受恰好 32 字节的 Noise X25519 static public key：

```text
SignNoiseStaticKey(noise_static_public_key_32) -> DER signature
```

私钥持有方必须自行构造并签名标准 libp2p 内容：

```text
SHA256(UTF8("noise-libp2p-static-key:") || noise_static_public_key_32)
```

libp2p adapter 收到上游 `Sign(data)` 调用时必须先确认：

1. `data` 恰好 56 字节；
2. 前 24 字节逐字节等于标准 Noise prefix；
3. 只把后 32 字节交给 `SignNoiseStaticKey`；
4. 返回值是可解析的规范 DER、low-S secp256k1 ECDSA 签名；
5. 使用已知业务公钥对完整标准 payload 本地复验成功。

### 7.3 Signed Peer Record 签名

Go 原生 libp2p 的标准 Identify 默认会为监听地址生成 Signed Peer Record。V1 不通过关闭
标准能力来规避签名，而是提供第二个固定用途：

```text
SignPeerRecord(peer_id, addresses, sequence) -> DER signature
```

SDK adapter 必须识别并严格解析标准 `libp2p-peer-record` 待签名内容，只把结构化字段交给
signer。私钥持有方必须使用标准 domain、payload type 和 protobuf 编码重建待签名字节。

强制约束：

- `peer_id` 必须由当前业务公钥派生；
- payload type 必须是标准 `libp2p-peer-record`；
- domain 必须是标准 `libp2p-peer-record`；
- addresses 必须是合法 multiaddr；
- signer 不能接受调用方自选 domain、payload type、摘要或签名格式；
- SDK 必须使用业务公钥复验签名后才返回上游。

### 7.4 禁止通用签名 oracle

公共 signer 接口不得出现：

- `Sign(bytes)`；
- `SignDigest(digest)`；
- 调用方选择 domain/hash/signature format；
- 任意长度 payload；
- raw private key getter。

原生 libp2p adapter 内部可以为了满足上游接口实现一个不公开的 `Sign(data)`，但它只能
识别并分发 V1 明确允许的 Noise static key 和 Signed Peer Record 两类内容。其他用途必须
返回 `unsupported signer purpose`。

### 7.5 异步状态复核

Worker、HSM、远程服务等 signer 实现必须在签名前和签名完成后复核自己的会话、owner、
epoch/lease 与 active public key。SDK 不规定这些状态如何传输，但必须支持 Context/
AbortSignal 取消，并在拿到签名后再次用构造时绑定的业务公钥本地复验。

上游 libp2p 的 identity `Sign(data)` 接缝不保证传入 Context/AbortSignal，因此 adapter 不能
只在“上游恰好传入取消信号”时才具有终止能力。Go 与 TypeScript adapter/host 装配必须拥有
独立的生命周期取消信号和有限的单次签名超时，并将它们传递到 typed signer。调用方停止
host、signer lane 失效或单次签名超时时，尚未完成的 Noise/Peer Record 签名等待必须结束，
不能因远端 signer 永久 pending 而泄漏 goroutine、Promise 或连接升级任务。

## 8. 通信加密与运行位置

业务私钥不承担日常数据加密。标准 Noise 使用自己的 X25519 密钥完成握手并派生连接会话
密钥，后续加解密在 libp2p host 所在运行时完成。

因此浏览器 Keymaster 模型中：

- Worker 只在新连接身份握手和标准 Peer Record 更新时处理小型签名请求；
- Window 内的 js-libp2p 负责 Noise、DTLS/WebSocket、Yamux、stream 和数据加解密；
- 新开 stream 不重新请求身份签名；
- Vault lock、active key 切换或 signer 会话失效时，调用方必须停止 host 并关闭已有连接，
  因为 Window 已建立的对称会话不会因业务私钥锁定自动失效。

## 9. SDK 职责

Go 和 TypeScript SDK 都必须提供语义一致的能力：

1. 校验 secp256k1 私钥/公钥；
2. 从私钥派生压缩公钥，仅供本地测试 signer 或可信本地实现；
3. 从压缩公钥派生标准 PeerId；
4. 从可内联公钥的 secp256k1 PeerId 取回压缩公钥；
5. 校验 public key、PeerId、multiaddr 三者一致；
6. 定义 Noise 与 Peer Record 两类受限 signer；
7. 构造 non-extractable 原生 libp2p identity adapter；
8. 提供推荐的标准 Noise host 装配入口，同时允许调用方提供 transport、监听地址和业务服务；
9. 从已认证 connection 提取 `AuthenticatedPeer`；
10. 可选 pin 期望公钥/PeerId，不一致时 fail closed；
11. 提供稳定错误分类，不在错误或日志中输出私钥和完整敏感签名请求。

`AuthenticatedPeer` 至少包含：

```text
public_key   33 字节压缩 secp256k1 公钥
peer_id      标准 libp2p PeerId
remote_addr  可选远端 multiaddr
```

## 10. Host 装配原则

SDK 不重新包装或复制整个 libp2p API。推荐 host 装配入口只负责：

- 安装当前 identity adapter；
- 强制启用标准 Noise；
- 保留标准 Identify/Signed Peer Record；
- 验证所选服务不会读取 raw 私钥或请求未知签名用途；
- 接受调用方提供的 transport、muxer、监听地址和业务 service。

V1 不承诺 TLS security transport、Circuit Relay voucher、DHT provider record 等可能新增身份
签名用途的能力。未来每增加一种用途，都必须先形成独立 typed signer、输入校验和跨语言测试，
不能扩大为通用签名。

## 11. 版本基线

首版实现和测试锁定：

```text
Go SDK reference       go-libp2p v0.49.0
Go native compatibility go-libp2p v0.45.0
TypeScript             libp2p 3.3.9
TypeScript Noise       @chainsafe/libp2p-noise 17.0.0
TypeScript Yamux       @chainsafe/libp2p-yamux 8.0.1
```

依赖升级不改变 V1 wire。升级时必须重新运行普通测试和相关集成测试，并记录兼容结果。

## 12. 固定测试向量

仓库必须保存 Go/TypeScript 共用的测试专用向量，至少覆盖：

- 私钥到压缩公钥；
- 压缩公钥到 PeerId；
- Noise 56 字节标准 payload 与 SHA-256；
- DER 签名在 Go/TypeScript 间交叉验证；
- 标准 Signed Peer Record 编码与交叉验证；
- 私钥 `0`、`n`、`n+1`、错误长度；
- 非曲线公钥、错误压缩前缀；
- 公钥/PeerId/multiaddr 不一致；
- 错误 signer purpose、prefix、长度和签名格式。

首个 identity 向量沿用已经验证的测试专用材料：

```text
private_key_hex  278d5bed18a82b66619e026c2efb2a907e35310829d9658fb967180636afaa6a
public_key_hex   02e940822d4e7a09ce013bed4fa812e92f22b0ed1fa2d1ad06ae0406680da1cc46
peer_id          16Uiu2HAmB8C2R7pBJu1z2u1gno7aXcbtkoUzrknTFN2EBLjRavKP
```

该私钥只能用于测试，文档必须明确其无生产资金和权限。

## 13. 测试分层

### 13.1 普通测试

默认 `go test ./...` 与 TypeScript `test` 只运行快速、单进程测试，不启动浏览器，不启动
跨语言子进程，不依赖公网或真实网络设备。

### 13.2 集成测试

集成测试使用独立、显式命令按需运行，不强制绑定 CI：

1. SDK Go remote signer ↔ SDK TypeScript remote signer；
2. SDK Go ↔ 未依赖 SDK 的原生 TypeScript libp2p；
3. SDK TypeScript ↔ 未依赖 SDK 的原生 Go libp2p；
4. SDK Go ↔ 原生 go-libp2p v0.45.0；
5. 双向打开 echo stream、发送非空和较大 payload、校验完整回包；
6. 校验双方观察到的 authenticated public key 与 PeerId；
7. 校验 SDK 节点没有 raw 私钥读取，未知签名用途 fail closed。

这里的 `remote signer` 必须与 host 运行位置分离，通过测试专用的结构化调用通道完成两类
typed 签名；直接在 host 进程中构造 `LocalSigner` 只能作为单元测试，不能代替 remote signer
集成验收。测试通道不是生产协议，不得因此新增公共 signer RPC 规范。

每个原生对照端必须在依赖图上与本 SDK 隔离，不能为了复用 echo handler 而 import/link
本仓库的任何 Go/TypeScript SDK package。每个矩阵项必须按规定的发起方向执行，并把连接层
实际认证到的 remote public key、PeerId 与固定预期值逐字段比较；只检查进程输出中出现
`OK` 不算验收。

### 13.3 浏览器集成测试

使用 Playwright 驱动真实 headless Chromium。开发机和测试机不需要桌面、X11 或 Wayland；
测试使用 Playwright 随版本安装的 Chromium，不依赖系统预装 `chromium`/Chrome 可执行文件：

- Chromium TypeScript SDK remote signer ↔ Go；
- WebSocket 握手和双向通信；
- WebRTC Direct 握手和双向通信；
- 签名发生在独立 Worker/模拟 signer 运行位置，Window 不取得 raw 私钥；
- host 停止、Abort 和 signer 失效后请求明确结束，不永久 pending。

WebSocket 与 WebRTC Direct 可以分成不同测试文件以便定位失败，但都属于普通集成测试资产。
仓库不规定 CI 必须运行它们，使用者可按自己的成本决定自动化策略。

Playwright 只能作为开发/测试依赖，不得进入 SDK runtime API。浏览器、系统动态库和首次下载
由显式安装命令准备；缺少浏览器时集成命令必须明确失败并给出安装提示，不能以退出码 0
静默跳过。runner 必须捕获 page error、console error、超时和非 `PASS` 结果，并在成功或失败
后关闭 browser/context、host 与全部子进程。

V1 浏览器基线使用 Playwright 随版本绑定的完整 Chromium 和 new headless 模式
（`headless: true`、`channel: 'chromium'`），不以精简 headless shell 或 DOM 模拟器代替真实
浏览器网络栈。Playwright 版本必须在 package lock 中固定，依赖升级后重新安装对应 Chromium
并重跑两种 transport。

## 14. 失败语义

- 身份材料非法：构造期失败；
- raw 私钥读取：明确 `non-extractable`；
- 未知签名用途：明确 `unsupported signer purpose`；
- signer 超时/取消/失效：当前握手或记录更新失败，不无限重试；
- 签名格式错误或本地复验失败：拒绝返回给 libp2p；
- 对端 key 类型非 secp256k1：连接可以由原生 libp2p 建立，但业务身份认证失败；
- pin 不一致：立即关闭或由调用方关闭连接，不提供忽略选项；
- 一个连接失败不改变密钥、不自动生成替代身份。

## 15. V1 完成定义

V1 完成必须同时满足：

- Go 与 TypeScript SDK API 语义一致；
- SDK 不存储、不导出业务私钥；
- Noise 和 Peer Record signer 都是固定用途，不存在公共通用签名接口；
- Go/TypeScript 固定向量全部通过；
- SDK Go 与 SDK TypeScript 可以握手和双向通信；
- SDK 与未引用本 SDK 的原生 libp2p 节点可以握手和双向通信；
- Playwright headless Chromium 中 WebSocket 与 WebRTC Direct 集成测试均实际通过；
- TypeScript 正式发布包不包含 integration、Playwright、测试 bundle、测试 endpoint 或测试私钥；
- 默认普通测试不启动重型集成环境；
- README、规范、公开 API 和测试对身份模型的描述完全一致。
