# PR56 full gate — T2 durable receiver seam

## 安全与批准范围
- 主代理批准仅修 T2 测试 seam；唯一生产 workspace 仍 r2。父为已冻结 7c445b4c；用 jj new 创建子 change、describe-first，不重写父 group，不移动 integration。
- jj/tdd/pre-implement/diagnosing-bugs 已加载；敏感文件扫描为空，.env/.env.local/node_modules ignored，Git/jj 身份一致。领域语言沿用已读 GLOSSARY、ADR-0001。
- 预先批准 seam：deliverOnce → 真实 durable ParentNotifyStore（或生产 receiver），磁盘重开检查同 notice 的唯一接受；actual SDK + SessionManager 的 host commitment 证据独占保留。两者不混为一事实。

## 四个可证伪假设及实证
- 1（支持）：R9 取消 pushError 提前去重后，旧数组 push sink 把 acceptance attempts 当 durable delivery。原 T2 在 group/baseline 各 3/3 红；缩到 malformed done + same record + 两次 deliverOnce 仍红，移除第二次调用绿。两个 attempts 的 notice eventId/body 相同。仅换真实 ParentNotifyStore，两 put、重开磁盘 pending 一条。
- 2（本顺序场景证伪）：通知 store 自身同 eventId 幂等失效。真实 store 重开 pending=1；首次 callback EIO、实际 store EISDIR 修复后 pending=1，接受失败前 pending=0。
- 3（本场景证伪）：时间/receiver/reload 使治理 noticeId 漂移。JSON clone record/reload 后 eventId/body 不变，两 put 一 durable pending；跨 group/baseline 同身份输出一致。
- 4（本场景证伪）：真实 receiver/SDK 重复提交治理正文。生产 registerDelivery + makeDeliverySink、matching SDK/core/AI1.0.4 + SessionManager 两边均验证：finished parent 不被唤醒；初次 sink attempts=2，真实 store.put=2，pending=1；自然 run 提交后重开 host 正文=1；第三次同 notice sink retry 不再 put；下一自然 flush 清理 outbox，host 仍=1。provider body counts [0,1,1] 是持久上下文保留，不是重复 append。治理独立 notice ledger delivered，原 completion run ledger=null。
- SDK 仪表化最初 class prototype 未命中生产实例；改为针对 parent-notify 路径的真实 ParentNotifyStore.put 文件读取栈计数。另修观测探针 JSON.stringify 对带引号正文的计数误差；outbox delivered 项下一 natural flush 才清除，早期 pending=0 假设不成立。失败探针日志均保留，不冒称业务 red。

## 决策
- 不恢复生产 pushError 早退：诊断只证明保存过错误，不证明 receiver 接受过通知；早退会吞掉首次接受 EIO/存储故障后的恢复。
- 不删旧断言、不单改 notices.length=2。更新 T2 的治理通知 sink 到真实 durable receiver store，分别检查两次 acceptance attempts、稳定 noticeId/body、重开磁盘 pending/body 一条。
- 同 seam 增补首次 acceptance EIO 与真实 store-unreadable 的恢复负例；恢复仍重试而 store 幂等接受一次。

## 证据与范围
- 独占诊断目录 `/tmp/pi-herdr-pr56-t2-diagnosis/`：原 T2 六次红、minimal 两边红/移除call绿、store/reload/fault/fault-store、真实SDK两边原始 JSONL/outbox/provider contexts。
- 完整源码及 SDK parity：`source-and-evidence-manifest.json`，group1186/baseline1185 tracked inputs 全树匹配，actual SDK/core/AI 与 fixture 同一模块 roots。
- 不覆盖前一轮红绿、不改新版 v3 工具/最终四片目录，不改任何生产 src。完整 npm test 必须重跑，baseline同红不是豁免。

