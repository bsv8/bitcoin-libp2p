# bitcoin-libp2p 多语言 Demo 与 E2E 范例施工单

> 状态：已完成。
>
> 本单只新增开发者范例及执行这些范例的显式 E2E 入口，不修改已经冻结的 V1 identity、
> PeerId、Noise、Identify、Yamux、Signed Peer Record 或 typed signer 协议边界。
>
> 上游约束以 [V1 需求与协议边界](../../docs/bitcoin-libp2p-v1-需求文档.md)、
> [001 V1 SDK 一次性施工单](../20260826/001-bitcoin-libp2p-v1-sdk一次性施工单.md)和
> [002 V1 审计整改施工单](../20260826/002-bitcoin-libp2p-v1-审计整改施工单.md)为准。

## 0. 施工目标

新增一组可以直接运行的最小 Demo，同时承担两个职责：

1. **Hello 范例**：开发者可以在几分钟内看懂如何创建 host、监听、拨号、认证对端、打开
   业务 stream、收发消息和关闭资源；
2. **真实 E2E**：测试程序启动的就是 README 中展示的 Demo，不再维护另一套只为测试服务的
   同义实现。

Demo 必须保持简单，但不能通过省略身份认证、私钥边界或错误处理来换取代码行数少。
开发者看完后应明确理解：

- SDK 使用业务 secp256k1 公钥作为标准 libp2p identity；
- Noise 握手和后续 stream 加密仍由原生 libp2p 完成；
- 应从安全升级后的连接认证远端公钥与 PeerId，不能相信业务消息自报身份；
- `LocalSigner` 只适合 Demo、测试或可信单进程程序；生产环境应实现私钥分离的 typed signer；
- Go、TypeScript 和未使用本 SDK 的原生 libp2p 节点可以使用同一标准 wire 通信。

## 1. 设计原则

### 1.1 一个 Demo 只回答一个主要问题

每个 Demo 的 README 第一屏必须说明“这个 Demo 教什么”和“它没有教什么”。不得把命令行
框架、配置系统、日志框架、数据库、服务发现、重连策略等应用工程问题混入 Hello 范例。

### 1.2 Demo 是被测对象，不是测试夹具的包装

- E2E runner 只能启动 Demo、读取其结构化输出并断言结果；
- 不能在 E2E runner 中重新实现 host、signer、协议 handler 或认证逻辑；
- Demo 不得 import `integration/` 下的测试 endpoint；
- 现有强互操作测试继续独立存在，不能改成只依赖较轻的 Demo smoke test；
- 可以共享常量和极小的字节读取辅助函数，但 SDK 调用主流程必须保留在每个 Demo 中，方便阅读。

### 1.3 由浅入深

先提供 Go 和 TypeScript 的最小 Hello，再复用两者证明跨语言；私钥分离、浏览器和原生互通
放在后续 Demo。开发者不需要先理解 remote signer IPC 或 Playwright 才能运行第一个示例。

### 1.4 不增加默认测试和 CI 负担

- 不新增 GitHub Actions 或其他强制 CI workflow；
- `go test ./...` 和 `cd typescript && npm test` 不启动 Demo 子进程或浏览器；
- Demo E2E 使用独立显式命令；
- 浏览器依赖缺失必须明确失败并给出安装命令，不能静默跳过；
- 快速场景与完整场景分开，开发者按需执行。

## 2. Demo 总览与学习路径

| 编号 | Demo | 主要学习目标 | E2E 证明 |
|---|---|---|---|
| 01 | Go Hello | Go SDK 建 host、handler、dial、认证与 stream | Go SDK ↔ Go SDK |
| 02 | TypeScript Hello | TypeScript SDK 的同义流程 | TS SDK ↔ TS SDK |
| 03 | Cross-language Hello | 不新增实现，直接交叉运行 01/02 | Go → TS、TS → Go |
| 04 | Remote Signer Hello | host 只持有公钥和两个 typed 签名能力 | Go、TS 各自的独立 signer 运行位置 |
| 05 | Browser Worker Hello | Window 不取得私钥，Worker 完成 typed 签名 | Chromium TS SDK → 原生 Go（WebSocket、WebRTC Direct） |
| 06 | Native libp2p Interop | 本 SDK 没有私有 wire | Go SDK → 原生 TS、TS SDK → 原生 Go |

