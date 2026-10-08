# Spec 43 最终评审修复记录

## 范围与测试 seam

- 在独立 worktree `spec43-final-review-fixes` 处理 Standards reviewer 的 P2；不碰原 worktree/主仓库文件。
- 回归 seam：实际注册的 `herdr_wake_subscription` 工具返回值与提示元数据；可独立启动的 recycle worker 对 Herdr 命令的受控 transport；既有 T2/T9 真实 CLI fixture 验证 durable close。
- 保持 Spec 43 T1-T12 已验收交付、回收与唤醒契约，特别是 ACK 无关、关闭失败可重试、run/pane 所有权校验、忙碌的新 run 不误杀。

## 决策

- recycle worker 是独立 Node 进程，不能为其运行引入 TS loader 或 dev-only 运行前提。选择抽取纯 Node ESM 共享 Herdr transport，使 TS 入口与 worker 共用受控调用、Result 错误解析及版本底线；不保留第二套 CLI JSON 解析器。
- wake tool 继续使用 `unwrap` 形成统一 Result 工具返回。策略拒绝映射到既有 `VALIDATION_ERROR`，具体 `notification-policy` reason 留在 error details 中，避免添加规范外错误码且保留 normal/quiet/none 拒绝语义。
- wake tool 的模型提示会明确显式授权范围、有效期、撤销方式，以及 quiet/none 不可被订阅覆盖。

## 实现进度

- 已确认当前分支始于 `ceca717` 且目标 worktree 干净；未触碰其他 worktree。
- T2/T7 回归 seam 已先失败：共享 transport 文件缺失、wake 工具无提示元数据、wake 返回非标准错误码、正式 registerDelivery 路径未设置 parent controller。
- 抽取原生 ESM transport，扩展与 detached worker 共用二进制解析、超时/Result envelope/error-code 处理及 0.9.0 最低版本常量与校验；worker 不加载 TypeScript。统一 HERDR_BIN 与兼容的 HERDR_BIN_PATH 解析， child/delivery 两处 worker 启动改用同一解析器。
- `registerDelivery` 现在建立 durable parent controller、sink 提交边界与持久 outbox；delivery tick 先经 controller admission。新增真实 SDK 注册入口用例，finished parent 的 late completion 保持 unread，下一自然 run 才消费。
- wake 工具改用 `unwrap` + `VALIDATION_ERROR`，具体拒绝/IO原因留在 `error.details.reason`；提示包含明确授权范围、TTL、撤销和 quiet/none 不覆盖规则。
- `package.json` 发布清单显式包含 transport 声明；T2 测试检查 worker/transport/声明文件的发布 globs。`pnpm pack --dry-run` 确认包内包含 worker、transport 与 `.d.mts`。
- 已收到顾问与 Spec reviewer 复核：所谓 `agent_settled` 前 retry backoff 截断为误报并正式撤回；保留既有 error grace，不改 timer，也不宣称修复该问题。
- 全量离线 suite 与 tsc 通过。真实 T2 CLI fixture 未通过 pane 回收验收：非重启路径在 pane disappearance 超时；重启路径在 failBin 运行后读取到 `pending:false`，但失败trace显示 worker 执行过 failBin `--version`。这与 worker catch 应保留 pending 的预期矛盾，未能取得真实关闭成功证据，已向协调者报告；不将 live 收据列作通过。

## 接手修复与 main 合并

