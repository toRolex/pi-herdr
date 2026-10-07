// The injected child extension (v0.6 issue 04) — loaded into spawned pi
// children via `-e <this file>` (same channel any extension rides; the spawn
// engine appends the flag). It gives a herdr-fleet child its substrate:
//
//   - `agent_done` — the child-side completion declaration: writes the
//     completion sidecar (`<session>.exit`, `{type:"done"}`) and exits. The
//     child's final assistant message is its delivered result (the parent
//     extracts it from the session JSONL — this tool carries no payload).
//   - session naming `herdr/<spawn-name>` at boot, so fleet sessions are
//     identifiable in /resume and never masquerade as the user's own.
//   - typed completion sidecar on auto-exit: `{type:"done"}`, or
//     `{type:"error", errorMessage, stopReason}` mined off the last assistant
//     message (provider-overload retry-exhaustion reaches the parent as a
//     typed failure, not a mystery).
//   - auto-exit on `agent_settled` for autonomous-stance children —
//     `agent_settled`, NOT `agent_end`, is the definitive idle signal (pi may
//     auto-retry/compact/continue after agent_end; mapping matches
//     src/selfreport.ts). Interactive children never auto-close.
//   - the identity/tools strip (`[scout] — 12 tools · 4 denied (Ctrl+H)`)
//     above the child's editor — a human walking into the pane sees what
//     they're in; Ctrl+H expands the full tool list. (The prior art used
//     Ctrl+J; pi binds ctrl+j to tui.input.newLine and ctrl+k to
//     tui.editor.deleteToLineEnd — ctrl+h is unbound.)
//
// Everything keys off the parent-stamped env (PI_HERDR_* namespace; the
// coinstallable prior art uses PI_SUBAGENT_* — no collisions, research §11).
// Without PI_HERDR_SESSION this extension is a no-op, so loading it in a
// non-child pi (or an adopted session) is harmless.

import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { resetCompletionEvent } from "./completion-event.js";
import { parseTriggerTurn } from "./agent-message.js";
import { closeSync, existsSync, fsyncSync, openSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
	assistantText,
	parseSessionEntries,
	refuseBareDone,
} from "./sessionfile.js";
import { compileJsonSchema, type CompiledSchema } from "./workflow/json-schema.js";
import type { ActivitySnapshot } from "./status.js";

/** Session file path — presence marks this pi as a herdr-spawned child. */
export const ENV_SESSION = "PI_HERDR_SESSION";
/** The spawn handle (pane name). */
export const ENV_NAME = "PI_HERDR_NAME";
/** Registry type the child was spawned from ("" for anonymous inline). */
export const ENV_AGENT = "PI_HERDR_AGENT";
/** "1" = autonomous stance (auto-exit on settle). Unset = interactive. */
export const ENV_AUTO_EXIT = "PI_HERDR_AUTO_EXIT";
/** Comma list of denied tools (for the identity strip count). */
export const ENV_DENIED_TOOLS = "PI_HERDR_DENIED_TOOLS";
/** Activity sidecar path — issue 07: written by the child-side activity
 * recorder, read by the orchestrator's poll loop (current tool, streaming —
 * what makes `active · bash 7m` possible). */
export const ENV_ACTIVITY_FILE = "PI_HERDR_ACTIVITY_FILE";

/** Schema file for a structured-output child (issue 14): the workflow host
 * writes the compiled JSON Schema to the workflow scratch dir and stamps this
 * env var with its path — a path, not inline JSON (Windows env-block limits).
 * Set only for `agent(prompt, { schema })` children of a workflow run. */
export const ENV_SCHEMA = "PI_HERDR_SCHEMA";
/** Root orchestrator session file (issue 39). Stamped at spawn so a
 * completion sidecar can name the session that may adopt an orphan. */
export const ENV_ROOT_SESSION = "PI_HERDR_ROOT_SESSION";

/** What the child produced, filled in as StructuredOutput is called.
 * PORTED from upstream `structured-output.ts` (MIT) — the capture box the
 * host reads via the completion sidecar. */
