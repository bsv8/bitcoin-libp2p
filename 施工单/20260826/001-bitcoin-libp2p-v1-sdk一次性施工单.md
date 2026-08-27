# bitcoin-libp2p V1 Go/TypeScript SDK 一次性施工单

> 状态：V1 已完成，整改验收通过。
>
> 本单以 [V1 需求与协议边界](../../docs/bitcoin-libp2p-v1-需求文档.md) 为唯一需求真值。
> 本轮采用一次性落地，不先提交一个持有 raw 私钥的临时版本，也不保留通用 signer 过渡接口。
> 整改记录见 [002 V1 审计整改施工单](002-bitcoin-libp2p-v1-审计整改施工单.md)。

## 0. 施工目标

在本仓库同时落地 Go 与 TypeScript SDK，使业务 secp256k1 公钥成为标准 libp2p identity，
同时保证 libp2p host 所在运行时不需要取得 raw 业务私钥。

最终必须证明：

1. Go SDK 与 TypeScript SDK 使用 remote signer 完成标准 Noise 握手和双向 stream 通信；
2. SDK 节点与完全未引用本 SDK 的原生 libp2p 节点自然互通；
3. 线上没有私有身份协议、私有 Noise 字段或自定义 PeerId；
4. signer 只支持 Noise static key 与 Signed Peer Record 两种固定用途；
5. 普通测试快速独立，跨语言和浏览器场景通过显式集成命令运行，不强制增加 CI 负担。

## 1. 硬性设计边界

### 1.1 必须做

- secp256k1 私钥、公钥和 PeerId 严格校验；
- Go/TypeScript 相同的 identity 与签名向量；
- non-extractable libp2p identity adapter；
- typed `SignNoiseStaticKey`；
- typed `SignPeerRecord`；
- 签名结果本地复验；
- 标准 Noise、Identify、Signed Peer Record、Yamux；
- authenticated remote public key 提取与 pin；
- SDK ↔ SDK、SDK ↔ 原生 libp2p 集成测试；
- Playwright 驱动的真实 headless Chromium WebSocket 与 WebRTC Direct 集成测试入口。

### 1.2 不能做

- 不得让 SDK signer 暴露通用 `Sign(bytes)` 或 `SignDigest`；
- 不得在 raw getter 返回真实、空、全零或伪造私钥；
- 不得修改上游 Noise、PeerId 或 Identify wire；
- 不得把测试 echo Protocol ID 变成生产身份协议；
- 不得在 SDK 中实现 Vault、Worker leader、lease、gRPC 或 HSM 协议；
- 不得加入业务消息 envelope、钱包和交易签名；
- 不得为了先跑通而暂时把业务私钥复制到 Window/host；
- 不得让默认普通测试启动浏览器或跨语言服务进程；
- 不得把集成测试强制写进仓库 CI 配置。

## 2. 目录与模块定稿

施工前建立以下最小结构：

```text
bitcoin-libp2p/
  README.md
  docs/
    bitcoin-libp2p-v1-需求文档.md
    identity-profile-v1.md
    security-model-v1.md
    integration-tests.md

  testdata/
    identity-v1.json
    noise-signature-v1.json
    peer-record-v1.json
    invalid-identity-v1.json

  go.mod
  identity/                 # Go 纯身份与向量能力
  signer/                   # Go typed signer contract
  golibp2p/                 # Go 原生 adapter、连接认证和 host 装配

  typescript/
    package.json
    tsconfig.json
    src/identity/
    src/signer/
    src/libp2p/
    test/

  integration/
    echo/                   # 仅测试使用的最小 echo 协议
    native-go/              # 不 import 本 SDK 的原生 Go 对照端
    native-typescript/      # 不 import 本 SDK 的原生 TS 对照端
    browser/                # Playwright headless Chromium WebSocket/WebRTC Direct

  scripts/
    test-integration.sh
    test-browser-integration.sh
```

Go module 固定为：

```text
github.com/bsv8/bitcoin-libp2p
```

TypeScript 包名在施工时固定为：

```text
bitcoin-libp2p
```

不再增加第二个同义包或兼容别名。

## 3. 第一阶段：共享规范与向量

### 3.1 新增正式规范

新增：

