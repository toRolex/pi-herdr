// herdr_get_agent_result — the pull/inspection tool (v0.6 issue 04).
//
// For pi children this session spawned, the result source is the child's
// parent-owned session JSONL: the EXACT last assistant message — no screen
// scraping, no tail heuristics, no truncation ambiguity. The completion
// sidecar (`<session>.exit`, written by the injected child extension) is
// checked BEFORE pane status: an auto-exited autonomous child is already
// gone from the fleet when its typed sidecar lands, and `gone` must not
// swallow a finished result.
//
// The pane-tail reader (`agent read`) survives ONLY as fallback for panes
// without a session substrate — panes this session didn't spawn (adopted)
// and non-pi passthrough kinds (ticket 01 ruling; research §2). For spawned
// pi children it is never consulted.
//
// Statuses: the interim vocabulary IS the ten-state projection (07):
// queued | starting | active | running | waiting | blocked for mid-flight,
// done | error | gone as terminal answers (a pull that finds the result
// hands it over directly — superseding the fleet's `finalizing` in-flight
// label). `gone` is a valid terminal answer carrying last-known registry
// metadata; sessions are never deleted by pi-herdr, so a gone pane's
// session file (and its result) remains readable — only the live pane is
// lost.

import { readFileSync } from "node:fs";
import { validEventId } from "../completion-event.js";
import { DeliveryLedger, type DeliveryProof, type DeliveryRecord } from "../delivery-ledger.js";
import { inspectToolResultReceipt } from "../delivery-host.js";
import { parseExitSidecar } from "../sessionfile.js";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
	extractText,
	type Err,
	type HerdrErrorCode,
	type Result,
	type ToolReturn,
} from "../env.js";
import { herdr } from "../herdr.js";
import { getAgentStatus } from "./orchestration.js";
import {
	projectStatus,
	readActivityFile,
	type ActivityRead,
	type ProjectedStatus,
} from "../status.js";
import {
	extractSessionResult,
	minedAssistantError,
	readExitSidecar,
	type ExtractedResult,
	type ReadSidecarResult,
	type ExitSidecar,
} from "../sessionfile.js";
import { spawnRecords, type SpawnRecord } from "../spawn.js";
import {
	defaultInputWake,
	registerResultInputWake,
	waitForInputOrPoll,
	type InputWake,
} from "../inputwake.js";

// ---- engine types -------------------------------------------------------------

/** The result-tool status: the ten projected states plus the two terminal
 * pull answers (`done`/`error` — a pull that finds the result hands it over
 * directly). In practice `finalizing` is never ANSWERED — the sidecar branch
 * above supersedes the in-flight push label — but the view speaks the same
 * vocabulary as the fleet. */
export type ResultStatus = ProjectedStatus | "done" | "error";

/** Structured inspection payload (tool `details`). */
export interface ResultView {
	target: string;
	eventId?: string;
	agentId?: string;
	runId?: string;
	sequence?: number;
	/** Registry handle when the target is one of ours. */
	name?: string;
	kind?: string;
	type?: string;
	stance?: string;
	promptSubmission?: SpawnRecord["promptSubmission"];
	status: ResultStatus;
	/** `bash 7m` / `streaming 12s` — the activity snapshot's detail,
	 * rendered as `active · bash 7m`. */
	detail?: string;
	/** Exact final assistant message text (pi children; source session-jsonl). */
	result?: string;
	/** The full last assistant message object, verbatim from the session JSONL. */
	message?: unknown;
	/** True when the child is still running — this is a mid-flight snapshot. */
	interim?: boolean;
	/** Where the result text came from. */
	source: "session-jsonl" | "pane-tail" | "registry";
	/** Parent-owned session file + completion sidecar (pi children). */
	sessionPath?: string;
	exitPath?: string;
	/** Typed child failure (sidecar or mined off the last assistant message). */
	error?: { stopReason?: string; errorMessage: string };
	/** Pane-tail read metadata (fallback path only). */
	tail?: { truncated?: boolean };
	/** Last-known registry metadata for a pane that vanished (valid terminal). */
	lastKnown?: Record<string, unknown>;
	/** True when the target was never spawned by this session (adopted pane). */
	adopted?: boolean;
	note?: string;
	interruptedByInput?: true;
	reread?: true;
	acknowledged?: true;
	/** A claim proof accompanies the body only; receipts never carry bodyCommitted. */
	delivery?: DeliveryProof | { eventId: string; hostFile: string; status: DeliveryRecord["status"]; channel?: "push" | "pull"; token?: string };
}

export interface CompletionAck {
	eventId: string;
	agentId: string;
	runId: string;
	sequence: number;
	hostFile: string;
}

