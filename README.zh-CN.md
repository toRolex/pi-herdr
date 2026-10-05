# pi-herdr

[English](README.md) | [简体中文](README.zh-CN.md)

一个 [pi](https://pi.dev) 扩展，在可见的 [herdr](https://herdr.dev) 终端窗格中协调 AI 代理。你可以在 pi 会话中启动代理、发送后续消息并获取结果。每个子代理都是独立 CLI 进程，可以查看并干预。

本仓库是 [AndrewJacop/pi-herdr](https://github.com/AndrewJacop/pi-herdr) 的 [toRolex/pi-herdr](https://github.com/toRolex/pi-herdr) fork。扩展当前版本为 **1.0.0**，独立应用 herdr 要求 **0.9.0 或更新版本**。两者版本号不是同一回事。

## 环境要求

- Node.js 22.19.0 或更新版本，见 [package.json](package.json)。
- 可用的 pi 安装，且至少配置一个已认证模型。配置方式见 [pi](https://pi.dev)。子 pi 进程使用你的 pi 配置。
- 单独从 [herdr.dev](https://herdr.dev) 安装 herdr 0.9.0 或更新版本，确保在 `PATH` 中且服务正在运行。
- 如需启动其他代理种类，先安装对应 CLI。可用种类取自 herdr 实时种类列表。

检查环境，并从终端启动 herdr：

```bash
node --version
pi --version
herdr --version
herdr status
herdr
```

macOS 上通过 launchd 或 `brew services` 启动的 herdr 服务可能缺少 shell 的 `PATH`，导致依赖 Node 的子代理无法启动。如果启用了该服务，用 `brew services stop herdr` 仅停止 herdr，再从终端启动 `herdr`。重新连接旧服务不会修复它的环境。

扩展在启动和 reload 时检查 herdr 版本。缺少二进制或无法启动 herdr CLI 时返回 `HERDR_UNAVAILABLE`。其他 CLI 或服务故障可能返回 `VALIDATION_ERROR` 或 `TIMEOUT`。低于版本下限时返回 `HERDR_TOO_OLD`。

## 从 Git 安装

通过 pi 的 Git 源支持安装此 fork：

```bash
pi install git:github.com/toRolex/pi-herdr
```

安装后重启 pi 或执行 `/reload`。加载第三方扩展前先审查其代码。

也可以使用本地 checkout：

```bash
git clone https://github.com/toRolex/pi-herdr.git
cd pi-herdr
pi install ./
```

从 checkout 启动一次仅加载此扩展的 pi：

```bash
pi -ne -e ./src/index.ts
```

不要同时加载已安装副本和 checkout 副本。Git 安装命令使用仓库默认分支。要试用尚未合并的改动，先在本地切到对应分支，再加载 checkout。

## 快速开始

在项目中确认 herdr 正在运行，启动 pi，然后提出任务：

```text
启动名为 summ 的代理，将 README.md 总结为三条。
完成通知到达后，把结果交给我。
```

对应的 spawn 参数为：

```json
{
	"name": "summ",
	"prompt": "将 README.md 总结为三条。"
}
```

`herdr_spawn_agent` 立即返回已接受的 handle，以及 `starting` 或 `queued`。`starting` 不保证子代理已经启动完成。`queued` 表示并发额度已满，尚无窗格。

完成结果稍后按通知设置送达。要检查当前状态，可以调用 `herdr_list_agents`，或用以下参数调用 `herdr_get_agent_result`：

```json
{ "target": "summ" }
```

每次 result 调用只返回一次快照，不等待完成。公开 spawn 和 result 工具均不接受 `wait` 参数。

## 工具

默认注册 **12 个工具**；加载时若 `workflows_enabled: false`，则为 **11 个**。注册入口为 [src/index.ts](src/index.ts)。执行 `node tests/smoke.mjs` 可验证默认工具列表。

| 工具 | 参数与合同 |
| --- | --- |
| `herdr_spawn_agent` | 必填 `prompt`。可选 `type` 或内联 `agent`，不能同时提供。另接受 `name`、`kind`、`model`、`thinking`、`fork`、`agent_args`、`cwd`、`isolated`、`group`。立即返回接受状态，不是完成结果。 |
| `herdr_save_agent` | `type` 与内联 `agent` 必须二选一。`target` 默认为 `project`，也可为 `global`。覆盖已有文件需 `overwrite: true`。保存不受 spawn kill-switch 限制。 |
| `herdr_get_agent_result` | `target` 为 spawn handle 或窗格 ID。可选 `lines`，默认 80，仅限制回退窗格输出。返回单次快照，不阻塞等待。 |
| `herdr_message_agent` | 必填 `target` 与 `text`。`submit` 默认 true；false 仅输入文字，不按 Enter。送达不证明模型已消费消息。 |
| `herdr_interrupt_agent` | `target` 解析为本会话启动的 pi 子代理。用 Escape 取消当前回合，不终止进程。 |
| `herdr_resume_agent` | `target` 必须为保留的 spawn handle，不是文件路径。可选 `message` 给已消失的 pi 子代理新任务。 |
| `herdr_list_agents` | 无参数。本会话子代理显示推导状态，其他窗格保留 herdr 的粗粒度状态。 |
| `herdr_run_workflow` | 优先使用 `scriptPath`，其次 `script`，最后已保存的 `name`。另接受 JSON 形态的 `args` 和 `resumeFromRunId`。返回后台 run ID 与脚本路径。 |
| `herdr_run_command` | 必填 `paneId` 与 `command`。在已有原始窗格输入 shell 命令并按 Enter。 |
| `herdr_read_pane` | 必填 `paneId`。`source` 为 `recent`、`visible` 或 `recent-unwrapped`。默认 `recent`、`lines: 50`、`format: "text"`。格式也可为 `ansi`。 |
| `herdr_wait_output` | 必填 `paneId`，以及字面量 `match` 或 Rust `regex` 之一。可选 `source`、`lines`、`timeoutMs`、`raw`。先搜索已有输出，再等待匹配。默认超时 30000 毫秒。 |
| `herdr_send_keys` | 必填 `target` 与非空逻辑键名数组 `keys`。`agentScope: true` 用代理名或 label 寻址，否则使用原始窗格 ID。`ctrl+c` 等按键可能中断进程。 |

schema 与实现见 [src/tools](src/tools)。窗格、tab、workspace 和手动 worktree 管理仍由 herdr UI 或 CLI 提供，不是额外的模型工具。

### 代理定义与路由

registry 优先级依次为会话内联定义、项目 `.pi/agents/*.md`、全局 `~/.pi/agent/agents/*.md`、内置定义。内置类型为 `general-purpose`、`Explore`、`Plan`。省略 `type` 和 `agent` 时，也通过此 registry 解析 `general-purpose`。`Explore` 和 `Plan` 是只读搜索及规划代理。

内联 `agent` 接受 `name`、`description`、`kind`、`model`、`thinking`、`system_prompt`、`prompt_mode`、`tools`、`exclude_tools`、`skills`、`agent_args`、`session_mode`、`auto_exit`、`interactive`、`spawning`、`cwd`。`prompt_mode` 默认为 `replace`，也可为 `append`。定义文件用 frontmatter 的 `session-mode`、`auto-exit`、`deny-tools`、`args` 表示对应内联字段。未知 frontmatter 键会被忽略。

模型按以下五级顺序解析：

1. Spawn 的 `model`。
2. 定义的 `model`。
3. `models.agents.<definition-name>`。
4. `models.default`。
5. 父会话模型。

模型 ID 必须是 pi registry 中精确、已认证的 `provider/model-id`。非法路由会指出值来自哪一级。Spawn 的显示 `name` 不用于选择定义名模型 pin。

Thinking **只取 spawn 的 `thinking`，其次定义的 `thinking`**。不继承父会话 thinking，也不取 settings 的模型 pin。两者都未设置时，子代理使用自己的默认值。接受 `off`、`minimal`、`low`、`medium`、`high`、`xhigh`、`max`。显式 thinking pin 仅支持 pi。

`kind` 通过 herdr 的 `agent start --kind` 选择 CLI。所选种类无法落实的字段会导致拒绝。非 pi 子代理没有 pi 的会话文件、精确结果或 resume 保证。原始 `agent_args` 追加在定义参数之后，后面的 flag 优先。

### 会话、隔离与布局

Pi 子代理使用父会话持有的 session 文件，并加载注入的子扩展。窗格关闭后文件仍保留，在 pi `/resume` 中显示为 `herdr/<name>`。

- `standalone` 为默认值，新会话且无父子关联。
- `lineage-only` 仅添加 `parentSession` header 链接，不复制对话。
- `fork` 复制父会话对话，截断于父会话最后一条用户消息之前。Spawn 的 `fork: true` 覆盖定义的 `session_mode`。复制会增加上下文 token 成本，且只是快照，不是实时共享内存。若无可读父 session 文件，磁盘内容为空，但所选模式仍报告为 `fork`。

子代理默认 autonomous，完成后关闭窗格。用 `agent: { interactive: true }` 或 `agent: { auto_exit: false }` 保持窗格打开以继续交互。这些字段属于定义，不是 spawn 顶层参数。

`isolated: true` 创建 herdr 侧 Git worktree，不能与 `cwd` 同用。代理退出后 worktree 保留，不再需要时另行删除。超过 2000 字符的 prompt 使用保留的 `<session>.task.md` 文件。

Spawn 门禁按 kill-switch、spawn depth、parallel cap 顺序执行。超过并发额度时，已接受的 spawn 进入队列。

创建窗格时读取布局设置：

- `grid` 为默认值，最多三列等宽、两行，每个 tab 六个存活窗格。在 orchestrator 的 tab 中，主窗格也占一个位置。第七个窗格进入新 tab。
- 省略 `group` 时使用 orchestrator 的 tab。Grid 模式下，同一 `group` 使用同名 tab；满员后新增一页，后续子代理优先填最早有空位的同组页面。空 group 视为省略。
- `spiral` 交替向右、向下分割，已有窗格保留较大份额。Spiral 模式忽略 `group`。

修改 `layout_mode` 只影响之后新建的窗格，不移动已有窗格。

### 结果、消息与恢复

本会话启动的 pi 子代理从保留的 session JSONL 读取精确最终 assistant 文本，不抓屏。运行中的响应为 interim 快照，失败暴露带类型的错误。非 pi 子代理与其他会话启动的窗格回退到可能截断的 pane-tail 输出。

消息先解析窗格 ID 或 herdr 名称，再解析 spawn handle。保留角色 `orchestrator` 只指发送者的直接父，同名 agent 不能抢占。普通消息使用 `<agent-message from="…" to="…">` 包装，身份由 spawner 声明，不经过验证。

阻塞的自由文本问题通过 `herdr_message_agent` 接收原始回答；选项列表问题通过 `herdr_send_keys` 接收逻辑按键。排队中的子代理没有可接收消息的窗格，已消失目标会拒绝投递。

Interrupt 仅支持本会话启动且仍存活的 pi 子代理，拒绝非 pi、排队、已空闲和已消失的子代理。中断后用 `herdr_message_agent` 调整任务。已消失的 pi 子代理可用 handle 和新 `message` 调用 `herdr_resume_agent`。Resume 复用保留的 session 文件，并按当前 settings 重新解析定义与路由。没有 message 时，恢复的子代理仅回放会话并保持空闲，不恢复进程内存状态。

完成通知携带完整最终消息。`normal` 唤醒父会话，`quiet` 在下一次自然回合投递，`none` 禁用完成推送。阻塞子代理会唤醒父会话，但人类已接管窗格时除外。人类在子窗格输入会禁用自动关闭，并抑制对话中的推送。子代理空闲后，持续安静达到 `idle_rearm_minutes`，最新结果按通知设置投递，窗格关闭。`notifications: "none"` 时仍关闭窗格，但不推送结果。任意按键重置计时。

循环等待修复**仅影响内部前台 result wait**。新输入使该内部等待提前返回带 `interruptedByInput` 的 interim 快照，不 abort 无关工具。公开 result 检查仍为单次快照。后台 workflow 等待显式使用 `inputWake: null`，继续等待子代理完成。

### 后台 workflow

`herdr_run_workflow` 立即返回。脚本在沙箱中运行，结束后父会话收到一次聚合结果。子代理完成消息交给 run，不分别向父会话推送完成消息；阻塞子代理仍请求关注。

示例 `script` 值：

```javascript
export const meta = { name: "parallel-review", description: "审查两个文件" };
const results = await parallel([
	() => agent("审查 src/inputwake.ts", { label: "review-input" }),
	() => agent("审查 src/tools/result.ts", { label: "review-result" }),
]);
return results.filter(Boolean);
```

沙箱提供 `agent`、`parallel`、`pipeline`、`phase`、`log`、`args`、`budget` 和嵌套 `workflow`，不提供文件系统、网络或 `eval`。`Date.now()`、无参数的 `new Date()`、`Math.random()` 会抛错。子代理仅支持 pi，并经过相同 spawn 门禁。

`agent` 选项包括 `label`、`phase`、`agentType`、精确 `model`、`effort`、`isolation: "worktree"`、shell 命令 `gate`、以此前 workflow 子代理的 `label` 作为 `resume`、结构化输出 `schema`。Label 必须以小写字母开头，仅包含小写字母、数字、连字符或下划线。失败调用返回 `null`。每次启动都必须 await。`parallel` 有汇合屏障，`pipeline` 连通各阶段但没有整阶段屏障。嵌套 workflow 限一层。`budget.total` 始终为 `null`；`budget.spent()` 返回输出 token 用量，无法恢复用量时为 `Infinity`。

内联脚本自动保存到 `.pi/workflows/<meta.name>.js`。内容不同时使用数字后缀，项目目录不可写时回退到临时 scratch。保存的名称依次从 `.pi/workflows/`、`.agents/workflows/`、全局代理目录的 `workflows/` 解析。

迭代时编辑返回的文件，并用 `scriptPath` 再运行。`resumeFromRunId` 重放同会话此前 run 的未变前缀，变化或失败的调用及其后缀重新运行。若此前 journal 含任一代理 resume 调用，该 run 的所有调用均不重放。Workflow 不跨越父会话生命周期。禁用 workflow 只拒绝新 run，不停止正在运行的 run。

## 设置

执行 `/subagents` 或 `/subagents config` 打开菜单，编辑 settings，也可使用需确认的 **Kill all agents**。不存在 `/subagents set key value` 命令。

设置合并自全局 `~/.pi/agent/herdr.json` 和项目 `.pi/herdr.json`。项目逐键优先，`models.agents` 按定义名合并。格式错误的文件会报告并忽略，菜单不会覆盖该文件。

| 设置 | 默认值 | 作用 |
| --- | --- | --- |
| `agents_kill_switch` | `false` | 拒绝新 spawn，不终止已有子代理。 |
| `default_kind` | `"pi"` | 默认 CLI 种类。 |
| `models.default` | 未设置 | 在父模型之前使用的回退模型。 |
| `models.agents` | `{}` | 从代理定义名到模型 ID 字符串的映射。 |
| `max_parallel_agents` | `3` | 超额 spawn 排队。 |
| `max_spawn_depth` | `2` | 限制递归启动。 |
| `notifications` | `"normal"` | `normal`、`quiet` 或 `none`。 |
| `idle_rearm_minutes` | `15` | 人类接管后，代理空闲时的安静时长。 |
| `workflows_enabled` | `true` | 加载时决定是否注册。随后禁用会拒绝新 run；改变工具注册列表需 reload。 |
| `layout_mode` | `"grid"` | `grid` 或 `spiral`，用于新建窗格。 |

Spawn 门禁、模型路由和通知在使用时读取对应设置。`idle_rearm_minutes` 在启动时传给子代理。`HERDR_BIN` 覆盖二进制路径，`PI_HERDR_NO_SELF_REPORT=1` 在该 pi 进程中禁用 self-report。

## 限制与平台支持

- 上游报告已在 Windows 和 macOS 测试，Linux 尚未验证。herdr 自身平台支持需另行核实。
- Self-report 仅支持 pi；其他 CLI 依赖 herdr TUI 检测和内部状态轮询。
- 保留的 session 记录对话，不记录所有进程内存。非 pi 结果不是精确 session 文件读取。
- 启动子代理需要可用 CLI、模型认证及服务环境。接受 spawn 不证明启动成功。

## 本地开发

在 checkout 中安装**本地开发依赖**后执行仓库脚本。以下命令用于开发，不是扩展分发渠道：

```bash
npm install
npm test
npm run typecheck
npm run test:live
npm run test:multi
npm run test:stress
```

`npm test` 运行离线测试。Live、多代理和压力测试需要正在运行的 herdr 服务及可用模型认证。TypeScript 直接加载，不需要 build。修改后重启 pi 或 reload。参阅 [CONTRIBUTING.md](CONTRIBUTING.md) 和[文档索引](docs/README.md)。

## 归属与许可

本 fork 保留上游项目的 [MIT 许可](LICENSE)，© Andrew。

Workflow 核心来自 [tintinweb/pi-subagents](https://github.com/tintinweb/pi-subagents)，使用 MIT 许可。移植模块包括 `src/workflow` 中的 `runtime.ts`、`worker-source.ts`、`meta.ts`、`journal.ts`、`saved.ts`、`progress.ts`、`json-schema.ts`，以及子代理 `StructuredOutput` 工具。卡片布局参考其 `workflow-card.ts`。源码 header 记录移植来源与修改。Host 集成、run 生命周期、卡片模块及工具注册是 pi-herdr 代码；保留上游未 await 启动的报错文本。
