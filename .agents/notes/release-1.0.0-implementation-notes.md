# Release 1.0.0 + 安装方式切换 — implementation notes

## 任务

- 打 1.0.0（hard fork 独立版本线，起点）
- 删除已合并的两个 PR 分支（本地 + origin）
- settings.json 改为 GitHub 来源安装
- 评估是否发 npm（参照 pi-slash-anywhere）

## 已确认事实（前置诊断）

- main 领先 upstream v0.6.0 76 commits，全是本 fork 的工作 → hard fork
- `pr/widget-narrow-callout`：src/widget.ts 与 main 零差异 → 已合，可删
- `pr/watchdog-finished-check`：核心逻辑在 main src/delivery.ts:607-629 → 已合，可删
- upstream 停在 v0.6.0；fork origin = github.com/toRolex/pi-herdr
- CHANGELOG.md 顶部为 [Unreleased]；package.json 仍 0.6.0，包名 @andrewjacop/pi-herdr（原作者 scope）

## 决策

- 版本号 1.0.0（用户拍板）：fork 重新开始版本线，surface 已收敛（twelve-tool），E2E hardening 收尾
- 包名待定：原 @andrewjacop/pi-herdr 是原作者 scope，npm 发不了；需换自己的 scope
- 上游 remote（upstream）保留不动，仅历史参考

## Steps

- [x] 删 PR 分支（-D，内容已验证在 main；origin 远程分支因网络错误未删成，待网络稳定后 `git push origin --delete <branch>`）
- [x] CHANGELOG [Unreleased] → [1.0.0]（两段 Unreleased 合并，重复小节标题去重，Keep a Changelog 顺序 Added/Changed/Fixed/Removed）
- [x] package.json：1.0.0 + @torolex/pi-herdr + author/homepage/repo/bugs → toRolex
- [x] npm test 99 passed
- [x] tag v1.0.0 + push（需 `-c http.version=HTTP/1.1` 兜底，HTTP2 framing layer / SSL 间歇性故障）
- [x] settings.json：本地路径 → `git:github.com/toRolex/pi-herdr`（JSON 校验通过）
- [ ] npm 发布：`pi-herdr` 无 scope 名被无关项目占用 → 定 `@torolex/pi-herdr`；publishConfig access public 已有；当前 npm 未登录（401），登录是人工步骤
  → **用户决定暂不发布**（2026-10-03）：先用 GitHub 来源（`git:github.com/toRolex/pi-herdr`）。将来要发时只需 `npm login` + `npm publish --access public`，包名与配置已就绪

## Deviations

- 分支删除用 `-D`：`git branch -d` 拒绝（patch-id 不同，squash/rebase 式合并），人工核对内容在 main 后强删
- CHANGELOG 原有两个 `## [Unreleased]` 块，合并时用 python 脚本重组，勿重复踩
