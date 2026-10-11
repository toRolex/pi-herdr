# spec43 T2 (#45) 实现笔记

## 决策
- autonomous child 先保存完整 canonical 正文、typed 终态声明、agentId/runId/sequence/eventId；新协议 eventId=runId，sequence复用 T1（1），不在 agent_start/retry 重分配。
- `.completion-<eventId>.json` 保留独立声明，exclusive create + fsync；不同载荷拒绝覆盖。`.exit` 为 atomic/fsync 旧入口桥接。结果工具支持 eventId 寻址，优先已提交正文，旧身份不明记录不伪造事件。
- 缺正文/写盘失败声明为 persistence-error（治理错误，非 T10 任务error）。不shutdown、不terminal mark、不正常回收。同一治理状态仅通知一次。provider error无正文时child明确持久化错误正文。
- child 保存 close intent 后启动 detached recycle worker；parent 离线无需ACK。worker仅回收fleet无agent的pane；核对声明身份、owner registry当前run/pane。失败记入intent，最多120次自动重试；parent session_start重放pending intent。intent retained，worker也可手动restart。
- parent close awaited，pending/error/授权持久保存。授权绑定agent/run/pane，takeover rearm单独布尔；ordinary/adoption均重试不推新事件。生产close重新检查fleet与owner registry。
- interactive自然settle继续常驻，显式agent_done可结束。旧takeover idle rearm语义保留。
- detached worker加入npm files，`npm pack --dry-run`确认包含。

## 验证
- 原生 `git merge spec43-integration`：already up to date（e3c8a84）。
- `npm run typecheck`通过。
- 清理本agent额外继承PI_HERDR_*后，用用户指定的精确env npm test命令，全量exit 0，末行 `99 passed, 0 failed`。
- `tests/spec43-t2.mjs`：稳定事件、事件引用完整读取、close失败序列化恢复重试、过期授权拒绝、缺正文不关闭、治理通知去重。
- 修复旧WIP假失败测试：run_start先于正文，真实目录占据.exit，不再普通文件可被rename覆盖。
- 真实Herdr/pi tracer（deterministic provider只替代模型边界，真实TUI/CLI/session/进程）证据见 `.agents/evidence/spec43-t2/README.md`。最新普通回收 b77703bb-38a4-427a-882a-dd38cc91fa38；故意worker失败后restart回收 00c88fbb-da27-4907-96f2-63aaf0ca45ad。parent deliveryPasses=0、ackWrites=0，child退出、pane消失、10171-byte完整结果恢复。镜像 `/tmp/spec43-notes/evidence/spec43-t2/`。

## 边界与风险
- 不声明接收端exactly-once ACK；T3负责消费协议。completion事件稳定，close重试不制造新事件，push durable sink沿用既有去重。
- Herdr CLI不存在compare-and-close原子接口；fresh fleet/registry核对和只关empty shell保守保护，但观察与close之间仍有极窄TOCTOU。pane ID实际代际不复用；不能把该策略宣称为跨恶意并发原子保证。
- fsync保证文件内容落盘；未增加目录fsync，极端断电文件系统目录元数据语义不在测试证明范围。
- 真实worker restart已验证；parent extension session_start重放入口由实现+离线suite验证，未另做完整parent TUI重启tracer。
- 保存错误sidecar本身也不可写时无法保证文件通知；child不退出，agent_done返回可见工具错误，parent缺声明治理通知兜底。