export interface StructuredCapture {
	/** The last payload that validated, canonical JSON. Absent until one does. */
	json?: string;
	/** Why the most recent attempt was rejected, for the error text. */
	lastError?: string;
	/** Whether the tool was called at all — "never tried" reads differently. */
	called: boolean;
}

export function createStructuredCapture(): StructuredCapture {
	return { called: false };
}

/** Claude Code's tool name, kept verbatim — a ported prompt that mentions
 * `StructuredOutput` is still telling the truth. */
export const STRUCTURED_OUTPUT_TOOL_NAME = "StructuredOutput";

/**
 * The synthetic tool behind `agent(prompt, { schema })` — PORTED from
 * upstream `structured-output.ts` (MIT), adapted to pi-herdr's env channel
 * (the schema arrives as a file path, not in-process state).
 *
 * pi has no forced toolChoice, so this is pressure, not guarantee: the
 * caller's schema IS the parameters (providers that can constrain sampling
 * hold the payload to it), the description demands the call, and an
 * off-schema payload is answered with `isError` so the model self-corrects
 * inside the same run. The host-side re-check (applySchema) is the actual
 * guarantee, and the host's one resume prompt is the backstop.
 */
export function createStructuredOutputTool(
	compiled: CompiledSchema,
	capture: StructuredCapture,
): ToolDefinition {
	return {
		name: STRUCTURED_OUTPUT_TOOL_NAME,
		label: "Structured Output",
		description:
			"Report your final answer. Call this exactly once, with the complete result, and put everything the " +
			"caller needs inside the arguments — text written outside this call is discarded. If a call is " +
			"rejected for not matching the schema, fix the reported fields and call it again.",
		promptSnippet: "Report your final answer as structured data",
		promptGuidelines: [
			"Your final answer MUST be reported by calling StructuredOutput. Prose outside that call is discarded.",
		],
		// The caller's schema is the tool's input schema, verbatim — that is
		// what makes the provider fill the fields. pi types this as typebox's
		// TSchema, which v1 defines as an open interface, so a plain JSON
		// Schema satisfies it at runtime; the cast is shape-level only.
		parameters: compiled.schema as never,
		async execute(_id, params) {
			capture.called = true;
			const verdict = compiled.check(params);
			if (verdict !== true) {
				capture.lastError = verdict;
				// isError puts the reason in front of the model as a tool result,
				// so it can correct itself inside this same run.
				return {
					content: [{
						type: "text",
						text: `StructuredOutput did not match the required schema:\n${verdict}\nCall it again with a corrected value.`,
					}],
					isError: true,
					details: {},
				};
			}
			// Last valid call wins: a model that calls twice meant the second one.
			capture.json = JSON.stringify(params);
			capture.lastError = undefined;
			return { content: [{ type: "text", text: "Recorded." }], details: {} };
		},
	};
}

/** A minimal shape of the agent messages this extension inspects. */
export interface AgentMessageLike {
	role?: unknown;
	stopReason?: unknown;
	errorMessage?: unknown;
	[k: string]: unknown;
}

/**
 * Whether a settled run should close an autonomous child. Manual input does
 * not strand the stance: the decision is whether the latest settled run
 * completed normally. `stopReason: "aborted"` stays OPEN (a human interrupted
 * — leave the pane for inspection or another prompt); `stopReason: "error"`
 * still exits (paired with the error sidecar so the parent learns it was a
 * failure, not a clean completion).
 */
export function shouldAutoExitOnSettle(
	messages: AgentMessageLike[] | undefined,
): boolean {
	if (messages) {
		for (let i = messages.length - 1; i >= 0; i--) {
			const msg = messages[i];
			if (msg?.role === "assistant") return msg.stopReason !== "aborted";
		}
	}
	return true;
}

/**
 * If the latest assistant message ended with `stopReason: "error"` (typically
 * auto-retry exhausted on an overload / rate limit / server error), return
 * its mined error info. Null when it completed normally or was aborted.
 */
