# T7 SDK lifecycle research（checkout SDK 1.0.2；TUI host 1.0.4）

## 生产 seam 建议

- `agent_start` → busy；assistant `message_end` 含真实 `toolCall` → busy；无工具的最终 assistant → closing；`agent_settled` → finished。
- 最终生产策略：busy/closing/finished 全部收入 durable ParentNotifyStore，不在工具 `turn_end` dispatch；下一自然用户run的 `before_agent_start` 才以 `nextTurn + triggerTurn:false` 消费。显式 wake 独立 scoped one-shot 授权。
- **Deviation：撤销先前safe-tool turn_end seam建议。** 公共turn_end不暴露batch terminate，不能可靠保证有自然continuation；仅凭toolResults非空可能制造额外request。主agent选择全部busy hold，牺牲当run即时消费以保证不中断、不制造继续。真实terminate测试现已覆盖。
- early followUp 建议已收紧：它保护工具不被 abort，但工具之后仍会额外请求，不能用于“借已有自然 continuation”保证。
- phase 必须与 SDK busy bit 分开。final answer message_end 及 agent_end handler 期间，SDK 仍 streaming。
- 当前 busy-only `followUp` 策略能保护运行中工具，但不能保证 final answer 后不额外请求。
- 公共 `message_end` 替换只能撤正文，不能取消已选择的下一请求；不能用 T3 gate 冒称 request-level hold。不要清全队列。
- 自然新 run 使用真实 `AgentSession.prompt`。`nextTurn` 不在低层 `Agent.prompt` 或 idle `sendCustomMessage(...triggerTurn:true)` 中消费；测试必须覆盖这个差异。

## 源码定位

以下均为 checkout 的 `node_modules/@earendil-works/` 下 SDK dist，coding-agent 与 agent-core 实际 package.json 均为 **1.0.2**，`sdk-summary.json.sdkVersion`自动读取该值。安装的CLI/TUI host为1.0.4；不能把host版本写成checkout SDK版本。

| 事实 | 位置 |
|---|---|
| final assistant message_end 先于 tool execution、queue poll | pi-agent-core/dist/agent-loop.js:138-192 |
| followUp 在模型拟停止后 drain，非被动 context | pi-agent-core/dist/agent-loop.js:192-207 |
| agent_end listeners await 完才 finishRun 清 streaming | pi-agent-core/dist/agent.js:345-365,381-438 |
| agent_end 新队列又触发 continue | pi-coding-agent/dist/core/agent-session.js:1344-1414 |
| agent_settled 前才清 session run active | pi-coding-agent/dist/core/agent-session.js:671-698 |
| nextTurn 只入私有数组，无 wake | pi-coding-agent/dist/core/agent-session.js:1746-1773 |
| 自然 prompt 在 before_agent_start 后消费 nextTurn | pi-coding-agent/dist/core/agent-session.js:1552-1595 |
| nextTurn custom message 执行 message_end arbitration 再持久化 | pi-coding-agent/dist/core/agent-session.js:734-766 |

## 限制

- `message_end` 注册顺序为同宿主扩展信任边界；本策略不会精准回收已经入 followUp 的旧推送。
- closing 是完成通知调度语义，不代表整个 SDK 会停止；重试、boundary continue、人工输入可合法继续。
- finished 后显式 wake 是用户授权新请求，应独立覆盖。
- 每个 receiver 只承诺单 Pi 进程 event-loop 顺序；不声明跨进程原子性。
- nextTurn 是 SDK 内存队列；T3 durable ledger 保留未确认 token，不等同队列本身持久化。

## 实现过程

- 已完整读取 T3 host/result tests 与两份 T3 notes。
- 派独立研究子代理被 spawn-depth=3 拒绝；本 agent 直接核对 SDK。
- checkout 无 node_modules；建立忽略的 `node_modules -> ../pi-herdr/node_modules` 供真实 SDK 测试复用。
- SDK/extension docs 及 full-control、extensions examples 已读；测试计划使用未 subclass 的真实 AgentSession，避免 T3 helper 绕过 lifecycle 对 T7 的误证。
- 不修改 src；已接主 agent 的 `registerParentDelivery` + `makeDeliverySink` 第三参数 `allowCommit`。生产 handler、sink、message_end gate、ledger 与真实 ExtensionAPI binding 一起跑。
- Agent 构造显式使用 coding-agent `convertToLlm`；core 默认转换丢 custom role，不能把 core-only fixture 冒称生产 provider context。

## 最终真实验证

`node tests/spec43-t7-sdk.mjs`，10 cases；`sdk-test.log`、`sdk-summary.json` 与每例 `sdk-*-parent.jsonl` / `sdk-*-provider.json` 保存证据。

1. final assistant closing 时 SDK busy=true，故意 followUp 触发额外request（反例）。
2. agent_end handler 时仍busy，故意followUp触发第二低层run（反例）。
3. closing/finished nextTurn不request，下一Session.prompt自然消费；显式wake恰好1新request。
4. 普通SDK followUp：真实tool latch期间无request/abort；工具自然响应后仍多1request。
5. 生产controller：closing/finished hold不request；下一自然run正文各1；显式scoped订阅wake恰好1新request且subscription耗尽。
6. 生产普通工具：run仍自然2requests但通知全部hold，provider/JSONL无正文、工具无abort；下一自然用户run新增1request正文一次。
7. 生产terminate:true工具：run只有1request，通知不制造continuation，provider/JSONL无正文；下一自然用户run新增1request正文一次。
8. gate closing负例：已queue followUp只撤正文，无法撤请求；后续自然run恢复正文一次。
9. gate旧run负例：old deliveryParentRun nextTurn在新natural run被剥离；ledger available，随后natural run正文恢复一次。
10. gate策略切换：custom message_start之后切none，message_end拒正文；provider/JSONL无正文；normal恢复后消费一次。

所有拒绝均生成withdrawn receipt，不误ack delivered。证据包括真实SessionManager reopen及真正provider request messages，不是手写JSONL。

## 已提醒父agent的剩余风险

- 公共 `tool_execution_end`准确字段：`{type,toolCallId,toolName,result:any,isError,parentToolCallId?}`，`event.result.terminate === true`保留工具hint；`toolResult`消息与`turn_end.toolResults`不保留terminate。声明见 `extensions/types.d.ts:837-845`，核心 `AgentToolResult.terminate?: boolean` 见 `pi-agent-core/dist/types.d.ts:51`。工具hint不是公开batch continuation决定。
- `terminate:true` 工具batch没有自然 continuation；生产已移除safe边界，并增加真实SDK case验证没有制造request。旧 `sdk-production-tool-safe-boundary-*` 是先前设计的历史证据，不纳入当前sdk-summary，当前证据为 `sdk-production-tool-held-false/true-*`。
- `gatedHosts`首次sink注册capture boundary；生产初始化若先无boundary sink，后controlled sink可能继续旧gate。需父agent核对生产初始化顺序。
- 当前不是跨崩溃exactly-once证明；没有kill-process/掉电实验，也不声称SDK session文件fsync。
- Advisor复核建议已落实负向gate/recovery与terminate证明；生产初始化顺序由父agent核对，实际TUI完整index接线已通过。
- 环境每次运行先删所有 `HERDR*`、`PI_HERDR*`；`PI_OFFLINE=1`，空资源loader、内存settings、隔离session临时目录；finally dispose所有session并删除temp。无测试pane，无其他session改动。