编号表示推荐阅读顺序，不表示 SDK 层级。01 和 02 是最短入口；03 直接复用它们，不能复制出
第三套 Hello 源码。

## 3. 目录定稿

施工后目录保持如下：

```text
examples/
  README.md                         # 总入口、学习路径、所有一键命令
  protocol.md                       # Demo-only Hello stream 约定

  01-go-hello/
    README.md
    main.go

  02-typescript-hello/
    README.md
    package.json
    package-lock.json
    tsconfig.json
    src/main.ts

  04-remote-signer/
    README.md
    go/
      host/main.go
      signer/main.go
    typescript/
      package.json
      package-lock.json
      tsconfig.json
      src/host.ts
      src/signer.ts

  05-browser-worker-hello/
    README.md
    index.html
    src/main.ts
    src/signer-worker.ts
    server/                           # 原生 Go transport 对照端，独立 module
      go.mod
      go.sum
      main.go

  06-native-interop/
    README.md
    native-typescript/               # 独立 package，不依赖本 SDK
      package.json
      package-lock.json
      src/main.ts

  e2e/
    runner.mjs                       # 只编排进程和解析结果

scripts/
  test-demos.sh                      # 显式入口，不挂入普通测试
```

`03-cross-language` 是运行组合而不是新目录。总 README 必须直接给出 01/02 交叉运行命令，
避免为了编号完整制造重复源码。

如施工者发现 TypeScript Demo 需要少量构建配置，可以在各自目录补充配置文件，但不得建立
新的 SDK 包、复制 SDK 源码或通过相对路径 import `typescript/src`。

## 4. 统一的 Demo-only Hello 协议

所有 Demo 使用：

```text
/bitcoin-libp2p/demo/hello/1.0.0
```

这个 Protocol ID 只属于示例业务 stream，不是 identity、signer 或 SDK 协议，也不得由 SDK
自动注册。`examples/protocol.md` 固定以下最小语义：

- client 在新 stream 中发送一条不超过 1 KiB 的 UTF-8 文本；
- server 返回 `hello, <原文本>`，随后正常关闭 stream；
- 空消息、非 UTF-8 或超限消息应关闭/重置当前 stream，不影响 host；
- E2E 在同一连接上连续打开两条 stream，证明业务 stream 不重新执行 Noise 握手；
- 不在业务 payload 中携带或自报公钥、PeerId、签名或 token；
- 对端身份只从 Noise 已认证的连接取得。

不得增加自定义身份握手、自定义加密、业务签名 envelope 或通用 signer 请求。

## 5. 统一进程接口与结构化输出

为了让人工运行与 E2E 使用同一程序，01、02、04 和 06 的 host 程序统一接受最少参数：

```text
--mode server|client
--listen <multiaddr>       # server；缺省使用 127.0.0.1 随机端口
--dial <p2p-multiaddr>     # client
--message <utf8>           # client；缺省 hello
--expect-peer-id <peerId>  # 可选 pin
--expect-public-key <hex>  # 可选 pin
```

参数名称跨语言保持一致。Demo 可以增加 transport 或 signer 运行位置所需的少量参数，但不得
发展为通用配置框架。

标准输出使用一行一个 JSON 对象，普通说明和错误写入标准错误。至少包含：

### 5.1 Server ready

```json
{
  "event": "ready",
  "demo": "go-hello",
  "language": "go",
  "peerId": "...",
  "publicKey": "02...",
  "address": "/ip4/127.0.0.1/tcp/12345/p2p/...",
  "protocol": "/bitcoin-libp2p/demo/hello/1.0.0"
}
```

