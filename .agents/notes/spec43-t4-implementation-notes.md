# spec43 T4 实现笔记

## 目标与 seams

#47：`herdr_send_agent` QueueOnly。按用户明确指定使用原生 git。
测试 seam：注册工具 execute、逻辑 session 邮箱、真实 installed SDK 与双 pi TUI。

## 决策

- 独立 `.queue-only-inbox.json` 旁挂逻辑 agent session。关闭 pane 不影响 mailbox；send 不 prompt/interrupt/resume，不使用旧 `<agent-message>` input / eventId triggerTurn 路径。
- 参数仅 target/text，不接受 completion/eventId。accepted:true + queued:true 仅在持久化成功后返回；rejected/save-failed 可见，绝不宣称已读。
- 沿用 INBOUND_LIMIT=20/10s、PENDING_CAP=8。QueueOnly overflow 拒绝新消息，不丢弃已接受旧消息；这是与 legacy oldest-drop 的有意差异，保障 accepted durability。
- 接收只在 before_agent_start（已有合法 turn）返回 custom message，来源与正文 JSON 编码，声明不构成用户授权。忙时/闲时均无主动消费或模型调用。
- 审查发现安装 SDK 的 message_end 在 session append 之前。已移除错误 ACK：agent_settled / 下次 before_agent_start / 写 mailbox 时，只按磁盘 custom_message ID reconcile；fsync session 后才移除对应消息。崩溃发生在 handoff 前消息保留；发生在 handoff 后按磁盘去重。
- mailbox 使用跨进程排他目录锁，原子 rename + file/directory fsync。可确认 ESRCH 的 dead PID 锁可恢复，活锁/未知归属锁不抢占，返回可见保存失败。锁 owner 写失败 finally 清理。
- live 寻址先按真实返回 pane 选记录，NOT_FOUND/transport unavailable 可用持久逻辑记录；防旧名称劫持。lineage 检查不依赖 Herdr 在线；直接 parent、child、peer 允许，跨代拒绝。
- 新 child 环境增加 PI_HERDR_PARENT_SESSION；旧 child 从持久 lineage 推断 parent。index 与 injected child 都注册 receiver，WeakSet 防同 API 重复。
- legacy message_agent 保留原行为；其 generationGate export 曾用于实现，最终新 send 使用持久 lineage，因此无需修改 legacy 语义。

## 验证

- red：tests/send.mjs 首次缺 send.ts，MODULE_NOT_FOUND。
- green：注册工具/offline 保存、容量/限流、写失败、下一合法 turn、持久 ACK、parent-child/peer/保留角色、旧名称抢占回归、Herdr unavailable、dead lock 恢复。
- 真实 installed SDK 与 Herdr CLI 双 TUI：busy bash 完成、idle 无额外 stream、下一用户 turn 消费；证据 `.agents/evidence/spec43-t4/`，复制 `/tmp/spec43-notes/evidence/spec43-t4/`。
- 用户精确 npm test 清 HERDR_* 命令仍未清本子代理继承的 PI_HERDR_*，复现 substrate 3 失败 + 缺 exit。先 shell unset 全部 PI_HERDR_*，再原样执行用户精确 test 命令：全绿。不是代码问题。
- integration tip 检查仍为 e3c8a84；无需额外 merge。

## 边界 / 风险

- same-OS-user 本地身份声明，非安全边界。无法保证模型不会误信正文，但来源不提升消息 role/授权。
- 若进程在 mkdir(lock) 后、owner 写入前被 SIGKILL，未知归属锁保留且可见失败，需人工确认后清理；PID 被复用也保守拒绝。不会静默丢 accepted。
- ACK 是持久 session handoff，不是模型已读/人工已读。模型/provider 失败后已交给 session 的消息仍可恢复上下文。
- deterministic provider 仅替换模型决策；SDK/TUI/CLI/tool/session 均真实，不宣称远程模型认证已验。
