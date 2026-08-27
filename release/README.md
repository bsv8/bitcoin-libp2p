# 双语言发布说明

`release/versions.json` 是 Go 与 TypeScript 发布版本的唯一清单。`0.1.0` 是已发布且不可
修改的 V1 批次；当前 V1.1 批次的目标版本是 `0.2.0`，目前仅完成本地发布准备，尚未
发布到 npm、Go proxy 或远端 tag：

- npm：`bitcoin-libp2p@0.2.0`
- Go：`github.com/bsv8/bitcoin-libp2p@v0.2.0`

Go module 位于仓库根目录，因此使用标准根 tag `v0.2.0`，不能使用
`go/v0.2.0`。npm 使用无 scope 的公开包名 `bitcoin-libp2p`。本批次新增
`/stream` 与 `/webrtc-direct`，正式 tarball 不包含 integration、浏览器 bundle、
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

完整 `npm audit` 报告的 7 个 high 已按
[0.2.0 npm audit 限期风险接受](npm-audit-risk-acceptance-0.2.0.json)形成结论：审查时
`@libp2p/webrtc 6.0.30` 已是最新版，风险链位于未进入当前浏览器/Node.js正式运行路径的
React Native/Metro 条件依赖，且上游尚无不受公告影响的 `image-size` 版本。接受结论只对
`0.2.0` 生效并于 2026-09-27 到期。旧 Vitest/Playwright 开发工具链的 critical/high 已通过
升级到 `vitest 4.1.11` 和 `@playwright/test 1.62.1` 清零，不纳入风险接受；
`make release-check` 会执行完整 audit，精确核对包名、数量、严重级别、直接依赖版本和到期日。
任一字段变化都必须重新审查，不得使用
`npm audit fix --force` 或未经互操作验证的 overrides 隐藏告警。

正式发布前还必须满足：

1. 工作区干净，发布提交已经推送到远端 `main`。
2. `npm whoami` 成功，发布账号可以发布无 scope 包。
3. npm registry 中不存在 `bitcoin-libp2p@0.2.0`。
4. 远端不存在 tag `v0.2.0`。
5. Go 与 TypeScript 按同一批次发布；任一侧不具备条件时不做部分发布。

建议在门禁全部通过后连续执行：

```text
(cd typescript && npm publish)
git tag v0.2.0
git push origin v0.2.0
```

发布后验证：

```text
npm view bitcoin-libp2p@0.2.0 version
git ls-remote --tags origin refs/tags/v0.2.0
GOPROXY=https://proxy.golang.org go list -m github.com/bsv8/bitcoin-libp2p@v0.2.0
```

若 npm 发布已成功而 Git tag 推送失败，应保留现场并立即重试 tag 推送，不能改用
另一个版本掩盖不完整批次。
