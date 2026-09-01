# bitcoin-libp2p V1.2 uvarint Stream 分帧需求

> 状态：已实施并通过验收（2026-09-01）。
>
> 本文是 V1.2 新增公开能力的长期需求真值。施工入口见
> [005 施工单](../施工单/20260901/005-bitcoin-libp2p-uvarint-stream-framing施工单.md)。
> 接收队列安全整改见 [006 施工单](../施工单/20260901/006-TypeScript-uvarint接收队列安全整改施工单.md)。
>
> V1.1 的 identity、PeerId、Noise、Identify、Yamux、Stream 半关闭和 WebRTC Direct
> 契约保持不变。本文只修订 V1.1 中“业务消息分帧完全留给下游”的边界。

## 1. 背景与问题

libp2p Stream 向应用提供可靠、有序的连续字节流，但不保留应用消息边界。
发送方一次 `Write`/`send` 的内容，接收方可能拆成多个 chunk 收到；一个接收
chunk 也可能同时包含多条应用消息。

~~~text
libp2p 底层 frame    负责 Stream 复用和传输
uvarint 应用分帧   负责恢复一条完整消息
业务 payload          由 SSP 等上层协议解码
~~~

V1.1 已提供 `readStreamToEnd`，但它的语义是“读到对端半关闭”，只适用于
一条 Stream 承载一份有限响应。SSP 类长期 Stream 需要在不关闭 Stream 的情况下
连续读写多条消息，不能使用 EOF 作为每条消息的边界。

## 2. 核心决策

V1.2 在 `bitcoin-libp2p` 内提供 Go/TypeScript 同义的通用 uvarint Stream 分帧：

~~~text
frame = uvarint(payload_byte_length) || payload
~~~

固定原则：

1. 发送方只传入 payload 原始字节；SDK 必须自动使用 `len(payload)`/
   `payload.byteLength` 计算当前报文长度；
2. 调用方不得另行传入“当前报文长度”，避免声明长度与真实字节数不一致；
3. 最大接收长度只是本地内存安全配置，创建 framer/decoder 时固定一次；
4. 最大接收长度不进入 frame、不发送给对端、不握手、不协商；
5. SDK 在根据对端声明的长度分配 payload 内存之前，必须先执行本地上限检查；
6. 分帧层只返回原始 payload，不解码 CBOR、JSON、Protobuf，不理解 Protocol ID；
7. 不引入 `uint32be` 方言、供应商 framing 配置或自动格式猜测。

## 3. 线上字节格式

| 部分 | 类型 | 中文含义 |
|---|---|---|
| `length_prefix` | 最短无符号 LEB128 | 后续 payload 的原始字节数 |
| `payload` | 原始字节 | 上层协议的一条完整消息 |

uvarint 必须：

- 与 Go `encoding/binary.PutUvarint` 的字节结果一致；
- 每字节低 7 位携带数据，最高位表示是否还有后续字节；
- 低位数据组先出现；
- 只接受最短编码，例如整数 1 必须为 `01`，`81 00` 必须拒绝。

通用 framing 允许零长度 payload，编码为 `00`。上层协议若不允许空消息，
应在自己的 Protocol Profile 中拒绝；`bitcoin-libp2p` 不代替业务协议决定该语义。

固定的基础向量：

| payload 字节数 | uvarint 十六进制 | 中文说明 |
|---:|---|---|
| 0 | `00` | 通用空 frame |
| 1 | `01` | 单字节长度 |
| 127 | `7f` | 1 字节 uvarint 上界 |
| 128 | `80 01` | 2 字节 uvarint 起点 |
| 16383 | `ff 7f` | 2 字节 uvarint 上界 |
| 16384 | `80 80 01` | 3 字节 uvarint 起点 |
| 1048576 | `80 80 40` | 1 MiB 长度 |

## 4. 本地接收上限

V1.2 固定：

~~~text
DefaultMaxInboundFrameBytes = 1048576 // 默认本地接收上限，1 MiB
~~~

它的性质是：

| 问题 | 固定结论 |
|---|---|
| 是否是当前 payload 长度 | 否；当前长度由 SDK 从 payload 自动计算 |
| 是否写入 frame | 否 |
| 是否发送给对端 | 否 |
| 是否需要协商 | 否 |
| 何时配置 | 创建 framer/decoder 时一次 |
| 何时检查 | 收到 uvarint 后、分配 payload 内存前 |

不传配置时使用 1 MiB 安全默认值。确有其他协议需求时，可在 framer/decoder
初始化时显式覆盖一次。不提供每条消息传入最大长度的 API。

## 5. Go 公开语义

Go 新增 `streamio` package，面向 `io.ReadWriter`，不依赖具体业务协议：

~~~go
const DefaultMaxInboundFrameBytes = 1 << 20 // 默认本地接收上限

type UvarintFramer struct { /* 内部读写状态 */ }
type UvarintFramerOption func(*uvarintFramerConfig) error

func WithMaxInboundFrameBytes(max int) UvarintFramerOption // 初始化时覆盖一次本地上限

func NewUvarintFramer(
    stream io.ReadWriter,
    options ...UvarintFramerOption,
) (*UvarintFramer, error)