export function findLatestAssistantError(
	messages: AgentMessageLike[] | undefined,
): { errorMessage: string; stopReason: "error" } | null {
	if (!messages) return null;
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg?.role !== "assistant") continue;
		if (msg.stopReason !== "error") return null;
		const raw =
			typeof msg.errorMessage === "string" ? msg.errorMessage.trim() : "";
		return {
			errorMessage:
				raw || "agent loop ended with stopReason=error (no errorMessage field)",
			stopReason: "error",
		};
	}
	return null;
}

/** The typed completion sidecar payload for a settled run. */
export function buildCompletionSidecar(
	messages: AgentMessageLike[] | undefined,
	eventId: string,
):
	| { type: "done"; eventId: string }
	| {
			type: "error";
			errorMessage: string;
			stopReason: "error";
			eventId: string;
	  } {
	const error = findLatestAssistantError(messages);
	return error
		? { type: "error", ...error, eventId }
		: { type: "done", eventId };
}

/**
 * Final assistant body to commit on a declared `agent_done`. Empty when the
 * current run has none — the caller refuses the tool instead of writing a sidecar.
 * The SDK persists a tool-only assistant before execute; skip it, but never
 * cross a user message or the latest agent_start's entry boundary.
 */
export function finalAssistantText(sessionPath: string, runStart = 0): string {
	const entries = completionEntries(sessionPath);
	for (let i = entries.length - 1; i >= runStart; i--) {
		const entry = entries[i];
		if (entry.type !== "message") continue;
		const message = entry.message as { role?: unknown } | null | undefined;
		if (message?.role === "user") break;
		if (message?.role !== "assistant") continue;
		const text = assistantText(message);
		if (text.trim()) return text;
	}
	return "";
}

function completionEntries(sessionPath: string): Record<string, unknown>[] {
	try {
		return parseSessionEntries(readFileSync(sessionPath, "utf8")).entries;
	} catch {
		return [];
	}
}

export { assistantText, refuseBareDone };

/** Parse the parent-stamped denied-tools env value. */
export function parseDeniedTools(rawValue: string | undefined): string[] {
	return (rawValue ?? "")
		.split(",")
		.map((value) => value.trim())
		.filter(Boolean);
}

/**
 * The identity/tools strip lines. Collapsed (default):
 * `[scout] — 12 tools · 4 denied (Ctrl+H)`; expanded adds the full tool list
 * and the denied names. Pure so the shape is pinned offline. Ctrl+H: pi binds
 * ctrl+j (newLine) and ctrl+k (deleteToLineEnd); ctrl+h is unbound.
 */
export function identityStripLines(opts: {
	label: string;
	tools: readonly string[];
	denied: readonly string[];
	expanded?: boolean;
}): string[] {
	const tag = opts.label ? `[${opts.label}]` : "[herdr agent]";
	if (!opts.expanded) {
		const denied = opts.denied.length ? ` · ${opts.denied.length} denied` : "";
		return [`${tag} — ${opts.tools.length} tools${denied} (Ctrl+H)`];
	}
	const lines = [
		`${tag} — ${opts.tools.length} tools  (Ctrl+H to collapse)`,
		...(opts.tools.length ? [opts.tools.join(", ")] : []),
	];
	if (opts.denied.length) lines.push(`denied: ${opts.denied.join(", ")}`);
	return lines;
}

/**
 * Grace window (ms) between an error settle and the auto-exit. A settled
 * error is NOT yet retry exhaustion: pi may be scheduling its next retry
 * (backoff gaps grow with each attempt). Exiting on the first error settle
 * would kill the retry machine mid-flight; only a full quiet window — no new
 * run started, no further settle — means the retries are done and the parent
 * must hear the typed failure.
 *
 * Default 30s; PI_HERDR_ERROR_EXIT_GRACE_MS overrides (tests, long-backoff
 * fleets). Read per settle, so a late env change still applies.
 */
export function errorExitGraceMs(): number {
	const raw = Number(process.env.PI_HERDR_ERROR_EXIT_GRACE_MS);
	return Number.isFinite(raw) && raw >= 0 ? raw : 30_000;
}


