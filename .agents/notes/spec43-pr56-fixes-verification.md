# PR56 已验证发现验收矩阵

基点：`99431428cd7b3fc9937866281a8e29dc6fea7891`。原报告：`/tmp/pi-herdr-pr56-review.Yrlzwr/review-verified.md`。

“通过”必须指向整合后的执行结果；单组声明、源码检查或 ledger 状态不能代替实际宿主持久事实。

|发现|验收不变量|整合入口与执行结果|
|---|---|---|
|S1 P2|首次查询计入总deadline；abort及时结束；延迟查询返回后不得误报available|待验收|
|SP1 P2|无可靠身份/交付凭据的legacy事件不得新交付正文；保留待核对|待验收|
|SP2 P2|normal非terminate工具后在当前自然continuation带正文；closing延后；quiet不主动消费|待验收|
|SP3 P2|已接受启动失败有稳定durable failed event；wait/result/ACK统一可寻址|集成专项绿：默认真实SDK no-adapter/no-tick；failure-point archive/registry、两drain不重启、pending归属、FIFO后项、unknown退役对账、owner、archive身份切片。日志 `/tmp/spec43-pr56-jj-merger-final-spec43-pr56-delivery-{fixes,sdk}.log`；依赖仍混搭，最终匹配host/全量验收待六路验证|
|R1 P1|旧close暂停、新run启动、旧close恢复：不得关闭新pane或清其绑定|待验收|
|R2 P1|stale idle+child busy排队回放：新run身份与新正文一致|待验收|
|R3 P1|历史startBeganAt不得阻塞已接受恢复；容量释放/reload可继续|待验收|
|R4 P1|interactive驻留idle/done可执行busy时积压；FIFO提交无interrupt|待验收|
|R5 P2|部分写故障不留下已提交残片；恢复重试可发布完整事件；真实冲突仍拒绝|待验收|
|R6 P2|旧worker恢复不覆盖新run回收intent；后继worker能执行|待验收|
|R7 P2|跨进程确定丢失queue/匹配撤回receipt可重排；未知pending不自动解锁|待验收|
|R8 P2|child忙时输入的images经真实SDK回放到provider|待验收|
|R9 P2|首次通知store失败后仍重试；诊断保存不冒充通知接受|待验收|
|R10 P2|R2不能用R1 structured capture满足完成或交付|待验收|
|R11 P2|治理告警与terminal交付身份隔离；告警先提交/待交付两序均不吞最终正文|待验收|

## 跨组复核

- 生命周期与worker：旧操作暂停→新followup/容量释放→旧操作恢复。
- child：新run回放边界同时核对身份、images、structured reset。
- 失败与恢复：部分写/启动失败→恢复→wait/result/ACK。
- 仲裁：告警先提交/通知put失败/queued进程退出→正常Push/Pull恢复；正文核对SDK＋SessionManager。
- 接收：tool_end与closing边界不强造turn、不interrupt；S1异步后复核。

## 验收范围

merger已在离线sandbox完成六个新增入口与typecheck，日志 `/tmp/spec43-pr56-jj-merger-final-<入口名>.log`及`...-final-typecheck.log`，仅当前集成混搭依赖专项结果。实际窄审在核读范围无剩余必修，但未运行测试或独立重审result/delivery全部接入，不代替完整双轴验收。最终全量、匹配SDK1.0.2/1.0.4、迁移、pack与15行矩阵闭环交冻结后的六路验证。live/TUI/win/multi/stress未在本轮执行；不以既有基点证据冒充新修复的live验证。不宣称断电、未经证明的跨崩溃exactly-once或multiwriter安全。

## 数据保护

原主目录status/diff、原integration diff、stash及归档内容快照：`/tmp/pi-herdr-pr56-fix-context/`。归档初始快照14901项，未跟随symlink；依赖及.git目录仅记录目录mtime。最终对比待执行。
