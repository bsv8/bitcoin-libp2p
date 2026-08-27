# bitcoin-libp2p Stream 与 WebRTC Direct SDK 封装施工单

> 状态：功能整改完成，待提交后最终验收（2026-08-27）。
>
> 需求真值：[V1.1 Stream 与 WebRTC Direct SDK 扩展需求](../../docs/bitcoin-libp2p-v1.1-stream-webrtc-direct-需求文档.md)。
>
> 本单在已验收 V1 上新增公开 API，不修改 identity、PeerId、Noise、Identify、
> Yamux、Signed Peer Record 或 typed signer wire/权限边界。

## 0. 施工目标

一次性完成两个可独立使用、共用真实 Chromium 互操作验收的能力：

1. `bitcoin-libp2p/stream`：封装 TypeScript libp2p `Stream` 的缓冲区、半关闭、结束事件竞态、
   大小上限、超时和取消；
2. `bitcoin-libp2p/webrtc-direct` 与 Go `webrtcdirect`：封装严格 endpoint、certhash、
   PeerId/public key 绑定、Chromium-only Direct dialer 和认证拨号。

施工者必须先完成单元语义和共享向量，再运行真实 Chromium + Go。不得以反复
延长 timeout、降级为 WebSocket、忽略 certhash/pin 或放宽事件断言来换取 PASS。

## 1. 施工边界与目录定稿

施工后至少形成：

```text
typescript/src/stream/index.ts
typescript/test/stream.test.ts

typescript/src/webrtc-direct/index.ts
typescript/test/webrtc-direct.test.ts

webrtcdirect/endpoint.go
webrtcdirect/endpoint_test.go

testdata/webrtc-direct-endpoint-v1.json

typescript/package.json               # 新增 ./stream、./webrtc-direct exports
typescript/README.md                  # 新 API 及字段中文说明链接
README.md                             # 双语言能力与限制
docs/integration-tests.md             # 真实 Chromium/Go 证据入口
release/versions.json                 # 最后阶段更新为 0.2.0
release/README.md                     # 0.2.0 发布与回退说明
```

可以在既有 browser integration/Demo 内增加场景，不要为同义的 Chromium/Go endpoint
复制第三套长期测试实现。测试 bundle、Playwright 和原生 endpoint 不得进入正式 npm 包。

## 2. 施工纪律

- 使用当前 lockfile 锁定的 libp2p 3.3.9、`@libp2p/interface` 3.3.0、
  `@libp2p/webrtc` 6.0.30 和 Go v0.49.0 实际 API，不凭记忆编写事件或错误语义；
- 不 import `@libp2p/webrtc` 的 `src/private-*` 或 `dist/private-*` 内部路径；只使用正式公开 export；
- multibase/multihash/PeerId/multiaddr 必须使用已锁定标准库，不手写 base64url、
  varint、protobuf 或 Base58；
- 新 API 必须有 TypeScript 声明、source map、消费者安装测试和中文字段说明；
- 不更改 `0.1.0` 已发布产物/tag；只在全部功能和验收完成后准备 `0.2.0`；
- 不新增强制 CI workflow；重型浏览器测试继续使用显式命令；
- 不放宽 non-extractable identity，不让 signer 接受任意字节或对外暴露 raw private key。

## 3. A01：公开 API 与依赖边界冻结

### 施工

1. 按需求文档冻结 `/stream`、`/webrtc-direct` 与 Go `webrtcdirect` 的类型和错误码；
2. 确认 `createWebRTCDirectDialer` 复用 `createHost`，不复制 identity/Noise/Yamux/Identify 装配；
3. 把 `@libp2p/webrtc` 从 TypeScript `devDependencies` 移入精确锁定的 `dependencies`；
4. 根据实际 import 评估 multiformats 依赖，不依赖上游包的私有转传依赖。

### 验收

- API 符合需求文档字段语义；
- `npm ls --omit=dev` 包含公开 runtime 所需依赖；
- 源码不存在 `@libp2p/webrtc/src/` 或 `/private-to-public/` 私有 import。