- `docs/identity-profile-v1.md`：只描述标准身份映射与认证真值；
- `docs/security-model-v1.md`：描述私钥分离、允许的 signer purpose、生命周期和威胁边界；
- `docs/integration-tests.md`：记录普通测试、跨语言测试和浏览器测试的独立命令。

不得在正式规范中写入 gateway 的 `key.json` 或 Keymaster 的具体 Worker 消息。

### 3.2 固定向量

以需求文档中的测试 key 为 identity vector，增加：

- 合法私钥、公钥、PeerId；
- 固定 Noise static public key；
- 标准 56 字节待签名 payload；
- SHA-256 digest；
- Go/TypeScript 可交叉验证的 DER 签名；
- 固定 Peer Record 字段、标准 unsigned bytes 与 DER 签名；
- 私钥边界和错误身份向量。

测试不得仅由一个语言生成期望值后让另一个语言照抄。两端必须分别调用原生库派生并与
提交的固定真值比较。

### 3.3 本阶段验收

- JSON 文件能被 Go/TypeScript 独立读取；
- 字段全部有长度、编码和用途说明；
- 测试私钥明确标记为 TEST-ONLY；
- 不出现生产 key、环境变量或随机生成后未提交的期望值。

## 4. 第二阶段：Go SDK

### 4.1 `identity`

实现：

- 私钥标量严格校验；
- 压缩公钥严格解析；
- 从测试/可信本地私钥派生公钥；
- 从公钥派生标准 PeerId；
- 从 secp256k1 PeerId 提取公钥；
- public key、PeerId、multiaddr 一致性校验；
- bytes 为真值、hex 只作为边界转换。

### 4.2 `signer`

定义窄接口：

- 返回绑定的 33 字节公钥；
- `SignNoiseStaticKey(ctx, staticKey32)`；
- `SignPeerRecord(ctx, structuredRecord)`。

接口不接收任意 payload、digest、domain 或格式。上下文取消必须向下传播。

同时提供只服务测试和可信单进程程序的本地私钥 signer。它必须与 remote signer 走相同
typed 接口，不能成为业务代码绕过边界获取 raw key 的出口。

### 4.3 `golibp2p`

实现 go-libp2p `crypto.PrivKey` 形状的 adapter：

- `Type` 固定 secp256k1；
- `GetPublic` 返回绑定公钥；
- `Equals` 按公开身份比较；
- `Raw` 返回 non-extractable 错误；
- 内部 `Sign` 只识别标准 Noise payload 与标准 Peer Record payload；
- 未知内容返回 unsupported signer purpose；
- signer 返回后以公钥复验。

实现连接认证 helper 与推荐 host 装配。装配必须显式使用标准 Noise，保留标准 Identify，
并允许调用方注入 transport、muxer、listen address 和业务 handler。

### 4.4 Go 普通测试

必须覆盖：

- 所有合法和非法向量；
- adapter 从未成功读取 raw；
- Noise payload 错长度/错 prefix；
- Peer Record 错 domain/错 type/错 PeerId/非法地址；
- signer 返回 compact、坏 DER、错误 key 签名时被拒；
- Context 取消；
- `AuthenticatedPeer` 只接受 secp256k1；
- pin 不一致 fail closed。

本阶段验收命令：

```text
go test ./...
```

该命令不得启动 Node、Chromium 或长期监听进程。

## 5. 第三阶段：TypeScript SDK

### 5.1 `identity`

实现与 Go 同义的：

- 私钥/公钥严格校验；
- 公钥与 PeerId 双向转换；
- multiaddr pin 校验；
- bytes/hex 明确分层；
- 相同固定向量。

### 5.2 `signer`

定义与 Go 同义的异步 typed signer：

- `publicKey()`；
- `signNoiseStaticKey(staticKey32, signal?)`；
- `signPeerRecord(record, signal?)`。

不得接受任意 bytes 或 digest。AbortSignal 必须能终止本地等待。

### 5.3 js-libp2p adapter

实现 non-extractable secp256k1 private-key adapter：

- `publicKey` 是标准 js-libp2p 公钥对象；
- `raw` getter 明确抛错；
- `equals` 按公开身份比较；
- 内部 `sign(data)` 严格识别两类标准 payload；
- 将 payload 拆成 typed signer 入参；
- DER 返回值必须本地复验；
- 不得用 type assertion 掩盖真实 raw 读取。

