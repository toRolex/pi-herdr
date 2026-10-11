# PR56 parent fixes — S1 / SP2 / R7

## Scope / seams

- 固定基线 9943142；续接 `/Users/rolex/Documents/Codes/githubProject/MyProject/pi-herdr.spec43-fix-parent` 的既有实现，不重做 S1/SP2/R7。
- 已确认 seams：wait 公共工具；真实 AgentSession + ExtensionRunner + SessionManager 注册交付；独立 Node 进程重启。沿用这些 seams 补故障回归。
- 本组源码仅 `src/delivery-ledger.ts`、`src/parent-delivery.ts`、`src/tools/wait.ts`；测试为 `tests/pr56-parent-wait.mjs`、`tests/pr56-parent-sdk.mjs`、既有改动 `tests/spec43-t7-sdk.mjs`。本次新修仅 ledger、parent-delivery、parent-sdk 测试与本 notes；wait 和既有 T7 实现保留。
- 不改 tools/result.ts、delivery.ts、spawn.ts、package.json 或共享依赖。SP3 wait 旧 startError 恢复和生产 spawn 接入留给 merger。
- 本次无版本控制操作、提交、merge、push、jj snapshot；最终集成及全量验证归主代理。
- 所有测试命令 `env -u HERDR_BIN_PATH`，执行环境进一步清除 HERDR/PI_HERDR；PATH 前置退出码 91 的 fake Herdr，SDK provider 离线确定性，无真实 pane 操作。

## Decisions

### 保留的实现

- **S1**：首次 discover 之前建立总 deadline；status 接收预算/用户取消合并的 AbortSignal，并以 Promise.race 限制忽略 signal 的 adapter；await 后复查取消和剩余预算。timeout=0 不查询 pane，已有 durable event 可立即返回；wait 不消费、不 ACK、不停 child。
- **SP2**：按公开 `tool_execution_end.result.terminate` 记录最终工具结果；仅完整且非全 terminate 的正常工具批次，在 `turn_end` 返回 `custom_message` drafts，由 SDK 在其已选择的自然 continuation 前持久提交。保留 `event.entries`，不设置 `continue:true`，不 send/steer/followUp 制造请求；quiet 不走该 busy seam。
- **R7**：queued 携带 process PID/incarnation。只有宿主可完整读取、无正文 commit，且 queued owner 确认 ESRCH，才恢复 available；pending 不随进程死亡或时间释放。匹配 eventId/token 的空 withdrawal receipt 是明确未提交证据，可以恢复 queued/pending；错 token 不解锁。正文持久凭据优先于撤回凭据。

### 接续复核新发现：批次内故障丢 draft

- Opus 参数顾问静态复核发现：A 成功 claim 为 pending 并放入局部 drafts 后，B 的 queue/claim 写失败使 handler throw；A draft 未返回 SDK，后续却被 pending 永久阻止。此问题不依赖多 writer、PID 复用或真实 pane。
- 先补真实 SDK `batch-claim-failure`：busy 工具期间接受 A/B，仅对 B 的 queued→pending rename 注入一次 EIO。红测在 **A 的自然下一 provider 请求正文次数 0，期望 1** 失败，不是 fixture setup 失败。
- 局部修复为逐通知隔离异常：保留并返回已成功的 drafts；失败 claim 尚未向 SDK 提交正文，因此为该 token 返回无正文、无 delivery proof 的 `deliveryHostWithdrawn` draft。SDK 持久化空 receipt 后，既有 R7 仲裁恢复 B，而不是盲目放开 unknown pending。
- 不靠第二次 ledger 写入撤回失败 claim，避免撤回写也失败时再次毒化 queued；失败通过带 eventId 的 stderr 明确告警，outbox 保留供后续自然 run 恢复。
- 补 `batch-queue-failure` 邻接覆盖：B 的 available→queued 写失败也不能丢 A；B 下一自然 run 自动投递，两条宿主正文均只 append 一次。
- 旧 T3 回归发现截断 JSONL 的错误文案为 `incomplete host JSONL tail`，不满足 `/unknown|invalid/i`，实际仍 fail-closed。给该诊断补 `host outcome unknown:`；未弱化旧断言或改变释放条件。

