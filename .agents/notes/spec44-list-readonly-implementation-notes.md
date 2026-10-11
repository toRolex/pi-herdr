# #44 AC5 list 只读修复

- 公共 seam：已授权的真实 `herdr_list_agents.execute`；仅替换外部 fleet transport，Registry、ParentNotifyStore、DeliveryLedger 与 host 文件均真实。
- 以正式 `tests/spec43-t3-ledger.mjs` 扩展回归，构造三个 queued 事件：host body proof、匹配 withdrawn receipt、无证明队列。重复 list 应 unread=2，ledger bytes/hash/status、Registry 内存/磁盘及 host/outbox 均不变。
- 采用 reconcile readOnly projection；默认 reconciliation 继续持久修复，且在后续 queuePush 前立即检查磁盘 delivered/available，防止测试被 queuePush 的二次修复掩盖。

## 实测结果

- RED：正式 ledger suite 原用例通过，新公共 list 回归在 ledger bytes/SHA256 不变断言失败；实际 queued → delivered/available。
- GREEN：同一正式回归通过；两次 list unread=2，所有快照保持不变，默认 reconcile 磁盘立即持久 delivered/available，防重与 withdrawn 重试通过。
- `node --check tests/spec43-t3-ledger.mjs`、`npm run typecheck` 均 exit 0。
- 相关正式测试：spec43-t3-host、spec43-t3-result、spec43-pr56-delivery-fixes（18 cases）、spec43-pr56-delivery-sdk、delivery-durable-sdk、delivery-pending-session 均 exit 0；delivery.mjs 为 148 passed / 0 failed。
- 未跑全套与真实 TUI；本 unit 仅覆盖 #44 AC5，非全 #44 验收。测试写入的 owned evidence 已恢复到父 revision，不纳入交付。

## Deviations

- `workspace add --ignore-working-copy` 创建 owned workspace 元数据后拒绝 materialize。仅在新 owned workspace 执行 `jj new integration -m ...` 完成 materialize；旧树没有 snapshot/写入。初始未描述空 child 被 JJ 自动放弃，实际 child describe-first 且作者 identity gate PASS。