export interface GetResultParams {
	target: string;
	reread?: boolean;
	ack?: CompletionAck;
	wait?: boolean | number;
	lines?: number;
}

/** Injectable seams (offline red-green; defaults hit herdr + disk). */
export interface GetResultDeps {
	/** The session spawn registry — default: the LIVE spawnRecords(). */
	registry?: () => ReadonlyMap<string, SpawnRecord>;
	/** Live agent_status — default: getAgentStatus. */
	status?: (paneId: string) => Promise<Result<string>>;
	/** Pane-tail read (fallback) — default: `herdr agent read`. */
	readTail?: (
		target: string,
		lines: number,
	) => Promise<Result<{ text: string; truncated?: boolean }>>;
	/** Session-JSONL extraction — default: extractSessionResult. */
	extract?: (sessionPath: string) => ExtractedResult | null;
	/** Completion-sidecar read — default: readExitSidecar. */
	readSidecar?: (sessionPath: string) => ReadSidecarResult;
	/** Activity-sidecar read — default: readActivityFile (src/status.ts). */
	readActivity?: (activityPath?: string) => ActivityRead;
	sleep?: (ms: number) => Promise<void>;
	now?: () => number;
	pollMs?: number;
	/** Undefined uses the registered foreground scope; null is a background wait. */
	inputWake?: InputWake | null;
	signal?: AbortSignal;
	/** Both are required for consumption; absent host keeps the offline inspection API. */
	hostFile?: string;
	toolCallId?: string;
	onConfirmationError?: (error: Error, eventId: string) => void;
}

const TERMINAL: ReadonlySet<ResultStatus> = new Set([
	"done",
	"error",
	"blocked",
	"gone",
]);

const sleep = (ms: number): Promise<void> =>
	new Promise((r) => setTimeout(r, ms));

/** Build a non-ok Result with a normalized error code. */
function err(code: HerdrErrorCode, message: string, details?: unknown): Err {
	return { ok: false, error: { code, message, details } };
}

/** Last-known registry metadata, for `gone` answers. */
function lastKnownOf(record: SpawnRecord): Record<string, unknown> {
	return {
		name: record.name,
		kind: record.kind,
		type: record.type,
		stance: record.stance,
		depth: record.depth,
		spawnedAt: record.spawnedAt,
		startedAt: record.startedAt,
		lastStatus: record.lastStatus,
		startError: record.startError,
		worktreePath: record.worktreePath,
		...(record.sessionPath ? { sessionPath: record.sessionPath } : {}),
		...(record.activityPath ? { activityPath: record.activityPath } : {}),
	};
}

/** Common envelope fields for a registry target (status filled per path). */
function viewBase(
	target: string,
	record: SpawnRecord,
): Omit<ResultView, "status"> {
	return {
		target,
		name: record.name,
		kind: record.kind,
		type: record.type,
		stance: record.stance,
		promptSubmission: record.promptSubmission,
		source: "registry",
		...(record.sessionPath
			? {
					sessionPath: record.sessionPath,
					exitPath: `${record.sessionPath}.exit`,
				}
			: {}),
	};
}

/** Read the activity sidecar through the injectable seam. */
function activityOf(record: SpawnRecord, deps: GetResultDeps): ActivityRead {
	return (deps.readActivity ?? readActivityFile)(record.activityPath);
}

/** The shared interim projection for a LIVE pane: one call into the 07
 * projection so the pull tool and the fleet can't drift apart. */
function interimProjection(
	record: SpawnRecord,
	deps: GetResultDeps,
	live?: string,
): { status: ResultStatus; detail?: string } {
	return projectStatus(record, {
		live,
		absent: false,
		unhealthy: live === undefined,
		sidecar: false, // the sidecar branch above already handled done/error
		activity: activityOf(record, deps),
		now: (deps.now ?? (() => Date.now()))(),
	});
}

/**
 * One inspection pass over a registry record: sidecar first (a finished
 * auto-exited child is `gone` in the fleet but `done`/`error` here), then
 * live pane status, then the session JSONL for interim/final pi results.
 */
