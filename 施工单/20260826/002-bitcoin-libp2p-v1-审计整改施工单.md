# bitcoin-libp2p V1 审计整改施工单

> 状态：已完成，最终验收通过。
>
> 本单只整改首版审计发现的阻断项，不改变已经冻结的 V1 wire、PeerId、Noise、Identify、
> Yamux、typed signer purpose 或业务身份模型。
>
> 需求真值：[V1 需求与协议边界](../../docs/bitcoin-libp2p-v1-需求文档.md)。原始施工范围：
> [001 V1 SDK 一次性施工单](001-bitcoin-libp2p-v1-sdk一次性施工单.md)。

## 0. 整改结论与施工纪律

当前实现已经证明固定向量、基础 adapter 和现有 TCP 跨进程场景可以运行，但不能据此标记
V1 完成。施工者必须按本单顺序关闭以下阻断：

1. 真实 libp2p host 路径中的 remote signer 超时、取消和生命周期；
2. SDK ↔ SDK 使用独立 remote signer，而不是进程内 `LocalSigner`；
3. 原生对照端依赖图隔离、准确拨号方向和强身份断言；
4. Playwright headless Chromium WebSocket/WebRTC Direct 实际验收；
5. TypeScript 正式发布包与 integration/test 资产隔离；
6. 补齐失败测试、修正无效测试入口和文档状态。

不得通过扩大为通用签名、复制 raw 私钥进 host/Window、关闭 Identify/Signed Peer Record、
伪造 `Raw/raw`、修改标准 wire 或降低断言来换取测试通过。测试专用 signer 通道不能成为
生产 RPC 协议。

## 1. P0：remote signer 生命周期

### 1.1 问题

Go adapter 的原生 `Sign(data)` 当前从 `context.Background()` 开始；TypeScript 虽然接受
`AbortSignal`，但 Noise 上游调用不保证传入 signal。只验证直接调用 adapter 的取消，不足以
证明真实 Noise 握手可以结束。永久 pending 的 Worker/RPC signer 可能泄漏 goroutine、Promise
或连接升级任务。

### 1.2 必须修改

- Go/TypeScript adapter 或 host 装配拥有独立生命周期取消源；
- 每次 Noise/Peer Record 签名都有有限、可配置且有安全默认值的超时；
- 有上游 Context/AbortSignal 时与内部生命周期、单次超时合并，任一结束即停止本地等待；
- host stop、signer lane 失效和身份轮换准备阶段必须取消全部未决签名；
- signer 返回后仍需复核 active public key 并完成 DER/low-S/绑定公钥验证；
- 不额外公开供业务调用的通用 `SignContext(bytes)`；原生 `Sign(data)` 只是严格分发接缝。

不要求强行终止已经到达 HSM/Worker 的物理签名操作，但 SDK 对该请求的等待必须结束，迟到
响应必须被丢弃且不能恢复旧连接任务。

### 1.3 验收测试

- Go 与 TypeScript 均使用永不返回的 typed signer 发起真实 Noise dial；
- 单次签名超时后 dial 明确失败；
- host stop 后所有未决等待结束；
- signer 在请求中途退出/拒绝时当前握手失败；
- 测试有整体超时并验证无永久 pending，不只直接调用 adapter 方法。

## 2. P0：真正的 remote signer 跨语言场景

### 2.1 必须修改

当前 Go/TypeScript SDK integration endpoint 不得再以 host 进程中的 `LocalSigner` 冒充
remote signer。增加测试专用独立 signing lane，可选子进程、Node Worker Thread 或本机临时
RPC，但只能接收：

- `SignNoiseStaticKey(staticKey32)`；
- `SignPeerRecord(peerId, addresses, sequence)`。

host 进程只持有绑定公钥和 typed client。测试通道不得接受任意 bytes、digest、domain、hash
或签名格式，也不得被 SDK runtime 导出。

### 2.2 必测

- Go SDK remote signer 主动连接 TypeScript SDK remote signer；
- TypeScript SDK remote signer 主动连接 Go SDK remote signer；
- 两个方向都完成 Noise、Identify、至少两条 echo stream；
- host 进程内探测 raw 明确失败；
- signer 请求次数证明新开业务 stream 不重复执行 Noise identity 签名。

