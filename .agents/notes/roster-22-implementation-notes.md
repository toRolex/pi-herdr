# #22 T1 implementation notes

- 唯一生产 seam 保持 `registerAgents`；在 `before_agent_start` 中写 `systemPromptOptions.sections["agent-roster"]`。正文复用 `renderRoster(dirs)`，未修改 `src/agentdefs.ts`，层序、排序、名称转义、512 UTF-8 字节预算及确定性渲染契约不变。
- section 每轮覆盖赋值，天然幂等；spawn 工具不在 `selectedTools` 或有效 roster 为空时删除自己的 section key。其他扩展的 sections 不修改。
- 删除 `prepareLoadout` 与已无职责的 `renderSpawnDescription`。静态工具 description 指向 `<agent-roster>` system-prompt section。
- tests/spawn.mjs 将 roster 契约断言迁移至 before_agent_start section，并覆盖幂等、inactive 清理、section 隔离；tests/agentfiles.mjs mock 增加 `on`。
- GLOSSARY Roster 定义改为专属 system-prompt section。

## Deviations

- 无 spec/ticket 偏离。真实 pi 生命周期验证属于 spec 的层 2，本 T1 ticket 要求为注册口单元测试；未在本票扩展为 live runtime 测试。