async function inspectRecord(
	target: string,
	record: SpawnRecord,
	deps: GetResultDeps,
	lines: number,
): Promise<ResultView> {
	const base = { ...viewBase(target, record), agentId: record.agentId, runId: record.runId, sequence: record.sequence };
	const isPi = record.kind.toLowerCase() === "pi" && Boolean(record.sessionPath);
	const extract = deps.extract ?? extractSessionResult;
	const readSidecar = deps.readSidecar ?? readExitSidecar;

	// 1. typed sidecar — the child's own terminal declaration.
	if (isPi && record.sessionPath) {
		const sidecar = readSidecar(record.sessionPath);
		if (sidecar.state === "ok") {
			Object.assign(base, { eventId: sidecar.sidecar.eventId });
			const extracted = extract(record.sessionPath);
			if (sidecar.sidecar.type !== "persistence-error" && sidecar.sidecar.eventId && (!sidecar.sidecar.text?.trim() && !(sidecar.sidecar.type === "done" && sidecar.sidecar.structured?.trim()))) {
				return { ...base, status: "error", note: "governance failure: completion declaration has no final body" };
			}
			if (sidecar.sidecar.type === "persistence-error") {
				return { ...base, status: "error", source: "session-jsonl", error: { errorMessage: sidecar.sidecar.errorMessage }, note: "governance failure: completion was not durably saved" };
			}
			if (sidecar.sidecar.type === "done") {
				return {
					...base,
					status: "done",
					source: "session-jsonl",
					...(sidecar.sidecar.text || sidecar.sidecar.structured ? { result: sidecar.sidecar.text ?? sidecar.sidecar.structured } : {}),
					...(extracted
						? { result: sidecar.sidecar.text ?? sidecar.sidecar.structured ?? extracted.text, message: extracted.message }
						: {
								note:
									"sidecar is done but the session file holds no assistant message yet",
							}),
				};
			}
			return {
				...base,
				status: "error",
				source: "session-jsonl",
				error: {
					...(sidecar.sidecar.stopReason
						? { stopReason: sidecar.sidecar.stopReason }
						: {}),
					errorMessage: sidecar.sidecar.errorMessage,
				},
				...(extracted ? { message: extracted.message } : {}),
			};
		}
		// invalid/missing: not evidence — fall through to live status.
	}

	// 2. no pane ever started.
	if (record.startError) {
		return {
			...base,
			status: "gone",
			lastKnown: lastKnownOf(record),
			note: `the pane never started: ${record.startError}`,
		};
	}
	if (!record.paneId) return { ...base, status: "queued" };

	// 3. live pane status (coarse authority until 07's projection).
	const statusOf = deps.status ?? getAgentStatus;
	const live = await statusOf(record.paneId);
	if (!live.ok) {
		const code = live.error.code;
		const inner = (live.error.details as { code?: string } | undefined)?.code;
		if (code === "NOT_FOUND" || inner === "agent_not_found") {
			// The pane vanished. Race the sidecar once more (auto-exit writes it
			// just before shutdown): a done/error sidecar still wins over gone.
			if (isPi && record.sessionPath) {
				const sidecar = readSidecar(record.sessionPath);
				if (sidecar.state === "ok" && sidecar.sidecar.type === "done") {
					const extracted = extract(record.sessionPath);
					return {
						...base,
						status: "done",
						source: "session-jsonl",
						...(extracted
							? { result: extracted.text, message: extracted.message }
							: {}),
					};
				}
				if (sidecar.state === "ok" && sidecar.sidecar.type === "persistence-error") {
					return { ...base, status: "error", source: "session-jsonl", error: { errorMessage: sidecar.sidecar.errorMessage }, note: "governance failure: completion was not durably saved" };
				}
				if (sidecar.state === "ok" && sidecar.sidecar.type === "error") {
					return {
						...base,
						status: "error",
						source: "session-jsonl",
						error: {
							...(sidecar.sidecar.stopReason
								? { stopReason: sidecar.sidecar.stopReason }
								: {}),
							errorMessage: sidecar.sidecar.errorMessage,
						},
					};
				}
			}
			return {
				...base,
				status: "gone",
				lastKnown: lastKnownOf(record),
				...(isPi && record.sessionPath
					? (() => {
							// The pane died without a sidecar. If its last word was a
							// failed attempt, that failure IS the terminal answer —
							// more informative than a bare gone.
							const extracted = extract(record.sessionPath);
							const mined = extracted && minedAssistantError(extracted.message);
							if (mined && extracted) {
								return {
									status: "error" as const,
									source: "session-jsonl" as const,
									message: extracted.message,
									error: {
										stopReason: mined.stopReason,
										errorMessage: mined.errorMessage,
									},
									note: "pane died after a failed attempt; no sidecar was written",
								};
							}
							return {
								note: "pane is gone; its session file remains readable (pi --session) — no completion sidecar was written",
							};
						})()
					: {}),
			};
		}
		// transient herdr error — the projected last-known-live view (the
		// activity sidecar still tells the truth even when the CLI hiccups)
		const proj = interimProjection(record, deps);
		return {
			...base,
			status: proj.status,
			...(proj.detail ? { detail: proj.detail } : {}),
			interim: true,
			note: `pane status unavailable (${live.error.message})`,
		};
	}
	record.lastStatus = live.data;

	// blocked: an ask-user overlay — not a result; steering is the answer.
	if (live.data === "blocked") return { ...base, status: "blocked" };

	if (live.data === "idle" || live.data === "done") {
		const settled = record.submitted || record.sawWorking;
		if (!settled) return { ...base, status: "starting" };
		// settled with an unconsumed result — pi children: read the JSONL.
		if (isPi && record.sessionPath) {
			const extracted = extract(record.sessionPath);
			if (record.runId && record.stance === "autonomous") return { ...base, status: "waiting", interim: true, result: extracted?.text, note: "no durable terminal declaration; text is only an interim snapshot" };
			if (extracted) {
				const mined = minedAssistantError(extracted.message);
				if (mined && record.stance === "autonomous") {
					// A failed attempt on a LIVE autonomous pane is not yet
					// exhaustion: the child's grace window lets pi retry. Keep
					// polling (non-terminal projected state); the typed payload
					// rides along so callers see the truth.
					const proj = interimProjection(record, deps, live.data);
					return {
						...base,
						status: proj.status,
						...(proj.detail ? { detail: proj.detail } : {}),
						interim: true,
						source: "session-jsonl",
						message: extracted.message,
						result: extracted.text,
						error: { stopReason: mined.stopReason, errorMessage: mined.errorMessage },
						note: "last attempt failed; the child may still retry — wait for the sidecar or pane exit",
					};
				}
				if (mined) {
					// Interactive children never write a sidecar and never
					// auto-exit: a settled error is final for them.
					return {
						...base,
						status: "error",
						source: "session-jsonl",
						message: extracted.message,
						error: { stopReason: mined.stopReason, errorMessage: mined.errorMessage },
					};
				}
				return {
					...base,
					status: "done",
					source: "session-jsonl",
					result: extracted.text,
					message: extracted.message,
				};
			}
			return {
				...base,
				status: "done",
				source: "session-jsonl",
				note: "no assistant message in the session file yet",
			};
		}
		// Non-pi children have no session substrate — the pane-tail fallback is
		// the only result source for them (ticket 01 §5).
		return inspectAdopted(target, deps, lines, base);
	}

	// working/unknown: mid-flight — the projected vocabulary (07), with the
	// message-so-far for pi children. (The completion sidecar was already
	// checked above, so `sidecar: false` here is accurate, not an omission.)
	const proj = interimProjection(record, deps, live.data);
	const view: ResultView = {
		...base,
		status: proj.status,
		...(proj.detail ? { detail: proj.detail } : {}),
		interim: true,
	};
	if (isPi && record.sessionPath) {
		const extracted = extract(record.sessionPath);
		if (extracted) {
			view.source = "session-jsonl";
			view.result = extracted.text;
			view.message = extracted.message;
			view.note = "mid-flight snapshot — the child is still running";
		}
	}
	return view;
}

