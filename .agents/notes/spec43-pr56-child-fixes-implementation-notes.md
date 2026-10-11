# spec43 PR56 child fixes — R2/R5/R8/R10

## 范围与 seam

- 基点 99431428cd7b3fc9937866281a8e29dc6fea7891；仅 spec43-fix-child 工作树。
- 用户授权 seam：生产 child default 注册入口 + 真实 SDK AgentSession/ExtensionRunner/SessionManager + 确定性离线 provider。观察 provider context、宿主 JSONL、不可变 completion archive、shutdown 回调；不使用函数提取替代宿主验证。
- R2：busy followup 在真正消费 user message 时绑定 run，不在重排时绑定。
- R5：临时文件完整写入并 fsync 后以 no-clobber 原子发布，保留冲突保护；注入真实 FS 部分写故障。
- R8：busy direct input 保留 images。
- R10：新 run 清空 structured capture（保持注册工具引用同一 capture 对象）。
- 依赖检查 SDK 1.0.4 后，仅新建本 worktree node_modules symlink 至原 integration；不编辑共享依赖。全部测试 env -u HERDR_BIN_PATH，清除 child/Herdr env，禁止真实 pane 操作。

## 初步因果

SDK 在输入重排时马上发出 extension input，队列消费不重新发 input，也不一定发 agent_start；user message_start 才是真实开始边界。仅修 queuedInputs 分支会过早绑定 R2，仍污染正在执行的 R1。计划在 message_start 绑定 TriggerTurn，并独立维护 replay 防重排。

## 红绿证据

测试入口：`env -u HERDR_BIN_PATH node tests/spec43-pr56-child-sdk.mjs [case]`；每场景独立真实 Node host，避免 provider 全局注册与 jiti 内建模块缓存干扰 FS 注入。

- R2 RED `/tmp/spec43-pr56-child-R2-red.log`：新 run archive ENOENT，旧身份写入；GREEN `/tmp/spec43-pr56-child-R2-green.log`：生产 lifecycle 的 stale-idle 提交进入真实 SDK busy 队列，最终正确新 run archive/sidecar、完整正文、宿主 JSONL。
- R8 RED `/tmp/spec43-pr56-child-R8-red.log`：queued input image reached provider 断言 false；GREEN `/tmp/spec43-pr56-child-R8-green.log`：实际工具无 abort，provider 及 SDK 持久消息保留原 PNG。
- R10 RED `/tmp/spec43-pr56-child-R10-red.log`：R1 capture 令 R2 bare agent_done 被错误接受（isError=false）；GREEN `/tmp/spec43-pr56-child-R10-green.log`：拒绝无自有正文完成，之后新 StructuredOutput 正常采集并完成。
- R5 RED `/tmp/spec43-pr56-child-R5-red.log`：ENOSPC 部分写已发布最终 eventPath（published=true）；GREEN `/tmp/spec43-pr56-child-R5-green.log`：失败仅 governance sidecar、shutdown=0，无终态残片；同 run 原 tool 再试成功完整发布。
- 全新增入口 GREEN `/tmp/spec43-pr56-child-all-green.log`：四项 + 已发布 event 后 sidecar rename EIO 恢复 + 已提交事件相同内容幂等/不同内容冲突（两子场景）+ busy TriggerTurn 与图片/structured 联合 replay；共 8 场景。
- 支持范围 SDK 1.0.2 同 8 场景 GREEN `/tmp/spec43-pr56-child-sdk102.log`：临时 Node host `/tmp/spec43-pr56-child-sdk102-H3Nv3F`，完整生产 src symlink 与已有 1.0.2 依赖，不编辑任何共享依赖或其他 worktree。
- `env -u HERDR_BIN_PATH npm run typecheck` GREEN（SDK 1.0.4、Node v24.19.0）；`env -u HERDR_BIN_PATH npm test` 48 个原有脚本全绿，日志 `/tmp/spec43-pr56-child-npm-test.log`。测试自动修改的 tracked evidence 在本 worktree 恢复，并删除本次产生的 5 个 untracked evidence 文件，不纳入提交。

## 实现因果

- R2 保留 extension input 的防递归重排，仅在真实 user message_start 才 parseTriggerTurn，重置身份、runStart、completionSaved 与错误退出计时。SDK 同一次 agent_start 内即可 drain followUp，不能只在 agent_start 绑定。
- parent stale-idle 提交会提前写 `.completion-event` marker，不能把 marker 当作 child 已开始证据。联合测试改用 direct envelope 输入，在旧工具尚未结束时断言 marker 未变。
- R10 reset 同一 capture 对象，不更换引用，以免注册 StructuredOutput 工具继续写旧对象；同 run 重试不清已验证结果，明确新 run 或已保存后的隐式新 run 才重置。
- R5 同目录唯一临时文件，wx 写完并 fsync，hard link 原子 no-clobber 发布；EEXIST 只接受完整同内容，保留真实不同内容冲突。unlink 临时文件 best effort，未发布临时残留不是终态声明。
- 独立 R5 单场景绿但最初同进程连跑时 FS 注入被 jiti 缓存屏蔽；改为独立 Node 进程，显式断言 injected=true，防止“测试绿但故障没发生”。

## Deviations / 限制

- 不改 package.json 测试列表，新增入口由主代理统一追加。
- 不执行真实 CLI/TUI/live；shutdown 回调不是 pane 已关闭证据。
- Opus 顾问确认 R2/R8/R10 当前路径无确定问题，提出父目录 fsync 与 sidecar 发布失败盲点。后者已补真实 EIO 回归；前者属基点已有、已验证报告第 171 行明确公开排除的掉电持久性限制，不在四项修复中扩张契约。文件 fsync + 原子发布不等于目录项跨掉电可靠，不宣称 exactly-once/跨掉电保证。
- 文件系统不支持同目录 hard link 时，完成失败可见且不正常回收；没有退化为覆盖式 rename。仅验证 macOS、Node24.19.0；未验证最低 Node22.19、Windows 或网络文件系统。
- Opus code-simplifier 只读复核：无值得立即改的简化，保留就地故障注入与 message_start/agent_start 各自语义，不引入过度抽象。
