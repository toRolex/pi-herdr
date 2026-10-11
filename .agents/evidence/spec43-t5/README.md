# T5 真实 CLI/TUI 证据

成功版本：`tui-110648/`。`result.json` 保存 idle starting、busy 两个独立 queued run、gone 同 session 恢复及旧 event 查询。

- `idle.jsonl` / `busy.jsonl`：真实 child pi TUI 会话，deterministic provider。
- `terminal.json`：真实终端内容。
- `transport.jsonl`：实际 Herdr CLI 动作。
- `doctor.json`：HEALTHY。
- `cleanup.json`：workspaceGone / scratchGone / evidenceRetained 均 true。
- 父编排使用 Node 调用生产引擎；不声称父模型自主行为或外部模型质量。

历史失败尝试保留命令和 cleanup；不是验收证据。自动测试日志和 typecheck 日志因仓库 ignore 规则，仅在磁盘及 `/tmp/spec43-notes/evidence/spec43-t5/` 保存。
