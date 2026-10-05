# spec29-t34 implementation notes

## Decisions

- Seam：`messageAgent` 的公开结果（`tests/message.mjs` 注入 `agentGet`/`send`/`env`）。不断言内部调用次数。
- `target === "orchestrator"` 在 pane-id / herdr 名 / registry handle 之前解析，只读 `PI_HERDR_ORCHESTRATOR_PANE`。同名 live agent 或 spawn handle 不再抢占。
- 未设 env、父 pane `agent get` 失败：沿用现有诚实文案（`no orchestrator above you` / `the orchestrator pane (…) is gone`）。
- 不做隔代拒绝（#40），不做入站限流（#36）。
- 文案（工具 description、docs、README、GLOSSARY）同步改掉「真实名称优先于保留角色」，否则与行为矛盾。

## Deviations

- 无。