func (framer *UvarintFramer) WriteFrame(payload []byte) error
func (framer *UvarintFramer) ReadFrame() ([]byte, error)
~~~

语义：

- `WriteFrame(payload)` 内部自动计算 `len(payload)`，不接收 length 参数；
- 一次 `WriteFrame` 必须把长度前缀和 payload 作为一个不可交错的写操作；
- 同一 framer 的并发写必须串行化，不得让两个 frame 字节交错；
- `ReadFrame()` 可在同一 Stream 上连续调用，每次只返回一个完整 payload；
- 接收端先校验 uvarint 和本地上限，再分配内存；
- 返回的 payload 不包含长度前缀，且所有权归调用方；
- `UvarintFramer` 不自动关闭、reset 或设置 deadline，Stream 生命周期仍由调用方控制；
- 同一 framer 只允许一个读消费者，不支持并发 `ReadFrame()`。

## 6. TypeScript 公开语义

TypeScript 扩展已有 `bitcoin-libp2p/stream` 子路径：

~~~ts
export const DEFAULT_MAX_INBOUND_FRAME_BYTES = 1024 * 1024;
export const DEFAULT_MAX_BUFFERED_BYTES = 4 * 1024 * 1024;
export const DEFAULT_MAX_BUFFERED_FRAMES = 1024;

export interface UvarintFramingOptions {
  maxInboundFrameBytes?: number; // 本地接收上限；默认 1 MiB
  maxBufferedBytes?: number;      // 未消费字节总上限；默认 4 MiB
  maxBufferedFrames?: number;     // 未消费完整帧数上限；默认 1024
  signal?: AbortSignal;          // 取消长期读取
  abortStreamOnError?: boolean;  // 分帧/超限错误时是否 abort；默认 true
}

export function encodeUvarintFrame(payload: Uint8Array): Uint8Array;
export function writeUvarintFrame(stream: Stream, payload: Uint8Array): boolean;

export function readUvarintFrames(
  stream: Stream,
  options?: UvarintFramingOptions,
): AsyncIterable<Uint8Array>;
~~~

`maxBufferedBytes` 和 `maxBufferedFrames` 必须是正安全整数；传入 `0`、负数、`NaN` 或
非整数时，`readUvarintFrames` 在创建 reader 时同步抛出 `RangeError`。

语义：

- `encodeUvarintFrame` 和 `writeUvarintFrame` 内部使用 `payload.byteLength`；
- API 不接受当前 frame length 参数；
- `writeUvarintFrame` 将“前缀 + payload”合并为一个连续 `Uint8Array`，只调用一次
  `stream.send`，并原样返回 `send` 的 backpressure boolean；
- `readUvarintFrames` 使用单一 `message` 消费路径，不与 async iterator 重复消费字节；
- 每次迭代只产生一个完整 payload，但一个底层 chunk 可以产生多个 payload；
- 长度前缀和 payload 都必须支持任意拆包，未消费字节必须保留到后续 chunk；
- 正常远程 EOF 且没有剩余字节时迭代结束；EOF 时留有部分前缀或 payload
  必须报错；
- 取消、迭代器 `return`、EOF 和所有错误路径必须清理 listener 与内部缓冲；
- API 不设默认整个 Stream 超时，因为它用于合法的长期消息流；超时由上层通过
  `AbortSignal` 或 Stream 生命周期管理。

## 7. 错误与本地处理

Go sentinel/wrapping 和 TypeScript `StreamFrameError.code` 必须稳定区分：

| TypeScript `code` | Go 稳定分类 | 中文含义 |
|---|---|---|
| `ERR_FRAME_PREFIX` | `ErrFramePrefix` | uvarint 溢出、过长或非最短编码 |
| `ERR_FRAME_TOO_LARGE` | `ErrFrameTooLarge` | 对端声明长度超过本地接收上限 |
| `ERR_FRAME_BUFFER_FULL` | — | TypeScript 未消费字节或完整帧数量超过本地 reader 上限 |
| `ERR_FRAME_TRUNCATED` | `ErrFrameTruncated` | EOF 发生在前缀或 payload 完成之前 |
| `ERR_FRAME_STREAM` | `ErrFrameStream` | 底层 Stream 读写错误，且不属于以上分类 |

分帧错误是本地错误：

- 不生成额外网络控制包；
- 不把本地最大长度发送给对端；
- TypeScript 默认 abort 损坏或缓存超限的 Stream，Go 由调用方根据错误决定 reset/close；
- 保留底层 `cause` 供本地诊断，稳定控制流只使用上表分类。

## 8. 依赖与实现边界

当前锁定依赖已间接包含：

- Go `github.com/libp2p/go-msgio v0.3.0`，其 varint writer 使用 `binary.PutUvarint`；
- TypeScript `it-length-prefixed 11.0.1`，由 libp2p 依赖树间接引入。

实施时可包装经审计的上游实现，但必须满足本文全部语义，不得把上游默认值、
错误类或 buffer 所有权直接暴露为本 SDK 契约。如果正式源码 import 上述 package，
必须将其声明为直接依赖，不能依赖上游偶然带入的 transitive dependency。

