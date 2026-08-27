# bitcoin-libp2p 示例

这些示例展示标准 libp2p host、连接认证、业务 stream、私钥分离、浏览器 Worker 和原生互通；它们不是 SDK 的第二套运行时。所有 Hello 示例都使用 [Demo-only protocol](protocol.md)，SDK 本身不会自动注册它。

## 5 分钟路径

前置环境：Go 1.25+、Node.js 20+、npm，以及已构建的 TypeScript SDK。首次准备（测试入口不会代替这些步骤，也不会访问 npm registry）：

```text
go test ./...
npm ci --prefix typescript
npm run build --prefix typescript
npm ci --prefix examples/02-typescript-hello
npm run build --prefix examples/02-typescript-hello
```

运行 `--all` 前再准备 Remote Signer、Browser Worker、Native TypeScript 和 Chromium：

```text
npm ci --prefix examples/04-remote-signer/typescript
npm run build --prefix examples/04-remote-signer/typescript
npm ci --prefix examples/05-browser-worker-hello
npm run build --prefix examples/05-browser-worker-hello
npm run build:browser --prefix examples/05-browser-worker-hello
npm ci --prefix examples/06-native-interop/native-typescript
npm run build --prefix examples/06-native-interop/native-typescript
cd typescript && npx playwright install chromium
```

1. 阅读并运行最短的 [Go Hello](01-go-hello/README.md)：

   ```text
   go run ./examples/01-go-hello --mode server
   go run ./examples/01-go-hello --mode client --dial <从 ready.address 复制的地址> --message "hello from demo"
   ```

2. 阅读 [TypeScript Hello](02-typescript-hello/README.md)，用同一个 `ready.address` 运行 TS client，或执行四向快速验收：

   ```text
   ./scripts/test-demos.sh --quick
   ```

3. 需要私钥分离时进入 [Remote Signer Hello](04-remote-signer/README.md)；需要浏览器时进入 [Browser Worker Hello](05-browser-worker-hello/README.md)。完整矩阵（含 Chromium、native interop 和最小失败场景）使用：

   ```text
   ./scripts/test-demos.sh --all
   ```

## 学习路径

| 顺序 | 示例 | 回答的问题 |
| --- | --- | --- |
| 01 | [Go Hello](01-go-hello/README.md) | 如何用 Go SDK 创建 host、认证连接和复用两条 stream？ |
| 02 | [TypeScript Hello](02-typescript-hello/README.md) | TypeScript SDK 的同义 API 流程是什么？ |
| 03 | Cross-language | Go 和 TypeScript 是否使用同一套标准 wire？直接运行 01/02 的交叉组合即可。 |
| 04 | [Remote Signer Hello](04-remote-signer/README.md) | host 如何只持有公钥，把 typed 签名请求交给另一个进程？ |
| 05 | [Browser Worker Hello](05-browser-worker-hello/README.md) | Window 如何只持有 signer proxy，并用 WebSocket/WebRTC Direct 连接原生 Go？ |
| 06 | [Native libp2p Interop](06-native-interop/README.md) | 不安装本 SDK 的原生 libp2p 节点为何可以自然互通？ |

正式的身份、签名边界与安全说明：

- [V1 需求与协议边界](../docs/bitcoin-libp2p-v1-需求文档.md)
- [Identity profile](../docs/identity-profile-v1.md)
- [Integration test 说明](../docs/integration-tests.md)

## Cross-language 命令

先在一个终端启动 server，复制它输出的 JSON `address`、`peerId` 和 `publicKey`；再在另一个终端运行 client。两边的源码就是 01/02，没有第三套 Cross-language 实现。

TypeScript server，Go client：

```text
node examples/02-typescript-hello/dist/main.js --mode server
go run ./examples/01-go-hello --mode client --dial <TS ready.address> --message "hello from go" --expect-peer-id <TS ready.peerId> --expect-public-key <TS ready.publicKey>
```

Go server，TypeScript client：

```text
go run ./examples/01-go-hello --mode server
node examples/02-typescript-hello/dist/main.js --mode client --dial <Go ready.address> --message "hello from typescript" --expect-peer-id <Go ready.peerId> --expect-public-key <Go ready.publicKey>
```

client 的 `hello` JSON 会报告 authenticated remote `publicKey`/`peerId`、拨号地址和 `streams: 2`。业务 payload 不携带身份字段；不要用业务响应中的 PeerId/公钥替代连接认证结果。

## 运行与验收边界

`go test ./...` 和 `cd typescript && npm test` 不启动这里的子进程或浏览器。Demo E2E 只通过显式的 `scripts/test-demos.sh` 运行；测试入口只检查已准备的依赖，`--all` 的正式 SDK tarball 消费安装在临时目录且使用离线模式。找不到 Chromium 时会以非零状态明确提示 `cd typescript && npx playwright install chromium`，不会跳过。