### 5.2 Client success

```json
{
  "event": "hello",
  "demo": "typescript-hello",
  "language": "typescript",
  "remotePeerId": "...",
  "remotePublicKey": "02...",
  "remoteAddress": "...",
  "request": "hello",
  "response": "hello, hello",
  "streams": 2
}
```

约束：

- JSON 字段顺序不是协议，E2E 必须解析 JSON 后按字段断言；
- 不得用 `grep OK` 作为成功标准；
- 不得输出私钥、完整签名请求、签名结果或 signer IPC 敏感内容；
- server 只有在监听成功并完成 handler 注册后才能输出 `ready`；
- fatal error 返回非零；SIGINT/SIGTERM 必须关闭 host、stream、Worker、signer 子进程和监听端口。

## 6. Demo 01：Go Hello

### 6.1 阅读目标

`main.go` 应让 Go 开发者顺序看到：

1. 创建 Demo-only、临时 secp256k1 signer；
2. 构造 `golibp2p.HostConfig`；
3. 由应用注册 Hello protocol handler；
4. server 输出带 `/p2p/<PeerId>` 的完整拨号地址；
5. client 建立连接并调用 `AuthenticatedPeerFromConn`；
6. 可选地校验期望 public key 与 PeerId；
7. 打开两条 stream、校验响应并关闭 host。

应用 handler 必须在 Demo 内注册，不能让人误以为 SDK 自带 Hello 协议。

### 6.2 私钥说明

默认生成本次进程使用的临时测试身份，或读取 E2E 显式提供的 TEST-ONLY fixture。README 和
源码注释必须紧邻 signer 创建位置说明：

- `LocalSigner` 仅用于 Demo、测试或可信单进程程序；
- 生产业务私钥不应复制进 host；
- 正确的私钥分离接法见 Demo 04。

不得把固定测试私钥硬编码在源码，也不得打印它。

### 6.3 简洁度要求

- 主流程目标不超过约 150 行，辅助读取函数另计；
- 只使用标准库、Go SDK 和必要的 go-libp2p stream 类型；
- 不使用 Cobra、Viper、第三方日志框架或依赖注入容器；
- 错误必须处理，不能以大量省略号或伪代码冒充可运行范例。

## 7. Demo 02：TypeScript Hello

### 7.1 阅读目标

与 Demo 01 保持同义顺序：

1. 创建临时 `LocalSigner`；
2. 调用 `createHost`，显式注入 TCP transport；
3. 注册应用拥有的 Hello handler；
4. server 输出完整地址；
5. client dial 后调用 `authenticateConnection`；
6. 可选 pin；
7. 两条 stream 收发并在 `finally` 中 `node.stop()`。

不得直接调用底层 `createLibp2p` 来绕过 SDK，也不得从 `peerId` 对象存在这一事实推断已经完成
业务侧认证检查。

### 7.2 消费者真实性

- 源码必须按包名 `@bsv8/bitcoin-libp2p` 及公开 subpath import；
- 不得 import `../../typescript/src`、`dist` 内部文件或 integration endpoint；
- 本仓库人工运行可通过 `file:../../typescript` 安装已构建包；
- E2E 必须优先从 `npm pack` 产生的正式 tarball 安装，顺带证明公开 exports 和声明可消费；
- Demo 自身不得被打入正式 SDK tarball。

### 7.3 简洁度要求

与 Go Demo 等价，不引入 Web 框架、命令行框架或状态管理库。stream 字节读取可以有一个小型
辅助函数，但不能隐藏 `createHost`、`dial`、`authenticateConnection` 和 `newStream` 主流程。

## 8. Demo 03：Cross-language Hello

本 Demo 不新增应用源码。`examples/README.md` 给出两组交叉命令：

