# #22 T1 implementation notes

- 唯一生产 seam 保持 `registerAgents`；在 `before_agent_start` 中写 `systemPromptOptions.sections["agent-roster"]`。正文复用 `renderRoster(dirs)`，未修改 `src/agentdefs.ts`，层序、排序、名称转义、512 UTF-8 字节预算及确定性渲染契约不变。
- section 每轮覆盖赋值，天然幂等；spawn 工具不在 `selectedTools` 或有效 roster 为空时删除自己的 section key。其他扩展的 sections 不修改。
- 删除 `prepareLoadout` 与已无职责的 `renderSpawnDescription`。静态工具 description 指向 `<agent-roster>` system-prompt section。
- tests/spawn.mjs 将 roster 契约断言迁移至 before_agent_start section，并覆盖幂等、inactive 清理、section 隔离；tests/agentfiles.mjs mock 增加 `on`。
- GLOSSARY Roster 定义改为专属 system-prompt section。

## T2 层 2 验证（ticket 23）

- `tests/roster-section-live.mjs`：真实 pi CLI + deterministic provider（离线），6 场景全绿：S1 恰一份 + 核心 sections 完整；S2/S3 codemode-sim 加载顺序前/后均存活（prepareLoadout 描述覆盖被吸收、sim 自己的 section 共存）；S4 active-tools 门控（`--tools` 排除 spawn 工具 → 无孤儿菜单）；S5 跨 run 刷新（新 agent 下一 run 可见、无残留）；S6 字节确定性（同输入同字节 → 无谓缓存失效）。
- **prompt-cache 结论**：确定性渲染保证输入不变时 section 字节稳定，pi 仅在 section 变化时下发 diff；真实 provider 缓存命中率离线不可测，文档化为已知限制。
- **未覆盖**：真实 pi-tool-search 扩展端到端激活（需 live model 调用 tool_search；S4 已在同一 selectedTools 机制层证明门控契约）；manual dialog / live provider / herdr pane 交互归 TUI recipes。
- **存量 bug（与 spec 22 无关，未修）**：print 模式下 `src/index.ts:88` session_start 的 stale ctx 访问 `ctx.ui.setStatus` 导致 exit 1；转录在崩溃前已完整。建议另行提 issue。
- 证据：`.artifacts/verification/roster-section-live-<run-id>/`（summary.json + 各场景 session JSONL）。

## Deviations

- 无 spec/ticket 偏离。真实 pi 生命周期验证属于 spec 的层 2，本 T1 ticket 要求为注册口单元测试；未在本票扩展为 live runtime 测试。
