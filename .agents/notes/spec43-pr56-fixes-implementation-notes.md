# spec43 PR56 已验证审查修复

## 上下文

- 接续 PR https://github.com/toRolex/pi-herdr/pull/56；固定基点 `99431428cd7b3fc9937866281a8e29dc6fea7891`。
- 规格与既有 tickets：`/tmp/pi-herdr-pr56-fix-context/spec43.json`、`tickets.json`。
- 唯一修复清单：`/tmp/pi-herdr-pr56-review.Yrlzwr/review-verified.md`，4P1 + 11P2，15项。不重做已完成T1–T12。
- PR 已于本轮首先转回 draft。

## 决策与因果

- 原主目录有8项改动，原 integration worktree 有证据改动及未跟踪文件；均不搬运、不stash、不清理。本轮 `wt` 从固定基点新建 `spec43-pr56-fixes` 作为修复integration。
- 所有子代理指定 Opus。按共享源码/因果分组：生命周期 R1/R3/R4/R6；child R2/R5/R8/R10；交付 SP1/SP3/R9/R11；parent S1/SP2/R7。组内TDD，组间独立worktree。
- 生命周期与交付组都会涉及 `delivery.ts`，前者仅关闭授权部分，后者仅事件/告警部分；由专门merger整合，不在同一工作区并发写。
- 测试仅在本轮worktree写入证据。测试命令清除 `HERDR_BIN_PATH`，真实SDK允许确定性provider/fake Herdr，不得触碰真实pane或误称live验收。
- 保护快照放 `/tmp/pi-herdr-pr56-fix-context/`，记录主目录diff、status、stash与原integration diff。归档数据不删除、不重写；既有worktree不移除。
- 提交/合并/推送原PR属于用户 `/implement-spec` 明确授权的交付流程；不得force push，不自行关闭尚未合并PR所关联issues。

## 覆盖账

|组|已验证发现|状态|
|---|---|---|
|生命周期|R1、R3、R4、R6|实施中|
|child|R2、R5、R8、R10|实施中|
|交付|SP1、SP3、R9、R11|实施中|
|parent|S1、SP2、R7|实施中|

## Deviations

- 使用新的修复integration分支而非直接在既有 `spec43-integration` 上写入，以保护其已有测试证据改动。最终通过非强制推送更新同一PR head；本地原integration若脏，不强行移动或清理。

## 2026-10-08 接续

- HANDOFF/RESUME 核对修复 integration `74d2b66`、child `2fd361c`；三组保留未提交源码、测试和 evidence，仅处理剩余修复。
- PR56 只读核对仍 OPEN/draft，远程 head `9943142`，分支 `spec43-integration`。尚未推送或变更其状态。
- 全部实现代理 `model=opus`，沿用用户已认可的 `opus → sol` 映射。
- lifecycle 已补 R4 明确提交失败后 reload 重试及关闭锁负例；parent 补批次中后项 claim/queue 失败不丢前项 draft；delivery fixture 已修好，取得真实生产 SP3 no-tick 红测，helper 补 bridge/identity 保护。生产 SP3 仍由 merger 接入。
- 用户明确“使用jj优先”。原主目录已存在 jj store，身份与 Git 有效身份一致（rolex / torolex@163.com）。使用 `--ignore-working-copy` 导入 Git refs/history，未 snapshot 或修改原工作副本。
- 不在已有脏 Git linked worktree 另起 jj store。从 `74d2b66` 新建 `spec43-pr56-jj-integration` workspace，三组从 `9943142` 新建独立 jj workspace，仅复制经过限定审查的源码/tests/notes，不复制旧 evidence 重生成，不重做实现。原 Git 修复工作区全部保留。
- 首次 `workspace add` 带 `--ignore-working-copy` 后已创建目录但无法填充工作副本；检查其只含 .jj/.git，再仅在新 workspace 执行 `jj new 74d2b66` 完成填充，没有重置或删除既有现场。后续从新 workspace 创建其他 workspace 不带该标志；主目录始终不作普通 snapshot 命令。
- Context7 resolve 仍 fetch failed，未冒称在线文档通过；按本机 jj 0.46.0 help 的 `workspace add --colocate` 能力执行。
- 整合要求指针 `/tmp/pi-herdr-pr56-fix-context/RESUME-SP3-MERGER-REQUIREMENTS.md`：accepted 新 identity、终态失败队列不再执行、archive-first wait、真实 SDK 无 adapter/tick 绿测。

## 接续 Deviations

- jj 优先要求覆盖原 handoff 的原生 Git / wt 操作方案；目录由 jj 的 `workspace add --colocate` 创建，以共享既有 store，避免未知的 wt Git worktree 直接接入 jj 行为。Git 仅用于只读检查。
- 原三组 Git 工作区作为保留现场，不在交付完成后自行清理。仅新的本轮 jj implementer workspace 在确认无脏内容后按 jj 流程清理；原主目录、原 integration、归档、stash 均保留。

