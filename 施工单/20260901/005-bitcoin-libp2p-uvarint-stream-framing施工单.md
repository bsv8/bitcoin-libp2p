# bitcoin-libp2p uvarint Stream 分帧施工单

> 状态：已完成（2026-09-01）。
>
> 需求真值：[V1.2 uvarint Stream 分帧需求](../../docs/bitcoin-libp2p-v1.2-uvarint-stream-framing-需求文档.md)。
>
> 本单在已验收 V1.1/`0.2.0` 上新增通用 framing API，Go/npm 双语言的
> 下一个目标包版本统一为 `0.3.0`。不倒改 `0.2.0` tag 或已发布产物。

## 0. 施工结论

一次性完成 Go/TypeScript 同义的 uvarint 长度分帧：

~~~text
调用方传入 payload
  → bitcoin-libp2p 自动计算 payload 原始字节数
    → 写入 uvarint(字节数) + payload

接收 uvarint
  → 用本地上限检查
    → 检查通过后读取完整 payload
~~~

不增加任何“发送最大长度给对端”的报文、握手或协商。不要求业务在每次
发送时传入当前长度或最大长度。

## 1. 施工边界和目录

施工后至少形成：

~~~text
streamio/framing.go
streamio/framing_test.go

typescript/src/stream/framing.ts
typescript/test/stream-framing.test.ts
typescript/src/stream/index.ts              # 导出 framing API

testdata/uvarint-framing-v1.json            # Go/TypeScript 共享向量
integration/framing-go/                      # 如现有 integration 架构需要
typescript/src/integration/framing.ts        # 如现有 integration 架构需要

docs/bitcoin-libp2p-v1.2-uvarint-stream-framing-需求文档.md
docs/integration-tests.md
README.md
typescript/README.md
release/versions.json                        # 最后阶段才从 0.2.0 升级为 0.3.0
release/README.md
~~~

可以复用现有 native interop 进程和脚本，不为同义分帧复制第二套长期
integration runner。

## 2. 施工纪律

- 以 V1.2 需求文档为唯一语义真值；
- 编码必须与 Go `encoding/binary.PutUvarint` 一致并且只接受最短结果；
- 优先审计并包装已锁定的 `go-msgio`/`it-length-prefixed`，不凭记忆重写完整
  Stream 状态机；
- 上游实现若不拒绝非最短编码、不正确处理 EOF 或暴露不符合需求的默认上限，
  必须在 SDK wrapper 中补齐；
- 正式源码 import 的 package 必须是直接依赖，不依赖 transitive dependency 偶然存在；
- 所有公开 API、options、错误码和 fixture 英文字段都必须有中文含义；
- 不修改 identity、typed signer、PeerId、Noise、Yamux、WebRTC Direct 或已有
  `readStreamToEnd` 语义；
- 不在本单中自动 publish、创建/push tag 或 push 远程。

## 3. A01：共享字节规范和 fixture

### 施工

1. 新建 `testdata/uvarint-framing-v1.json`；
2. 固定线上格式 `uvarint(payload.byteLength) || payload`；
3. 固定 0、1、127、128、16383、16384、1048576 的长度前缀；
4. 加入二进制、NUL、无效 UTF-8 和中文 UTF-8 payload；
5. 加入拆包、粘包、连续多 frame、截断和非最短 uvarint 向量；
6. invalid case 只记录稳定错误分类，不记录完整英文 error message。

### 验收

- Go/TypeScript 测试直接读取同一 JSON，不复制两套常量；
- 向量明确 length 是 payload 的原始字节数，不是字符数；
- fixture 不含业务 Protocol ID、CBOR 或 SSP 字段语义。

## 4. A02：Go `streamio.UvarintFramer`

### 施工

实现需求文档的 Go API：

~~~go
framer, err := streamio.NewUvarintFramer(stream) // 默认本地接收上限 1 MiB
err = framer.WriteFrame(payload) // 内部自动计算 len(payload)
payload, err = framer.ReadFrame()
~~~

要求：

- `WriteFrame` 只接收 payload，内部编码长度前缀；
- 串行化并发写，确保“前缀 + payload”不与其他 frame 交错；
- 正确处理 short write、底层 error 和 partial write；
- `ReadFrame` 先读并验证最短 uvarint，再检查本地上限，最后分配内存；
- 使用 `io.ReadFull` 或等价语义恢复完整 payload；
- 干净 EOF 与部分前缀/payload EOF 分类正确；
- 若使用 `go-msgio`，将其移为直接 Go 依赖，并包装稳定错误、buffer 释放和
  所有权；
- framer 不 close/reset 调用方所有的 Stream。

### 验收

- 共享 fixture 全部通过；
- `go test -race` 证明并发写不交错；
- 恶意长度在大内存分配前返回 `ErrFrameTooLarge`；
- 返回 payload 可由调用方长期保留，不被后续 `ReadFrame` 覆盖。

## 5. A03：TypeScript uvarint framing

### 施工

在 `bitcoin-libp2p/stream` 实现：

