# 双语言发布说明

`release/versions.json` 是 Go 与 TypeScript 的发布版本清单。当前发布配置为 `0.3.2`：

- npm：`bitcoin-libp2p@0.3.2`，项目目录 `typescript/`。
- Go：`github.com/bsv8/bitcoin-libp2p@v0.3.2`，根 go.mod、根标签，不用 `go/v...`。
- 协议版本仍为 1。本次将已有源码中的可选流帧计量正式发布，取代消费方 `0.3.1` 的同功能本地补丁；保留已有 WebRTC 与 uvarint 协议。

已发布版本及标签不可覆盖。本文件的版本配置不代表已完成线上发布，发布后必须查询 npm 和远端标签验证。

## 发布门禁

从仓库根目录运行：

```sh
node ../BSV8_Engineering/e2e/bitcoin-libp2p/release-check.mjs
../BSV8_Engineering/e2e/bitcoin-libp2p/scripts/test-demos.sh --all
```

门禁不会创建标签、推送或发布 npm。它检查版本清单、Go module、npm manifest/lockfile、示例锁定的本地 SDK 版本、正式 tarball 内容，以及在隔离目录中所有公开入口的导入和 TypeScript 声明消费。测试唯一源码保留在工程仓 `test/bitcoin-libp2p/`，不复制进产品。

正式 `dist` 的每条非相对、非 Node.js 内置模块导入都必须是 `dependencies` 声明的精确版本；不能依赖相邻仓或传递依赖提升而掩盖缺失声明。tarball 不包含测试、集成 bundle 或原生测试 endpoint。

## 依赖审计策略

`@libp2p/webrtc` 的非可选 peer 会自动引入未被 SDK 浏览器/Node.js 路径加载的 React Native/Metro 工具链。`typescript/.npmrc` 使用 `omit[]=peer`，门禁执行 `npm audit --omit=peer`，要求 0 个漏洞。

若 audit 不为空，必须重新审查并提供当前版本的 `release/npm-audit-risk-acceptance-<version>.json`，精确核对包名、数量、严重级别、依赖版本和到期日。旧版本接受文件仅为历史，不能直接改版本号复用；不得用 `npm audit fix --force` 或未经互操作验证的 overrides 掩盖告警。

## 正式发布

1. 门禁通过，发布提交推送到远端 main，工作树干净。
2. npm 登录/发布权限可用，必要时由操作者在本机完成 2FA；不把口令或一次性验证码写入源码、日志或聊天。
3. 确认 npm `0.3.2`、远端 `v0.3.2` 尚不存在，不覆盖历史版本。
4. Go 与 TS 同批次发布；任一侧缺少条件时不做标签单边发布。

```sh
(cd typescript && npm publish --access public)
git tag -a v0.3.2 -m 'bitcoin-libp2p 0.3.2'
git push origin v0.3.2
```

若 npm 已成功而标签推送失败，保留现场并重试原标签，不另换版本掩盖不完整批次。

## 发布后核对

```sh
npm view bitcoin-libp2p@0.3.2 version
git ls-remote --tags origin refs/tags/v0.3.2
GOPROXY=https://proxy.golang.org go list -m github.com/bsv8/bitcoin-libp2p@v0.3.2
```

消费方删除旧补丁或本地 replace 前，必须更新精确依赖并验证构建及对应集成；发布 SDK 不自动证明消费方已切换。
