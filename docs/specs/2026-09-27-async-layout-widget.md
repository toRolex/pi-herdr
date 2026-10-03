# Spec: 等宽网格 spawn、工具层强制异步、窄终端 fleet widget 不崩

状态：本地草稿（issue tracker 未配置，未发布、未打 `ready-for-agent`）。
来源：grilling 2026-09-27。未答项按当时推荐锁定，见 Further Notes。

## Problem Statement

作为在 herdr 里用 pi-herdr 派子 agent 的人，我遇到三件互相加重的事：

1. 每次 spawn 都在当前 tab 里向右 split。agent 一多，pane 越来越窄，主窗口也被挤没。没有「相关任务聚在一起、无关任务换 tab」的办法。
2. spawn / 取结果的工具 schema 仍暴露 `wait`。模型可以（也经常会）让主窗口阻塞到子 agent 结束。提示词约束不可靠，必须在工具层拿掉。
3. Subagents fleet widget 在终端窄于约 36 列时，会把框画得比终端更宽。pi TUI 对超宽行直接崩溃。向右堆 pane 会稳定制造这种宽度。

## Solution

1. spawn 在同一 tab 里维持一个等宽网格：最多 3 列、2 行、6 个 slot。列宽永远相等（2 列时每列 1/2，3 列时每列 1/3）。主窗口是左上第一格，没有额外宽度特权。满 6 个占用 slot 再开新 tab。模型用可选 `group` 声明任务类别；同组进同一 tab。
2. 从 spawn 工具和 get-result 工具的对外 schema 删除 `wait`。两者永远立刻返回。内部等待（workflow host、spawn 内部参数）保留。
3. fleet widget 的每一行（含 header、footer、callout）可见宽度不得超过当前终端宽度；窄终端截断，不撑宽。

## User Stories

1. 作为编排者，我想 spawn 后主窗口立刻拿回控制权，以便我继续派活或自己干活，而不是干等子 agent。
2. 作为编排者，我想工具 schema 里根本没有 `wait`，以便模型无法选择阻塞。
3. 作为编排者，我想 `herdr_spawn_agent` 的说明写明「永远后台、立刻返回；超并发上限时 status 为 queued」，以便模型不再尝试等待参数。
4. 作为编排者，我想 `herdr_get_agent_result` 永远是单次快照、说明里写明可轮询、永不阻塞，以便我用重复调用来观察进度。
5. 作为编排者，我想 workflow 脚本里的 `agent()` 仍然等到该子 agent 结束并拿到正文，以便流水线语义不变。
6. 作为编排者，我想 `herdr_wait_output` 继续阻塞到 pane 打出目标行，以便我等服务器 ready 之类的原始输出。
7. 作为编排者，我想同一 tab 里所有列等宽，以便没有一个 pane 被压成不可读的细条，也没有一个被特权撑大。
8. 作为编排者，我想只有 1 个 pane 时它占满 tab，以便单独工作时不浪费空间。
9. 作为编排者，我想 2 个 pane 时是一行两列、各 1/2 宽，以便主窗口和第一个 agent 并排。
10. 作为编排者，我想 3 个 pane 时是两列各 1/2：左列只有主窗口，右列上下两个 agent，以便和「主在左、右侧上下两个次要 pane」一致，同时列仍等宽。
11. 作为编排者，我想 4 个 pane 时是 2×2、每列 1/2，以便第四个 slot 落在主窗口正下方。
12. 作为编排者，我想 5 或 6 个 pane 时是 3 列各 1/3、最多 2 行，以便横向不超过三列。
13. 作为编排者，我想第 7 个需要落位的 pane 打开新 tab 而不是把格子压到 1/4，以便单 tab 永远不超过 2×3。
14. 作为编排者，我想新 tab 套用同一套网格规则，以便每个 tab 的几何一致。
15. 作为编排者，我想主窗口始终占该 tab 网格的左上格，以便我知道自己的工作面在哪。
16. 作为模型，我想 spawn 时传入可选 `group` 字符串来声明任务类别，以便相关 agent 聚在一起。
17. 作为模型，我想省略 `group` 时 agent 进入主窗口所在 tab 的网格，以便默认行为和现在一样「跟着手边的工作」。
18. 作为模型，我想相同 `group` 的后续 spawn 进入已有的该组 tab，以便一组任务不散落。
19. 作为模型，我想用一个新的 group 名表达「这是另一类任务」，以便它得到自己的 tab，而不需要单独的 `new-tab` 开关。
20. 作为编排者，我想某个 group 的占用 slot 超过 6 时再开一个同组 tab（标题仍能看出组别），以便大组不会撑破网格。
21. 作为编排者，我想 group tab 的标题包含组名，以便我能分辨 tab。
22. 作为编排者，我想 agent pane 关闭后网格不要整体重排，以便我正在看的 pane 不会突然跳位。
23. 作为编排者，我想下一次 spawn 优先占用同 tab 里已空出的 slot，以便关掉的 pane 把位置还回来，而不是永远只往右长。
24. 作为编排者，我想布局在 herdr 只支持向右/向下 split 的前提下，用 split、ratio、resize、必要时 move 拼出网格，以便不依赖不存在的 left/up split。
25. 作为编排者，我想排队中的 spawn（还没有 pane）不占网格 slot，以便并发上限不会提前撑开空 tab。
26. 作为编排者，我想 widget 在 32 列终端里仍然渲染且不崩溃，以便 herdr 把 pane 切窄时 pi 不会退出。
27. 作为编排者，我想 header、每一数据行、footer、blocked callout 的可见宽度都不超过终端宽度，以便不存在「只修了 footer、header 仍超宽」的漏网路径。
28. 作为编排者，我想窄宽度下文字被截断而不是把框撑出终端，以便信息变少但会话还在。
29. 作为编排者，我想宽终端下 widget 仍按内容收缩、不超过终端宽度，以便修复不把大屏画丑。
30. 作为维护者，我想这三项改动各自可独立提交，以便以后 rebase upstream 时冲突面小。
31. 作为维护者，我想包版本从仍写着的 0.5.0 升到 0.6.0，以便版本号和已经落地的 v0.6 行为一致。
32. 作为维护者，我想改动发生在 fork 工作副本，旧的 `~/tools/pi-herdr` checkout 不动，以便当前正在加载的那份在切换前不被半改。
33. 作为维护者，我想离线测试不依赖 herdr server 就能证明 schema 不再接受 `wait`、网格规划符合上表、widget 在窄宽度不产出超宽行。

