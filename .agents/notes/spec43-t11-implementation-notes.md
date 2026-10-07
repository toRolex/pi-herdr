# spec43 T11 (#54) 实现笔记

## 基线与 seams
- 用户要求原生 git、自己实现；不派子代理。
- `gh issue view 54 --repo toRolex/pi-herdr` 已读。T3、03/04/09 笔记已读。
- `git merge spec43-integration` 已是最新；37a357d。当前 checkout 缺 T6 implementation note；后来找到兄弟 worktree `pi-herdr.spec43-t6/.agents/notes/spec43-t6-implementation-notes.md` 并完整读取。Wait read-only/event identity 与本实现兼容；整合 tip 实际未含 T6 文件，不假称已含依赖。
- 按任务验收既有 seams：注册 result 工具、receiver-scoped durable ledger、真实 SDK/SessionManager 提交边界。

## 设计
- reread 是显式查看，不取得 delivery proof，不改变事件/账本。
- ACK 参数显式携带 eventId、agentId、runId、sequence、hostFile；与当前宿主和 durable sidecar 双重核对。
- ACK 允许 available/queued/delivered；pending 未知提交拒绝（不能撤回已返回、尚未提交的 Pull），待宿主 durable 证明后重试。ACK 不是阅读/理解证明。
- 排队 Push 复用 T3 message_end 仲裁，acked 拒绝旧 token。

## TDD 与实现
- 先新建注册工具 seam 测试；npm ci 补依赖后得到 red：reread 返回 undefined 而非原文。再逐切片实现 reread、ACK、失败/恢复和仲裁。
- 账本同步持久化 ACK，写失败不返回成功；没有内存 ACK 标记。reread 无 delivery proof，不被 confirmation hook 当作正文提交。
- 覆盖已交付状态引用、同事件复读、ACK 后复读、五身份字段拒绝、blocked/未完成拒绝、互斥参数、queued Push stale token、并发 ACK/result、pending 拒绝、ACK 写失败后仍可消费、新 run 不被旧 ACK 吞掉、旧 eventId 可复查。

## 验证与证据
- 全 suite 精确用户命令；先 unset 已枚举 PI_HERDR_* 注入变量。exit 0，末行 `99 passed, 0 failed`。typecheck / diff --check exit 0。
- `tests/spec43-t11.mjs` 真实 SDK 1.0.4 Agent/AgentSession/ExtensionRunner/SessionManager：queued Push→ACK→drain 持久普通正文 0、withdrawn receipt 1；Pull→ACK→普通 result→reread 普通正文 1、显式复读 1。重开 ledger 均 acked。provider context 和实际回执保留证据。
- `tests/spec43-t11-live.mjs` 实际 Herdr CLI、pi TUI、注册 result 工具：普通正文 1、ACK 无正文、普通查询 acked 无正文、reread 原文；terminal 可见 ACK caller declared handled 和 Explicit reread。child durable event 为固定 seed，deterministic provider 仅替代模型决策，不冒称 child 完成流程验证。
- TUI 首轮 CLI pane read text 被 JSON.parse 拒绝；已保留失败证据并清理 owned workspace。第二轮修正 text 返回适配，完整 GREEN，workspace/scratch 已清理，证据保留。
- 证据 `.agents/evidence/spec43-t11/`；复制 `/tmp/spec43-notes/evidence/spec43-t11/`。全 suite 会覆盖 T3 fixtures，回滚这些生成噪音，不混入本票。

## 限制 / Deviations
- 未知 pending ACK 拒绝而非冒险吞掉：已提交 durable proof 后可重试。无法撤回已返回的并发 Pull；同步仲裁保证 ACK 获胜后后续普通正文为零。
- 沿用 T3 单接收宿主、单 Pi writer 信任边界。SDK append 无 fsync；不声称断电安全或跨进程锁。
- queued Push message_end 撤销模型上下文/磁盘正文；不撤回可能已经由 message_start 展示的历史 UI 曝光。
- T6 不在实际 integration tip；不擅自合入其他未授权分支。已读其 sibling notes 并记录。

