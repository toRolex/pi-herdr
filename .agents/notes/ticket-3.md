# ticket-3 layout_mode

## Baseline（开工前 `npm test`，commit 264b3b3）

- `npm install` 后才有 `jiti`；干净 checkout 无 `node_modules`。
- 套件在 `tests/substrate.mjs` [7] 中断，exit 1。与布局无关。
  - `without PI_HERDR_SESSION the extension is a no-op` 失败：mock pi 上 `tools`/`shortcuts` 非空。
  - `session named herdr/<spawn-name>` 失败。
  - `identity strip rendered aboveEditor content` 失败。
  - 随后 `readFileSync(.../s.jsonl.exit)` ENOENT，进程崩溃。后续 settings/spawn 套件没有跑到。
- 本票不修 substrate。相关回归单独跑 `tests/settings.mjs`、`tests/spawn.mjs`、`tests/grid.mjs`。
- `tests/spawn.mjs` [3] `listAgentTypes: session first, then built-ins` 在本机失败：`~/.pi/agent/agents/` 有 `comment-sicko.md`、`poteto-agent.md`，`listAgentTypes` 把它们算进去。既有、与布局无关。

## 第 7 个之后同 group 的 tab 归属

group 按 **tab label** 认领，不按「最近一个」。

- 无 group：主 tab（编排者当前 tab）。主窗口钉在 r1c1。
- 有 group：已有 label 等于该 group、且 live occupant < 6 的 tab。多个有空位时取 tab list 里最靠前的那个。
- 没有有空位的同名 tab：开新 tab，label = group。
- 同 group 的第 7 个 live occupant 再开一页，label 仍是该 group。再后来的同 group spawn 填最早的未满页，满了才再开页。洞只在本 tab 内复用。
- 空字符串 group 当省略。

## Decisions

- `layout_mode` 是 settings enum，默认 `grid`。非法值走现有 validate：忽略并记 issue，落到另一文件或默认。
- 规划器恢复为 `src/grid.ts` 纯函数。START 时读设置：`spiral` 走现有 `nextSplitFor`，行为不变；`grid` 走 `placeOnGrid`。
- 模式只在 START 读取。已存在的 pane 不重排。
- 并发：grid 在 `startRecordNow` 入口占座（`gridClaim`），排队的 START 看到前面的占座，不抢同一洞。
- 新 group tab：`tab create` 返回的 shell 直接 `agent start`（`existingPane`），不再 split。env 打在 `tab create` 上。
- 开第三列：先把该行 col 1 向左缩 1/6，再对半分。