## Implementation Decisions

- 三项改动都进 fork。旧 checkout 与 settings 里的 `../../tools/pi-herdr` 本 spec 不改；安装切换是后续人工步骤。
- 版本：`0.5.0` → `0.6.0`。三个独立 commit：网格布局、widget 宽度钳制、工具层删除 `wait`。bump 放在其中一个 commit 或单独的版本 commit 均可，但不要把三项行为揉进同一个 commit。
- 并行：两个 worktree。一个只做网格布局；另一个做 widget 钳制和异步化（两个 commit）。汇合点只有版本号。

### 网格（spawn 布局）

- 废止「无 layout 参数、永远当前 tab 向右 split」这条 charter。人类仍不手调每个 pane；机器按下面的规则摆。
- 新增可选 spawn 参数 `group: string`。无其他 placement 枚举。空字符串视为省略。
- 归属：省略 `group` → 编排者当前 tab。非空 → 按组名复用已有 tab；没有则新 tab，标题含组名。同组占用 slot 达到 6 后再开同组 tab。
- 容量按**已占用 slot**计，不按「历史上 spawn 过的次数」计。pane 消失则该 slot 变空。queued（尚无 pane）不占 slot。
- 列数由该 tab 当前占用 slot 数（含主窗口格，不含空位目标）在落位时决定，列永远等宽：
  - 1 slot：1 列，宽 1
  - 2 slot：1 行 × 2 列，列宽 1/2
  - 3–4 slot：2 列，列宽 1/2，2 行
  - 5–6 slot：3 列，列宽 1/3，2 行
  - 需要第 7 个占用 slot：新 tab，从 1 重新计
- 填充序（主窗口固定 r1c1；agent 从第二列起、列内自上而下，再向右；主列下方最后填）：

  | 占用 agent 数 | 形状 | 位置 |
  |---|---|---|
  | 1 | 1×2 @ 1/2 | a1 = r1c2 |
  | 2 | 2×2 的右列 @ 1/2 | a1 = r1c2，a2 = r2c2 |
  | 3 | 2×2 @ 1/2 | a3 = r2c1（主窗口正下方） |
  | 4 | 3 列 @ 1/3 开始长出 | a4 = r1c3 |
  | 5 | 3×2 @ 1/3 | a5 = r2c3 |

  3 agent 的例子就是：左列只有主窗口（半宽），右列上下两个 agent。6 个 pane（主 + 5 agent）是 3 列 × 2 行、每列 1/3。主窗口与 agent pane 等宽，不再有「主窗口 ≥ 50%」的特权。
- 不重排。agent 结束后留下空 slot；下次向该 tab spawn 时先填空 slot，再按上表增长。增长列数时允许对**现存** pane 做一次等宽 resize（从 1/2 收到 1/3），这是列数规则的一部分，不是「补洞重排」。
- herdr `pane split` 只有 `right` 和 `down`，外加 `ratio`；`pane resize` 与 `pane move` 可用。实现必须用这些原语拼出上表，不能假设 left/up split。
- 不在 spawn 后再强行保证「agent pane ≥ N 列」。网格已经限制最窄为 1/3；再抢主窗口宽度超出本 spec。
- spawn 工具与内部 launch 的 `wait` 分支保留在内部 API。工具层永远不传 `wait`。

### 工具层异步

- 从 spawn 工具参数表删除 `wait`（boolean | integer）。execute 不再把 wait 传给内部 spawn。
- 从 get-result 工具参数表删除 `wait`。execute 不传 wait，等价于单次读取。
- 两处 description 删掉「`wait: true` 会阻塞」的句子，改成永远后台 / 单次且可轮询。
- 不删除内部 `getAgentResult` 的等待循环。workflow host 对它传 `wait: true`，删了会拆掉 workflow。
- `herdr_run_workflow` 保持「脚本跑完再返回」。
- `herdr_wait_output` 保持阻塞匹配。