## T2 red/green 与全量后续
- 新独立 matching104 host `/tmp/pi-herdr-pr56-fullgate-fix/host`；独占 wrapper/profile/preload/npmcache，只读继承旧安全策略，另拒绝前组 evidence/diagnosis 写入。没动新版 v3 工具/最终四片目录。
- 原 loop `NODE_OPTIONS='--import=/tmp/pi-herdr-pr56-fullgate-fix/retain-preload.mjs' node /tmp/pi-herdr-pr56-fullgate-fix/run.mjs /tmp/pi-herdr-pr56-fullgate-fix/host tests/spec43-t2.mjs`：`logs/t2-original-red.log` exit1（旧 attempts2!=1）；修真实 durable sink 后 `logs/t2-durable-green2.log` exit0。
- 新增 assertion 曾误假设 completionEventId 一定是旧 run；原 child fixture 下一 agent_start 已换 marker UUID。该中间 `t2-durable-green.log` 红仅是新增 probe/fixture 假设错误，不当生产红。改为验证 notice 与引用 completion 是不同命名空间，不改 producer/marker。
- 完整 `... run.mjs <host> /opt/homebrew/lib/node_modules/npm/bin/npm-cli.js test`：`logs/npm-test-first.log` exit1，越过 T2/T3，首个后续失败 T6:15 available→timeout；short-circuit 后范围未运行，不宣称通过。
- 六已命名专项 + typecheck 独立 `interim-exits.txt` 全0，不代替完整门禁。

## T6 身份诊断与批准的最小 fixture 修正
- 原 archive = `{eventId:evt-first,runId:r1,agentId:a1,sequence:1,text:SECRET BODY}`，current=`{name:worker,runId:r1,agentId:a1,sequence:1}`，target=evt-first。retained lookup current=false，wait.ts:32 拒绝 archive 自身 runId != eventId，不是 line34 要求历史等于 current。
- group 与 5563d43 baseline targeted 各3/3红，日志 `logs/t6-{host,baseline-host}-{1,2,3}.log`；最初完整失败 root 被旧 retention selector 清理，后续 targeted 完整原件独占保留，不称其为原完整运行现场。
- 单变量 `/tmp/pi-herdr-pr56-fullgate-fix/t6-identity-probe.mjs`：仅改 archive.runId r1→evt-first，current不变即available；再改current.sequence=9，历史run与sequence均异于current仍available。合法current archive + 历史bridge仍available，历史archive/bridge字节不变。两边 `logs/t6-identity-{host,baseline-host}.log` exit0。
- 约束来源精确：已接受 `JJ-MERGER-PLAN.md:49` current eventId=runId，`:50,67` retained有效自身身份且允许异current；`RESUME-SP3-MERGER-REQUIREMENTS.md:14-15`；冻结 `tests/spec43-pr56-delivery-fixes.mjs:242-248` 合法historical与自身runId冲突timeout显式回归。不能笼统把原 Spec65 当作 runId=eventId 的唯一依据。
- 主代理据诊断批准仅修 T6 fixture：正例 own runId=id，current绑定正例新run，首例 expected对应更新；独立 evt-illegal/runId=r1 的timeout0负例；current evt-later/seq2 对旧evt-first/seq1 retained正例，archive/bridge bytes不变。不改生产wait、不延长timeout、不删负例。
- 同原 targeted命令 `tests/spec43-t6.mjs` → `logs/t6-valid-green.log` exit0；已有 `tests/spec43-pr56-delivery-fixes.mjs SP3-wait-identity` → `logs/t6-existing-wait-negative.log` exit0；typecheck → `logs/t6-typecheck.log` exit0。
- 主代理随后授权当前子change完整输入门禁后的完整 npm test；若全绿即可保存group，不因等待Fable census延迟；若再失败只报告断言/截止范围，不自行追加根因诊断或修正。Census与本候选验收不同，不重复其后续根因诊断。候选命令、完整 gate/source manifest、每轮日志/raw在独占 fullgate 目录；新发现与终态由外部 result 记录，避免为更新结论改写已验证源码输入。
- 最终须证明 `src` Git tree及host实际每文件字节与冻结父7c445b4相同，本组只修改tests/spec43-t2.mjs、tests/spec43-t6.mjs和本notes。

