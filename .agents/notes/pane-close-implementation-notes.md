# autonomous sidecar 关 pane

日期：2026-09-28。只改 fork `CallMeRol/pi-herdr`。未提交。

## 决策

关窗只加在父进程 `deliverSidecar` 末尾。子进程 `ctx.shutdown()` 只退出 pi，没有 pane id。`SpawnRecord.paneId` 在父进程。

`deliverSidecar` 改成 async。`deliverOnce` 里 `await` 它。先 `deliverTerminal`（done 和 error 都走完），再关。`record.delivery` 仍在 `deliverTerminal` 里标记，挡住第二次进入，所以关窗也只尝试一次。

关的条件（`shouldCloseAfterSidecar`）：

- `stance === "autonomous"`
- 没有 `takenOver`
- 没有 `workflow`
- sidecar 不是 `rearm: true`

`closePane` 仍 best-effort：抛错吞掉，结果已经交付。

## 为什么不关 workflow

handoff 写明正常完成的 workflow 子窗格这次不顺手关。abort 已在 `src/workflow/host.ts` 关。`record.workflow` 直接排除。

## 测试夹具

`tests/delivery.mjs` 的 `world()` 在没传 `opts.close` 时以前把 `close: undefined` 传进去。`closePane` 用 `deps.close ?? herdr(...)`，undefined 会落到真的 `herdr pane close`。autonomous sidecar 现在都会进关窗，quiet / none / workflow 段里的普通子代理会真关 pane。默认改成 noop。显式 fake 的断言不受影响。

## 注释

`Stance`、`SpawnRecord.stance`、`SpawnResultData.stance` 都写过「pane closes itself」。三处一起改成：子进程退出 pi，父进程关 pane。只改类型注释会留下同样的假话。

`child.ts` 里把 `ctx.shutdown()` 写成关 pane 的注释改成「退出这个 pi」。rearm 注释写明 pane 留着。

## 验证

`node tests/delivery.mjs`：78 passed。`npm test`：全过。未跑 `test:live`。

## Deviations

无。workflow 正常完成不关，按 handoff 保持现状。