### Fleet widget

- 先通读 widget 的全部输出路径（header、数据行、footer、blocked callout），再改。不接受只贴 footer 的四行补丁当作完成。
- 框宽 `F` 满足 `F ≤ 终端宽度`。终端比 header 最小形状还窄时，`F` 取终端宽度，内容走截断，禁止把 `F` 抬回 `headerMin`。
- footer 与 header 一样经过按可见宽度截断，禁止用未截断的重复字符直接画出 `F - 2`。
- dash 计数在窄宽度下不得为负。
- 不给 herdr pane 设最小宽度作为第二道防线。

### 测试 seam

最高层、已有的 seam 有两个，不新开第三个产品入口：

1. **工具 schema / execute 参数**：现有离线 smoke（注册工具、读 `parameters`、调 execute）覆盖 `wait` 消失、`group` 出现、description 文案。execute 对 herdr 的调用保持可替换，断言传给内部 spawn / get-result 的参数里没有 `wait`。
2. **纯网格规划**：把「占用 slot + 空位 → 目标几何与下一步 split/resize」做成无 I/O 的规划函数，离线断言上表每一行。herdr 命令的真正发出仍走现有 spawn 编排；规划函数是为了不把几何规则埋进只在 live herdr 上才跑得动的路径。这是唯一新建的 seam，放在 spawn 编排调用 herdr 之前。
3. **widget 渲染**：沿用现有离线 widget 测试（直接渲染行、看可见宽度）。新增窄宽度用例（至少宽度 32 与宽度小于 header 最小形状），断言每一输出行可见宽度 ≤ 给定宽度。

## Testing Decisions

- 好测试只看外部行为：schema 形状、传给下游的参数、规划结果的 slot 坐标与列宽、渲染行的可见宽度。不断言 split 命令的字符串拼写，除非那是规划函数的公开输出。
- 先例：`tests/smoke.mjs` 与 `tests/modes.mjs` 的 schema 断言；`tests/widget.mjs` 的离线渲染；`tests/settings.mjs` 的 schema consistency。
- 网格：1 至 6 个占用、第 7 个换 tab、空 slot 复用、省略 group 与同 group 复用、不同 group 分 tab、queued 不占 slot。
- 异步：spawn 与 get-result 的 JSON schema 不含 `wait`；execute 不把 wait 传下去；workflow host 仍以等待方式调用内部 get-result（可用现有 host 测试或一条锁定调用形态的测试，避免回归时把内部等待一起删掉）。
- widget：宽度 32、以及宽度小于当前 header 最小宽度时，header/行/footer/callout 都不超宽；宽终端仍不超过传入宽度。
- `npm run typecheck` 与 `npm test`（离线、不依赖 herdr server）是合并门禁。live herdr 用例不作为本 spec 的完成条件。

## Out of Scope

- 改 `~/tools/pi-herdr` 或在本 spec 内执行 `pi install` / 改 settings.json。
- 给 spawn 增加 `direction`、`placement: new-tab`、`related: boolean`。组别只用 `group` 字符串。
- spawn 后把 pane 拉到固定最小列数。
- 给 herdr TUI 设 pane 最小宽度。
- agent 结束后紧凑重排（挪动仍然活着的 pane 去补洞）。
- 删除 workflow 的阻塞返回，或删除 `herdr_wait_output`。
- 删除内部 spawn / get-result 的 `wait` 实现。
- 向 pi 上游报告 TUI 崩溃（崩溃是宽度检查的正确行为）。
- 调研「AI agent 开发流程」或「如何写 skill」这两个被中断的旁支。
- 支持向左/向上 split（herdr CLI 没有这个方向）。

## Further Notes

- Grilling 已确认：两项都做且先考虑布局；改 fork；workflow 保留；`herdr_wait_output` 保留；widget 先穷举超宽路径再改；版本独立 commit 升到 0.6.0；两个 worktree 而不是三个。
- 下列是用户没点头、按推荐锁死的，实现时不要再发明第三种：
  - 填充序采用上表（agent 先占右列上、右列下，再占主窗口正下方，再向右加列），不是「先填主窗口下方」。
  - 不重排，只复用空 slot。
  - `group` 无 `"new"` 哨兵。
- 主窗口「等宽」与「主窗口更大」的矛盾已由用户裁决：永远等宽。3 个窗口 = 两列各 1/2（右列上下叠），6 个窗口 = 三列各 1/3。
- package.json 在改动前版本字符串仍是 `0.5.0`，HEAD 已是 v0.6 行为（workflows）。这是 bump 的原因，不是另一次功能发布。
- 发布：本仓库没有 `docs/agents/issue-tracker.md`。要变成 GitHub issue 并打 `ready-for-agent`，先跑 `/setup-rolex-skills`。在此之前本文件就是 spec 的唯一副本。