/** Consumption never reads session assistant drafts, even when the pane is settled or gone. */
async function consumeResult(params: GetResultParams, deps: GetResultDeps): Promise<Result<ResultView>> {
	if (params.reread && params.ack) return err("VALIDATION_ERROR", "reread and ACK are mutually exclusive");
	if (!deps.toolCallId) return err("VALIDATION_ERROR", "completion consumption requires a tool call id");
	if (deps.signal?.aborted) return err("TIMEOUT", "aborted");
	try { readFileSync(deps.hostFile!, "utf8"); }
	catch { return err("VALIDATION_ERROR", "completion consumption requires a readable host session file; no body was claimed"); }
	const registry = (deps.registry ?? spawnRecords)();
	const record = registry.get(params.target) ?? [...registry.values()].find(r => r.paneId === params.target);
	if (!record && validEventId(params.target)) {
		for (const candidate of registry.values()) {
			if (candidate.kind.toLowerCase() !== "pi" || !candidate.sessionPath) continue;
			let saved;
			try { saved = parseExitSidecar(readFileSync(`${candidate.sessionPath}.completion-${params.target}.json`, "utf8")); }
			catch { continue; }
			if (saved.ok && saved.sidecar.eventId === params.target &&
				(!candidate.agentId || saved.sidecar.agentId === candidate.agentId)) {
				return consumeSidecar(params.target, candidate, saved.sidecar, deps, params);
			}
		}
	}
	if (!record || record.kind.toLowerCase() !== "pi") {
		if (params.ack || params.reread) return err("VALIDATION_ERROR", "explicit reread/ACK requires a durable pi completion event");
		return { ok: true, data: await inspectAdopted(params.target, deps, params.lines ?? 80, record ? viewBase(params.target, record) : undefined) };
	}
	const base = { ...viewBase(params.target, record), agentId: record.agentId, runId: record.runId, sequence: record.sequence };
	if (!record.sessionPath) return { ok: true, data: { ...base, status: "error", note: "governance failure: spawned pi child has no session substrate" } };
	const read = (): ExitSidecar | undefined => {
		const result = (deps.readSidecar ?? readExitSidecar)(record.sessionPath!);
		if (result.state !== "ok") return undefined;
		const sidecar = result.sidecar;
		if ((record.runId && sidecar.runId !== record.runId) ||
			(record.agentId && sidecar.agentId !== record.agentId) ||
			(record.sequence !== undefined && sidecar.sequence !== record.sequence)) return undefined;
		return sidecar;
	};
	const first = read();
	if (first) return consumeSidecar(params.target, record, first, deps, params);
	if (params.ack || params.reread) return err("VALIDATION_ERROR", "explicit reread/ACK refused: no matching durable terminal event");
	if (record.startError) return { ok: true, data: { ...base, status: "gone", lastKnown: lastKnownOf(record), note: `the pane never started: ${record.startError}` } };
	if (!record.paneId) return { ok: true, data: { ...base, status: "queued", interim: true } };
	const live = await (deps.status ?? getAgentStatus)(record.paneId);
	if (deps.signal?.aborted) return err("TIMEOUT", "aborted");
	const raced = read();
	if (raced) return consumeSidecar(params.target, record, raced, deps, params);
	if (!live.ok && (live.error.code === "NOT_FOUND" || (live.error.details as { code?: string } | undefined)?.code === "agent_not_found")) {
		return { ok: true, data: { ...base, status: "gone", lastKnown: lastKnownOf(record), note: "no durable terminal declaration; no draft was read" } };
	}
	if (live.ok) record.lastStatus = live.data;
	const projected = interimProjection(record, deps, live.ok ? live.data : undefined);
	return { ok: true, data: { ...base, ...projected, interim: true, note: "no durable terminal declaration; status only, no draft was read" } };
}

