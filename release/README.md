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
make release-check
./scripts/test-demos.sh --all
```

`make release-check` 只修改本地依赖和临时目录，不创建 tag、不推送代码，也不发布 npm 包。
它需要只读访问 npm registry，以检查最新版和 audit 公告；同时验证版本清单、Go module、
npm manifest/lockfile、正式 tarball 内容、所有公开入口的运行时导入和 TypeScript 声明消费，
并运行 Go 与 TypeScript 测试。

发布门禁还会检查正式 `dist` 的每一条裸模块说明符：Node.js 内置模块和相对路径之外，
必须全部是 `dependencies` 中已声明的精确版本依赖。历史问题 `webrtc-interconnect` 曾经
import 未声明的 `@libp2p/utils`，只因传递依赖被提升到顶层才能侥幸解析；该检查用于阻止
同类幽灵依赖再次进入正式包。

完整 `npm audit` 报告只剩 1 个 high，已按
[0.3.1 npm audit 限期风险接受](npm-audit-risk-acceptance-0.3.1.json)形成结论：审查时
`@libp2p/webrtc` 最新稳定版是 `6.0.33`，本版本继续锁定 `6.0.31`；风险链仍位于未进入
当前浏览器/Node.js 正式运行路径的 React Native/Metro 条件依赖，剩余公告只有
`image-size` 的两个拒绝服务漏洞，修复版本 `2.0.3`+ 落在 `metro@0.87.0` 声明的
`image-size ^1.0.2` 区间之外，用 overrides 强推属于未经互操作验证的隐藏告警，已拒绝。
接受结论只对 `0.3.1` 生效并于 2026-10-26 到期。`0.3.0` 的 7 个 high 中已有 6 个被上游
公告库修复，风险面从 7 个包收敛到 1 个包。`make release-check` 会执行完整 audit，精确核对
包名、数量、严重级别、直接依赖版本和到期日。任一字段变化都必须重新审查，不得使用
`npm audit fix --force` 或未经互操作验证的 overrides 隐藏告警。

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
