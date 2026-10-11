# spec43 T1 (#44) — implementation notes

## Decisions

- `agentId` 与 `runId` 在 spawn 被接受、写入 registry 前生成 UUID；queued drain 复用记录，因此不会重新分配。`sequence` 初始为 1，作为事件引用字段预留。
- pane `name` 仍是兼容 handle；没有把 pane/session 路径当逻辑身份。
- 老 registry 缺少 agent/run 身份时，恢复仅标记 `identityReviewRequired`，不生成伪造 ID；仍执行原本的 name/kind/owner 校验和 fail-fast，保留旧记录读取路径。
- list 的 spawned rows 增加 agent/run/sequence、title、activity 与 unread（现阶段默认 0）；不增加正文或触碰 delivery/ACK 标志。title 使用 type/handle，activity 使用已有状态字段，不扩张底层 fleet schema。

## T1 收尾决策 / 验收

- Registry 以持久化 JSON 往返测试验证身份三元组；旧记录只加 `identityReviewRequired`，不制造身份。
- 启动失败仍沿用原 run 记录与 `startError`，list 投影为 `gone`，并继续返回 agentId/runId/sequence；不把失败伪装成 started。
- `FleetRow` 保留 UI 所需诊断字段；公开 list tool details.rows 映射为 #44 白名单（身份、title、activity、unread、state），正文也渲染稳定身份与概况，不返回消息正文/final/草稿或辅助字段。

## 遗留 / 验证风险

- `npm run typecheck` 通过。`tests/spawn.mjs` 初次 306/307 的唯一失败是断言序列化整个 Result（文本含“one task”），改为只检查公开 rows 后 307/307 通过；`tests/status.mjs` 新增失败启动断言通过。
- 全量 `npm test` 首次被继承的 `PI_HERDR_SESSION` 等环境变量污染；通过动态清理全部 `PI_HERDR_*` / `HERDR_*` 后，`npm run typecheck && npm test` 串行全绿。孤立验证显示 substrate 91/91。
- `node tests/spec43-t1-live.mjs` 真实 Herdr CLI 运行通过：accepted identity 可 list 发现，注入 start adapter failure 后轮询至原 run 在 list 显示 gone，registry restore 往返通过。证据在 `.agents/evidence/spec43-t1/live-summary.json`；临时 parent registry 是 demo 合成路径，不是 Pi session 文件。子 session 保留。离线另验证持久化 JSON 往返与 legacy unknown 身份。
- fleet UI 消费者兼容性仍需实际验证。sessions 不应删除。
