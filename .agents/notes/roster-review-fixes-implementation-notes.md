# Roster 双轴 review 修复

## 范围与 seam

输入：`/tmp/roster-spec-context/{review-spec,review-standards,issue-14,orchestration}.md`。基线 integration `41ec1ee8d757ac35f99a49c03577706bb8d82aa3`。
用户要求单 implementer；不再派发。已确认 seam 为 #14 指定的 `herdr_spawn_agent.prepareLoadout` 模型可见 description；临时真实项目/全局文件 + session 注册，沿用 tests/spawn.mjs。不测试私有 renderer、不 mock pi 内部。

## 安全与 VCS

沿用协调者已完成的 secret 安全门与此 WT 的 jj 接入；本地 Git/jj 身份均 rolex / torolex@163.com。新建空 @ 的父为 integration tip，describe-first 完成。只操作此 WT；main 用户 snapshot `0fde7ba22f3a4f3aaeabdd772634c64fe5a5b0ae` 不触碰；不 push/close。

## 决策与验证（持续更新）

- 先新增 escape-token 边界回归，真实 red 后最小实现；再新增 Unicode 名字回归并独立 red→green。
- session/file 同名覆盖是测试缺口，不是运行时优先级 bug；补菜单 seam 断言。项目/全局均为真实同名文件，在 session Dup 注册后断言仅一个胜方及两个败方描述缺席。
- escape 截断由原字符生成 representation token，再计 UTF-8 预算。508/507/506 前缀必须整 token 舍弃；503 前缀刚好可容纳完整 `\\u0007` + marker。仍维持 code-point 边界和恰好 512B 不加 marker。
- 名字 JSON.stringify 后只转义 U+2028/U+2029；JSON.parse 无损恢复并用原名 resolve，不 trim、不限长。
- guideline 新增行点名 herdr_spawn_agent；增加注册表面回归。
- 已安装 pi-coding-agent 1.0.2：`dist/core/extensions/types.d.ts:482` 声明 prepareLoadout，`dist/core/agent-session.js:1128,1143` 收集/调用 hook，确认最低已验证宿主。host peer 使用 `>=1.0.2`，不凭空添加宿主上限；pi-ai peer 使用宿主 dependencies 的 `^1.0.2`，约束共享 Model 类型所在兼容 1.x。两包 engines 均 `>=22.19.0`，本包同步 Node floor；不假装支持 Node20。lock 只改根元数据，未刷新无关传递依赖。

## 非阻断 precedence smell：保留理由

不提取 shared effective snapshot。resolver 的 session 命中无需读盘；roster 必须一次读取全目录并输出固定分组排序。共用 eager snapshot 会破坏 resolver fast path、增加 I/O；共用 lazy registry adapter 则为固定四层引入额外协议与 issues 生命周期，超过本次表示边界修复必要范围。file loader 已统一 project/global 同名胜方，剩余重复是 session/file/built-in 顺序。保持现有结构而非无关泛化；菜单 seam 已覆盖 project/global、session/file、file/built-in，既有 resolver tests 单独覆盖相同优先级。将来真实新增层或变更 precedence 时，再在保留 session fast path 和 unknown-type malformed issues 的前提下提取共享访问边界。此次明确关闭为接受的非阻断 smell，不宣称已消除重复。

## 测试证据

所有测试子进程删除全部 `PI_HERDR_*` 后运行；未只删除已知部分变量。npm ci 成功（0 vulnerabilities）。Node v24.19.0。

- `/tmp/roster-red-escape.log`：257/260，3 个独立 escape 边界断言失败。初次 fixture session 未清理使 deterministic 断言多失败；测试清理修正后重跑纯 red，再改产品代码。
- `/tmp/roster-green-escape.log`：260/260。
- `/tmp/roster-red-name.log`：260/262，两个名字单行/roundtrip 断言失败；先修复测试自身 parse guard 后重跑纯 red。`/tmp/roster-green-name.log`：262/262。
- `/tmp/roster-red-guideline.log`：263/264，仅新 guideline 失败；session 同名覆盖新增测试直接绿，因属于覆盖缺口，未人为制造产品 bug。
- `/tmp/roster-red-peers.log`：178 pass / 3 fail，host/pi-ai/Node 安装契约断言失败后修改 metadata。
- `/tmp/roster-final-typecheck.log`：完整 npm run typecheck exit 0。
- `/tmp/roster-final-test.log`：完整 npm test exit 0；spawn 264/264、smoke 181/181；全部原有套件运行完成。不把 wrapper 成功冒充子进程成功，逐项检查 exit status。
- 未执行 live/stress/真实 TUI，也未声明测试 Node 最低版本或旧宿主运行行为。安装契约回归属于公开 package manifest 边界，不扩展 #14 roster 唯一行为 seam。

## Deviations / pointers

- VCS 偏差：jj 0.45.1 linked WT 不支持普通 colocate init，协调者采用 `jj git init --git-repo MAIN`，共享 Git refs、独立 jj operations；因果详见 `/tmp/roster-spec-context/orchestration.md`，此任务不变更接入方式。
- 模型 fallback：协调者 #17 feature 实现因 Grok 不可用采用 gpt-6-luna medium，非配置变更；pointer 同上。此轮单 implementer 沿用派发模型，不自行 fallback。