## 验收

- 接续起点 child 已合入回归退出 0，7 标签（8 场景）全绿，日志 `/tmp/spec43-pr56-resume-child-integration.log`；不替代后续整合验收。
- 原主目录与原 integration status、diff HEAD SHA256 均与 before 一致；8 条 stash `%H %gs` 身份/顺序一致；归档14901项哈希一致，快照 `archive-content-resume-start.json`。
- parent 六组脚本与 typecheck 绿；lifecycle 新六项与 typecheck 绿，但旧 wrapper 的零默认 transport 请求附加断言失败，请求均由 fake Herdr 拦截。delivery helper 八组与 SDK adapter 绿，默认 SP3 仍红。均非最终整合结果。

待记录整合后的全量测试与双轴复核。未执行live/TUI/win/multi/stress前不得报告其通过。

## 2026-10-08 jj merger / SP3 生产接入

- 主代理逐组明确授权后使用 jj 多父 new merge：lifecycle `07ca3943`、parent `438c64af`、delivery `7a092193`，无冲突；既有 integration notes 和各原 workspace 均保留。独立实现 change `pktsnykv`，不 native Git 写入、不 push/ready、不删除任何 workspace；最新约束覆盖上文 cleanup 计划。
- TDD 原默认真实 SDK SP3 红：`/tmp/spec43-pr56-jj-merger-SP3-red.log` 的 wait timeout/available业务断言；生产 spawn failure-point finalizer 接入后 no-adapter/no-tick绿，强化 wait之前已有 immutable archive及receiver registry、两次drain启动一次和archive字节稳定的断言。helper-adapter仅保留辅助入口，不能替代默认绿。
- accepted pendingRunId 在 worktree之前晋升，但 sidecar reset不提前；definitive failed head只消费匹配runId项，存储门成功后不同已接受FIFO head可继续，startError/startBeganAt不再让后项饿死。R4驻留明确提交拒绝仍用followupSubmitError、原head可retry，不发布SP3终态。
- 阶段化 prelaunch/creating/executor/submitting 区分错误确定性：启动前明确Result/rejection才finalize；创建回包丢失、已有executor的boot/布局错误、提交后未知异常走startOutcomeUnknown/治理诊断而不是never-started。未知结果保守禁止自动重投；显式维护重启进入新的start路径会重置该诊断，不宣称未知执行的exactly-once。
- startError保留原launch error；事件写入和registry写入错误独立为startFailurePersistenceError，catch明确报错。drain/wait存储恢复不重复启动；缺receiver registry owner不能默认为持久成功。旧无phase/no-pane/submitted=false startError按既有accepted registry兼容恢复，identityReview/pending冲突/uncertain不合成终态。
- wait先immutable archive再匹配bridge，各候选独立读取；同agent retained历史event允许旧run/sequence，current要求eventId=current run及完整identity和terminal body。valid structured body保持可等待。缺失/损坏bridge不遮挡archive，别run bridge字节保留；wait不返回正文/claim/ACK。保留parent S1 deadline/abort和timeout=0 durable lookup。
- 新切片红绿日志：`/tmp/spec43-pr56-jj-merger-{detached,FIFO,wait-restore,unknown,storage}-{red,green}.log`；FIFO身份修复后archive-first剩余红另存`...-FIFO-archive-red.log`。unknown绿首轮被fixture错误node:fs导入/1秒等待短于生产1.5秒settle阻塞，修fixture后最终联合日志才是有效绿，不能将早期中间日志当完成。
- `/tmp/pi-herdr-pr56-offline.WyKbMI/run.mjs` 安全包装逐项执行六个新增入口和TypeScript tsc --noEmit，均exit0：`/tmp/spec43-pr56-jj-merger-final-<入口名>.log`及`...-final-typecheck.log`。delivery-fixes共14组，默认delivery SDK为SP3 no-tick和R11两实际宿主持久时序。package.json原48入口保留并追加六个组入口。
- 包装清HERDR*/PI_SESSION_FILE、PATH fail-closed stub、JITI cache关闭、macOS sandbox拒真实binary/网络/原工作区及共享依赖写入。本轮不跑全量/旧smoke；全量由主代理安全包装执行，smoke真实schema子场景应如实记录skip，不算真实CLI通过。
- 当前真实SDK tests有coding-agent1.0.4与顶层core1.0.2混搭，专项绿不能称SDK默认匹配host矩阵通过。1.0.2/1.0.4一致依赖overlay实际矩阵由主代理另跑，继续作为最终验收门；未改共享依赖。parent SDK测试在新integration生成本轮`.agents/evidence/pr56-parent/sdk-summary.json`，不覆盖原保留workspace；临时fixture已释放，summary的正文计数是运行时SessionManager断言，不把已删除fixture路径宣称现存证据。
- 顾问model=opus只读窄审推动未知阶段负例；最终实际窄审结论由主代理转达：已核读范围无剩余必须修，保留当前实现、不扩大生产改动。顾问未运行测试，未独立重审result/delivery全部接入，不算最终双轴完整性验收。全量/pack/匹配SDK矩阵/最终双轴仍待主代理，不能称15项最终闭环。

