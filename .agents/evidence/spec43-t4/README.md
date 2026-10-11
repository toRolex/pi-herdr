# T4 QueueOnly 验收

## GREEN
- 最终 `run-1791329266507/`：真实 Herdr 0.9.3 CLI + pi 1.0.4 双 TUI + 当前 checkout extension。
- 最终 `sdk-1791329261083/`：真实 installed SDK `createAgentSession`、file-backed SessionManager、DefaultResourceLoader、ModelRuntime。
- 最终实现不在 message_end ACK（SDK 该事件早于 persistence）；按磁盘 custom_message IDs 在 settled/下次合法 turn reconcile。上述最终证据已重新运行。

## 已证实
1. receiver 忙时发送，bash `sleep 5` 正常输出 `QUEUE_BUSY_TOOL_FINISHED`；工具无取消，续流未看到消息。
2. receiver settle 后消息仍持久化，模型 stream 次数不增。
3. receiver 闲时发送，等待 1.2 秒 stream 次数不增。
4. 下一合法 user turn 才在模型 context 看见两条消息。
5. user entry 后仅落盘一次 `custom_message`；持久化后 mailbox 为空。
6. 每个独占 workspace 和 scratch 已关闭删除，证据保留；每次运行都有 cleanup.json。

## 复现
测试 driver 与 TUI shell 动态删除 HERDR_*、PI_HERDR_*、PI_SESSION_FILE。全量测试遵循用户精确命令；子代理继承的 PI_HERDR_* 需先在执行 shell unset，否则 substrate mock 被污染。下列为独立 demo 命令。

```bash
env -u HERDR_ENV -u HERDR_PANE_ID -u HERDR_TAB_ID -u HERDR_WORKSPACE_ID -u HERDR_SOCKET_PATH -u HERDR_BIN_PATH -u PI_SESSION_FILE node tests/queue-only-live.mjs
env -u HERDR_ENV -u HERDR_PANE_ID -u HERDR_TAB_ID -u HERDR_WORKSPACE_ID -u HERDR_SOCKET_PATH -u HERDR_BIN_PATH -u PI_SESSION_FILE node tests/queue-only-sdk.mjs
```

## 边界
- deterministic provider 仅替换模型决策，不证明真实远程模型认证、智能效果、overlay、resume、布局。
- TUI sender fixture 写 persisted registry 指向真实 receiver pane/session；逻辑注册表寻址真实，spawn 生命周期不在本 demo 范围。
- SDK demo 直接 enqueue mailbox，专测真实 receiver SDK integration；真实 herdr_send_agent 工具调用由 TUI demo 证明。
- 早期失败目录保留：CLI pane run 空输出解析、断言误用 nested message 字段/重新解析对象 indexOf。均为 demo 错误，修正后最终 GREEN；不作为产品缺陷。
- 全部证据复制到 `/tmp/spec43-notes/evidence/spec43-t4/`。