### 5.4 TypeScript 普通测试

覆盖与 Go 相同的向量和失败语义，并增加：

- 上游 host 创建、启动、停止不读取 raw；
- signer Promise 失败和 Abort 后不永久 pending；
- Uint8Array/Uint8ArrayList 输入都按实际字节严格校验；
- 不在错误、call log、snapshot 中记录完整敏感 payload。

本阶段验收命令由 `typescript/package.json` 固定，但默认命令不得启动 Go 或浏览器。

## 6. 第四阶段：跨语言与原生互通

### 6.1 测试 Echo 协议

只在 `integration/echo` 定义一个最小测试 Protocol ID，例如：

```text
/bitcoin-libp2p/test/echo/1.0.0
```

它只能存在于测试和测试文档中，不得被 SDK host 自动注册，也不得被描述为 V1 身份协议。

Echo 行为固定为：客户端发送长度受限字节，服务端原样返回；测试必须校验非空、小 payload
和至少一组较大 payload，不引入 protobuf、JSON 消息壳或业务签名。

### 6.2 原生对照端

`integration/native-go` 与 `integration/native-typescript`：

- 不能 import/link `bitcoin-libp2p`；
- 使用原生 secp256k1 私钥对象；
- 使用标准 Noise/Yamux/transport；
- 注册相同 echo Protocol ID；
- 输出仅限测试需要的 PeerId、公钥和结果摘要，不输出私钥。

### 6.3 必测矩阵

| 发起方 | 接收方 | 最低要求 |
|---|---|---|
| Go SDK remote signer | TypeScript SDK remote signer | 握手、身份一致、双向 echo |
| TypeScript SDK remote signer | Go SDK remote signer | 反向拨号与双向 echo |
| Go SDK remote signer | 原生 TypeScript | 原生端不依赖 SDK仍成功 |
| TypeScript SDK remote signer | 原生 Go v0.49 | 原生端不依赖 SDK仍成功 |
| Go SDK remote signer | 原生 Go v0.45 | 现有 gateway 版本线兼容 |

每项都必须记录双方实际观察到的 remote public key 和 PeerId，并与预期值比较。

### 6.4 失败矩阵

- 错误 public key pin；
- multiaddr PeerId 与业务公钥不一致；
- 对端 Ed25519 可完成原生连接时，业务身份认证仍明确拒绝；
- signer 中途取消；
- signer 返回错误 key 的合法 DER；
- raw getter 被探测；
- 未知 identity 签名用途；
- host 停止后未决 stream 明确结束。

### 6.5 集成命令

`scripts/test-integration.sh` 负责跨语言、跨进程测试。必须：

- 使用随机本机端口；
- 有整体超时；
- 失败和退出时清理子进程；
- 不访问公网；
- 不修改用户配置和密钥；
- 不被默认普通测试隐式调用。

## 7. 第五阶段：真实浏览器集成

### 7.1 Chromium WebSocket

Playwright 在无桌面环境中启动真实 headless Chromium，Window 中运行 TypeScript SDK
adapter，签名能力通过独立 Worker 或测试 signer RPC 提供。Go 对端使用 SDK 或原生实现。

验收：

- Window 无 raw 私钥；
- 标准 Noise 握手成功；
- PeerId/公钥一致；
- 双向 echo；
- 多条 stream 复用连接时不为每条消息请求 Noise identity 签名；
- Worker/signing lane 取消后当前连接建立明确失败。

### 7.2 Chromium WebRTC Direct

复用同一 identity/signer，不修改 SDK 身份协议。只把 transport 切换为标准 WebRTC Direct。

验收：

- Chromium ↔ Go 真实握手；
- 认证出的公钥和 PeerId 与 WebSocket 路径一致；
- 双向 echo；
- transport 变化不增加新的 signer purpose；
- host/连接关闭后所有测试进程退出。

### 7.3 浏览器集成命令

`scripts/test-browser-integration.sh` 显式运行上述场景。不得由默认 `go test ./...` 或
TypeScript 普通测试调用，也不在本单中新增强制 CI workflow。

