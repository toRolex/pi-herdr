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

## Deviations

- 原实施范围仅 Standards 三项；后续协调者追加生产 `registerDelivery` finished-parent 仲裁 must-fix，因此按最小范围加入 parent controller wiring 与 SDK 公共入口回归。
- 未改 child retry/error grace：SDK 实际 `agent_settled` 信号在 prompt/retry/continuation 循环最终结束后发出，且 finding 已撤回；为避免对有效重试契约做无依据调整，保留原实现。
