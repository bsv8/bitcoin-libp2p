# 双语言发布说明

`release/versions.json` 是 Go 与 TypeScript 发布版本的唯一清单。当前批次必须同时交付：

- npm：`@bsv8/bitcoin-libp2p@0.1.0`
- Go：`github.com/bsv8/bitcoin-libp2p@v0.1.0`

Go module 位于仓库根目录，因此使用标准根 tag `v0.1.0`，不能使用
`go/v0.1.0`。npm 包是 scoped public package，首次及后续发布都应显式使用
`--access public`。

## 发布门禁

在仓库根目录执行：

```text
make release-check
./scripts/test-demos.sh --all
```

`make release-check` 只做本地、可重复的检查，不创建 tag、不推送代码，也不发布
npm 包。它会验证版本清单、Go module、npm manifest/lockfile、正式 tarball 内容、
所有公开入口的运行时导入和 TypeScript 声明消费，并运行 Go 与 TypeScript 测试。

正式发布前还必须满足：

1. 工作区干净，发布提交已经推送到远端 `main`。
2. `npm whoami` 成功，发布账号具有 `@bsv8` scope 的写权限。
3. npm registry 中不存在 `@bsv8/bitcoin-libp2p@0.1.0`。
4. 远端不存在 tag `v0.1.0`。
5. Go 与 TypeScript 按同一批次发布；任一侧不具备条件时不做部分发布。

建议在门禁全部通过后连续执行：

```text
(cd typescript && npm publish --access public)
git tag v0.1.0
git push origin v0.1.0
```

发布后验证：

```text
npm view @bsv8/bitcoin-libp2p@0.1.0 version
git ls-remote --tags origin refs/tags/v0.1.0
GOPROXY=https://proxy.golang.org go list -m github.com/bsv8/bitcoin-libp2p@v0.1.0
```

若 npm 发布已成功而 Git tag 推送失败，应保留现场并立即重试 tag 推送，不能改用
另一个版本掩盖不完整批次。