function consumeSidecar(target: string, record: SpawnRecord, sidecar: ExitSidecar, deps: GetResultDeps, params: GetResultParams): Result<ResultView> {
	const base = { ...viewBase(target, record), agentId: sidecar.agentId, runId: sidecar.runId, sequence: sidecar.sequence, eventId: sidecar.eventId };
	if (sidecar.type === "persistence-error") {
		if (params.ack || params.reread) return err("VALIDATION_ERROR", "explicit reread/ACK requires a durably saved completion");
		return { ok: true, data: { ...base, status: "error", note: "governance failure: completion was not durably saved" } };
	}
	const body = sidecar.text?.trim() ? sidecar.text : sidecar.type === "done" && sidecar.structured?.trim() ? sidecar.structured : undefined;
	if (!validEventId(sidecar.eventId) || !body) {
		if (params.ack || params.reread) return err("VALIDATION_ERROR", "explicit reread/ACK requires a durable event id and final body");
		return { ok: true, data: { ...base, status: "error", note: "governance failure: completion declaration has no durable event id or final body" } };
	}
	const ledger = new DeliveryLedger(deps.hostFile!);
	const ref = { eventId: sidecar.eventId, agentId: sidecar.agentId, runId: sidecar.runId, sequence: sidecar.sequence, sessionPath: record.sessionPath };
	if (params.reread) return { ok: true, data: { ...base, status: sidecar.type, source: "session-jsonl", result: body, reread: true, note: "explicit reread of the original completion; not a new delivery" } };
	if (params.ack) {
		const ack = params.ack;
		if (!ref.agentId || !ref.runId || ref.sequence === undefined || ack.hostFile !== deps.hostFile || ack.eventId !== ref.eventId || ack.agentId !== ref.agentId || ack.runId !== ref.runId || ack.sequence !== ref.sequence) return err("VALIDATION_ERROR", "ACK agent/run/sequence/event or receiver host mismatch");
		const acknowledged = ledger.acknowledge(ref);
		return { ok: true, data: { ...base, status: sidecar.type, acknowledged: true, delivery: { eventId: ref.eventId, hostFile: ledger.hostFile, status: acknowledged.status }, note: "caller declared handled; no claim that the model read or understood the body" } };
	}
	const claimed = ledger.claimPull(ref, deps.toolCallId!);
	if (!claimed.bodyAllowed) {
		return { ok: true, data: { ...base, status: sidecar.type, delivery: { eventId: sidecar.eventId, hostFile: ledger.hostFile, status: claimed.record.status, channel: claimed.record.channel, token: claimed.record.token }, note: "completion body already claimed; status reference only" } };
	}
	return { ok: true, data: { ...base, status: sidecar.type, source: "session-jsonl", result: body, delivery: ledger.proof(claimed.record), ...(sidecar.type === "error" ? { error: { stopReason: sidecar.stopReason, errorMessage: sidecar.errorMessage } } : {}) } };
}

