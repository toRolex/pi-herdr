# spec43 T7 (#50)

## 计划与因果
- 独立 sol 子代理验证真实 SDK 边界、provider 请求及自然 run；主线实现宿主接收策略与有限 wake 订阅。
- 使用原生 git（用户明确指定）。已有整合基线含 T3 公共 message_end 仲裁；不得以入队时 busy 位作为提交许可。
- 初步方案：receiver session sidecar 保存待交付正文、unread 与订阅。settings 仅提供授权（notifications），不是订阅容器。订阅必须显式、限匹配范围、TTL 与 one-shot，支持撤销；恢复从磁盘加载。
- TDD：新增状态/订阅测试先红，再生产实现，再真实 SDK/TUI 证据。

## 实现迭代
- receiver session `.herdr-parent-notify.json` 原子 fsync+rename 保存待交付消息和有限订阅；settings.notifications 只授权，不暗建 subscription。TTL 最多一小时、AND scope（agent/run/event）、one-shot、撤销；quiet/none 返回 policy-conflict。
- busy 时只持久保存，不使用 followUp。assistant `message_end` 无 toolCall 进入 closing，先于finished。自然 `before_agent_start` 进入新 UUID run，发 nextTurn，不另起请求。
- SDK研究发现 toolResults 非空不能证明自然continuation：terminate:true batch仍有toolResults，但不会自然发下一请求；公共turn_end不暴露terminate。所以最终收紧为所有busy事件留下一自然run，绝不以tool完成触发额外request（验收未要求同run即时消费）。舍弃早期tool turn_end steer方案。
- T3 `message_end` 公共 gate 再检查 receiver phase/run/policy/TTL；拒绝正文则 defer queued token、精准撤回旧消息正文，下一自然run重新提交；不清无关SDK队列。
- explicit wake 只匹配 completion kinds；持久消费授权在dispatch之前，避免crash重复wake。无eventId通知用receiver-owned notice identity，不能伪造 child run 身份。
- none 生产loop仍入 durable receiver store，只禁止dispatch；list未读从store与T3磁盘ledger计算，pull提交后自然去未读。未读终态row不被registry delivery标志隐藏。
- 全suite首次失败4项均旧smoke tool/hook精确计数，更新为新公开wake工具与parent边界。第二次遇无pi.on离线mock，保留旧adapter兼容；第三次suite绿（末行99 passed,0 failed）。清PI_HERDR_*继承变量后执行用户精确env命令。

## 最终验收
- 真实SDK（checkout 1.0.2）10case：final closing/agent_end旧followUp反例、nextTurn自然消费、普通工具不abort、生产closing/finished零自动请求、explicit一次wake、普通/terminate工具busy hold后自然下一轮一次正文、旧epoch/策略gate拒绝与恢复。
- 真实Herdr CLI + pi TUI host 1.0.4，完整checkout index生产接线：`tui-governance-hold-20261007-094033-66219/result.json` exit0。总provider requests=5；finished late保持1，自然run新增2（工具自然响应）、explicit新增1，oneShot consumed。owned workspace/scratch均cleanup完成。
- review修复：重复delivered completion入队前磁盘reconcile，不误消耗subscription；所有terminal paths统一补agent/run/sequence；gate boundary读取dynamic WeakMap，不被首次sink绑定缺boundary劫持。
- 用户指定env npm test exit0，末行 `99 passed, 0 failed`；新增parent、wake、真实SDK均已纳入suite。typecheck exit0；diff --check exit0。测试运行改写T3证据后原生git restore，只保留T7证据。

## 明确限制
- T3 session JSONL readback无fsync，claim→append崩溃未知pending保留，不自动重发；未承诺断电安全或跨进程exactly-once。
- `message_end` gate撤正文不能取消已经由旧版本选中的followUp请求；新策略不提前排followUp，旧队列恢复仍受此宿主限制。
- SDK队列仅内存；跨进程restart若queued结果未知，账本failclosed保留待核验，不能盲重放。sidecar完整保存正文、unread、订阅供恢复，未把未知queue伪装confirmed。
- 原有T3 gate可能message_start先展示旧body；证明覆盖provider context/持久正文，不撤历史UI曝光。同宿主后续可信扩展替换是信任边界。
- one-shot订阅消耗在dispatch之前；若随后宿主unknown故障，不擅自恢复授权或制造重试wake。

## Deviations
- grok 本周额度耗尽；SDK 验证使用 pstack 审查类 sol/high。