~~~ts
const sent = writeUvarintFrame(stream, payload); // 内部使用 payload.byteLength

for await (const payload of readUvarintFrames(stream)) {
  // 每次只得到一条完整 payload
}
~~~

要求：

- `encodeUvarintFrame` 返回一个连续、独立所有权的 `Uint8Array`；
- `writeUvarintFrame` 只调用一次 `stream.send`，返回其 backpressure boolean；
- `readUvarintFrames` 只注册一条 `message` 消费路径；
- chunk 到达前后的任意拆包/粘包都不得丢字节、重复消费或提前 yield；
- 长度通过 `Uint8Array.byteLength` 计算，不使用字符串 `.length`；
- 默认本地接收上限 1 MiB，options 只在 iterator 创建时读取一次；
- 最大长度不编码、不 `send`、不与对端协商；
- iterator 无默认全局 timeout，但支持 AbortSignal；
- EOF 时内部 buffer 非空必须返回 `ERR_FRAME_TRUNCATED`；
- reset/abort/迭代器早退/取消/正常 EOF 均清理 listener、等待队列和缓冲；
- 若使用 `it-length-prefixed`，将其加入精确锁定的 `dependencies`，并包装其默认
  `maxDataLength`、错误类、`Uint8ArrayList` 和非最短编码行为。

### 验收

- fake Stream 对每种结束事件顺序和拆包/粘包组合有确定测试；
- 每个错误路径都断言 `code`、listener 数量和未决 Promise 清理；
- 输入 payload/chunk 在调用后被修改，不得污染已编码或已 yield 的结果；
- 无 Node `Buffer` 专有路径，Chromium bundle 可正常构建。

## 6. A04：稳定错误与资源清理

### 施工

- Go 导出 `ErrFramePrefix`、`ErrFrameTooLarge`、`ErrFrameTruncated`、
  `ErrFrameStream`，使用 `%w` 保留 cause；
- TypeScript 导出 `StreamFrameError`，`code` 固定为
  `ERR_FRAME_PREFIX | ERR_FRAME_TOO_LARGE | ERR_FRAME_TRUNCATED | ERR_FRAME_STREAM`；
- 错误文本可诊断，但不作为稳定控制流；
- 本地上限错误不生成网络错误响应或配置报文；
- TypeScript 按 `abortStreamOnError` 决定是否 abort；Go 返回错误后不擅自 reset。

### 验收

- Go `errors.Is/As` 可同时找到稳定分类和底层错误；
- TypeScript `cause` 保留底层错误；
- 正常 EOF 不误报为 truncated，任何部分 frame EOF 不误报成功；
- 恶意连续非终止前缀在有界字节数内被拒绝。

## 7. A05：Go/TypeScript 跨语言验收

### 施工

1. 扩展现有 `scripts/test-integration.sh`；
2. Go 编码 fixture，TypeScript 解码并输出 payload 摘要；
3. TypeScript 编码同一 fixture，Go 解码并输出 payload 摘要；
4. 两端对 invalid case 输出稳定分类；
5. 增加真实 Go 原生 Stream ↔ TypeScript Stream 的连续多 frame 场景；
6. 真实场景在同一 Stream 上至少交换小 payload、包含中文字节的 payload 和
   128 KiB payload，不用 EOF 分隔每条消息。

### 验收

- 两种语言编码结果逐字节一致；
- 两种语言对 invalid case 分类一致；
- WebSocket 和 WebRTC Direct 传输至少各验证一次同义 framing；
- 验收不通过文字搜索 `PASS` 判定，必须解析结构化结果。

## 8. A06：SSP 集成边界示例

### 施工

在文档和 test-only integration 中展示：

~~~text
业务 Protocol ID：/ssp/1.0.0          # 由 SSP 定义
Stream framing：bitcoin-libp2p uvarint      # 由本 SDK 实现
本地接收上限：1 MiB                    # 使用默认，不发给对端
payload：完整 SSP Wire                    # 由 SSP 解码
~~~

要求：

- `bitcoin-libp2p` 正式源码不 import SSP package；
- 通用 framing fixture 不包含 SSP Protocol ID；
- 示例中发送 SSP Wire 只调用 `WriteFrame(sspWire)`/
  `writeUvarintFrame(stream, sspWire)`；
- 不向 API 传当前报文长度；
- 常规 SSP 用法不传最大长度，使用 SDK 默认 1 MiB 本地检查。

### 验收

- 示例能看出“通用机制属于 bitcoin-libp2p，Protocol Profile 属于 SSP”；
- 文档不声称 libp2p 底层 frame 自动等于 SSP 报文边界；
- 文档明确本地上限不进入网络。

## 9. A07：文档、公开导出和发布包

### 施工