### 最后窄审阻塞闭环与冻结边界

- unknown最终对账必须同时满足同agent/run/sequence/eventId的合法immutable terminal archive、有效text或可JSON.parse的structured正文、delivery为done/error、executor已退役（无pane且非close pending）。仅消费这个已完成run的匹配head，后续不同accepted run继续FIFO；损坏archive/foreign identity/无正文/损坏structured均不得解锁。
- 真实grid post-create `pane swap`失败使pane存在而startedAt缺失；合法完成+退役+reload之后，旧startBeganAt会继续命中启动中排除保护。真实业务红 `/tmp/spec43-pr56-jj-merger-grid-clock-red.log`（R2 starts 1!=2）→精准清旧clock/phase后green同前缀。没有伪造startedAt，也没有全局移除启动中筛选。reconcile registry写失败时完整rollback unknown/head/startBeganAt/phase/persistence诊断，最终脚本同时实际注入EISDIR核对rollback和reload后继续。
- retained archive要求eventId与archive寻址及其自身runId自洽，同agent但允许历史sequence不同于current；mismatched run反例 `/tmp/spec43-pr56-jj-merger-retained-consistency-{red,green}.log`。
- 默认launcher `src/tools/orchestration.ts:143–245` 先pane split后agent attach，后者失败仍可能留shell。AGENT_START_FAILED code-only不是无副作用证明；删除creating→prelaunch降级，所有创建已请求的未知Result/rejection保守对账。`/tmp/spec43-pr56-jj-merger-code-only-red.log`是真实业务红；最终unknown切片含code-only Result保护，未宣称真实CLI执行。
- accepted-failure窄统一resolver位于sessionfile：parentSession/currentOrchestratorSession/lineage.ownerSession所有存在值必须一致，缺失/冲突可观察报错；仅lineage fallback还须其registry记录同name/agent及current/pending/followup acceptance。检查接在spawn finalizer、unknown保存/对账、wait/result/delivery helper-seed之前。保留原launch error，独立记录持久诊断；无可信owner不seed、不发布failure identity/sessionPath。已有合法immutable archive纯读不强求owner修复；已知receiver registry不可读/写不能冒充新acceptance发布。
- 实际SDK receiver的wait→Pull→tick owner冲突反例 `/tmp/spec43-pr56-jj-merger-owner-conflict-{red,green}.log`；missing/conflict spawn、可信/伪lineage fallback、ownerless immutable纯读均在SP3-owner-contract受控路径绿。没有全仓重构registry，也不把合法current-owner迁移自动猜成旧owner。
- malformed structured负例此前正确JSON.parse guard已实现，因此额外采用仓库外完整副本 `/tmp/pi-herdr-pr56-body-mutation-host` 的nonempty-only mutation证明测试敏感性：`/tmp/spec43-pr56-jj-merger-malformed-structured-mutation-{red,green}.log`。integration production predicate从未弱化。该red仅敏感性证明，不称旧head业务缺陷red；副本恢复正确predicate后绿。
- 最后六新增入口再次全部sandbox exit0，typecheck exit0，统一日志 `/tmp/spec43-pr56-jj-merger-final-<入口名>.log` 与 `...-final-typecheck.log`；delivery-fixes最终16组，SDK默认SP3 no-adapter/no-tick、SP3-owner实际receiver、R11两宿主持久时序绿。当前混搭依赖专项结果不升级为匹配SDK host通过。
- restoreSpawnRegistry可选SpawnDeps使离线reload控制autodrain=false；默认路径drain绑定实际读入的session owner，避免后台恢复写到不相关current owner。新回归不启动真实Herdr。
- 按 `/tmp/pi-herdr-pr56-fix-context/PARALLEL-VERIFY-CONTRACT.md`，完成jj snapshot/bookmark后写JJ-FROZEN.json，revision/full changeId固定。mustFixRemaining=0仅指已知窄审实现阻塞已闭环，不替代最终六路验证。冻结后本实现者暂停workspace源码/tests/package写入，全量/匹配1.0.2与1.0.4/迁移/pack/15行矩阵/双轴由独立协调者处理；仍不push、ready或清理任何workspace。

