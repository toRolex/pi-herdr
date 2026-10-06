# spec43 T1 (#44) — implementation notes

## Decisions

- `agentId` 与 `runId` 在 spawn 被接受、写入 registry 前生成 UUID；queued drain 复用记录，因此不会重新分配。`sequence` 初始为 1，作为事件引用字段预留。
- pane `name` 仍是兼容 handle；没有把 pane/session 路径当逻辑身份。
- 老 registry 缺少 agent/run 身份时，恢复仅标记 `identityReviewRequired`，不生成伪造 ID；仍执行原本的 name/kind/owner 校验和 fail-fast，保留旧记录读取路径。
- list 的 spawned rows 增加 agent/run/sequence、title、activity 与 unread（现阶段默认 0）；不增加正文或触碰 delivery/ACK 标志。title 使用 type/handle，activity 使用已有状态字段，不扩张底层 fleet schema。

## Deviations / remaining gaps

- 没有实现启动失败的独立失败事件/专门 list UI 呈现；既有 `startError` 与 projected `gone` 保持原逻辑，需后续验收补强。
- 未跑真实 Herdr 工具 demo；本地离线环境只验证 spawn 引擎。
- `npm test` 首次因依赖缺失，执行 `npm ci` 后开始运行；后续全量链在 `tests/substrate.mjs` 报 child extension fixture 的 ENOENT（`.exit`），但 `tests/spawn.mjs` 301/301、`tests/smoke.mjs` 181/181 均通过。故不能宣称全量通过。
- 旧 registry 身份迁移尚未加入独立专项测试；类型检查与已有读取测试覆盖未替代该验收。
