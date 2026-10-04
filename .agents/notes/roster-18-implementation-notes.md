# #18 Roster description 预算 — implementation notes

## 交付内容
`renderRoster`（src/agentdefs.ts）新增 `renderDescription`：非 built-in 胜出定义的 description
1. 压平：`\s+`（Unicode 空白/行分隔符也包含）→ 单空格 + trim（单行条目）。
2. 转义：残余 C0 控制（U+0000–U+001F）+ DEL/C1（U+007F–U+009F）→ `\u00xx` 固定宽文本。
3. 预算：512 UTF-8 字节（`ROSTER_DESC_BUDGET_BYTES`），含转义膨胀与省略标记 `…`（U+2026，3 字节）；超限按 code-point 边界截断（不拆代理对/多字节字符），`for…of` 逐 code point 累计 `Buffer.byteLength`。
- 名字绝不 trim/截断（JSON 字符串无损渲染，round-trip `type`）。
- built-in 例外仅当胜出层 === "built-in"（effectiveRoster 的 entry.layer）；同名覆盖不得豁免。
- 全量菜单契约不变：无总预算/条目上限/omitted 计数。
- 确定性：纯函数，同输入同字节；不含时间戳等不稳定输入。

## 决策与因果
- **压平 vs 转义分层**：第一版把控制字符与空白合并在一个 flatten regex 里（都会变空格），被自己写的 Bell 测试抓住——spec 同时要求"压平空白"和"转义控制字符"，控制字符必须以 `\u0007` 形式可见而非吞掉。改为只压平 \t\n\r\f\v 和空格，其余控制字符走转义。
- **标记选 `…`（3 字节）**：预算按字节计，选单字符多字节标记简单且省预算；budget = 512 - 3，逐 code point 贪心填充。
- **转义在截断之前**：先转义再截断，保证预算天然计入转义膨胀（转义只发生在残留控制字符上，而这些字符不会被多字节截坏——转义产物全是 ASCII）。
- **`entryLine` 闭包坑**：测试里 read-at-use 断言用旧 `menu` 常量而不是重新调 `menu18()`，导致两条断言假失败。修测试（entryLine 改传 menu 参数），非实现 bug。
- **`md()` helper 的 `JSON.stringify(undefined)`**：占位符测试把字符串 "undefined" 写进了 frontmatter，description 键意外存在。改为 desc===undefined 时省略该键。

## TDD 证据
- 原会话 `/Users/rolex/.pi/agent/sessions/--Users-rolex-Documents-Codes-githubProject-MyProject-pi-herdr.roster-ticket-18--/2026-10-04T19-32-48-773Z_a180a48b-9099-43c8-8bf6-b219237e3d8a.jsonl`：原实现前 239/248（含 helper 问题），实现后 246/248，修 helper 后 248/248（行75）。原全套输出被 shell 管道过滤，不当作完整验收证据。提取日志 `/tmp/roster-spec-context/ticket18-prior-tdd.log`。
- 收尾 Unicode 空白回归：NBSP/em-space/U+2028/U+2029 应变普通空格；red 248/249，最小修复 `/\s+/gu`，green 249/249。日志 `ticket18-unicode-{red,green}.log`。
- 收尾 C1 控制回归：U+0085/U+009F 仍裸露；red 249/250，扩至 DEL/C1，最终 green 256/256。日志 `ticket18-controls-{red,green}.log`。
- 删除永真 `|| true` 断言，改完整条目字面量。内置例外以 fixture 完整 Explore (>512B) 验证，不再用 Plan 子串。名字夹具改为 >512B CJK + 首尾空白/引号/换行，并原样 resolve。
- 验已有通过行为：emoji code-point 边界、转义后恰好512B不误截、转义膨胀和 marker 计入预算、session 胜出同预算、40条长描述全量显示。未为这些既有通过行为声称新的 red。
- 收尾全套 `npm test`（package.json 17个脚本）exit=0；`npm run typecheck` exit=0。完整 `/tmp/roster-spec-context/ticket18-npm-test.log`、`ticket18-typecheck.log`。
- 全部运行以 spawnSync 独立 env 删除 **所有** `PI_HERDR_*`；日志头 remaining=0、尾真实退出码，无管道掩盖状态。未执行 live/stress，不声称真实 TUI 验证。

## 收尾范围与因果
- 收尾现有 `llsklnoy / 40744d03`，不是首次实现 feature；父节点已为 integration tip `f72bf30e`，无需 rebase。
- 已读 #14/#18、orchestration、GLOSSARY、TDD 指南；不存在 docs/adr/。身份 rolex / torolex@163.com 已核对；沿用 orchestration secret scan，无新增敏感文件。
- Unicode/C1 的改动仅修现有实现遗漏；维持先 whitespace 后 escaping，避免吞 bell。
- 模型可见 header 明确 small trusted registries / no total budget or entry cap / large-directory overhead not promised，落实 #18 第六项规模契约；非新机制。
- 子代理只读复核被 max_spawn_depth=3 拒绝，本会话复核；未改配置或绕过限制。
- 完成后 `roster-ticket-18` 移至 `@`；不 push、不 close、不修改 main。

## 未偏离 spec
无 Deviations。seam 唯一（prepareLoadout→renderRoster），未新增机制，未问用户。