1. TypeScript Hello 作为 server，Go Hello 作为 client；
2. Go Hello 作为 server，TypeScript Hello 作为 client。

E2E 同时执行：

| 发起方 | 接收方 |
|---|---|
| Go SDK Demo | Go SDK Demo |
| TypeScript SDK Demo | TypeScript SDK Demo |
| Go SDK Demo | TypeScript SDK Demo |
| TypeScript SDK Demo | Go SDK Demo |

四项都必须比较 server `ready` 与 client `hello` 中的 remote public key、PeerId、拨号地址
`/p2p` component、响应内容和 stream 数量。这样用最少源码同时证明两种语言的 SDK 使用方法
和跨语言 wire 一致性。

## 9. Demo 04：Remote Signer Hello

### 9.1 目标

在 Hello 主流程之上只增加一个概念：raw 私钥位于另一个运行位置，host 只得到固定公钥和
两个 typed 签名能力。

必须各有一个 Go 和 TypeScript 场景：

- Go：host 进程与 signer 子进程分离；
- TypeScript Node：host 与 signer Worker/子进程分离；
- host 进程内不能构造 `LocalSigner`，也不能读取 raw 私钥；
- signer client 只实现 SDK 的 `Signer`/`TypedSigner` 接口；
- 两条业务 stream 不产生新的 Noise identity 签名请求。

### 9.2 Demo 内部通道边界

为了保持可运行，可以使用 stdio JSON Lines、Worker message 或本机临时 IPC，但必须满足：

- 通道代码完全位于 Demo 内，不进入 SDK export；
- 请求只有 `publicKey`、`noise-static-key`、`peer-record` 三种固定形状；
- 不接受任意 payload、digest、domain、hash 算法或签名格式；
- signer 响应由 SDK adapter 按绑定公钥复验；
- Abort/Context、单次超时、子进程退出和 host stop 均结束本地等待；
- README 明确声明这个 IPC 只是教学实现，不是 bitcoin-libp2p signer 标准或推荐生产 RPC；
- 生产使用者应在相同 typed interface 后连接自己的 Keymaster、Worker、HSM 或受保护服务。

### 9.3 E2E

Go 和 TypeScript 各执行一次完整 Hello，并额外断言：

- host 与 signer 的 PID/Worker 运行位置不同；
- host 启动信息只有 signer public key，不含 raw key；
- Noise 签名请求实际到达 signer；
- 两条业务 stream 复用连接，不增加 Noise identity 签名次数；
- signer 中途退出时 dial 非零失败且没有永久 pending；
- host stop 后未决 signer 请求为零。

该 Demo 只负责把安全架构讲清楚；现有 integration 中更完整的 reject、wrong-key、pending 矩阵
仍是最终回归真值，不能删除。

## 10. Demo 05：Browser Worker Hello

### 10.1 人工体验

提供一个命令启动原生 Go libp2p Hello server 和静态页面，并打印访问 URL。页面只显示：

- 当前 browser PeerId 与 public key；
- 已认证的 Go remote PeerId 与 public key；
- transport；
- Hello 请求、响应与成功/失败状态。

不做后台管理界面、复杂样式或状态面板。

本 Demo 的被教学 SDK 端是 Chromium 中的 TypeScript SDK。Go receiver 使用独立 module 的
原生 go-libp2p，对 WebSocket 与 WebRTC Direct 提供相同标准 wire。这样既证明浏览器 SDK 的
使用方式，也证明它能和原生节点通信。

不得为了让 Go SDK host 承担 WebRTC Direct receiver 而放宽 non-extractable identity。当前
Go SDK 只默认承诺不读取 raw key 的 TCP 路径；部分 Go transport constructor 可能需要
`PrivKey.Raw`。未来只有在上游 transport 能明确支持 non-extractable identity 后，才能另单评估
Go SDK receiver，不能在 Demo 中复制或伪造 raw 私钥绕过边界。