## 后续 census 8 项实际闭环
- Fable 对冻结7c只做预查，38入口30exit0/8exit1，不是新候选最终验收。8项为T11/T10、delivery、delivery-reload-sdk、delivery-pending-session、T5、queue-only-sdk、delivery-quiet-reload-sdk。并行报告只读/static不是修改fixture已绿；本唯一执行器先实际probe再做被批准最小测试修正，不改生产src。
- 当前候选 b6f64f4d 完整1187输入gate匹配，生产src树与7c相同；`npm-test-candidate.log` exit1，越过T2/T6/T7父/订阅/SDK，停T11:87；T10及后续未运行。该候选为中间阶段，不用其SHA冒充后续源码。

### T11/T10
- T11原event `{eventId:event-1,runId:run-1,agentId:agent-1,sequence:1,text:T11 EXACT ORIGINAL\nfinal line}` 与current run/agent/seq匹配，但自身event/run冲突。candidate明确治理invalid identity，wait timeout；仅改own eventId→run-1即wait available、Pull完整原文、二次Pull无正文。T10原failure-event/run冲突，current=run；仅改eventId→run，终态wait/Pull正常。诊断 `terminal-identity-probe.mjs` 与 `logs/identity-T{11,10}-candidate-host.log` exit0。
- baseline5563 WAIT拒绝但RESULT错误接收原非法自身身份（旧一致性漏洞），不能写baseline同业务红。baseline T11 targeted越过旧unit断言，尾部SDK证据copy因新policy拒绝旧evidence目录EPERM；仅工具阻塞，不冒称全PASS。baseline probe的新增‘旧body应为空’诊断assert会红，恰揭示旧不一致，不作为合法结果失效证据。
- 批准后仅纠正两fixture own eventId=runId；T11下一future-run亦同规则，保留历史不同current全部原断言。独立非法event/run normal/reread/ACK拒绝无body、两可能ledger key均不claim、wait timeout0负例。不改生产消费/ACK规则、不删除blocked/stale/quiet/finished断言。
- `logs/spec43-t{11,10}-valid-green.log` exit0，原red及raw全保留。

### 两证据路径与 pending-session
- 独占 `path-sandbox/` 实作v3形状policy：默认禁全部写入，仅本片目录允许；禁网络/真实Herdr。preflight实测旧 `/tmp/spec43-notes`、旧 `/tmp/closed-quiet-reload`、r2生产写入EPERM，私有TMPDIR允许；没改最终四片工具/控制目录。
- queue-only主artifact已有argv[2]，finally却硬编码全局 `/tmp/spec43-notes`。原在该policy下先打印业务GREEN、保留primary/raw，再finally EPERM；不能算脚本PASS。仅finally外送base→tmpdir，primary artifacts与所有业务assert不变。quiet-reload仅mkdtemp硬编码/tmp→join(tmpdir(),prefix)，SDK_ROOT env仅选依赖不选输出。两`*-path-red.log`原样保留，`*-path-green.log` exit0，raw及primary/export位于本片私有TMPDIR/host目录。
- pending原全局 `/tmp/pending-*` 使ledger queue写EPERM；旧/pending/ matcher吞路径中的pending，sent=0仍非业务pending。仅session位置移到私有TMPDIR，实际sent=1、error.code未设、message=`delivery pending durable confirmation; SDK accepted but host commit unconfirmed`。tracked改用精确业务exception谓词并排除OS code，保留同session/reload/unknown session/不同host/回原host全部原断言。`pending-{global,private}-probe.log`、`pending-original-red.log`、`pending-private-green.log`保留，真实green0。