- 合并 `origin/main` 的 `abb04df`（#57）：保留显式注入诊断才输出、不重复推送终态、own/adopted 关闭前持久化与失败后可重试、精确 `pane_not_found` 幂等成功。旧 takeover/rearm 部分不恢复，等价治理通过当前 agent/run/pane 授权和新 run 所有权校验实现；旧 sidecar 字段继续忽略。
- 修复真实 T2 根因：共享 transport 改为异步后，worker 的 agent list、pane list、pane close 必须逐一 await。fleet/panes 必须有真实数组，缺失或畸形返回保留 `pending:true` 和错误，不能当成 pane 消失。
- 独立 worker seam 覆盖版本失败、close 失败、真实存在 pane 发起 close、权威空 pane 列表、不合法/缺失列表，以及 owner/run 过期的独立取消原因。成功关闭/确认消失时清除历史失败错误，不改二进制解析器优先级。
- 首次修复后真实 restart T2 已通过：`b01d46f5-763b-4f17-b6bb-5ea0e078cc6e`。失败 worker 停止后，独立 replay 真正关闭 pane，10171 字节完整结果仍可从不可变事件与 session 恢复，无 parent delivery/ACK。
- 聚焦验收通过：直接 `node_modules/.bin/tsc --noEmit`、T2、delivery 146/0、registry failure SDK、T7 parent/wake/生产 registerDelivery SDK、T12 SDK。
- 最终 worker 源码再次真实复验：自主回收 `7dc656d5-fdef-424c-a605-341584e43ba2`、版本失败后重启 `894cb542-58d1-486c-809f-238c9d20ce16` 均成功。提交精简 `worker-recovery-verification.json`，含 pane list 真空证据、关闭收据、恢复正文 hash 和零 ACK/parent delivery；完整原始 artifacts 保留本地，不提交全套路径/时间戳 churn。
- 全套 smoke 的旧 hook 数量断言需同步新增生产 parent controller：agent_start、turn_end、session_start 各增加一个。测试前隔离调用者的 `HERDR_BIN_PATH=/opt/homebrew/bin/herdr`，避免它覆盖离线 fixture 的 `HERDR_BIN`；仅运行环境清除，不修改生产 resolver 语义。
- 强模型顾问窄范围验收复核未发现 must-fix；不扩展重构。
- 标准双 parent merge commit 为 `e48a11b`，保留 `fe43996` 与 main `abb04df`。最终 `env -u HERDR_BIN_PATH node --run test` 全套通过（exit 0）；不提交 SDK 重跑产生的全套路径/时间戳变化或 lockfile。
- `spec43-integration` 的 `ceca717` 已是当前分支祖先；按交付步骤再次 merge 确认即可，无需重做其实现。

## 最终 delta：transport 退出状态治理

- Standards delta 新 P2 已用 T2 红测复现：stdout 为成功 JSON 但进程 exit 1 时，旧共享 transport 错误返回 `ok:true`，worker 因此清除 close intent。
- 仅修共享 transport：优先解析 stdout 标准错误；非零退出且 stdout 非错误时继续解析 stderr 标准错误并保持原错误码映射。非错误 JSON 只有 exit 0 才成功，其他退出状态返回统一 `VALIDATION_ERROR`，保留 exitCode/stdout/stderr，worker 继续保持 pending 和可见错误。
- 聚焦回归覆盖成功 JSON + exit 1、stdout 成功 + stderr 标准错误的优先级、信号退出未证明成功、正常 JSON + exit 0，以及 worker close 成功 JSON + exit 1 的 pending/error。直接 tsc、T2、T12 SDK 已通过；不重复运行已完成的 live 验收。
- 已以标准 merge `262509d` 合入协调者最新 integration `fc0c15e`；不修改 resolver、权限、共享依赖或其他 worktree。
- 最终 `env -u HERDR_BIN_PATH node --run test` 全套 exit 0；强模型窄复核无 must-fix。提交范围仅 transport、T2 回归与本记录，其余 evidence churn 原样保留。

## Deviations

- 原实施范围仅 Standards 三项；后续协调者追加生产 `registerDelivery` finished-parent 仲裁 must-fix，因此按最小范围加入 parent controller wiring 与 SDK 公共入口回归。
- 未改 child retry/error grace：SDK 实际 `agent_settled` 信号在 prompt/retry/continuation 循环最终结束后发出，且 finding 已撤回；为避免对有效重试契约做无依据调整，保留原实现。