## 4. A02：TypeScript `readStreamToEnd`

### 施工

- 实现单一消费路径，合并 `Uint8Array`/`Uint8ArrayList` chunk；
- 使用 stream 当前状态与 `message`、`end`、`remoteCloseWrite`、`close` 共同判定结束；
- 实现默认 15 秒 timeout、1 MiB `maxBytes` 和外部 AbortSignal 合并；
- 超时、取消和越界默认 abort 当前 stream，并将所有终止路径收敛到幂等 cleanup；
- 错误保留安全 `cause`，不把 partial bytes 当作成功值返回。

### 验收

- 需求 11.1 的 fake stream 竞态矩阵全部通过；
- 测试使用 fake timer 断言 timeout，不引入真实长时 sleep；
- 断言 listener/timer/AbortSignal 清理和单次 settle，不只断言最终 bytes。

## 5. A03：Stream 真实回归与内部去重

### 施工

1. 将 TypeScript integration 和 Browser Worker Demo 中手写的同义 `readAll` 替换为正式
   `bitcoin-libp2p/stream` 公开入口；
2. 若 native 对照端为证明“不依赖 SDK”而保留小型读取函数，必须在源码注释中说明，
   不得为去重破坏 native 依赖隔离；
3. Demo 按“先启动读取 Promise，后 send/close write”的顺序展示最小用法。

### 验收

- WebSocket 与 WebRTC Direct 都使用正式 helper 连续运行至少 20 次无超时；
- 每次在同一连接上打开两条 stream，小响应和 128 KiB 响应逐字节相等；
- 重复运行是稳定性证据，不允许脚本遇到单次失败后自动重试掩盖。

## 6. A04：WebRTC Direct 共享向量

### 施工

- 新增 `testdata/webrtc-direct-endpoint-v1.json`，每个字段在 schema/附近文档有中文含义；
- valid case 记录输入地址、规范地址、host 类型/值、UDP 端口、certhash digest、
  PeerId 和公钥；
- invalid case 记录预期稳定错误码，不依赖 Go/Node 的完整错误字符串。

### 验收

- 需求 11.2 矩阵全部入库；
- 向量中的私钥若为了测试派生公钥而存在，必须紧邻标注 TEST-ONLY，无任何资金和生产权限；
- Go 和 TypeScript 测试都直接读取同一个 JSON，不复制两套常量。

## 7. A05：TypeScript endpoint 解析与生成

### 施工

- 实现 `parseWebRTCDirectEndpoint`、`buildWebRTCDirectEndpoint` 和不可变/拷贝返回数据；
- 严格检查完整组件序列、端口、SHA2-256 certhash 和 secp256k1 PeerId；
- 复用 `bitcoin-libp2p/identity` 派生/提取公钥，不在新模块重新实现 PeerId；
- pin 同时提供 public key 和 PeerId 时，先检查两者相互一致，再与地址比较。

### 验收

- TypeScript 共享向量全部通过；
- parse 后 build 与 build 后 parse 都产生同一规范 multiaddr；
- 输入字节数组与返回 digest/public key 不共享可变 buffer。

## 8. A06：Go `webrtcdirect` endpoint package

### 施工

- 实现与 TypeScript 同义的 `Endpoint`、`EndpointInput`、`EndpointPin`、`ParseEndpoint`
  和 `BuildEndpoint`；
- 使用 Go multiaddr/multihash/peer 库，复用本仓库 `identity` package 完成 secp256k1 校验；
- 导出可用 `errors.Is` 判断的 sentinel errors，保留底层 cause；
- 只处理 endpoint 数据，不 import Go WebRTC transport，不新建 host/listener，不接触私钥。

### 验收

- Go 共享向量全部通过，与 TypeScript 规范化结果和错误分类一致；
- `go list -deps ./webrtcdirect` 不出现 pion WebRTC transport 装配或本仓库 signer 实现依赖；
- 包注释明确说明“只校验 endpoint，不证明 UDP/DNS/防火墙可达”。

## 9. A07：WebRTC Direct dialer 与认证拨号

### 施工