## 3. P0：原生对照端与身份强断言

### 3.1 原生端隔离

- `integration/native-go` 建立独立 Go module；
- 原生 Go 在自己的 module 内实现最小 echo，不 import/link 主 module 的 `integration/echo`；
- 原生 TypeScript entry 不 import SDK source、dist 或 package export；
- 用依赖图检查证明原生端不存在 `github.com/bsv8/bitcoin-libp2p` 或
  `bitcoin-libp2p` 依赖；
- 保留 v0.45 独立 module，不把它并回主 module。

### 3.2 矩阵方向

至少准确执行：

| 发起方 | 接收方 |
|---|---|
| Go SDK remote signer | TypeScript SDK remote signer |
| TypeScript SDK remote signer | Go SDK remote signer |
| Go SDK remote signer | 原生 TypeScript |
| TypeScript SDK remote signer | 原生 Go v0.49 |
| Go SDK remote signer | 原生 Go v0.45 |

可以增加反向场景，但不能用反向场景替代上述方向。

### 3.3 强断言

`run_client` 不能只搜索 `OK`。每项必须解析并比较：

- server 实际 PeerId；
- client 从 authenticated connection 取得的 remote PeerId；
- client 从 authenticated connection 取得的 33 字节 remote public key；
- 固定向量中的期望公钥和 PeerId；
- 拨号 multiaddr 的 `/p2p` component。

任意一项缺失或不一致都必须失败。输出不得包含私钥或完整敏感签名请求。

## 4. P0：Playwright headless Chromium

### 4.1 运行模型

浏览器测试改由 Playwright 启动其版本绑定的真实 Chromium：

```text
cd typescript
npm install
npx playwright install chromium
cd ..
./scripts/test-browser-integration.sh
```

开发环境不要求桌面、X11、Wayland 或系统预装 Chromium。Linux 缺少动态库时，由开发镜像或
有权限的环境执行 `npx playwright install --with-deps chromium`。本单不新增强制 CI job。

### 4.2 实现要求

- Playwright 仅为 devDependency；
- Playwright 版本精确锁定在 package lock，升级后重新安装对应浏览器并重跑两种 transport；
- 使用 bundled full Chromium、`headless: true` 和 `channel: 'chromium'`，不依赖
  `CHROMIUM_BIN`，不以精简 headless shell 或 DOM 模拟器代替；
- Bash 可继续负责 Go/HTTP 服务和清理，浏览器导航与断言由 Playwright runner 负责；
- 分别运行 WebSocket、WebRTC Direct，使用独立 browser context；
- 捕获 `pageerror`、console error、browser crash、navigation/test timeout；
- 等待结构化 PASS 结果并校验公钥、PeerId，不能只 dump DOM 后 grep；
- 缺少 Playwright 或浏览器时返回非零并打印安装命令，不能成功跳过；
- 成功和失败路径都关闭 page/context/browser、Worker、host 和子进程。

### 4.3 浏览器失败场景

- Worker signer 永久 pending，dial/测试超时后明确结束；
- Worker 在签名中途退出，当前连接建立失败；
- host stop 后 Window 无未决 signer Promise；
- 两条以上 stream 复用同一连接，业务消息不触发新的 Noise identity 签名；
- WebSocket 与 WebRTC Direct 认证出的公钥和 PeerId 完全一致。

## 5. P1：TypeScript 构建与发布边界

### 5.1 必须修改

正式 `npm pack` 不能包含 `dist/integration`、浏览器 bundle、测试 worker、测试 endpoint 或
TEST-ONLY 私钥。建议：

- 主 `tsconfig`/build 只编译 `index`、`identity`、`signer`、`libp2p`；
- integration 使用独立 tsconfig 和独立、被忽略的输出目录；
- `package.json.files` 明确列出正式 SDK 产物，不笼统发布整个含测试资产的 `dist`；
- 仅供 integration 的 Playwright、WebRTC/TCP 等依赖按实际 runtime 用途放入 devDependency；
- `npm pack --dry-run` 纳入发布前人工验收。

