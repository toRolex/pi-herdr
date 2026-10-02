// Offline tests for the equal-width spawn grid.
//
// Public seam: planGridPlacement / splitFor. Expectations are the spec
// table, not a re-implementation of the planner.
//
// Run: node tests/grid.mjs

import { createJiti } from "jiti";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const jiti = createJiti(import.meta.url);
const grid = await jiti.import(join(ROOT, "src/grid.ts"), { parent: ROOT });

let passed = 0;
let failed = 0;
function assert(cond, msg) {
	if (cond) {
		passed++;
		console.log(`  ✓ ${msg}`);
	} else {
		failed++;
		console.error(`  ✗ ${msg}`);
	}
}
const eq = (a, b, msg) =>
	assert(
		JSON.stringify(a) === JSON.stringify(b),
		`${msg} (got ${JSON.stringify(a)})`,
	);

const main = { id: "main", role: "main" };
const agent = (n) => ({ id: `a${n}`, role: "agent" });

console.log("\n[1] column count and the spec fill order");
{
	eq(
		grid.planGridPlacement({ occupied: [main], tabId: "t0" }),
		{
			tabId: "t0",
			columns: 1,
			rows: 1,
			assignments: [{ id: "main", row: 1, col: 1 }],
		},
		"1 slot is a single full-width column",
	);
	eq(
		grid.planGridPlacement({ occupied: [main, agent(1)], tabId: "t0" }),
		{
			tabId: "t0",
			columns: 2,
			rows: 1,
			assignments: [
				{ id: "main", row: 1, col: 1 },
				{ id: "a1", row: 1, col: 2 },
			],
		},
		"2 slots: main left, a1 right, columns of 1/2",
	);
	eq(
		grid.planGridPlacement({
			occupied: [main, agent(1), agent(2)],
			tabId: "t0",
		}),
		{
			tabId: "t0",
			columns: 2,
			rows: 2,
			assignments: [
				{ id: "main", row: 1, col: 1 },
				{ id: "a1", row: 1, col: 2 },
				{ id: "a2", row: 2, col: 2 },
			],
		},
		"3 slots: main left half, two agents stacked on the right",
	);
	eq(
		grid.planGridPlacement({
			occupied: [main, agent(1), agent(2), agent(3)],
			tabId: "t0",
		}),
		{
			tabId: "t0",
			columns: 2,
			rows: 2,
			assignments: [
				{ id: "main", row: 1, col: 1 },
				{ id: "a1", row: 1, col: 2 },
				{ id: "a2", row: 2, col: 2 },
				{ id: "a3", row: 2, col: 1 },
			],
		},
		"4 slots: a3 is under the main window",
	);
	eq(
		grid.planGridPlacement({
			occupied: [main, agent(1), agent(2), agent(3), agent(4)],
			tabId: "t0",
		}),
		{
			tabId: "t0",
			columns: 3,
			rows: 2,
			assignments: [
				{ id: "main", row: 1, col: 1 },
				{ id: "a1", row: 1, col: 2 },
				{ id: "a2", row: 2, col: 2 },
				{ id: "a3", row: 2, col: 1 },
				{ id: "a4", row: 1, col: 3 },
			],
		},
		"5 slots: three columns, a4 at the top of column 3",
	);
	eq(
		grid.planGridPlacement({
			occupied: [main, agent(1), agent(2), agent(3), agent(4), agent(5)],
			tabId: "t0",
		}),
		{
			tabId: "t0",
			columns: 3,
			rows: 2,
			assignments: [
				{ id: "main", row: 1, col: 1 },
				{ id: "a1", row: 1, col: 2 },
				{ id: "a2", row: 2, col: 2 },
				{ id: "a3", row: 2, col: 1 },
				{ id: "a4", row: 1, col: 3 },
				{ id: "a5", row: 2, col: 3 },
			],
		},
		"6 slots: 3 columns by 2 rows, each column 1/3",
	);
}