### T5
- `t5-owner-probe.mjs` initially直接spawn.ts import与lifecycle内部spawn.js落不同registry，诊断NOT_FOUND而非owner原因；改为匹配原fixture spawn.js后ownerless/only-parentSession/actual-submit-reject三probe全0。此仪表化错误不作生产red。
- 真正单变量：ownerless拒绝、submit0；仅可信parentSession→accepted/submit1/distinctrun/receipt/session/submitted/FIFO正确；拒绝callback确实在重开uncertain registry后执行1次，AGENT_START_FAILED+原fixture message。`t5-old-false-green-proof.json`实证原弱receipt断言在owner gate submit0仍true。
- 仅补合法parent/lineage/registry/独占substrate到正例；resident首次成功及failedRecord callback重开验证accepted run + uncertain durable precommit；failedRecord加强submitCalls1、精确error code/message，不能把未联系executor称启动拒绝；保留ownerless no-contact，既有六专项仍有registry-fail/unknown负例。初加的所有fresh-pane submit都必须promptSubmission=uncertain探针不符合原startRecord阶段模型，已收窄到本修复相关resident seam，原restore/drain/concurrency业务断言未放宽。
- `t5-original-red.log`旧4红、`t5-owner-fixture-green.log`误宽探针4红、`t5-owner-fixture-green2.log`真实全green0分开保存。
- 当前offline真实SDK中followup调用均direct triggerTurn+显式parentSession；没发现真实registered herdr_trigger_turn仅signal而靠session_start自动owner绑定的runtime覆盖。正例unit补parent不替代该wiring证明，列最终recovery范围缺口，不暗示生产门禁已被放宽。

### delivery / reload
- `deferred-failure-probe.mjs`逐阶段：缺owner→governance owner unavailable；只补可信owner→identity review；modern accepted identity/known prelaunch→helper实际自动seed真实substrate+canonical failure archive+typed原正文。probe0，不把静态建议当运行。
- delivery仅该accepted failure正例补owner、agent/run/seq、真实child/parent文件、prelaunch未提交；原typed正文断言保持，另查canonical archive身份；原缺owner/身份fixture保留独立governance/no-final/no-close负例。world仅新增可选sessionPath以提供可信receiver。`delivery-original-red.log`与`delivery-accepted-negative-green.log`exit0保存。
- reload现代身份only probe：原raw sink typed分支其实已通过（不能复述静态‘一定仍抛’），旧缺身份导致review治理notice而非合法final。随后用生产admission+完整SDK自然run/public session.reload实际证实host重开body1、provider[0,1,1]、registry writer失败回滚。outside-helper最初spawn.ts namespace同样空registry，匹配spawn.js后真正probe0；该NOT_FOUND/0pending不当生产错误。
- tracked reload升级到production registerDelivery+makeDeliverySink、real AgentSession+SessionManager gated append及public reload，保留registry失败不能虚报和重开body1；旧缺身份row独立restore→identityReviewRequired/no-final/no-close负例。`reload-modern-identity-only.log`、`reload-production-admission-probe2.log`、`reload-admission-tracked-green.log`与raw/provider contexts保留；后者在v3形状policyexit0。

## 最终候选验证约定
- 每次候选SHA变动先完整tracked输入manifest/parity gate，再运行对应源码；新trace/log只用独占fullgate目录，不改旧证据、不把旧宽profile绿替代v3形状验证。
- 完成全部已批准项后跑一次完整 npm test、六专项、typecheck，并在私有TMPDIR/v3形状policy实跑受影响脚本。若再出现不属于批准前提的失败，保留原始截止范围先报告，不机械改assert。
- 最终source gate必须证明生产src与7c Git tree及host逐字节相同；仅tests和本notes改变。结果及最终SHA在外部result记录，避免为了补green自述改写已验证输入。

## Deviations
- 无生产行为偏离；所有fixture/证据路径seam修正均经caller确认前提后批准。diagnostic probe只放独占/tmp，debug instrumentation不进入仓库。
