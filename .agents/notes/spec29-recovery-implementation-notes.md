# Spec 29 recovery implementation notes

## Decisions
- 孤儿 done 分支必须 await deliverTerminal；adoptOrphans 才能在异步 close Result 返回后写回 delivery/paneClosePending/paneCloseError。旧测试即时 resolve 掩盖了 missing-await race。
- 所有 deliverTerminal 调用统一 await；不更改普通 pane close 的既有 best-effort 策略。
- closeDeliveredPane 在首次关闭及每次重试读取 takeover marker。owner registry 可能早于人工接管，不能仅信任 takenOver 内存字段。
- 测试真实 sleep(15) 后返回 {ok:false}，立即检查磁盘 pending/error；使用克隆 root records + 每次读磁盘 registry 验证 fresh-memory retry、working/blocked 抑制、接管 marker 新增后的抑制。

## Validation
- node tests/delivery.mjs: 156 passed, 0 failed（后续最终回归见 coordinator）。
- 初次 pnpm typecheck 被现有依赖 @earendil-works/pi-tui 缺失阻断。
- 子审查派发被 max_spawn_depth=3 拒绝，执行本地测试代替。

## Deviations
- 无 spec 偏离。依赖安装使用 pnpm install --offline；依赖完成落盘但 ignored-builds policy 返回非零，不批准无关 build scripts。