console.log("\n[2] a 7th occupant opens a new tab; holes are reused");
{
	const full = [main, agent(1), agent(2), agent(3), agent(4), agent(5)];
	eq(
		grid.planGridPlacement({
			occupied: full,
			incoming: agent(6),
			tabId: "t0",
			newTabId: "t1",
		}),
		{
			tabId: "t1",
			columns: 1,
			rows: 1,
			assignments: [{ id: "a6", row: 1, col: 1 }],
			openedTab: true,
		},
		"7th occupant is alone on a new tab",
	);
	eq(
		grid.planGridPlacement({
			occupied: [main, { ...agent(1), at: { row: 1, col: 2 } }],
			incoming: agent(9),
			tabId: "t0",
			holes: [{ row: 2, col: 2 }],
		}),
		{
			tabId: "t0",
			columns: 2,
			rows: 2,
			assignments: [
				{ id: "main", row: 1, col: 1 },
				{ id: "a1", row: 1, col: 2 },
				{ id: "a9", row: 2, col: 2 },
			],
		},
		"an empty slot is filled before the grid grows",
	);
	eq(
		grid.planGridPlacement({
			occupied: [{ ...agent(2), at: { row: 2, col: 2 } }, main],
			incoming: agent(9),
			tabId: "t0",
			holes: [{ row: 1, col: 2 }],
		}),
		{
			tabId: "t0",
			columns: 2,
			rows: 2,
			assignments: [
				{ id: "main", row: 1, col: 1 },
				{ id: "a2", row: 2, col: 2 },
				{ id: "a9", row: 1, col: 2 },
			],
		},
		"a hole in the middle is reused instead of growing",
	);
}

console.log("\n[3] split target keeps columns equal");
{
	const plan = grid.planGridPlacement({
		occupied: [main, { ...agent(1), at: { row: 1, col: 2 } }],
		incoming: agent(2),
		tabId: "t0",
	});
	const split = grid.splitFor(plan, "a2", [
		{ id: "main", at: { row: 1, col: 1 } },
		{ id: "p-a1", at: { row: 1, col: 2 } },
	]);
	eq(
		{
			paneId: split.paneId,
			direction: split.direction,
			ratio: split.ratio,
			at: split.at,
		},
		{
			paneId: "p-a1",
			direction: "down",
			ratio: 0.5,
			at: { row: 2, col: 2 },
		},
		"the second agent splits the first agent downward, half and half",
	);
	const wide = grid.planGridPlacement({
		occupied: [
			main,
			{ ...agent(1), at: { row: 1, col: 2 } },
			{ ...agent(2), at: { row: 2, col: 2 } },
			{ ...agent(3), at: { row: 2, col: 1 } },
		],
		incoming: agent(4),
		tabId: "t0",
	});
	const third = grid.splitFor(wide, "a4", [
		{ id: "main", at: { row: 1, col: 1 } },
		{ id: "p-a1", at: { row: 1, col: 2 } },
	]);
	eq(third.ratio, 0.5, "the remaining half is split in half");
	eq(third.direction, "right", "the third column splits right");
	eq(
		third.commands.map((c) => c.args.slice(0, 6).concat(c.args.slice(-2))),
		[
			[
				"pane",
				"resize",
				"--pane",
				"main",
				"--direction",
				"left",
				"--amount",
				String(1 / 6),
			],
		],
		"the left column shrinks by 1/6 of the tab first, so three columns end equal",
	);
}

console.log("\n[4] group tabs isolate capacity and holes");
{
	const groupFull = [
		{ ...agent(1), at: { row: 1, col: 1 } },
		{ ...agent(2), at: { row: 1, col: 2 } },
		{ ...agent(3), at: { row: 2, col: 2 } },
		{ ...agent(4), at: { row: 2, col: 1 } },
		{ ...agent(5), at: { row: 1, col: 3 } },
		{ ...agent(6), at: { row: 2, col: 3 } },
	];
	eq(
		grid.planGridPlacement({
			occupied: groupFull,
			incoming: agent(7),
			tabId: "g1",
			newTabId: "g2",
		}).tabId,
		"g2",
		"a group tab's 7th occupant opens another tab of that group",
	);
	const otherTabHole = grid.planGridPlacement({
		occupied: [{ ...agent(1), at: { row: 1, col: 1 } }],
		incoming: agent(2),
		tabId: "g1",
		holes: [],
	});
	eq(
		otherTabHole.assignments.find((a) => a.id === "a2"),
		{ id: "a2", row: 1, col: 2 },
		"with no hole on THIS tab the next agent grows, it does not borrow another tab",
	);
	const reused = grid.planGridPlacement({
		occupied: [{ ...agent(2), at: { row: 1, col: 2 } }],
		incoming: agent(8),
		tabId: "g1",
		holes: [{ row: 1, col: 1 }],
	});
	eq(
		reused.assignments.find((a) => a.id === "a8"),
		{ id: "a8", row: 1, col: 1 },
		"a hole on this group tab is filled before the grid grows",
	);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