特别必须审计：

- 非最短 uvarint 是否会被拒绝；
- 长度上限是否在内存分配之前检查；
- 写入是否处理 short write；
- 返回 payload 是否与可复用内部 buffer 共享；
- TypeScript 解码器在 EOF 时是否能区分干净结束与截断 frame。

## 9. 与 SSP 的责任边界

`bitcoin-libp2p` 不得写死 `/ssp/1.0.0`、SSP `MaxWireBytes`、CBOR 或 ActionResult。
SSP 集成层负责：

~~~text
Protocol ID              = /ssp/1.0.0
SSP MaxWireBytes         = 1048576
Stream frame             = bitcoin-libp2p uvarint framing
frame payload            = 一个完整 SSP Wire
~~~

因 SSP 上限与 SDK 默认本地接收上限同为 1 MiB，常规用法不需要传任何
最大长度配置：

~~~go
framer, _ := streamio.NewUvarintFramer(stream) // 使用默认 1 MiB 本地接收上限
_ = framer.WriteFrame(sspWire) // SDK 自动计算 len(sspWire)
wire, err := framer.ReadFrame()
~~~

上层 SSP adapter 在收到 payload 后仍必须校验：非空、完整 Wire、CBOR 规范编码、
Wire 版本和业务字段。

## 10. 测试基线

Go 和 TypeScript 必须共用 `testdata/uvarint-framing-v1.json`，至少覆盖：

- 第 3 节全部固定长度向量；
- payload 包含任意二进制、NUL、无效 UTF-8 和中文 UTF-8 字节，证明分帧不解码字符串；
- 前缀和 payload 在每个有意义位置拆成多 chunk；
- 一个 chunk 包含多个 frame，以及完整 frame 后跟下一个 frame 的部分数据；
- 恰好等于本地上限和超过上限 1 字节；
- `81 00` 等非最短编码、uvarint 溢出、前缀 EOF 和 payload EOF；
- 收到恶意大长度时未分配对应大小的内存；
- Go 并发 `WriteFrame` 不交错，TypeScript 每次 `writeUvarintFrame` 只发送一个连续 chunk；
- TypeScript iterator 取消、早退、EOF、reset 和错误路径全部清理 listener 和缓冲。
- TypeScript reader 的未消费字节和完整帧队列必须有界；达到上限允许成功，超过上限返回
  `ERR_FRAME_BUFFER_FULL`，并清理 listener、等待任务和内部缓冲。

跨语言验收必须证明：

~~~text
Go WriteFrame       → TypeScript readUvarintFrames
TypeScript write    → Go ReadFrame
两端的 frame 字节逐字节一致
两端对非法前缀和本地超限的拒绝结果一致
~~~

测试使用内存 reader/writer、fake Stream 和现有 native interop。普通单元测试不启动
Chromium 或长期网络服务。

## 11. 明确不做

- 不为所有 libp2p Protocol ID 强制自动加上 uvarint；只有显式使用 framing API 的协议受影响；
- 不修改 libp2p、Yamux、Noise、WebSocket、WebRTC Direct 或 QUIC 底层 wire；
- 不解码 CBOR、JSON、Protobuf 或任何业务 payload；
- 不定义 SSP Protocol ID、SSP 最大 Wire、请求响应或 Session 语义；
- 不发送本地最大长度，不增加 framing 握手或协商包；
- 不提供每条消息传入长度或最大长度的 API；
- 不支持 `uint32be`、自动分帧探测或按供应商选择格式；
- 不用 `readStreamToEnd` 模拟长期多消息 Stream。

## 12. 版本、发布与迁移

- V1.1/`0.2.0` 的已有 API 保持不变；
- V1.2 是新增 Go package 和 TypeScript `/stream` API 的兼容功能版本，Go/npm
  双语言的下一个目标包版本统一为 `0.3.0`；
- `readStreamToEnd` 保留，有限 request/response 仍可继续使用；
- 长期多消息协议迁移到 `UvarintFramer`/`readUvarintFrames`；
- 不自动改变已有业务 Protocol ID 的字节格式；各业务协议必须先明确冻结自己的
  Protocol Profile，再切换到新 framing API。

## 13. 完成定义

- Go/TypeScript 的 uvarint 编码对共享 fixture 逐字节一致；
- 发送 API 只传 payload，当前长度全部由 SDK 自动计算；
- 本地接收上限只在初始化时配置，不进入任何网络报文或协商；
- 解码在内存分配前拒绝超限和非法 uvarint；
- 两端正确处理拆包、粘包、多 frame、空 frame、截断 frame 和 Stream 错误；
- TypeScript 未消费队列受默认 4 MiB/1024 帧上限保护，不能因合法小 frame 持续到达而无限增长；
- Go 并发写不交错，TypeScript 长期 iterator 无 listener、Promise 或缓冲泄漏；
- `readStreamToEnd`、identity、Noise、Yamux、WebRTC Direct 与全部 V1/V1.1 测试保持通过；
- Go/npm `0.3.0` 的类型声明、中文文档、消费者编译和打包门禁通过；
- 未经单独授权，不执行 publish、tag 或 push。
