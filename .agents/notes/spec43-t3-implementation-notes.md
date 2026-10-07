# spec43 T3 (#46) 实现笔记

## 顺序
- 先派真实 SDK/SessionManager 宿主能力验证。验证精准撤销、提交前重仲裁与 tool result 磁盘边界后，才实现账本。
- 原生 git。实现者备用 sol：pstack 指定主力 grok 本周额度耗尽。
- result 独立分析；待宿主 seam 与账本接口确认后接入。

## 已知上下文
- 整合 tip 6d8cc1d。T4 note 不存在于当前 checkout；稍后确认整合分支内容，不能虚称已读取。
- 既有 sink 保留未知 pending，不超时重发；磁盘证据优于 SessionManager 内存 branch。

## 宿主验证后实现
- `tests/spec43-t3-host.mjs` 真实 SDK+SessionManager 证明 private queue 可精准取消；生产 ExtensionContext 无 session 实例，不能采用 private-only 路径。
- 最高公共运行 seam 为 `message_end` 同role替换：agent-core await event listener后采样，SDK in-place replacement改变同一state对象与持久记录。已排队旧Push精准剥离正文，不清队列、不动无关输入。receipt不是正文交付凭证。
- 宿主proof通过后才新建 `src/delivery-ledger.ts`；hostFile隔离、同步fsync临时文件+rename决策，claim持久化在正文之前。queued Push允许Pull抢占；pending未确认不可抢，不以超时重发。
- ledger reconcile只读磁盘。获准body proof需event/token/channel/host匹配；withdrawn receipt不确认。legacy已持久push不重放；旧进程pending迁成未知pending并保留身份核对。
- pull工具磁盘事实由toolResult.details.delivery证明；tool_result/message_end hook均早于append，不当ACK。

## 边界
- SDK SessionManager append无fsync；readback仅证明进程重启可恢复，不是断电安全。
- ledger claim后宿主append前崩溃：未知pending保留，可能无正文但不重发；不能宣称跨崩溃exactly-once。
- public message_start可能提前UI展示旧body，message_end撤销证明的是实际模型上下文与磁盘正文，不是撤销历史UI曝光。
- 同宿主单Pi进程内同步仲裁；未宣称多个同时写同session的进程原子锁。

## 测试迭代
- 首次精确env命令仍受额外PI_HERDR_*继承污染；先显式unset额外变量，再保持用户指定env命令原样运行。
- 基线长suite超过120s；后续改为足够长timeout。
- ledger测试：Push queued→Pull抢占、第二Pull拒绝、stale receipt不ACK、宿主提交/ledger ACK写失败后重启修复、独立receiver、legacy unknown及Read无消费，已通过。
- 既有durable/reload/quiet/registry failure SDK suites通过。

## 最终验收
- SDK version 1.0.4。真实 SDK、真实 SessionManager、真实 ExtensionRunner注册工具、Agent execution、截获实际provider context（deterministic provider只替代模型输出，无网络）共同验证五case：Push first / Pull first / 两Pull / queued Push后Pull再drain / concurrent Push-Pull。每宿主持久正文message=1；完成后的每次provider request context正文message=1，初次完成前为0。不是模拟sink或手工写盘作为综合验收。
- 证据 `result-sdk.json`、五份parent JSONL、五份provider JSON；`host-sdk.json`提供队列精准撤销研究、公共异步gate、无关输入保留、immediate context append旁路拒绝及磁盘边界。
- `ledger.json`补review回归：unknown/invalid宿主failclosed；旧pending map按eventId批量迁移，不依赖正文format；旧token gate剥离正文保留pending待核对；accepted后throw不重新发送。
- registered result严格消费durable声明；run/agent/sequence校验，不读draft；直接Read无消费。离线无host engine保留旧inspection兼容，不是模型tool入口。reread/ack API未实现，状态预留acked供T11。
- void dispatch thrown通常不能证明未提交，保留pending；只有显式adapter标记 `deliveryOutcome: not-submitted` 才release。旧lineage test为明确beforeenqueue故障增加该标记，不凭任意同步异常猜测。
- ACK failure：真实toolResult已盘上persisted、ledger ACK save注入失败；恢复后新ledger凭磁盘修复delivered，不再正文。EISDIR branch-only evidence永不ACK。
- 私有队列适配迁至 `tests/helpers/delivery-host-private.ts`，不发布非生产SDK私有耦合。
- 再次 `git merge spec43-integration`：already up to date，tip仍6d8cc1d。T4文件/notes当前确实不存在，已告知parent；本票未伪称含T4。
- 最终指定env npm test exit0，末行 `99 passed, 0 failed`；`npm run typecheck` exit0；`git diff --check` exit0。

## 明确限制 / 不作承诺
- claim→宿主append前进程崩溃：token pending保留待核验，不自动超时解锁；可能无正文但不会擅自重发。未做kill-process故障注入，已验证实际await boundary与文件写故障/reopen恢复，不宣称未经验证跨崩溃exactly-once。
- 同一个receiver session由单Pi进程写；fsync+rename不能冒称跨多个同时写同session进程的互斥。
- SDK不fsync及ledger不fsync目录：断电/文件系统元数据持久性不在证明范围。
- publicgate在message_end前撤销模型正文/磁盘正文，不撤回可能已由message_start显示的UI曝光；后加载可信extension可覆写replacement，是同宿主extension信任边界。
- 兼容无stable identity旧记录明确保留待核对；正式stable identity push缺host不downgrade。legacy fakehost/离线sink仍为既有测试适配兼容路径。