### 10.2 密钥边界

- raw TEST-ONLY 私钥只存在于 dedicated Worker；
- Window 只持有 public key 和 typed signer proxy；
- Window、URL、DOM、console 和网络日志不得出现 raw 私钥；
- Worker message 只能表达两种 typed signer purpose；
- Worker 退出、Abort、sign timeout 与 host stop 后 Promise 必须结束；
- README 明确 Demo Worker 不是生产 Keymaster，会话、leader、lease 和 Vault lock 由应用负责。

### 10.3 Transport 与 E2E

- 人工默认走 WebSocket，保证最容易理解和调试；
- 提供明确开关运行 WebRTC Direct，不在页面中自动猜测或静默降级；
- Playwright 使用 bundled full Chromium、`headless: true`；
- E2E 分别执行 WebSocket 和 WebRTC Direct；
- 两种 transport 都比较 authenticated public key、PeerId、Hello 响应及两条 stream；
- 捕获 page error、console error、browser crash 和 timeout；
- 开发环境不要求桌面、X11、Wayland 或系统 Chromium。

浏览器依赖未安装时打印：

```text
cd typescript && npx playwright install chromium
```

然后非零退出，不能标记跳过成功。

## 11. Demo 06：Native libp2p Interop

### 11.1 目标

用最短源码证明 bitcoin-libp2p 节点仍是标准 libp2p 节点。使用两个只实现同一 Hello protocol
的原生对照 server：

- 原生 Go server：复用 Demo 05 的独立 `server` module，不 import 主 module，并增加/保留 TCP
  运行参数；
- 原生 TypeScript server：独立 package，不依赖 `@bsv8/bitcoin-libp2p`。

原生端可使用原生 libp2p 支持的 secp256k1 identity，但不得复制 SDK adapter、typed signer 或
认证 helper。

### 11.2 E2E 方向

必须执行：

| 发起方 | 接收方 |
|---|---|
| Go SDK Hello client | 原生 TypeScript Hello server |
| TypeScript SDK Hello client | 原生 Go Hello server |

SDK client 仍需调用各自认证 helper 并比较公钥、PeerId 和 `/p2p` 地址。原生依赖图检查必须证明
没有本 SDK 依赖。

该 Demo 不替代现有 v0.45/v0.49 版本矩阵；这里只提供开发者可读的“为什么可以自然互通”范例。

## 12. E2E Runner

新增统一入口：

```text
./scripts/test-demos.sh --quick
./scripts/test-demos.sh --all
```

### 12.1 `--quick`

只运行 01、02、03 的四项组合：Go→Go、TS→TS、Go→TS、TS→Go。目标是在本机快速验证
Hello 范例仍能编译、运行和互通，不启动 Chromium。

### 12.2 `--all`

在 quick 基础上运行：

- Go remote signer；
- TypeScript remote signer；
- Chromium WebSocket；
- Chromium WebRTC Direct；
- Go SDK → 原生 TypeScript；
- TypeScript SDK → 原生 Go；
- remote signer 退出和 host stop 的最小失败场景。

### 12.3 Runner 纪律

- 为每个场景使用 127.0.0.1 随机端口和独立临时目录；
- 从 server 的 JSON `ready` 事件取得实际地址，不写死端口；
- 每个进程、dial、stream 和页面都有有限超时；
- 任一断言失败立即记录场景名、双方 stderr、地址和非敏感身份信息；
- success、failure、SIGINT 和 timeout 都回收 host、signer、Worker、browser 和子进程；
- 不依赖桌面，不访问公网，不使用生产 key；
- 不要求 `jq`；由 Node runner 解析 JSON 和编排跨语言进程；
- Bash 入口只负责环境检查、构建和调用 runner，不承载业务断言；
- runner 成功时输出逐项结果和最终汇总，任一场景失败整体非零。

## 13. 构建、依赖与发布边界