/**
 * The child-side activity recorder (v0.6 issue 07): mirrors this pi's
 * lifecycle into the activity sidecar the orchestrator's poll loop reads.
 * Writes are throttled to one per ACTIVITY_WRITE_MS for high-frequency
 * events (message_update fires per stream chunk); phase/tool changes flush
 * immediately, and a trailing write captures the final state of a throttled
 * window. Best-effort: a failed write must never break the agent loop.
 */
export const ACTIVITY_WRITE_MS = 500;

export class ActivityRecorder {
	private state: ActivitySnapshot;
	private lastWrite = 0;
	private trailing: ReturnType<typeof setTimeout> | null = null;

	constructor(
		private readonly path: string,
		private readonly now: () => number = Date.now,
		private readonly write: (path: string, data: string) => void = (p, d) =>
			writeFileSync(p, d),
	) {
		this.state = { version: 1, updatedAt: now(), phase: "starting" };
	}

	/** Boot: the child is up, no run yet. */
	sessionStart(): void {
		this.state = { version: 1, updatedAt: this.now(), phase: "starting" };
		this.flushNow();
	}

	/** A run began. */
	runStarted(): void {
		this.state = {
			...this.state,
			phase: "active",
			activeSince: this.now(),
			tool: undefined,
			toolStartedAt: undefined,
			streaming: false,
			waitingSince: undefined,
		};
		this.flushNow();
	}

	/** A tool started executing. */
	toolStarted(toolName: string): void {
		this.state = {
			...this.state,
			tool: toolName,
			toolStartedAt: this.now(),
			streaming: false,
		};
		this.flushNow();
	}

	/** The tool finished. */
	toolEnded(): void {
		this.state = { ...this.state, tool: undefined, toolStartedAt: undefined };
		this.flushNow();
	}

	/** Assistant message streaming (high frequency — throttled). */
	streamMessage(): void {
		this.state = { ...this.state, streaming: true };
		this.touch(false);
	}

	/** The run settled — pi will not auto-retry/compact/continue. */
	settled(): void {
		this.state = {
			...this.state,
			phase: "waiting",
			waitingSince: this.now(),
			activeSince: undefined,
			tool: undefined,
			toolStartedAt: undefined,
			streaming: false,
		};
		this.flushNow();
	}

	private touch(force: boolean): void {
		if (!force && this.now() - this.lastWrite < ACTIVITY_WRITE_MS) {
			this.scheduleTrailing();
			return;
		}
		this.flushNow();
	}

	private flushNow(): void {
		this.lastWrite = this.now();
		this.state.updatedAt = this.lastWrite;
		try {
			this.write(this.path, JSON.stringify(this.state));
		} catch {
			/* best-effort */
		}
		if (this.trailing) {
			clearTimeout(this.trailing);
			this.trailing = null;
		}
	}

	private scheduleTrailing(): void {
		if (this.trailing) return;
		this.trailing = setTimeout(() => {
			this.trailing = null;
			this.flushNow();
		}, ACTIVITY_WRITE_MS);
		this.trailing.unref?.();
	}
}

/**
 * Register the child extension. A no-op when PI_HERDR_SESSION is unset.
 * Exported (not only the default factory) so offline tests can drive it with
 * a mock pi.
 */
