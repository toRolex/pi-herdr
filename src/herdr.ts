// 扩展内唯一的类型化、版本门控 Herdr 入口。
// transport、超时、AbortSignal、JSON 解析与错误码映射由 herdr-transport.mjs 提供，
// 独立 Node 回收 worker 也调用同一边界。
//
// It also owns the herdr version probe and the version floor: pi-herdr
// requires herdr >= 0.9.0, and the gate inside herdr() itself refuses every
// call against an older (or unverifiable) herdr with one clean
// HERDR_TOO_OLD error — no tool can half-work below the floor.

import { resolveHerdrBin } from "./config.js";
import { runHerdrCommand } from "./herdr-transport.mjs";
import type { NormalizedAgent, Result } from "./env.js";
import { normalizeAgent } from "./env.js";
import { floorError, parseVersion, type HerdrProbe } from "./version.js";

export interface HerdrOpts {
	/** Hard timeout for the child process (ms). Default 60s. */
	timeoutMs?: number;
	/** Optional abort signal (e.g. ctx.signal) to cancel the call. */
	signal?: AbortSignal;
	/**
	 * If true and stdout is non-JSON with exit code 0, treat stdout as successful
	 * raw text data (used by `agent read` / `pane read` which may emit plain text).
	 */
	textOk?: boolean;
	/** Internal: skip the version-floor gate (used by the `--version` probe
	 * itself — the probe must run below the floor to detect it). */
	skipFloorGate?: boolean;
}

// ---- version probe + floor ---------------------------------------------------

let cachedProbe: Promise<HerdrProbe> | null = null;

/**
 * Probe `herdr --version` once and cache it. `--version` is client-local
 * (never touches the server) and bypasses the floor gate, so this is cheap
 * and safe even with no herdr server — and against an old herdr (that's how
 * the floor is detected at all).
 */
export function probeHerdr(): Promise<HerdrProbe> {
	if (cachedProbe) return cachedProbe;
	cachedProbe = runHerdr<string>(["--version"], {
		textOk: true,
		timeoutMs: 3_000,
		skipFloorGate: true,
	}).then((r) => {
		if (!r.ok) return { state: "missing" }; // HERDR_UNAVAILABLE / spawn fail
		const v = parseVersion(typeof r.data === "string" ? r.data : "");
		return v ? { state: "ok", version: v } : { state: "unknown" };
	});
	return cachedProbe;
}

/** Drop the cached probe and re-run it (use at session_start to catch updates). */
export function refreshHerdrProbe(): Promise<HerdrProbe> {
	cachedProbe = null;
	return probeHerdr();
}

/** Seed/drop the cached probe (tests only — offline floor-gate coverage). */
export function setProbeForTests(probe: HerdrProbe | null): void {
	cachedProbe = probe ? Promise.resolve(probe) : null;
}

/**
 * The version-floor gate: null when the call may proceed, or the single
 * `HERDR_TOO_OLD` / natural-flow decision. `missing` returns null so the
 * spawn itself produces the one clean HERDR_UNAVAILABLE error.
 */
async function floorGate(): Promise<Result<never> | null> {
	const e = floorError(await probeHerdr());
	return e ? { ok: false, error: e.error } : null;
}

/**
 * Run `herdr <args>`, gated on the version floor, parse the JSON envelope,
 * and return a Result<T>. Never throws — every failure path resolves to
 * `{ ok:false, error }`.
 */
export function herdr<T = unknown>(
	args: string[],
	opts: HerdrOpts = {},
): Promise<Result<T>> {
	if (opts.skipFloorGate) return runHerdr<T>(args, opts);
	return (async () => {
		const gate = await floorGate();
		if (gate) return gate;
		return runHerdr<T>(args, opts);
	})();
}

/** The ungated exec path (also the probe's own transport). */
async function runHerdr<T = unknown>(
	args: string[],
	opts: HerdrOpts = {},
): Promise<Result<T>> {
	try {
		return await runHerdrCommand(resolveHerdrBin(), args, opts) as Result<T>;
	} catch {
		return { ok: false, error: { code: "HERDR_UNAVAILABLE", message: "herdr binary could not be resolved" } };
	}
}

// ---- the fleet observation -------------------------------------------------

/**
 * One normalized fleet observation (`herdr agent list`) — the shared seam
 * every poll consumer uses (push delivery, the watchdog, the list view), so
 * the fleet-agent shape is spelled once (NormalizedAgent) and one tick costs
 * one CLI call no matter how many passes read it.
 */
export async function fleetList(
	signal?: AbortSignal,
): Promise<Result<NormalizedAgent[]>> {
	const r = await herdr<{ agents?: unknown[] }>(["agent", "list"], {
		timeoutMs: 10_000,
		signal,
	});
	if (!r.ok) return r;
	return { ok: true, data: (r.data?.agents ?? []).map(normalizeAgent) };
}