/**
 * get_agent_result, end to end. Single-shot unless `wait` is set: true =
 * until terminal (done/error/blocked/gone — waiting through the queue), a
 * number = bounded, current state on expiry.
 */
export async function getAgentResult(
	params: GetResultParams,
	deps: GetResultDeps = {},
): Promise<Result<ResultView>> {
	if (deps.hostFile) return consumeResult(params, deps);
	if (params.ack || params.reread) return err("VALIDATION_ERROR", "explicit reread/ACK requires a receiving host session");
	const now = deps.now ?? (() => Date.now());
	const pollMs = deps.pollMs ?? 1_500;
	const wait = params.wait;
	let wake: InputWake | null | undefined;
	if (wait) wake = deps.inputWake === undefined ? defaultInputWake() : deps.inputWake;
	const epoch = wake?.epoch ?? 0;
	let deadline: number;
	if (wait === true) deadline = Infinity;
	else if (typeof wait === "number") deadline = now() + wait;
	else deadline = now();

	for (;;) {
		if (deps.signal?.aborted) return err("TIMEOUT", "aborted");
		const lines = params.lines ?? 80;
		const record = (deps.registry ?? spawnRecords)().get(params.target);
		if (!record && validEventId(params.target)) {
			for (const candidate of (deps.registry ?? spawnRecords)().values()) {
				if (!candidate.sessionPath) continue;
				try {
					const saved = parseExitSidecar(readFileSync(`${candidate.sessionPath}.completion-${params.target}.json`, "utf8"));
					if (saved.ok && saved.sidecar.type !== "persistence-error" && saved.sidecar.eventId === params.target && (saved.sidecar.text || (saved.sidecar.type === "done" && saved.sidecar.structured))) {
						return { ok: true, data: { target: params.target, eventId: saved.sidecar.eventId, agentId: saved.sidecar.agentId, runId: saved.sidecar.runId, sequence: saved.sidecar.sequence, status: saved.sidecar.type, source: "session-jsonl", sessionPath: candidate.sessionPath, result: saved.sidecar.text ?? (saved.sidecar.type === "done" ? saved.sidecar.structured : undefined) } };
					}
				} catch { /* not an event in this retained session */ }
			}
		}
		if (!record) {
			// paneId match — a handle is the addressable key, but callers may
			// pass the pane id they got back from spawn.
			const byPane = [...(deps.registry ?? spawnRecords)().values()].find(
				(r) => r.paneId && r.paneId === params.target,
			);
			if (byPane)
				return {
					ok: true,
					data: await inspectRecord(byPane.name, byPane, deps, lines),
				};
			return { ok: true, data: await inspectAdopted(params.target, deps, lines) };
		}
		const view = await inspectRecord(params.target, record, deps, lines);
		if (deps.signal?.aborted) return err("TIMEOUT", "aborted");
		if (TERMINAL.has(view.status) || now() >= deadline)
			return { ok: true, data: view };
		if (wake && wake.epoch !== epoch) {
			return {
				ok: true,
				data: {
					...view,
					interim: true,
					interruptedByInput: true,
					note: "Input arrived while waiting. Handle the queued message before waiting again.",
				},
			};
		}
		if (wake) {
			await waitForInputOrPoll(
				wake, epoch, Math.min(pollMs, Math.max(0, deadline - now())), deps.signal,
			);
		} else await (deps.sleep ?? sleep)(pollMs);
	}
}

/**
 * The fallback: a pane this session did not spawn (adopted) — or any target
 * the registry does not know, or a spawned NON-pi kind (no session substrate).
 * Pane-tail reading only; never used for spawned pi children.
 */
async function inspectAdopted(
	target: string,
	deps: GetResultDeps,
	lines = 80,
	base?: Omit<ResultView, "status">,
): Promise<ResultView> {
	const readTail =
		deps.readTail ??
		(async (t: string, n: number) => {
			const r = await herdr<unknown>(
				[
					"agent",
					"read",
					t,
					"--source",
					"recent",
					"--lines",
					String(n),
					"--format",
					"text",
				],
				{ timeoutMs: 15_000, signal: deps.signal, textOk: true },
			);
			if (!r.ok) return r;
			return {
				ok: true as const,
				data: {
					text: extractText(r.data),
					truncated: Boolean((r.data as { truncated?: boolean })?.truncated),
				},
			};
		});
	const r = await readTail(target, lines);
	if (!r.ok)
		return {
			...(base ?? { target, source: "registry" as const }),
			status: "gone",
			adopted: !base,
		};
	return {
		...(base ?? { target, source: "registry" as const }),
		status: "running",
		source: "pane-tail",
		adopted: !base,
		result: r.data.text,
		tail: { truncated: r.data.truncated },
		note: base
			? "pane-tail fallback: this non-pi child has no session file to read exactly"
			: "pane-tail fallback: this pane was not spawned by pi-herdr, so there is no session file to read exactly",
	};
}

