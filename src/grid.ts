// Equal-width spawn grid. Pure: no herdr I/O.
//
// A tab holds at most 3 columns and 2 rows. Columns are always equal
// (1, 1/2, or 1/3 of the tab). The main window, when present, is r1c1 and
// is not wider than any agent column. Agents fill column 2 top-to-bottom,
// then the cell under the main window, then column 3 top-to-bottom.
// A 7th live occupant opens a new tab. A recorded hole is filled before
// the grid grows.

export interface GridCell {
	row: 1 | 2;
	col: 1 | 2 | 3;
}

export interface GridSeat {
	tabId: string;
	at: GridCell;
}

export function createGridTabArgs(workspace?: string, label?: string, env: Record<string, string> = {}): string[] {
	return ["tab", "create", ...(workspace ? ["--workspace", workspace] : []), ...(label ? ["--label", label] : []), "--no-focus", ...Object.entries(env).flatMap(([key, value]) => ["--env", `${key}=${value}`])];
}

export interface GridOccupant {
	id: string;
	role: "main" | "agent";
	/** Where this occupant already sits. Absent on a brand-new occupant. */
	at?: GridCell;
}

export interface GridAssignment extends GridCell {
	id: string;
}

/** One herdr command the launcher runs before `pane split`. */
export interface LayoutCommand {
	args: string[];
}

/** Where the next agent pane is split from, and the equal-width ratio
 * of that split. `commands` run first (open a tab, focus a pane). */
export interface SplitTarget {
	paneId?: string;
	direction: "right" | "down";
	ratio: number;
	commands: LayoutCommand[];
	/** Coordinate to remember once the pane exists. */
	at: GridCell;
	tabId: string;
}

export interface GridPlan {
	tabId: string;
	columns: 1 | 2 | 3;
	rows: 1 | 2;
	assignments: GridAssignment[];
	openedTab?: boolean;
}

/** Fill order after the pinned main cell. */
const AGENT_SLOTS: GridCell[] = [
	{ row: 1, col: 2 },
	{ row: 2, col: 2 },
	{ row: 2, col: 1 },
	{ row: 1, col: 3 },
	{ row: 2, col: 3 },
];

function shape(count: number): { columns: 1 | 2 | 3; rows: 1 | 2 } {
	if (count <= 1) return { columns: 1, rows: 1 };
	if (count === 2) return { columns: 2, rows: 1 };
	if (count <= 4) return { columns: 2, rows: 2 };
	return { columns: 3, rows: 2 };
}

function place(occupied: GridOccupant[], holes: GridCell[]): GridAssignment[] {
	const main = occupied.find((o) => o.role === "main");
	const agents = occupied.filter((o) => o.role !== "main");
	const assignments: GridAssignment[] = [];
	if (main) assignments.push({ id: main.id, row: 1, col: 1 });
	const taken = new Set(assignments.map(key));
	for (const agent of agents) {
		if (agent.at && !taken.has(key(agent.at))) {
			assignments.push({ id: agent.id, ...agent.at });
			taken.add(key(agent.at));
		}
	}
	const slots = [
		...holes,
		...(main ? AGENT_SLOTS : UNPINNED_SLOTS),
	];
	for (const agent of agents) {
		if (assignments.some((a) => a.id === agent.id)) continue;
		const slot = slots.find((s) => !taken.has(key(s)));
		if (!slot) continue;
		assignments.push({ id: agent.id, ...slot });
		taken.add(key(slot));
	}
	return assignments;
}

function key(cell: GridCell): string {
	return `${cell.row}:${cell.col}`;
}

/** A tab with no main window fills the same geometry from the top left. */
const UNPINNED_SLOTS: GridCell[] = [
	{ row: 1, col: 1 },
	{ row: 1, col: 2 },
	{ row: 2, col: 2 },
	{ row: 2, col: 1 },
	{ row: 1, col: 3 },
	{ row: 2, col: 3 },
];

export interface GridPlacementInput {
	occupied: GridOccupant[];
	incoming?: GridOccupant;
	tabId: string;
	/** Coordinate left empty by a closed pane. Filled before the grid grows. */
	holes?: GridCell[];
	/** Id to use when `occupied` is already a full 6 and `incoming` needs a tab. */
	newTabId?: string;
}

const CAP = 6;

export function planGridPlacement(input: GridPlacementInput): GridPlan {
	const { occupied, incoming, holes } = input;
	// The main pane counts toward the same six-cell cap.
	if (incoming && occupied.length >= CAP) {
		return {
			tabId: input.newTabId ?? input.tabId,
			columns: 1,
			rows: 1,
			assignments: [{ id: incoming.id, row: 1, col: 1 }],
			openedTab: true,
		};
	}
	const people = incoming ? [...occupied, incoming] : occupied;
	const assignments = place(people, holes ?? []);

	return { tabId: input.tabId, ...shape(people.length), assignments };
}

/**
 * The herdr split that lands `incoming` on the cell `planGridPlacement`
 * assigned it. Splits only go right or down, so a cell under an existing
 * pane splits that pane downward; a cell to the right splits the pane on
 * its left. Ratio is the new pane's share of the split pair, which keeps
 * every column the same width.
 */
export function splitFor(
	plan: GridPlan,
	incomingId: string,
	panes: { id: string; at: GridCell }[],
): SplitTarget | undefined {
	const cell = plan.assignments.find((a) => a.id === incomingId);
	if (!cell) return undefined;
	if (plan.openedTab || panes.length === 0) {
		// A full tab has nowhere to split. The command opens the tab; the
		// launcher attaches the agent to that tab's shell pane.
		const commands: LayoutCommand[] = plan.openedTab
			? [{ args: createGridTabArgs() }]
			: [];
		return {
			direction: "right",
			ratio: 0.5,
			commands,
			at: { row: cell.row, col: cell.col },
			tabId: plan.tabId,
		};
	}
	const left = panes.find((p) => p.at.row === cell.row && p.at.col === cell.col - 1);
	const above = panes.find((p) => p.at.col === cell.col && p.at.row === cell.row - 1);
	// The cell directly under the assignment. Splitting it downward grows
	// BELOW it, so it is only an anchor when that is where the assignment is.
	const below = panes.find((p) => p.at.col === cell.col && p.at.row === cell.row + 1);
	const right = panes.find((p) => p.at.row === cell.row && p.at.col === cell.col + 1);
	const anchor = above ?? below ?? right ?? left ?? panes[0];
	const direction = above || below ? "down" : "right";
	const commands: LayoutCommand[] = [];
	// herdr only splits right or down. Landing in a cell that already has an
	// occupant under it means the split created the pane in the wrong cell;
	// swapping the two puts the newcomer where the plan assigned it.
	const swap = below ?? (!above ? right : undefined);
	if (swap) {
		commands.push({
			args: ["pane", "swap", "--panes", `${swap.id},{new}`],
		});
	}
	let ratio = 0.5;
	if (direction === "right" && !right && plan.columns === 3 && left) {
		// Two equal columns become three. The leftmost pane of this row shrinks
		// by 1/6 of the tab (amount is an absolute ratio delta) so it keeps
		// 1/3; splitting what remains in half gives the other two columns 1/3.
		const edge = panes.find((p) => p.at.row === cell.row && p.at.col === 1) ?? left;
		commands.push({
			args: ["pane", "resize", "--pane", edge.id, "--direction", "left", "--amount", String(1 / 6)],
		});
	}
	return {
		paneId: anchor?.id,
		direction,
		ratio,
		commands,
		at: { row: cell.row, col: cell.col },
		tabId: plan.tabId,
	};
}
