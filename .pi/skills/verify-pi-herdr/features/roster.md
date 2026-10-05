# Roster

The Roster is the model-visible menu of addressable agent definitions. It renders one entry per name, the winning definition under session > project > global > built-in precedence, in fixed layer order, sorted by name. `src/agentdefs.ts` builds it (`effectiveRoster`, `renderRoster`); `registerAgents` attaches it to `herdr_spawn_agent`'s description through `prepareLoadout`.

## Sub-features

- `precedence` — first-hit-wins per name; project shadows global; built-in only when no file layer claims the name.
- `deterministic-render` — the same registry renders byte-identical output. Fixed layer order, code-point sort, lossless names, non-built-in descriptions flattened and capped at 512 UTF-8 bytes.

## How to get to it (user POV)

Open any pi session with the extension loaded. The `herdr_spawn_agent` tool description ends with the rendered roster. Names in it must round-trip as the spawn tool's `type` parameter.

## Driving it

No `verify.mjs` drive recipe exists for the roster (the spawn-result exchange does not assert roster output). Verify offline instead:

- `node tests/agentfiles.mjs` is the standing suite. It covers precedence (session > project > global > built-in), project shadows global, malformed files reported without killing the rest, and the agentDirs seam. Require it green.
- One-off render check through the same jiti seam:

```bash
node --input-type=module -e '
import { createJiti } from "jiti";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const jiti = createJiti(import.meta.url);
const agentdefs = await jiti.import("./src/spawn.ts");
const root = mkdtempSync(join(tmpdir(), "roster-"));
const mk = (dir, name, desc) => {
  writeFileSync(join(dir, name + ".md"), `---\nname: ${name}\ndescription: ${desc}\n---\nbody\n`);
};
const global = mkdtempSync(join(root, "g-")), project = mkdtempSync(join(root, "p-"));
mk(global, "shared", "global-desc");
mk(global, "only-global", "global-desc");
mk(project, "shared", "project-desc");
const dirs = { project, global };
const r1 = agentdefs.renderRoster(dirs);
const r2 = agentdefs.renderRoster(dirs);
if (r1 !== r2) throw new Error("render not deterministic");
if (!r1.includes('"shared": project-desc')) throw new Error("project did not shadow global");
if (!r1.includes('"only-global": global-desc')) throw new Error("global-only entry missing");
rmSync(root, { recursive: true, force: true });
console.log("roster ok");
'
```

Require the `roster ok` line. A live check (roster appears at the tail of `herdr_spawn_agent`'s description inside a real pi session) stays observational, not a gate.

## Gotchas

Session-layer entries come from the mutable in-memory registry, so a fresh process shows only file and built-in layers. The 512-byte description cap applies to non-built-in winners. Long descriptions do not fail the render, they truncate.
