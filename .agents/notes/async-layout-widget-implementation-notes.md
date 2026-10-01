# async-layout-widget implementation notes

Spec: `docs/specs/2026-09-27-async-layout-widget.md`

## Decisions

- 未开 worktree：用户这次说「按照 spec 修复」，在当前 fork `main` 上直接做，三个独立 commit 仍保留。
- 顺序：widget 钳制 → 工具层删 wait → 网格规划。网格是最大一块，先让崩溃路径变绿。
- seam 沿用 spec：widget 走 `renderWidgetLines`；schema 走已注册工具的 `parameters`；网格走无 I/O 的 `planGridPlacement`。

## Deviations

- 三列等宽不能靠一次 `pane split --ratio 1/3`。herdr 的 ratio 是「新 pane 占被切那一只的份额」，两列各 1/2 时再切右侧，1/3 会得到 1/2 与 1/6。实测（临时 tab，已关闭）：`pane resize --amount` 是绝对比例差（0.5 + 0.1 = 0.6）。所以先把左列收 1/6（留下 1/3），再把剩余半宽对半切。
- 新 group tab 不再 split。`tab create` 返回 `root_pane`，直接在那只 pane 上 `agent start`，避免又把编排者的 pane 切一刀。
- `placeOnGrid` 失败不拒绝 spawn，退回旧行为（从当前 pane 向右 split）。排队中的 spawn 没有 pane，不进网格；清空队列时走同一个 `startRecordNow`。
- 新 group tab 的 shell 由 `tab create` 启动，不是 `pane split`。`agent start` 没有 `--env`，所以 `PI_HERDR_*` 必须加在 `tab create` 上。漏了的话 child 扩展看不到 `PI_HERDR_AUTO_EXIT=1`，不写 `.exit`，完成结果不会被推进来。`tab create` 的 pane id 在 `root_pane`，不在 `tab`。
- 洞的复用要求已在场的 pane 带着坐标（`gridAt`）。没坐标的占用者会被当成新人重新放，测试里已用反例锁住。
- 未开 worktree，三个 commit 用 `git add -p` 无法做（非交互），改为按文件拆：widget 一个，schema 去 wait 一个（含它们的测试），网格一个。`agents.ts` 同时含去 wait 和 `group`，不拆开，进网格那个 commit。