runner 不得依赖系统预装 Chromium 或桌面环境。Playwright 与 Chromium 仅作为开发测试资产，
缺失时命令必须返回失败并提示执行 `npx playwright install chromium`；不能返回成功并跳过。
runner 必须捕获 page/console error、超时、Worker 失效和非 PASS 结果，并负责关闭 browser、
context、host 和所有测试子进程。V1 使用 Playwright bundled full Chromium 的 new headless
模式（`headless: true`、`channel: 'chromium'`），不以 DOM 模拟器代替。

## 8. 第六阶段：文档与使用示例

更新 README，并分别提供：

- Go remote signer 最小装配示例；
- TypeScript remote signer 最小装配示例；
- 原生 libp2p 对端不安装 SDK也能互通的说明；
- Noise 负责加密、业务 key 只负责身份的简短说明；
- 普通测试与集成测试命令；
- 已支持/未支持的 libp2p service 清单；
- 依赖升级后的重新验收要求。

示例 signer 可以在内存使用测试私钥，但必须明确标注 TEST-ONLY，不能暗示生产应把 raw
私钥放入 Window 或 host。

## 9. 推荐施工顺序

1. 先提交正式规范和全部固定向量；
2. 落 Go `identity` 与向量测试；
3. 落 TypeScript `identity` 与同一向量测试；
4. 落两端 typed signer；
5. 落两端 non-extractable libp2p adapter；
6. 先完成 SDK Go ↔ SDK TypeScript 的单次真实 Noise 握手；
7. 加入 Signed Peer Record 和标准 Identify；
8. 完成 SDK ↔ 原生矩阵；
9. 完成 Playwright headless Chromium WebSocket 浏览器集成；
10. 完成 Playwright headless Chromium WebRTC Direct 浏览器集成；
11. 更新 README、能力清单和验收记录。

任何阶段发现上游必须读取 raw 私钥时，立即停止并记录具体调用路径。不得用伪造 raw、复制
私钥或放宽 signer 作为绕过方式。

## 10. 验收命令边界

最终仓库至少提供三类独立入口：

```text
go test ./...                         # Go 普通测试
<typescript package test command>     # TypeScript 普通测试
./scripts/test-integration.sh         # 跨语言/原生互通
./scripts/test-browser-integration.sh # Playwright headless Chromium WS/WebRTC Direct
```

本施工单不新增 CI workflow，也不要求现有 CI 自动调用后两项。集成测试是否进入使用方 CI，
由使用方根据成本自行决定。

## 11. 最终验收清单

### 身份

- [x] 只支持 secp256k1 业务身份；
- [x] Go/TypeScript 派生相同公钥和 PeerId；
- [x] public key、PeerId、multiaddr pin 严格一致；
- [x] 对端身份来自认证 connection，不信任业务自报字段。

### 私钥边界

- [x] Go/TypeScript host 不取得 raw 私钥；
- [x] raw 读取明确失败；
- [x] 公共接口不存在通用 Sign/SignDigest；
- [x] Noise signer 只接收 32 字节 static public key；
- [x] Peer Record signer 只接收合法结构化记录；
- [x] 异步签名前后可由实现复核会话状态；
- [x] 所有签名返回 libp2p 前完成本地复验。

### 原生兼容

- [x] 没有自定义 Noise 或 PeerId；
- [x] 没有生产 `/bitcoin-libp2p/...` 身份协议；
- [x] SDK Go ↔ SDK TypeScript 成功；
- [x] SDK Go ↔ 原生 TypeScript 成功；
- [x] SDK TypeScript ↔ 原生 Go 成功；
- [x] Go SDK ↔ 原生 go-libp2p v0.45 成功。

### 通信

- [x] WebSocket 双向 echo 成功；
- [x] WebRTC Direct 双向 echo 成功；
- [x] 多 stream 复用同一连接；
- [x] signer/host 失效时请求明确失败，不永久 pending。

### 测试与文档

- [x] 默认普通测试不启动浏览器或跨语言进程；
- [x] 集成测试有独立显式命令；
- [x] 仓库未新增强制 CI 集成任务；
- [x] README、需求、规范、实现和测试口径一致；
- [x] 测试私钥无生产资金或权限并有明确标记。

## 12. 完成定义

只有全部最终验收项通过，本单才可以标记完成。只做到“依赖可安装”“PeerId 能派生”或
“同语言 mock 可以运行”均不算完成。V1 的核心交付是：私钥分离条件下的真实标准 Noise
互通，以及与不依赖本 SDK 的原生 libp2p 双向通信。