- README 增加 uvarint framing 能力、分层说明和 Go/TypeScript 最小示例；
- TypeScript README 对每个 options 字段给出中文含义；
- `docs/integration-tests.md` 增加 framing 验收入口和结果字段说明；
- `typescript/package.json` 的现有 `./stream` export 必须包含新 API 声明和 source map；
- Go package comment 明确说明它不解码业务 payload；
- 更新消费者安装/编译门禁，从正式 tarball import framing API；
- 只在 A01–A06 通过后，才把发布清单、npm manifest/lockfile 和发布文档统一
  从 `0.2.0` 升级为 `0.3.0`。

### 验收

- npm tarball 包含新 API 的 JS、`.d.ts`、source map，不包含 testdata/integration；
- 外部 Go 消费者可 import `github.com/bsv8/bitcoin-libp2p/streamio`；
- 外部 npm 消费者可 import `bitcoin-libp2p/stream`；
- 文档不暴露上游间接依赖的内部类型。

## 10. A08：全量回归和版本门禁

按顺序执行：

~~~text
go test ./...
go test -race ./...
go vet ./...

(cd typescript && npm test)
./scripts/test-integration.sh
./scripts/test-browser-integration.sh
./scripts/test-demos.sh --all
(cd typescript && npm pack --dry-run)
make release-check
~~~

要求：

- 普通 Go/TypeScript 单元测试不启动 Chromium、外部网络或长期进程；
- 现有 identity、remote signer、native interop、WebSocket、WebRTC Direct 和 Demo 全部保持 PASS；
- 不能通过增加 timeout、自动重试、改用 EOF 分帧或忽略 non-canonical 输入
  来换取 PASS；
- release check 核对 Go/npm 目标版本、直接依赖、公开 export 和消费者编译。

## 11. 明确不施工

- 不为所有 Stream 自动加 framing，调用方必须显式使用新 API；
- 不修改已有业务 Protocol ID 或自动探测对端格式；
- 不实现 `uint32be` 分帧或 framing mode 选项；
- 不把当前 payload length 作为 API 参数；
- 不把本地最大接收长度放入 frame、握手或其他网络报文；
- 不在每次读写时重复传入最大长度；
- 不解码或验证 SSP、CBOR、JSON、Protobuf 或其他业务内容；
- 不绑定 `/ssp/1.0.0` 或任何业务 Protocol ID；
- 不取代 `readStreamToEnd` 的有限响应用途；
- 不借机改造 identity、signer、Noise、Yamux、WebRTC Direct 或连接生命周期。

## 12. 实施顺序

~~~text
A01 冻结共享字节向量
  → A02 Go streamio.UvarintFramer
    → A03 TypeScript /stream framing
      → A04 稳定错误和资源清理
        → A05 Go/TypeScript 跨语言验收
          → A06 SSP 分层集成示例
            → A07 文档、公开导出和发布包
              → A08 全量回归与版本门禁
~~~

任一步骤都不得只更新 Go 或只更新 TypeScript 就对外发布。共享 fixture、
两种语言实现、跨语言验收和中文文档必须在同一版本一起完成。

## 13. 停止条件

遇到以下情况时停止扩大修改，保留最小复现并先回到需求评审：

- 必须修改 libp2p/Yamux/transport 底层 wire 才能实现应用分帧；
- TypeScript 必须同时启动 `message` 和 async iterator 两条消费路径才能工作；
- 上游 API 无法在 EOF 时区分干净结束与截断 frame；
- 只能依赖不稳定英文 message 区分关键错误；
- 必须把本地限制发送给对端或增加新握手才能完成；
- 需要把 SSP 类型或 Protocol ID import 到 `bitcoin-libp2p` 正式包。

## 14. 完成定义

- A01–A08 全部完成并通过；
- 发送端只传 payload，SDK 自动计算并写入当前原始字节长度；
- 默认 1 MiB 本地接收上限只用于检查，未进入任何网络报文；
- 两种语言正确处理最短 uvarint、拆包、粘包、连续多 frame、EOF 和恶意长度；
- Go 并发写不交错，TypeScript iterator 无监听器或缓冲泄漏；
- Go/TypeScript 共享 fixture 和真实 native Stream 互操作通过；
- `readStreamToEnd` 与所有 V1/V1.1 能力无回归；
- Go/npm `0.3.0` 公开 API、中文字段说明、消费者编译和打包门禁通过；
- 依赖树不依赖未声明的 transitive package；
- 需求文档和本单状态只在真实验收通过后改为已完成；
- 未执行未授权的 npm publish、Go tag 创建或远程 push。

## 15. 给 SSP 和其他上层协议的简短说明

> `bitcoin-libp2p` V1.2 将提供通用 uvarint Stream 分帧。发送时只传入 payload，
> SDK 自动计算原始字节数并发送 `uvarint(length) + payload`。默认 1 MiB
> 上限只在本地接收时检查，不写入 frame、不发送给对端、不进行协商。
>
> `bitcoin-libp2p` 只提供分帧机制，不写死 SSP Protocol ID 或解码 SSP Wire。SSP
> 继续负责规定 `/ssp/1.0.0` 使用 uvarint、payload 是完整 SSP Wire，并完成
> CBOR 与业务校验。
