# TypeScript uvarint 接收队列安全整改施工单

> 状态：已完成并通过验收（2026-09-01）。
>
> 需求真值：[V1.2 uvarint Stream 分帧需求](../../docs/bitcoin-libp2p-v1.2-uvarint-stream-framing-需求文档.md)。
> 本单承接 [005 施工单](./005-bitcoin-libp2p-uvarint-stream-framing施工单.md)，只整改
> TypeScript reader 的未消费缓存，不修改 Go 实现、线上字节格式或 SSP `/ssp/1.0.0`。

## 1. 问题与目标

`readUvarintFrames` 使用单一 `message` listener 将完整 payload 暂存到 `output` 队列。
如果业务消费速度低于对端发送速度，仅限制单条 payload 大小仍可能使队列无限增长。

本单采用“达到上限前正常工作，超过上限立即失败”的策略，不调用 `stream.pause()`/
`stream.resume()`，避免引入新的 Stream 流控语义。

线上格式保持：

```text
uvarint(payload_byte_length) + payload
```

## 2. 公开配置与稳定错误

`UvarintFramingOptions` 在 `readUvarintFrames` 创建时读取一次：

| 字段 | 默认值 | 中文含义 |
|---|---:|---|
| `maxInboundFrameBytes` | 1 MiB | 单条 payload 的本地接收上限 |
| `maxBufferedBytes` | 4 MiB | raw 输入、部分前缀/ payload、未消费 payload 的总字节上限 |
| `maxBufferedFrames` | 1024 | 已完成但尚未交给业务的帧数上限 |
| `signal` | 未设置 | 长期读取的取消信号 |
| `abortStreamOnError` | `true` | framing、缓存或 Stream 错误时是否 abort |

两个缓存上限只用于本地内存安全检查，不进入 frame、不发送给对端、不握手、不协商。

新增稳定错误码：

```text
ERR_FRAME_BUFFER_FULL
中文：未消费字节或已完成未消费帧数超过本地 reader 上限
```

超过 `maxBufferedBytes` 或 `maxBufferedFrames` 时，reader 必须停止解析、清空 output/raw
缓冲、拒绝所有等待中的 `next()`，移除 listener，并按 `abortStreamOnError` 默认 abort。
不得发送额外业务错误包。

## 3. 实施边界

- 接收 chunk 在复制进入内部 raw buffer 前检查累计容量；
- payload 分配前继续检查 `maxInboundFrameBytes`，并在完成帧加入 output 前检查帧数上限；
- 累计字节统计 raw 输入、部分前缀、部分 payload 和已完成但未消费的 payload；
- output、waiter、raw buffer、AbortSignal 和 EOF/错误清理沿用同一终止路径；
- 不增加第二条 async iterator/message 消费路径，不改变 `readStreamToEnd`；
- 不改变 `encodeUvarintFrame`、Go `streamio.UvarintFramer` 或 SSP 责任边界。

## 4. 测试与验收

`typescript/test/stream-framing.test.ts` 至少覆盖：

- 累计字节达到上限成功，超过 1 字节返回 `ERR_FRAME_BUFFER_FULL`；
- 已排队帧数达到上限成功，超过上限失败；
- 连续零长度帧和大量合法小帧不能无限增长；
- 超限后 listener、waiter、output/raw buffer 全部清理；
- 默认调用一次 `stream.abort()`，`abortStreamOnError: false` 不主动 abort；
- options 在 reader 创建时快照，后续修改不影响行为；
- `maxBufferedBytes/maxBufferedFrames` 传入 0、负数、NaN 或非整数时，在创建 reader 时同步抛出 `RangeError`；
- 正常 EOF、截断、reset、取消和底层错误不回归。

验收命令：

```text
(cd typescript && npm test)
node scripts/test-framing-integration.mjs
./scripts/test-integration.sh
./scripts/test-browser-integration.sh
./scripts/test-demos.sh --all
make release-check
```

本单通过后，V1.2 需求状态可以恢复为“已实施并通过验收”；`0.3.0` 仍需在提交、推送和
工作区干净后，按发布说明单独执行正式发布。
