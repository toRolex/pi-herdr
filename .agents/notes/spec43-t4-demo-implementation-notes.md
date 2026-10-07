# T4 QueueOnly demo

## 路线
- 两个真实 pi TUI、独占 Herdr workspace、explicit session files。
- Deterministic provider 仅替换模型决策；工具、CLI、before_agent_start、会话持久化均真实。
- receiver busy bash sleep 完成；busy/idle 两次 QueueOnly 消息都只在下一自然 user turn 可见；idle stream 计数保持不变。
- evidence 先捕获，再按 workspace ID + scratch receipt 清理；复制到 /tmp/spec43-notes/evidence/spec43-t4/。

## 执行结果
- 最终 TUI GREEN `run-1791328710897`；真实 SDK GREEN `sdk-1791328605890`。
- TUI 证据包括 commands/terminal、sender/receiver session、stream context、忙/闲 inbox snapshot、cleanup。
- receiver SDK 的 custom message 在 JSONL 中为 top-level `custom_message`，不是 `entry.message.customType`；验收按实际格式修正。
- 清环境同时影响 selfreport，因此 fixture 在 sender session_start 写 persisted registry 指向独占 receiver session/pane。发送路径仍为真实工具默认实现，不注入 send deps。
- 证据完整复制 /tmp；未改 src、未提交。

## Deviations
- 尝试派次级只读 SDK 审查，depth 3 上限拒绝；自行检查 SDK。