### 5.2 验收

- tarball 中没有 `integration`、browser bundle 或测试私钥；
- tarball 安装到空临时项目后，所有正式 exports 可 import 且类型声明完整；
- Node 与浏览器消费者不会因测试依赖被迫安装 Playwright；
- package version 在全部 P0/P1 完成前不得发布为 `1.0.0`。

## 6. P1：测试缺口与命令修正

- Go 必须实际读取 `invalid-identity-v1.json`，覆盖 `0`、`n`、`n+1`、错误长度、非曲线点；
- Go/TypeScript 都覆盖 compact、坏 DER、high-S、错误 key 的合法 DER；
- 两端覆盖 Peer Record 错 domain、错 type、错 PeerId、非法地址；
- TypeScript 覆盖 host 创建/启动/停止不读 raw、Promise reject 和 signer key 中途变化；
- 补齐 pin、Ed25519 连接后业务认证拒绝和 host stop 失败矩阵；
- 当前无测试文件却返回失败的 `npm run test:integration` 必须删除，或改为调用真实集成入口；
- 普通测试继续保持单进程，不启动 Go 子进程、Playwright 或监听服务。

## 7. 施工顺序与停止条件

严格按以下顺序施工：

1. 生命周期取消和真实 host pending 测试；
2. 测试专用 remote signer lane；
3. 原生端 module 隔离、矩阵方向与强身份断言；
4. Playwright headless Chromium 两种 transport 和失败场景；
5. npm 构建/发布隔离；
6. 补齐普通测试和修复命令；
7. 更新 README、integration 文档和实际验收记录；
8. 最后统一运行验收，不在中途声称 V1 已完成。

若发现标准 Noise/Identify 的新调用路径需要第三种签名用途，停止施工并提交调用栈和上游版本；
不得自行放宽 signer。若 Playwright WebRTC Direct 在 headless Chromium 失败，必须保留日志、
page error 和双方 multiaddr，先区分环境依赖与 wire/transport 问题，不能改成 mock 浏览器通过。

## 8. 最终验收命令

```text
go test ./...
go vet ./...
cd typescript && npm test
cd .. && ./scripts/test-integration.sh
./scripts/test-browser-integration.sh
cd typescript && npm pack --dry-run
```

浏览器安装是开发环境准备步骤，不属于普通测试，也不要求放入 CI：

```text
cd typescript && npx playwright install chromium
```

## 9. 完成定义

只有以下条件同时满足，才能把需求文档、001 施工单和 README 状态改回“V1 已完成”：

- 两端真实 remote signer 在成功、超时、取消、退出路径均无永久 pending；
- 原生对照端依赖图完全不引用本 SDK；
- 固定矩阵按准确方向通过，公钥、PeerId、地址均做强断言；
- Playwright headless Chromium 的 WebSocket、WebRTC Direct 和 signer 失败场景实际通过；
- npm 正式 tarball 不含 integration、Playwright、测试 bundle 或测试私钥；
- 普通测试、显式集成测试、文档和公开 API 口径一致；
- 没有新增强制 CI workflow。

## 10. 实际验收记录

2026-08-26 已完成本单整改并执行最终验收：

- Go signer 直接遵守带超时 Context，测试 signer 在取消后返回，未保留 adapter detached goroutine；
- 规定的 Go SDK→原生 TypeScript、TypeScript SDK→原生 Go v0.49、Go SDK→原生 Go v0.45 方向均通过，
  反向场景作为额外回归覆盖；
- Go/Node 独立 signer lane 均通过 normal、pending、exit、reject、wrong-key 失败模式；
- Playwright bundled full Chromium 在 `headless: true`、`channel: 'chromium'` 下通过 WebSocket、
  WebRTC Direct、pending、exit、host stop 和多 stream 场景；
- 正式 npm tarball 包含 README、LICENSE、完整 source map 和正式 SDK 产物，不包含 integration、
  浏览器 bundle、Playwright 或测试私钥；
- 生成目录已加入 Git 忽略，全部源码、测试、文档和施工单已纳入 Git 索引，未新增强制 CI workflow。