## Verification — 2026-10-08

### 证据与 red/green

- 旧已完成绿测可核对 `/tmp/pr56-parent-sdk-green4.log` 和仓库 `.agents/evidence/pr56-parent/sdk-summary.json`；本次未伪造/重跑旧 S1/SP2/R7 基线 red，也不把历史日志当最终集成验收。
- 本次首次局部运行目录 `/var/folders/d9/_0gbv97x6332wsrqhr4fcyj80000gn/T/pr56-parent-resume-Fi4Lty`：parent wait、parent SDK、typecheck 绿；旧 T3 在截断宿主错误分类断言红，后续脚本当时尚未跑。该现场保留。
- 新批次 claim 红测 `/tmp/pr56-parent-batch-red.bki9c4/red.log`；定向 claim 绿测 `/tmp/pr56-parent-batch-green.2Jgtnl/green.log`、queue 绿测 `/tmp/pr56-parent-batch-queue-green.Zh1tmZ/green.log`，均保留（含对应 stderr 故障诊断）。
- 修后联合验证 `/tmp/pr56-parent-resume-green.4muquU/summary.json`：以下 **6 个脚本 + typecheck 全部 exit 0**，Node v24.19.0，真实 SDK 1.0.4。

| 本组脚本 | 实际验证 |
| --- | --- |
| `pr56-parent-wait.mjs` | 总超时覆盖首次 status；忽略 abort 的 adapter 仍及时退出；lookup 中取消、await 后取消、预取消、零预算 |
| `pr56-parent-sdk.mjs` | 11 个逻辑场景、13 个独立 stage 进程：queue 丢失重开同宿主；unknown pending 跨进程不释放；normal 普通/混合工具自然 continuation；全 terminate 不制造请求；quiet 下一自然 run；匹配撤回恢复；两个批次 EIO；陈旧 unknown 和错 token 仍 pending |
| `spec43-t3-ledger.mjs` | Push/Pull 仲裁、宿主证据修复、legacy 未知保留、损坏 JSONL fail-closed、dispatch unknown 不重排 |
| `spec43-t6.mjs` | durable availability、独立 waiters、timeout/cancel 不消费事件 |
| `spec43-t7-parent.mjs` | parent policy/boundary 旧回归 |
| `spec43-t7-sdk.mjs` | 真实 SDK/SessionManager/ExtensionRunner 的旧 safe-boundary 与生产交付回归，含已更新 normal 非 terminate continuation 预期 |
| `npm run typecheck` | TypeScript 全仓编译检查通过；不是全仓测试 |

- 最新 parent SDK summary `/tmp/pr56-parent-resume-green.4muquU/evidence/pr56-parent/sdk-summary.json`；T7 SDK summary `/tmp/pr56-parent-resume-green.4muquU/evidence/spec43-t7/sdk-summary.json`。同目录 `*.mjs.log`、`typecheck.log` 为本次日志。
- 批次 A 的 provider 正文计数 `[0,1,1,1]`、B `[0,0,1,1]`：每次后续请求包含已有历史，不代表重复投递；各自 SessionManager readback 中正文 custom entry 恰好一次，工具 abort=0。
- normal 普通/混合批次当前自然下一请求含正文一次、宿主 append 一次；全 terminate 当前仅原请求一次；quiet 当前 continuation 无正文、下一自然 run 才一次。unknown pending / 错 token 两次自然 run 正文均为 0。

### evidence 保护

- 既有脚本默认写仓库 evidence。为不覆盖现场，本次运行用 Node wrapper **仅重定向 `.agents/evidence/` 下 mkdir/writeFileSync 输出**到新的 `/tmp` evidence 目录；非 evidence I/O、生产代码、真实 SDK/SessionManager/provider 与测试断言均不替换。
- 两次联合运行分别保存 evidence-before/after SHA256 清单；`evidencePreserved=true`，仓库既有全部 evidence 文件路径和内容哈希相同。没有 reset、清理或还原旧 evidence。测试自行释放的新临时 fixture 不涉及已有证据。