1. `createWebRTCDirectDialer` 通过现有 `createHost` 只注入 `webRTCDirect()` transport；
2. `dialAuthenticatedWebRTCDirect` 要求独立业务 pin，合并 timeout 和 AbortSignal；
3. 使用单个严格 Direct endpoint 拨号，不接受地址数组，不启动 WebSocket fallback；
4. dial 后调用 `authenticateConnection`，比较 endpoint PeerId、期望 pin 与实际 Noise 身份；
5. 认证失败时关闭新连接；超时/取消不留下未决 dial Promise 或 RTCPeerConnection。

### 验收

- unit test 使用可控 node/connection 覆盖成功、timeout、Abort、dial reject、auth reject 和 close reject；
- 错 pin 不可获得可用 connection，且 close 已被调用；
- 测试断言传给 `node.dial` 的只是规范 Direct multiaddr。

## 10. A08：稳定错误与 `AggregateError` 诊断

### 施工

- 实现需求第 9 节的稳定 `code` 和 `stage`；
- 递归展开 `Error.cause`、`AggregateError.errors` 和普通 Error，设置最大深度与条数，防止
  循环 cause 或巨大错误树；
- 保留开发者可查看的脱敏 diagnostics，稳定控制流只使用 code/stage；
- 当上游没有稳定阶段标识时统一分类为 `ERR_WEBRTC_DIRECT_DIAL`，不用 message regex
  伪造 ICE/DTLS/Noise 精确归因。

### 验收

- 单错误、多层 cause、多分支 AggregateError、循环 cause、非 Error 抛出值都有测试；
- diagnostics 数量/长度有上限，不包含测试注入的私钥、签名和 SDP 敏感标记；
- 底层错误不再只显示空 `AggregateError`。

## 11. A09：真实 Chromium + Go 正向证据

### 施工

- 复用现有 native Go v0.49 endpoint，动态监听 `/ip4/127.0.0.1/udp/0/webrtc-direct`；
- server ready 输出实际完整 `/certhash/.../p2p/...` 地址、PeerId 和公钥；
- Browser Window 通过正式 `/webrtc-direct` 和 `/stream` API 完成拨号、认证和两条 stream；
- Playwright 解析结构化结果，断言地址 host/port/certhash/PeerId、Noise 认证公钥、
  响应 bytes 和资源清理。

### 验收

- 单次正向场景无任何自动重试即 PASS；
- 在同一浏览器基线下显式重复 20 次全部 PASS，失败一次就保留完整证据并判 FAIL；
- runner 捕获 page error、console error、browser crash 和 timeout，成功/失败都关闭所有资源。

## 12. A10：真实负向与证书轮换证据

每个场景独立启动，不共享上一场景的 connection 或 endpoint：

| 场景 | 预期 |
|---|---|
| UDP 端口错误/无服务 | `ERR_WEBRTC_DIRECT_TIMEOUT` 或可靠的 `DIAL`，不 fallback |
| certhash 修改一字节 | validate 通过但真实 dial fail closed，不自动替换 |
| address PeerId 错误 | validate/pin 阶段 fail closed |
| expected public key/PeerId 错误 | validate 或 authenticate fail closed，连接关闭 |
| DNS 不可解析 | `ERR_WEBRTC_DIRECT_RESOLVE` |
| 外部 AbortSignal | 在整体 timeout 前结束，无 pending dial |
| server 重建证书后使用旧 certhash | fail closed，旧地址不自动恢复 |
| 使用 server 新发布地址且业务 PeerId 不变 | 恢复 PASS，证明传输证书与业务身份分层 |
| server reset stream | `/stream` reject，不返回 partial success |

轮换场景必须证明：SDK 不能从 certhash 推断 expiry，也不从未认证远端自动学习新指纹。

## 13. A11：文档、Demo 与下游迁移指南

### 施工

- README 第一屏保持 V1 identity 主线，在能力列表增加 Stream/Direct 公开入口；
- TypeScript README 提供一个最小的“parse endpoint → create dialer → authenticated dial →
  read stream”示例，字段都有中文解释；