- Go Hello 可以属于主 module；原生 Go 对照端必须是嵌套独立 module；
- TypeScript Demo 必须从公开包 export 消费 SDK；
- Playwright、TCP、WebRTC、构建工具只按 Demo/E2E 实际需要作为开发依赖；
- 所有 TypeScript 版本和 lockfile 必须固定，避免 Hello 命令每次得到不同依赖图；
- `node_modules`、Demo build、临时 tarball、Playwright 报告和 E2E 输出目录加入 `.gitignore`；
- `npm pack --dry-run` 必须继续证明正式 SDK tarball 不含 `examples/`、测试 key 或浏览器 bundle；
- 不发布独立 `bitcoin-libp2p-demo` npm 包，也不建立第二个 Go SDK module。

## 14. README 质量要求

每个 Demo README 必须按固定顺序编写：

1. 一句话说明学习目标；
2. 架构图或三行以内的进程关系说明；
3. 前置环境；
4. 可复制的 server 命令；
5. 可复制的 client/浏览器命令；
6. 预期输出；
7. 逐段对应 SDK API；
8. 私钥和生产边界警告；
9. 常见错误及停止方式；
10. 对应 E2E 场景。

总 README 提供“5 分钟路径”：先 Go 或 TypeScript Hello，再运行另一语言 client，最后按需求进入
Remote Signer 或 Browser。不得要求读者先阅读完整需求文档才能运行 Hello，但必须链接正式
identity 和 security 文档。

代码注释解释“为什么”，不要逐行复述语法。README 不粘贴一份会与源码漂移的大段完整代码，
而是引用可运行文件并摘录关键 API。

## 15. 安全与协议禁止事项

施工者不得：

- 把 Demo Protocol ID 注册进 SDK；
- 新增私有 Noise 字段、身份交换 stream 或自定义 PeerId；
- 把 signer IPC 描述成 Go/TypeScript 跨语言标准；
- 为 Demo 增加公共 `sign(bytes)`、`signDigest` 或任意 domain；
- 在源码、日志、JSON、浏览器 Window/DOM 中暴露测试或生产私钥；
- 用业务响应里的 PeerId/公钥替代 connection authenticated identity；
- 为缩短 Demo 而跳过签名结果复验、pin 失败或资源关闭；
- 让浏览器静默从 WebRTC Direct 降级到 WebSocket；
- 让 E2E 只检查进程退出码或某个 `OK` 字符串；
- 删除或弱化现有 integration 强矩阵来减少重复运行时间；
- 将 Demo E2E 强制加入 CI。

## 16. 施工顺序

严格按以下顺序实施，保证每一步都有可运行产物：

1. 固定 Demo-only Hello protocol、JSON 输出和目录；
2. 完成 Go Hello，并人工 server/client 自连；
3. 完成 TypeScript Hello，并从正式 package export 消费；
4. 用同一 01/02 源码完成四向 quick E2E；
5. 完成 Go/TypeScript Remote Signer Hello 与最小失败场景；
6. 完成 Browser Worker Hello 的 WebSocket，再增加 WebRTC Direct；
7. 复用 Browser Demo 的原生 Go server，完成原生 TypeScript server 与两端依赖隔离检查；
8. 完成 `--all` runner、超时、日志和统一清理；
9. 补齐各 Demo README、根 README 入口和 integration 文档链接；
10. 执行普通测试、既有 integration、Demo E2E、浏览器测试和发布包检查。

若为了实现 Demo 发现必须修改 SDK 公共 API、增加 signer purpose 或改变 wire，停止施工并单独
提出设计问题；不得在 Demo 施工中顺便改变 V1 协议。

## 17. 验收命令

施工完成后至少执行：

```text
go test ./...
go vet ./...
cd typescript && npm test
cd ..

./scripts/test-demos.sh --quick
./scripts/test-demos.sh --all

./scripts/test-integration.sh
./scripts/test-browser-integration.sh

cd typescript && npm pack --dry-run
```

