# 双语言发布说明

`release/versions.json` 是 Go 与 TypeScript 发布版本的唯一清单。`0.1.0`、`0.2.0`、
`0.3.0` 均为已发布且不可修改的历史版本；当前待发布版本是 V1.3 的 `0.3.1`，目前仅完成
本地发布准备，尚未发布到 npm、Go proxy 或远端 tag：

- npm：`bitcoin-libp2p@0.3.1`
- Go：`github.com/bsv8/bitcoin-libp2p@v0.3.1`

Go module 位于仓库根目录，因此使用标准根 tag `v0.3.1`，不能使用
`go/v0.3.1`。npm 使用无 scope 的公开包名 `bitcoin-libp2p`。本批次新增
`/webrtc-interconnect` 外部信令 WebRTC Transport，并保留 V1.2 的通用 uvarint `/stream`
分帧与 `/webrtc-direct`。正式 tarball 不包含 integration、浏览器 bundle、
原生测试 endpoint 或测试向量。

## 发布门禁

在仓库根目录执行：

```text
node ../BSV8_Engineering/e2e/bitcoin-libp2p/release-check.mjs
../BSV8_Engineering/e2e/bitcoin-libp2p/scripts/test-demos.sh --all
```

发布门禁脚本只修改本地依赖和临时目录，不创建 tag、不推送代码，也不发布 npm 包。
它需要只读访问 npm registry，以检查最新版和 audit 公告；同时验证版本清单、Go module、
npm manifest/lockfile、正式 tarball 内容、所有公开入口的运行时导入和 TypeScript 声明消费。
单元与集成测试在工程仓库 `BSV8_Engineering` 运行（见仓库 README）。

发布门禁还会检查正式 `dist` 的每一条裸模块说明符：Node.js 内置模块和相对路径之外，
必须全部是 `dependencies` 中已声明的精确版本依赖。历史问题 `webrtc-interconnect` 曾经
import 未声明的 `@libp2p/utils`，只因传递依赖被提升到顶层才能侥幸解析；该检查用于阻止
同类幽灵依赖再次进入正式包。

依赖审计策略（2026-10-19 起）：

- `@libp2p/webrtc` 把 `react-native-webrtc` 声明为非可选 peer；npm 会自动安装它，
  从而引入 React Native/Metro 工具链，这是此前所有 audit 告警的唯一来源。SDK 的浏览器与
  Node.js 路径从不加载这些包。
- 因此本仓库 `typescript/.npmrc` 设置 `omit[]=peer`，不安装该 peer；发布门禁执行
  `npm audit --omit=peer`，**要求 0 个漏洞**。
- 若将来审计不为空，门禁要求对应版本的
  `release/npm-audit-risk-acceptance-<version>.json`，并精确核对包名、数量、严重级别、
  直接依赖版本和到期日；任一字段变化都必须重新审查。不得使用 `npm audit fix --force`
  或未经互操作验证的 overrides 隐藏告警。
- `0.2.0`、`0.3.0`、`0.3.1` 的接受文件保留为历史记录，不再影响当前发布判定。

正式发布前还必须满足：

1. 工作区干净，发布提交已经推送到远端 `main`。
2. `npm whoami` 成功，发布账号可以发布无 scope 包。
3. npm registry 中不存在 `bitcoin-libp2p@0.3.1`。
4. 远端不存在 tag `v0.3.1`；不得修改或重建已发布的 `v0.2.0`、`v0.3.0` tag。
5. Go 与 TypeScript 按同一批次发布；任一侧不具备条件时不做部分发布。

建议在门禁全部通过后连续执行：

```text
(cd typescript && npm publish)
git tag v0.3.1
git push origin v0.3.1
```

发布后验证：

```text
npm view bitcoin-libp2p@0.3.1 version
git ls-remote --tags origin refs/tags/v0.3.1
GOPROXY=https://proxy.golang.org go list -m github.com/bsv8/bitcoin-libp2p@v0.3.1
```

若 npm 发布已成功而 Git tag 推送失败，应保留现场并立即重试 tag 推送，不能改用
另一个版本掩盖不完整批次。