- 明确说明 WebRTC Direct 是“不经第三方交换 SDP”，不是“内部没有 SDP”；
- 写明 certhash/PeerId 分层、证书轮换、DNS/UDP/防火墙不在静态 preflight 保证内；
- 提供下游迁移清单：删除手写 stream reader/certhash parser，保留 supplier 存储、fallback、
  endpoint 发现和业务协议。

### 验收

- Demo 只 import 正式包名/subpath，不 import `typescript/src` 内部路径；
- 示例实际被 E2E 运行，不只是未编译的文档代码；
- 文档不宣称 SDK 可以静态证明公网 UDP 可达。

## 14. A12：npm/Go 消费者与发布包门禁

### 施工

1. `package.json.exports/files` 精确包含 `/stream` 和 `/webrtc-direct` 的 JS、`.d.ts` 和 map；
2. `scripts/release-check.mjs` 在空临时项目安装 `npm pack` tarball，实际 import 两个新 subpath
   并编译中文注释的消费者 fixture；
3. 验证 Go 外部消费者可 import `github.com/bsv8/bitcoin-libp2p/webrtcdirect`；
4. 正式 tarball 明确排除 integration、Playwright、browser bundle、native endpoint、测试向量中不应
   发布的私钥材料。

### 验收

- `npm pack --dry-run` 内容与 `files` 清单一致；
- Node 与 browser bundler 消费者不依赖本仓库源码目录；
- `npm ls --omit=dev` 无 missing dependency，新 subpath 运行时不从 devDependency 偶然取包。

## 15. A13：全量回归与非回归约束

按顺序执行：

```text
go test ./...
go vet ./...
(cd typescript && npm test)
./scripts/test-integration.sh
./scripts/test-browser-integration.sh
./scripts/test-demos.sh --all
(cd typescript && npm pack --dry-run)
make release-check
```

要求：

- 现有 V1 remote signer、native interop、WebSocket、WebRTC Direct 和 demo 场景全部保持 PASS；
- 普通 `go test ./...`/`npm test` 不启动 Chromium、Go 子进程或长期端口；
- 重型场景缺少 Chromium 时明确失败并提示安装命令，不退出 0 跳过；
- 任一负向场景不允许通过字符串 `grep PASS` 验收，必须解析结构化字段。

## 16. A14：版本、状态与最终证据

只在 A01–A13 全部通过后：

1. 将 `release/versions.json`、npm manifest/lockfile 和文档的双语言目标版本统一为 `0.2.0`；
2. 更新 `release/README.md`，保留 `0.1.0` 不可变说明，写明 `0.2.0` 发布、验证和部分发布
   失败处理；
3. 在本单追加“实际验收记录”，记录日期、锁定版本、A01–A14 PASS/FAIL、
   执行命令与关键负向结果；
4. 将本单和需求文档状态改为“已完成，最终验收通过”。

本单不授权自动执行 `npm publish`、创建/push Git tag 或推送远端分支。发布动作必须另行获得
明确授权。

## 17. 停止条件

遇到以下情况立即停止扩大修改，保留最小复现、上游版本、完整 cause 树和双方地址：

- `@libp2p/interface` Stream 当前公开状态/事件不足以无竞态地判定对端写端结束；
- `@libp2p/webrtc` 必须 import 私有 API 才能完成 endpoint 或 dial 封装；
- Go WebRTC Direct 要求放宽 non-extractable key、伪造 `Raw()` 或新增通用 signer purpose；
- 真实负向失败只能依赖不稳定英文 message 才能细分 ICE/DTLS/Noise；
- 要求 SDK 从未认证远端自动获取/替换 certhash。

停止后不得自行改 wire、放宽身份 pin、延长 timeout 或增加 fallback。需要修改需求边界时，
先更新需求文档并经独立确认。

## 18. 完成定义