// ---- registration -------------------------------------------------------------

function fail(r: Err): ToolReturn {
	return {
		content: [
			{ type: "text", text: `Error (${r.error.code}): ${r.error.message}` },
		],
		details: { error: r.error },
		isError: true,
	};
}

/** Render a ResultView as the tool's text + error flag. */
function render(view: ResultView): ToolReturn {
	if (view.reread) return { content: [{ type: "text", text: `Explicit reread of completion ${view.eventId} — original final message:\n\n${view.result}` }], details: view };
	if (view.acknowledged) return { content: [{ type: "text", text: `Completion ${view.eventId} ACK: caller declared handled; this does not claim model reading or understanding. No body returned.` }], details: view };
	if (view.delivery && !("bodyCommitted" in view.delivery)) {
		return {
			content: [{ type: "text", text: `Completion ${view.eventId} is ${view.delivery.status} via ${view.delivery.channel ?? "unclaimed"}; this call is a status reference, not another body delivery.` }],
			details: view,
		};
	}
	const result = renderStatus(view);
	if (view.promptSubmission === "uncertain") {
		result.content.push({ type: "text", text: "Prompt submission uncertain: the task was pasted once; it was not pasted again. Inspect the pane before retrying." });
	}
	return result;
}

function renderStatus(view: ResultView): ToolReturn {
	const label = view.name ?? view.target;
	const where = view.sessionPath ? ` (session: ${view.sessionPath})` : "";
	switch (view.status) {
		case "done":
			return {
				content: [
					{
						type: "text",
						text: view.result
							? `Agent "${label}" finished — exact final message:\n\n${view.result}`
							: `Agent "${label}" finished, but no assistant message was found in its session file.${where}`,
					},
				],
				details: view,
			};
		case "error": {
			const msg = view.error?.errorMessage ?? view.note ?? "child failed";
			return {
				content: [
					{
						type: "text",
						text: `Agent "${label}" FAILED: ${msg}${where}${view.result ? `\n\n${view.result}` : ""}`,
					},
				],
				details: view,
				isError: true,
			};
		}
		case "queued":
			return {
				content: [
					{
						type: "text",
						text: `Agent "${label}" is still queued (fleet at max_parallel_agents) — no pane yet.`,
					},
				],
				details: view,
			};
		case "blocked":
			return {
				content: [
					{
						type: "text",
						text: `Agent "${label}" is BLOCKED on a question. Answer freeform with herdr_message_agent (the raw text becomes its answer); option lists take herdr_send_keys — see herdr_list_agents.`,
					},
				],
				details: view,
			};
		case "active": {
			const detail = view.detail ? ` (${view.detail})` : "";
			return {
				content: [
					{
						type: "text",
						text: view.result
							? `Agent "${label}" is active${detail} — interim snapshot of its latest message so far:\n\n${view.result}`
							: `Agent "${label}" is active${detail} — no assistant message yet.`,
					},
				],
				details: view,
			};
		}
		case "running":
			return {
				content: [
					{
						type: "text",
						text: view.result
							? `Agent "${label}" is still running — interim tail of its output:\n\n${view.result}`
							: `Agent "${label}" is still running (coarse status — no activity snapshot for this kind).`,
					},
				],
				details: view,
			};
		case "waiting":
			return {
				content: [
					{
						type: "text",
						text: `Agent "${label}" is waiting — settled with its pane intentionally open (interactive stance or mid-conversation).`,
					},
				],
				details: view,
			};
		case "starting":
			return {
				content: [
					{
						type: "text",
						text: `Agent "${label}" is starting up (boot window — the prompt may not be in yet).`,
					},
				],
				details: view,
			};
		case "stalled":
			return {
				content: [
					{
						type: "text",
						text: `Agent "${label}" looks STALLED (its activity snapshot has been unusable while the pane reports working). It may still recover — steer with herdr_message_agent or keep polling.`,
					},
				],
				details: view,
			};
		case "gone":
		default: {
			const known = view.lastKnown
				? ` Last-known: ${Object.entries(view.lastKnown)
						.filter(([, v]) => v !== undefined)
						.map(([k, v]) => `${k}=${String(v)}`)
						.join(", ")}.`
				: "";
			const resume = view.sessionPath
				? ` Its session file is retained (${view.sessionPath}) — readable and resumable; nothing was lost.`
				: "";
			return {
				content: [
					{
						type: "text",
						text: `Agent "${label}" is gone (no live pane).${resume}${known}${view.note ? ` ${view.note}` : ""}`,
					},
				],
				details: view,
			};
		}
	}
}