export function registerChildExtension(pi: ExtensionAPI): void {
	const sessionFile = process.env[ENV_SESSION];
	if (!sessionFile) return;
	// Narrowed alias — some nested function declarations below can't rely on
	// the guard's control-flow narrowing.
	const session: string = sessionFile;

	const childName = process.env[ENV_NAME] ?? "";
	const agentType = process.env[ENV_AGENT] ?? "";
	const autoExit = process.env[ENV_AUTO_EXIT] === "1";
	const rootSession = process.env[ENV_ROOT_SESSION]?.trim() || undefined;
	const denied = parseDeniedTools(process.env[ENV_DENIED_TOOLS]);
	const label = agentType || childName;

	// Structured output (issue 14): when the workflow host stamped a schema
	// file, register the StructuredOutput tool and let its validated payload
	// ride the completion sidecar. A missing/unreadable/bad file skips
	// silently — the host-side applySchema re-check still guards the contract.
	const schemaPath = process.env[ENV_SCHEMA];
	let structured: StructuredCapture | undefined;
	if (schemaPath) {
		let compiled: CompiledSchema | undefined;
		try {
			const compilation = compileJsonSchema(JSON.parse(readFileSync(schemaPath, "utf8")));
			if (compilation.ok) compiled = compilation.compiled;
		} catch {
			/* skip — the host-side check is the guarantee */
		}
		if (compiled) {
			structured = createStructuredCapture();
			pi.registerTool(createStructuredOutputTool(compiled, structured));
		}
	}

	// Activity recorder (issue 07) — independent of the rest of the
	// extension's lifecycle logic, so the sidecar stays truthful even when
	// error-grace branches early-return below.
	const activityPath = process.env[ENV_ACTIVITY_FILE];
	if (activityPath) {
		const recorder = new ActivityRecorder(activityPath);
		pi.on("session_start", () => recorder.sessionStart());
		pi.on("agent_start", () => recorder.runStarted());
		pi.on("tool_execution_start", (event) =>
			recorder.toolStarted(event.toolName),
		);
		pi.on("tool_execution_end", () => recorder.toolEnded());
		pi.on("message_update", () => recorder.streamMessage());
		pi.on("agent_settled", () => recorder.settled());
	}

	let toolNames: string[] = [];
	let expanded = false;

	const sidecarPath = `${sessionFile}.exit`;
	let runStart = 0;

	/** Persist a completion declaration before allowing autonomous shutdown.
	 * A persistence-error sidecar is a governance signal, not a task failure. */
	let identity = {
		agentId: process.env.PI_HERDR_AGENT_ID,
		runId: process.env.PI_HERDR_RUN_ID,
		sequence: Number(process.env.PI_HERDR_SEQUENCE ?? 1),
	};
	let completionEventId = identity.runId ?? resetCompletionEvent(session);
	let completionSaved = false;

	function scheduleRecycle(): void {
		const paneId = process.env.HERDR_PANE_ID;
		if (!paneId || !identity.runId || !identity.agentId) return;
		const intentPath = `${session}.recycle.json`;
		writeDurable(intentPath, JSON.stringify({ ...identity, eventId: completionEventId, sessionPath: session, name: childName, paneId, ownerSession: process.env.PI_HERDR_OWNER_SESSION, pending: true }));
		const worker = spawn(process.execPath, [fileURLToPath(new URL("./recycle-worker.mjs", import.meta.url)), intentPath, process.env.HERDR_BIN_PATH ?? "herdr"], { detached: true, stdio: "ignore" });
		worker.on("error", error => {
			writeFileSync(intentPath, JSON.stringify({ ...identity, eventId: completionEventId, sessionPath: session, name: childName, paneId, ownerSession: process.env.PI_HERDR_OWNER_SESSION, pending: true, error: String(error) }));
		});
		worker.unref();
	}

	function writeDurable(path: string, text: string): void {
		const temporary = `${path}.${completionEventId}.tmp`;
		const fd = openSync(temporary, "w", 0o600);
		try { writeFileSync(fd, text); fsyncSync(fd); } finally { closeSync(fd); }
		renameSync(temporary, path);
	}

	function writeSidecar(
		payload:
			| { type: "done"; text?: string; eventId?: string }
			| {
					type: "error";
					errorMessage: string;
					stopReason: string;
					text?: string;
					eventId?: string;
			  }
			| { type: "persistence-error"; errorMessage: string; eventId?: string },
	): boolean {
		if (completionSaved) return true;
		try {
			// A schema'd child's captured payload rides the done sidecar (issue
			// 14) — it IS the delivered result, ahead of the assistant text.
			const structuredField =
				payload.type === "done" && structured?.json !== undefined
					? { structured: structured.json }
					: {};
			const rootField = rootSession ? { rootSession } : {};
			// The marker, explicit done and settled sidecar share this run's ID.
			// No sidecar builder may mint a second business event.
			const eventField = {
				eventId: completionEventId,
			};
			const text = finalAssistantText(session, runStart) || (payload.type === "error" ? `[completion error: ${payload.errorMessage}]` : "");
			const bodyField = text.trim() ? { text } : {};
			if (payload.type !== "persistence-error" && !text.trim() && !payload.text?.trim() && !("structured" in structuredField)) {
				throw new Error("missing required final body");
			}
			const encoded = JSON.stringify({
				...payload,
				...(payload.type === "persistence-error" ? {} : bodyField),
				...structuredField,
				...rootField,
				...eventField,
				...identity,
			});
			// Save the event first; the legacy bridge is never the only copy.
			const eventPath = `${session}.completion-${completionEventId}.json`;
			if (existsSync(eventPath)) {
				if (readFileSync(eventPath, "utf8") !== encoded) throw new Error("completion event is already committed with different content");
			} else {
				const eventFd = openSync(eventPath, "wx", 0o600);
				try { writeFileSync(eventFd, encoded); fsyncSync(eventFd); } finally { closeSync(eventFd); }
			}
			writeDurable(sidecarPath, encoded);
			scheduleRecycle();
			completionSaved = true;
			return true;
		} catch (error) {
			if (payload.type === "persistence-error") return false;
			const message = error instanceof Error ? error.message : String(error);
			try {
				const failurePath = `${sidecarPath}.${completionEventId}.tmp`;
				writeFileSync(failurePath, JSON.stringify({
					type: "persistence-error",
					errorMessage: `completion persistence failed: ${message}`,
					eventId: completionEventId,
					...(rootSession ? { rootSession } : {}),
				}));
				renameSync(failurePath, sidecarPath);
			} catch { /* surfaced through the missing declaration and retained pane */ }
			return false;
		}
	}

	function renderStrip(ctx: { ui: { setWidget: Function } }): void {
		ctx.ui.setWidget(
			"herdr-identity",
			identityStripLines({ label, tools: toolNames, denied, expanded }),
			{ placement: "aboveEditor" },
		);
	}

	pi.on("session_start", (_event, ctx) => {
		// Fleet sessions are identifiable in /resume and never masquerade as
		// the user's own conversations.
		pi.setSessionName(`herdr/${childName || "agent"}`);
		toolNames = pi
			.getAllTools()
			.map((t) => t.name)
			.sort();
		renderStrip(ctx);
	});

	pi.registerShortcut("ctrl+h", {
		description: "Toggle herdr agent identity/tools strip",
		handler: (ctx) => {
			expanded = !expanded;
			renderStrip(ctx);
		},
	});

	// The child-side completion declaration: mark done, exit. The final
	// assistant message BEFORE this call is the delivered result.
	pi.registerTool({
		name: "agent_done",
		label: "Agent done",
		description:
			"Call this tool when the overall task is complete — it reports completion to the orchestrator " +
			"and closes this session. Your LAST assistant message before calling it is delivered in full, " +
			"so write a concise conclusion with key evidence, limitations, and references to deliverables; " +
			"put large reports in files and cite them. Then call agent_done. " +
			"Never call it mid-task.",
		parameters: Type.Object({}),
		async execute(_id, _params, _signal, _onUpdate, ctx) {
			if (ctx.hasPendingMessages?.()) return { content: [{ type: "text", text: "Submitted input is queued; finish it before declaring completion." }], details: {} };
			const text = finalAssistantText(session, runStart);
			const refusal = refuseBareDone(text);
			// A validated StructuredOutput payload is itself the result (prose
			// outside that call is discarded). Refuse only when there is neither.
			if (refusal && structured?.json === undefined) {
				return {
					content: [{ type: "text", text: refusal }],
					isError: true,
					details: {},
				};
			}
			const saved = writeSidecar(refusal ? { type: "done" } : { type: "done", text });
			if (!saved) {
				return { content: [{ type: "text", text: "Completion was not persisted; session remains open for recovery." }], isError: true, details: {} };
			}
			ctx.shutdown();
			return {
				content: [
					{ type: "text", text: "Completion recorded; this session is closing." },
				],
				details: {},
			};
		},
	});

	// agent_end is not terminal (pi may compact/retry/continue after it);
	// hold the messages and wait for agent_settled — the same mapping
	// src/selfreport.ts uses.
	let latestMessages: AgentMessageLike[] | undefined;
	pi.on("agent_end", (event) => {
		// SAFETY: only role/stopReason/errorMessage are ever read, and those are
		// common to every member of pi's AgentMessage union; the union just lacks
		// an index signature for the structural comparison.
		latestMessages = (event as unknown as { messages?: AgentMessageLike[] })
			.messages;
	});

	// A pending error-exit (see agent_settled below). Any new run, any input,
	// or any further settle cancels or reschedules it.
	let errorExitTimer: ReturnType<typeof setTimeout> | null = null;
	function cancelErrorExit(): void {
		if (errorExitTimer) {
			clearTimeout(errorExitTimer);
			errorExitTimer = null;
		}
	}

	let busy = false;
	let started = false;
	let followupAccepted = false;
	const queuedInputs = new Set<string>();
	pi.on("input", (event) => {
		if (event.source === "extension" && queuedInputs.delete(event.text)) return { action: "continue" };
		if (busy) {
			queuedInputs.add(event.text);
			pi.sendUserMessage(event.text, { deliverAs: "followUp" });
			return { action: "handled" };
		}
		const followup = parseTriggerTurn(event.text);
		if (!followup) return;
		followupAccepted = true;
		identity = { ...identity, runId: followup.runId, sequence: 1 };
		completionEventId = followup.runId;
		completionSaved = false;
		latestMessages = undefined;
		try { writeFileSync(`${session}.completion-event`, completionEventId, { mode: 0o600 }); } catch { /* durable declaration carries identity */ }
	});
	pi.on("agent_start", () => {
		busy = true;
		if (started && completionSaved && !followupAccepted) {
			completionEventId = randomUUID();
			identity = { ...identity, runId: completionEventId, sequence: 1 };
			completionSaved = false;
		}
		started = true;
		followupAccepted = false;
		if (!identity.runId) { completionEventId = resetCompletionEvent(session); completionSaved = false; }
		else { try { writeFileSync(`${session}.completion-event`, completionEventId, { mode: 0o600 }); } catch { /* durable declaration carries identity */ } }
		latestMessages = undefined;
		runStart = completionEntries(session).length;
		cancelErrorExit();
	});

	pi.on("session_shutdown", () => {
		cancelErrorExit();
	});

	pi.on("agent_settled", (_event, ctx) => {
		busy = false;
		if (ctx.hasPendingMessages?.()) return;
		if (!autoExit) return; // interactive stance — the pane stays open
		if (!shouldAutoExitOnSettle(latestMessages)) {
			// aborted → open for inspection (and no stale error-exit pending)
			cancelErrorExit();
			return;
		}
		const failed = findLatestAssistantError(latestMessages);
		if (!failed) {
			// Clean completion: the definitive settle. Sidecar + exit.
			cancelErrorExit();
			if (writeSidecar(buildCompletionSidecar(latestMessages, completionEventId))) ctx.shutdown();
			return;
		}
		// Settled on an error: NOT yet exhaustion. Give pi's retry machine a
		// quiet window; each fresh settle reschedules it, a new run cancels it,
		// and only real quiet (retries done) publishes the typed failure.
		cancelErrorExit();
		errorExitTimer = setTimeout(() => {
			errorExitTimer = null;
			if (writeSidecar(buildCompletionSidecar(latestMessages, completionEventId))) ctx.shutdown();
		}, errorExitGraceMs());
		errorExitTimer.unref?.();
	});
}

/** Default factory — the `-e` entry point. */
export default function (pi: ExtensionAPI): void {
	registerChildExtension(pi);
}