- A01–A14 的功能和本地证据已通过；提交并形成干净工作区后再标记总体 PASS；
- TypeScript Stream 竞态、超时、取消、越界和 reset 语义稳定；
- Go/TypeScript endpoint 规则与共享向量完全一致；
- Chromium + Go WebRTC Direct 正向 20 次无隐式重试全通过；
- wrong port/certhash/PeerId/public key、DNS、Abort、轮换和 reset 按预期分类并清理；
- 无 WebSocket fallback、无未决 Promise、无浏览器/Go 子进程/端口泄漏；
- npm 正式包和 Go 模块的 `0.2.0` 本地发布门禁通过；
- 未执行未授权的外部发布、tag 或 push。

## 19. 实际验收记录（2026-08-27，审计整改后）

锁定依赖：TypeScript `libp2p 3.3.9`、`@libp2p/interface 3.3.0`、
`@libp2p/webrtc 6.0.30`、Go `go-libp2p v0.49.0`；双语言版本清单已准备为 `0.2.0`。

| 项目 | 结果 |
|---|---|
| `go test ./...`、`go vet ./...` | PASS |
| `cd typescript && npm test` | PASS，4 files / 41 tests |
| `./scripts/test-integration.sh` | PASS，SDK/native/remote-signer 矩阵 |
| `./scripts/test-browser-integration.sh` | PASS，WebSocket 20/20、Direct 20/20；DNS、精确错误分类、真实 Go reset、旧/新 certhash 轮换通过 |
| `./scripts/test-demos.sh --all` | PASS，Demo、Browser Worker、native isolation |
| `make release-check` | PASS，npm `0.2.0` tarball、两新 subpath、声明、source map、消费者编译 |

本轮针对审计整改新增并验证：

- TS/Go builder 采用独立 multiaddr component 组装，拒绝 host 注入、空白 DNS 和 IP 地址族不匹配；共享向量覆盖三类输入；
- DNS 在 dial 前经注入 resolver 解析为 `ip4/ip6`，无结果或族不匹配固定返回 `ERR_WEBRTC_DIRECT_RESOLVE/resolve`；
- 认证失败优先调用 `connection.abort`，无 abort 时 graceful close 具有 1 秒上限；迟到 connection 也会被清理；
- browser runner 对每个失败场景严格断言 `{errorCode,errorStage}`，不再接受任意非 `UNKNOWN` 错误；
- 证书轮换测试使用 test-only Go transport 保持 host key/PeerId/Noise 不变，仅替换 WebRTC cert 派生输入；旧 certhash 场景使用“新 host + 新 UDP 端口 + 新 PeerId + 旧 certhash”的混合地址，确认只改变 certhash 后 fail closed；新地址成功；Go `v0.49.0` 生产 transport 仍保持其确定性证书行为；
- 公开 `resolveWebRTCDirectEndpoint()` 对忽略 AbortSignal 的 resolver 有界返回 `ERR_WEBRTC_DIRECT_RESOLVE/resolve`；整体 dial 的 DNS resolver 超时返回 `ERR_WEBRTC_DIRECT_TIMEOUT/dial` 且不调用 `node.dial()`；
- `/stream` reader 在 EOF 与 reset 竞态下检查最终 stream 状态，真实 Go reset 返回 `ERR_STREAM_ABORTED`。

审计整改前的 31 tests、单次 WebSocket 和宽松错误判定记录作废。本次未执行 npm publish、Go
tag 创建或远端 push；这些仍需单独授权。`0.1.0` 既有产物和 tag 未修改。

本地功能与发布材料验收：A01–A14 PASS。浏览器脚本默认 `acceptance` 模式强制 WebSocket/
Direct 各至少 20 次，`smoke` 模式会明确报告实际次数，不能再把缩短运行误报为 20 次。
旧 Vitest/Playwright 开发工具链的 critical/high 已升级清零；完整 `npm audit` 剩余 7 个
生产依赖 high 已形成仅适用于 `0.2.0`、截至 2026-09-27 的限期风险接受，并由
`make release-check` 精确核对包名、数量、严重级别、依赖版本和到期日；
详见 `release/npm-audit-risk-acceptance-0.2.0.json`。本次未执行 npm publish、tag 或 push，
这些外部发布操作仍需单独授权。