普通测试证明 SDK 未被 Demo 破坏；既有 integration 继续承担严格协议矩阵；Demo E2E 证明文档中的
可运行范例没有腐化；`npm pack` 证明示例资产没有进入正式发布包。

## 18. 完成定义

以下条件全部满足，才可将本施工单状态改为“已完成”：

- 01/02 源码短小、可独立阅读并完成同语言 Hello；
- 同一源码完成 Go→TS、TS→Go，不存在隐藏的第三套实现；
- client 明确使用 authenticated connection 取得和校验 remote public key、PeerId；
- Remote Signer Demo 的 host 不持有 raw 私钥，且 IPC 未进入 SDK export；
- Browser Window 不持有 raw 私钥，WebSocket/WebRTC Direct 均实际通过；
- 两个 native server 的依赖图不引用本 SDK，规定方向互通；
- quick/all E2E 解析结构化结果、带超时且无残留子进程；
- 默认普通测试没有新增跨进程或 Chromium 负担；
- 正式 npm tarball 不包含 Demo、Playwright 产物或测试 key；
- 总 README 和每个 Demo README 的命令已由施工者逐条复制执行；
- 未新增 CI workflow，未改变 V1 协议与 signer purpose。

完成后在本单末尾追加实际验收日期、运行环境、各命令结果和已知限制，不得预先写“验收通过”。

## 19. 实际验收记录

- 日期：2026-08-27。
- 环境：Linux；Go `go1.26.0`；Node.js `v22.13.1`；npm `10.9.2`；Playwright bundled Chromium。
- `go test ./...`：通过。
- `go vet ./...`：通过。
- `cd typescript && npm test`：通过，2 个测试文件、11 个测试通过。
- `./scripts/test-demos.sh --quick`：通过，Go/TS 同语言与双向跨语言共 4 项。
- `./scripts/test-demos.sh --all`：通过，quick、Go/TS remote signer、严格 Noise 请求计数（连接前 0、连接后恰好 1）、signer exit/host stop、Chromium WebSocket/WebRTC Direct、Browser Worker pending/worker-exit/abort/host-stop、两项 native interop 和依赖隔离均通过。
- `./scripts/test-integration.sh`：通过，既有 integration matrix 未受影响。
- `./scripts/test-browser-integration.sh`：通过，既有 Chromium WebSocket/WebRTC Direct、pending、exit、stop 场景通过。
- `cd typescript && npm pack --dry-run`：通过，正式包仅包含 SDK `dist`、README、LICENSE 和声明/source map，未包含 `examples/`、Demo bundle 或测试 key。
- 额外检查：独立 native Go module `go test ./... && go vet ./...` 通过；`scripts/run-browser-demo.sh websocket 49152` 成功打印可访问 URL，随后按测试超时清理。
- 整改复验：runner 已注册全局 ManagedProcess、browser、HTTP server 清理；SIGINT 中断演练返回 130，未留下 Demo 进程或临时目录；正常 `--quick`/`--all` summary 均报告 `managedProcesses: 0`、`cleanupTasks: 0`。
- `scripts/test-demos.sh` 不再安装源码目录依赖；`--quick` 只构建 Go/TypeScript Hello，`--all` 才构建其余范例；正式 SDK tarball 仅在临时目录以 npm offline 模式消费；Playwright 使用 `channel: 'chromium'`。

已知限制：Demo 的 `LocalSigner`、stdio JSONL signer IPC、浏览器 Worker 和随机身份都只用于教学/本机测试；生产环境仍需接入受保护 typed signer，并自行实现 session、leader、lease 和 Vault lock。浏览器 `--all` 需要预先执行 `cd typescript && npx playwright install chromium`；SDK Go receiver 的安全默认仍是 TCP，WebRTC Direct 由独立原生 Go 对照端承担。
