# PR56 T12 migration fixture follow-up

## 安全门与范围
- 原冻结 integration b1be294b 保留；现有r2仅 jj new 新子change，未重写b1be、不移动integration、不触碰旧四片报告/控制目录。
- jj workflow/tdd/pre-implement已加载。首次snapshot前敏感文件扫描为空；.env/.env.local/node_modules实际ignored；Git/jj身份一致。领域语言沿用已读GLOSSARY和ADR-0001。
- 预先批准seams：migration真实getAgentResult返回视图、normal duplicate/reread/ACK、同agent retained历史；T12 SDK注册tool + SessionManager FM1-FM5；不更改生产身份/owner/ledger门禁。
- 独占/tmp private-write-only sandbox、独立104/core104/AI104 matching host，禁网络/真实Herdr、原现场和共享依赖写入；不覆盖任何b1be证据为新SHA。

## 已读原始阻塞
- 旧四片migration日志：t12-migration23/0；migration-verify16项14PASS/2FAIL，AC1c首次正文缺失，AC2b首次正文undefined，其后duplicate/reread未执行；SDK/pack未执行。
- 原helper默认eventId=event-1、runId=run-1；AC2b仅改eventId=event-reread。静态形状尚不足以豁免，必须捕获实际返回治理视图、当前/事件/target完整身份并单变量验证。

## 契约
- 已接受 JJ-MERGER-PLAN.md:49 current eventId=runId及匹配agent/run/sequence；:50/:67 retained自身身份有效且允许异于current。
- RESUME-SP3-MERGER-REQUIREMENTS.md:14-15同约束；既有SP3-wait-identity historical合法/自身run冲突timeout回归。
- 不泛称原Spec65独自要求相等，不把合法历史与current不同误当非法。

## 决策与执行记录
- 独占目录 `/tmp/pi-herdr-pr56-t12-fix/`，沿旧已证明 private-write-only 形状新建自己的 profile/run/preload/npmcache/TMPDIR，不改任何旧控制。Node24.19、SDK/core/AI均1.0.4，fixture匹配。
- 原loop `NODE_OPTIONS='--import=/tmp/pi-herdr-pr56-t12-fix/retain-preload.mjs' node /tmp/pi-herdr-pr56-t12-fix/run.mjs /tmp/pi-herdr-pr56-t12-fix/host tests/spec43-t12-migration-verify.mjs` → `logs/migration-original-red.log` exit1，14/2，后续duplicate/reread未执行。
- `migration-view-probe.mjs` 实际捕获AC1c与AC2b首次返回。current=agent-1/run-1/seq1；target=arb或reread；bridge=event-1或event-reread/run-1/seq1，canonical archive不存在。首次return为governance invalid identity/noBody/noClaim，不是合法正文丢失。
- 每场景仅改bridge.eventId→run-1（current/target/agent/seq/body不变），首Pull完整原文，四次duplicate无正文且有reference，explicit reread完整原文并标记，实际全部过；`logs/migration-view-single-variable.log` exit0。该probe是public消费行为，不冒充SDK宿主提交。
- 单切片纠正helper默认eventId=run-1，`migration-ac1c-green-ac2b-still-red.log` 实际15PASS/1FAIL；再AC2b同case sidecar与current均run-reread，`migration-original16-positive-green.log` 16/0。
- AC4a原编号内增加子断言（不是新增case数）：已知current=agent-1/current-run/seq9，非法history-invalid/foreign-run/seq2 →正常治理/noBody，explicit reread/ACK拒绝，两可能ledger键均noClaim，非法archive字节不变；合法history-valid自洽run/seq7异current →首Pull原文、normal duplicate reference、explicit reread，历史archive和current桥字节不变。`migration16-expanded-ac4a-green.log` 16/0；原identity-unknown registry治理断言仍保留。

## 后续 SDK 两真实 fixture 问题
- 原 `tests/spec43-t12-sdk.mjs` 实跑：FM1-FM3通过；FM4:224 ledger文件ENOENT（副作用）。重开原始SDK JSONL显示注册tool回执确为isError/governance invalid own identity：sidecar event-fm4/run-fm4/agent-fm4/seq1，current匹配run/agent/seq，target fm4-agent。没有正文claim，所以没有ledger；不能为此补生产claim。
- 原view保留 `logs/fm4-original-return-view.json` 与raw/spec43-t12-sdk-Qlc5bf。隔离FM4观察原FM5：首次诊断替换未命中仍跑FM4，日志保留，不当FM5事实；精确隔离后 `fm5-original-isolated-view2.log`旧断言exit0，但真实持久toolResult同样isError/governance invalid(event-fm5/run-fm5)。`pulledBodies=0`此处是伪绿，不等于正常delivered reference；原view另存logs，不覆盖。
- 主代理确认条件授权：仅FM4 const eventId→run-fm4，该case sidecar/ledger/tool/ACK引用全部使用同const。新增重开toolResult必须真实完整body、非error、event与delivery proof同ID，再保留原ACK写失→pending→restart修复。FM1-FM3无child archive验证，原ledger refs值全部不动。
- FM5先加强注册Pull必须非error、done、无正文、真实delivery.status=delivered、所有event/run引用同case，旧event-fm5保留时 `sdk-fm4-green-fm5-real-reference-red.log` 实际FM4过、FM5 isError真红；再仅FM5 const→run-fm5，`sdk-fm1-fm5-canonical-green.log` 实际五例全过。
- 新写解释性注释/notes/断言说明用简体中文；既有payload和技术标识符保留，不为此改b1be或全库旧注释。
- 只读简化复核不建议机械抽helper；指出FM4若仅details保存body而工具content丢失仍可能伪绿，采纳在同FM4内增加持久toolResult文本块含原始完整正文断言，不增加FM编号。该静态建议不当runtime绿证，仍须同新候选全矩阵实跑。
- 原 `tests/t12-migration.mjs` 未改，`logs/t12-migration23-green.log` 23/0。原16个case的编号/原业务断言保留，AC4a子断言范围明确；FM编号仍1–5，不冒称追加case或完整旧SDK已跑。

## 新候选验证与交付边界
- 同新候选SHA完整tracked输入gate和matching SDK manifest，独立host实跑三T12（23、16含子断言、FM1–FM5）、完整npm54、typecheck及必要六专项；日志/raw/results按候选SHA独占，不更新旧b1be四片结果。
- 生产src与package必须与b1be Git对象和host实际字节同；只两个现存T12测试与本notes更改。
- 不移动integration或作最终冻结/合并。旧b1be四片migration14/2 STOP、未运行SDK/pack等范围原样保留；交付group后主代理才整合/绑定t12-next新roots并真实重跑必要门禁。

## Deviations
- 当前无；最终组只测试与本notes，完整src/package须与b1be逐字节同。新候选仅独占验证，暂不最终freeze/merge，等待主代理旧四片汇总后重新绑定。