export function registerResultTool(pi: ExtensionAPI, deps: GetResultDeps = {}): void {
	registerResultInputWake(pi);
	const pending = new Map<string, { hostFile: string; toolCallId: string; proof: DeliveryProof }>();
	const confirmPending = (): void => {
		for (const [key, candidate] of pending) {
			const { hostFile, toolCallId, proof } = candidate;
			const receipt = inspectToolResultReceipt(() => hostFile, toolCallId, message => {
				const delivery = (message.details as ResultView | undefined)?.delivery;
				return delivery !== undefined && "bodyCommitted" in delivery && delivery.bodyCommitted === true &&
					delivery.eventId === proof.eventId && delivery.token === proof.token &&
					delivery.hostFile === hostFile && delivery.channel === "pull";
			});
			if (receipt.status !== "persisted") continue;
			try {
				const record = new DeliveryLedger(hostFile).reconcile(proof.eventId);
				if (record?.status === "delivered" || record?.status === "acked") pending.delete(key);
			} catch (error) {
				const failure = error instanceof Error ? error : new Error(String(error));
				if (deps.onConfirmationError) deps.onConfirmationError(failure, proof.eventId);
				else console.error(`pi-herdr completion ${proof.eventId}: disk receipt exists but ledger confirmation failed; claim retained`, failure.message);
			}

		}
	};
	// These boundaries follow tool-result append; tool_result itself is only a candidate.
	pi.on("turn_end", confirmPending);
	pi.on("agent_settled", confirmPending);
	pi.registerTool({
		name: "herdr_get_agent_result",
		label: "Get herdr agent result",
		description:
			"Consume an agent's result — for agents you spawned with herdr_spawn_agent. " +
			"For pi children, only a durable completion event can deliver the full final body once. " +
			"Mid-flight calls report status without reading drafts; already claimed events return status references. " +
			"Use reread:true to explicitly review the original full body without changing its identity or delivery state. " +
			"Use ack with event/agent/run/sequence and receiver hostFile to declare handled without receiving the body; ACK is not proof of reading or understanding. Unknown pending submissions must first be durably confirmed. " +
			"Waiting is a separate tool: herdr_wait_agent_event returns only the event reference — never block or poll this tool for arrival. " +
			"For panes this session did not spawn (or non-pi kinds) it falls back to pane-tail reading. " +
			"A gone pane still answers with its last-known metadata; its session file stays readable and resumable. " +
			"Single-shot and never blocks: one call, one snapshot. Poll by calling again.",
		promptSnippet: "Consume an agent's result (exact final message for pi children)",
		promptGuidelines: [
			"Use herdr_get_agent_result to fetch a spawned agent's result — it returns the exact final assistant message, not a screen scrape.",
			"Wait for event availability with herdr_wait_agent_event first; herdr_get_agent_result consumes the body and never waits.",
			"A 'gone' result still carries last-known metadata and the retained session path; sessions are never deleted.",
		],
		parameters: Type.Object({
			target: Type.String({
				description:
					"Spawn handle, pane id, or immutable completion eventId (including a retained older run).",
			}),
			reread: Type.Optional(Type.Boolean({ description: "Explicitly reread the immutable final body, including after ACK; not a new delivery." })),
			ack: Type.Optional(Type.Object({
				eventId: Type.String(), agentId: Type.String(), runId: Type.String(),
				sequence: Type.Integer({ minimum: 1 }), hostFile: Type.String({ description: "Exact receiving session file from the result reference." }),
			}, { description: "Caller declares this completion handled. No body returned; not evidence of reading or understanding." })),
			lines: Type.Optional(
				Type.Integer({
					description:
						"Pane-tail line budget for the non-spawned fallback (default 80).",
				}),
			),
		}),
		async execute(id, p, signal, _update, ctx) {
			const hostFile = ctx?.sessionManager?.getSessionFile();
			if (!hostFile) return fail(err("VALIDATION_ERROR", "completion consumption requires a host session file"));
			try {
				confirmPending();
				const r = await getAgentResult(
					{ target: p.target, lines: p.lines, reread: p.reread, ack: p.ack },
					{ ...deps, hostFile, toolCallId: id, signal },
				);
				if (!r.ok) return fail(r);
				const delivery = r.data.delivery;
				if (delivery && "bodyCommitted" in delivery) {
					pending.set(JSON.stringify([hostFile, delivery.eventId]), { hostFile, toolCallId: id, proof: delivery });
				}
				return render(r.data);
			} catch (error) {
				return fail(err("VALIDATION_ERROR", `completion governance failure: ${error instanceof Error ? error.message : String(error)}`));
			}
		},
	});
}
