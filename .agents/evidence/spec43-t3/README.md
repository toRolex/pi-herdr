# spec43 T3 证据

- `host-sdk.json`：真实SDK/SessionManager queue研究与公共message_end gate能力；async gate被await，旧正文在provider采样与磁盘前撤销，无关消息保留；toolResult hook早于真实append；EISDIR内存/磁盘分叉。
- `ledger.json`：共享状态机、receiver隔离、unknown不超时释放、legacy pending迁移与变正文format回归、Read不消费、明确not-submitted与unknown分离。
- `result-sdk.json`：真实注册工具+ExtensionRunner+AgentSession+SessionManager+Agent loop。deterministic provider替代模型生成，截获实际请求context。五case全部宿主正文message=1，完成后provider context正文message=1。
- `result-*-parent.jsonl` / `result-*-provider.json`：实际磁盘原文与实际请求快照。正文按message.content计数，不把details metadata再次算作模型正文。
- `test-final.log` / `typecheck.log`：最终全套执行。精确env npm test前先unset额外继承PI_HERDR_*，避免child侧测试污染。

## 崩溃边界

已验证SDK接受未提交、await gate边界、tool result提交前/后事实、实际EISDIR branch-only失败、toolResult落盘但ledger ACK失败后凭磁盘修复、新SessionManager reopen。未执行kill-process故障注入，不宣称跨崩溃exactly-once。claim后append前未知pending不重发，可能需要显式人工核对。SDK无fsync；不证明断电安全。公共gate可能晚于UI message_start，不撤回UI历史曝光。单receiver单writer边界。

临时测试目录删除前已复制实际parent JSONL/provider快照；未启动/清理任何真实pane，未触碰用户session。
