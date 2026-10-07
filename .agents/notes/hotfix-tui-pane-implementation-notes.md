# TUI 输出与 pane 关闭修复记录

## 范围

用户报告 `pi-herdr delivery detect segment=sidecar→push` 日志反复覆盖 TUI，并描述输入框自动填字。用户还报告 agent 关闭 pane 后 pane 仍保留。两个症状分别调查和验证。

## 隔离

基线为 `7393ec99`。独立 jj workspace 为 `hotfix-tui-pane`。不搬动原目录的未提交改动，不关闭其他任务的 pane，不推送或发布。

## 验收检查点

每个症状都需要修复前失败复现、根因证据、修复后同一复现通过。测试与类型检查补充运行验证，不能代替运行验证。调查任务只读，实施按文件所有权分配。

## 决策

- 使用独立 jj workspace，避免 Worktrunk 的 Git 分支写入影响并行任务。
- 两个只读调查分别覆盖日志输出和 pane 生命周期。
- 实测 `debugLine` 默认写 `stderr`，六轮模拟投递确认失败把日志写进真实 pi TUI 的输入区边框和 footer。日志发生在 push 前，不能据此声称投递成功。
- 实测普通 close 第一次返回失败后，第二轮不再 close。真实 Herdr 测试 pane 的输出为 `FAIL close attempts=1 pushes=1 pane_still_listed=true pending=false error=none`。
- 比较统一关闭 helper 与分别修补两条关闭路径。选择统一 helper，避免普通与 adopted 的错误检查和接管保护再次分叉。二者的持久化 owner 仍分别处理。
- `rearm` 属于已投递完成事件。重试必须读取该事件的授权，并刷新接管标记，不能把 pending 本身当作关闭许可。
- 重复关闭本次新建的测试 pane，CLI 返回原码 `pane_not_found`。只把精确的该错误认作幂等成功，不把所有 `NOT_FOUND` 认作 pane 消失。
- 默认关闭诊断输出，但保留显式注入的 debug sink。保留 SDK 投递确认与去重，避免通过强行标记成功丢失结果。

## 验证证据

- 修复前 `pnpm test` 退出码为 0。现有测试未覆盖普通 close 失败后丢失 pending，也未约束默认 stderr 静默。
- 真实 TUI 复现 fixture 为 `/tmp/pi-herdr-hotfix-tui-repro.ts`。
- 真实 pane 复现脚本为 `/tmp/pi-herdr-hotfix-pane-repro.mjs`。只创建和关闭命名测试 session 中本次新建的 pane，未操作用户原有 pane。
- 命名测试 session 为 `pi-herdr-hotfix-tui-pane`。外层 PTY 由 `tmux -L pi-herdr-hotfix` 驱动。
- 截图现场是否存在 SDK 确认失败和 close CLI 失败，尚无现场错误证据。修复覆盖已复现机制，不声称证明全部现场原因。

## 最终结果

- `delivery.mjs` 新增回归在修复前输出 `182 passed, 18 failed`，修复后输出 `200 passed, 0 failed`。日志分别为 `/tmp/tui-pane-red.log` 和 `/tmp/tui-pane-green.log`。
- 真实 pi TUI 重跑六轮故障投递，诊断不再写入终端，输出 `HOTFIX_REPRO_DONE attempts=6 delivered=false editor_unchanged=true`。缩窄窗口后重复验证通过。画面记录为 `/tmp/pi-herdr-hotfix-tui-before.txt` 与 `/tmp/pi-herdr-hotfix-tui-after.txt`。
- 真实 Herdr pane 重跑，输出 `PASS close attempts=2 pushes=1 pane_still_listed=false pending=false error=none`。同样验证 reject，以及关闭已成功但响应丢失后重试得到实际 `pane_not_found`，都通过。
- 完整 `pnpm test` 退出码为 0，日志为 `/tmp/tui-pane-suite-final.log`。首次完整运行受 120 秒工具时限中断，扩大命令时限后完整重跑通过，不把中断算作通过。
- `pnpm typecheck` 退出码为 0。SDK 实际测试版本为 1.0.4，真实 pi TUI 版本同为 1.0.4。未单独验证 1.0.2。
- 两位独立审查均未发现可证明的新增运行缺陷，但指出 adopted 第三次持久化失败用例被跳过。删除该跳过，独立重跑 `delivery-registry-failure-sdk.mjs` 通过。完整套件通过后仅作此测试覆盖补充，未再改生产代码。
- 默认关闭过程持久化终态与待关闭意图。失败保留错误与重试状态。postclose 写失败不回滚已经持久化的 delivery，避免再次推送。
- 精确 diff 的注释复核删除三条自有逻辑叙述，保留外部 TUI 和错误码约束。未增加新的抑制规则或兼容层。
- 安装产生的 `pnpm-lock.yaml` 移至 `/tmp/pi-herdr-hotfix-generated-pnpm-lock.yaml` 保留，不纳入修复。
- 验证阶段未提交、推送、合并或发布。用户随后明确要求发布 PR，授权提交修复并推送独立 bookmark。PR 创建不包含合并或软件发版，原有用户会话尚未加载修复。

## Deviations

- 当前工具不能选择 pstack 配置中的模型名称。调查使用当前可用的 Sonnet 与 Opus。
- workspace 目录曾被会话权限阻挡。用户授权目录后继续。
