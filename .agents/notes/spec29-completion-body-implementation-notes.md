# #33 completion body

## Seams

用户指定：真实 JSONL（user → assistant full body → assistant agent_done toolCall-only）经注册 tool.execute，读取 completion sidecar，再经 delivery push。保持 snapshot 的 exact-last-assistant 语义不变。

## Plan

- 完成专用提取回溯最近非空正文，遇 user / 当前 agent_start 边界停止。
- done / settle / error / rearm 使用相同正文；structured 无正文仍允许。
- TDD 独立 node 回归；substrate、delivery、tsc 验证。
- ID 接口由 spec29-t38-gpt 负责。integration 基线 fd5f668，coordinator 确认当前无新 tip。

## Results

- RED：`completion-body-red.log` 实际注册 execute 拒绝 tool-only assistant，复现实证。
- GREEN：新增 completion-body node 回归，sidecar + push 全文、user/run 防陈旧、bare、structured、settle/error/rearm 均通过。
- `substrate` 91/91；`delivery` 151/151；`tsc --noEmit` exit 0（每条限制 180s）。日志 `/tmp/pi-herdr-spec29/completion-*.log`。
- 保持 `extractSessionResult` exact-last snapshot 语义；完成声明独立回溯。agent_start 以当时 JSONL entry count 固定下界，避免同一 user 下前次 run 成果泄漏。
- error sidecar 也保留 body，并用于 error push；否则 error/tool-only 最后消息仍会遮蔽正文。
- substrate 原纯文本fixture改成真实 user → text → toolCall-only 持久化顺序。
- 共享 node_modules 仅临时 symlink；交付前移除，不入提交。

## Deviations

- 审查 subagent 派发被 max_spawn_depth=3 拒绝。通知 coordinator，由 integration audit 验收。
- substrate 首轮继承 agent 环境导致 fixture 干扰；清除 PI_HERDR_* 后通过。不是代码失败。
- coordinator 确认 integration tip 仍 fd5f668（当前父），无新 tip 可 merge。ID + sidecar 由 merger 整合 t38 tip。