## Deviations / limits

- 本次复核增加两个批次故障切片、错误分类修正，未扩张业务范围；SP3 仍未在本组接入。merger 需接新测试入口、整合其它组、统一跑全量 integration。
- SDK 1.0.4 本地真实实现验证；此前 Context7 resolve 两次 fetch failed，本次没有在线文档查询，不能宣称在线文档核对通过。未验证 SDK 1.0.2、最低 Node22.19、live/TUI/Windows/multi/stress。
- SessionManager JSONL readback 不等于目录 fsync / 跨断电 exactly-once。pending 或未知宿主结果依旧保守保留；宿主 JSONL/ledger 持续不可写不能保证自动恢复。
- PID 被复用、owner 无效或无 owner 的旧 queued，缺少进程死亡确定证据时不自动释放；这是防重复优先的保守限制，不把 incarnation 字符串当作跨进程 PID 身份验证。未承诺同一宿主的多进程并发 writer。
- 测试的独立 stage fixture 临时 session 在完成后删除；summary/log 与指定定向红绿目录仍保留。不能把 summary 中这些已删除临时路径说成现存可复核 JSONL；正文次数是运行时经真实 SessionManager readback 断言，T7 导出 JSONL 位于上述新 evidence 目录。

## jj workspace 接续（覆盖上文旧阶段的版本控制限制）

- Coordinator 已接入共享 jj store 并创建 `/Users/rolex/Documents/Codes/githubProject/MyProject/pi-herdr.spec43-pr56-jj-parent`；新 @ `nlovvuzvzunr`，父 commit `99431428cd7b`。只向此 workspace 复制指定 7 个源码/tests/notes 文件，旧 worktree 不再写入。
- 复制前读取目标 4 个既有文件，确认新 tests/notes 不存在；原现场保留。Git 只读核对身份/ignore，jj 与 Git 均为 `rolex <torolex@163.com>`；无敏感文件，`.env` / `.env.*` / node_modules 已 ignore；未改任何配置。
- jj 接续阶段允许本 workspace 自动 snapshot、指定双亲 `jj new @ spec43-pr56-jj-integration` 和仅 parent bookmark；无 Git 写入、无 push、无其它 workspace/bookmark 修改。SP3 仍由 merger 处理。
- 迁移后 6 个组内脚本与 typecheck 全绿：`/tmp/pr56-parent-jj-premerge.HKMt0U/summary.json`，SDK 1.0.4，原 evidence 哈希不变。6 个源码/测试文件与旧 worktree 逐字节一致；仅新 notes 追加本阶段记录。`jj st` / `diff --summary` 恰好限定 7 文件，无新旧 T7 evidence。
- 实际执行 `jj new @ spec43-pr56-jj-integration -m 'merge(spec43): parent修复纳入当前整合基点'`，双亲为 parent 实现 `nlovvuzvzunr / 9daf6f772dd3` 与当时当前 integration `xquwxokvvzrs / 07ca3943e2e9`（已整合 lifecycle）。新 merge change `qtqxspswxnus`，自动合并无冲突；原 integration bookmark 不移动。
- 合并后同样 **6 个本组脚本 + typecheck 全绿**：`/tmp/pr56-parent-jj-postmerge.MesyC5/summary.json`，SDK 1.0.4、Node v24.19.0、真实 SDK/SessionManager + fake Herdr；evidencePreserved=true。`jj st` 无冲突；相对所纳入的 integration commit，`jj diff --summary` 仍仅指定 7 文件，无旧 evidence churn。复验后仅此 notes 补录结果，不再改源码/测试。
- 仅建立 `spec43-pr56-jj-parent` 指向本 merge change，最终 commit SHA 随本 notes snapshot 可变，由交付报告给出；无 push、无其它 bookmark 写入。未把本组 postmerge 绿测冒充全量 integration / 15 项最终闭环；SP3 和所有其它原有验收限制保持。
