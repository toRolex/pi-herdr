// Configuration: resolve the herdr binary.
// No pi settings.json API exists for extensions, so config is via env + PATH.

import { herdr } from "./herdr.js";
import { resolveHerdrBin } from "./herdr-transport.mjs";

export { resolveHerdrBin };

// ---- agent-kind validation (`agent start --kind`) ----------------------------
// The `agent` param is a free string validated against the LIVE kind list
// emitted by `herdr agent` (trailing `kinds: a|b|c` line), cached per session
// with a hardcoded fallback when herdr is unavailable.

/**
 * Hardcoded fallback: agent kinds herdr commonly ships. Used when the live
 * `herdr agent` kind list can't be fetched (no server, missing binary). Keep
 * roughly in sync with the live `herdr agent` output; the live list is
 * authoritative when available.
 */
export const AGENT_KINDS_FALLBACK: readonly string[] = [
	"pi",
	"claude",
	"codex",
	"gemini",
	"cursor",
	"devin",
	"agy",
	"cline",
	"omp",
	"mastracode",
	"opencode",
	"copilot",
	"kimi",
	"kiro",
	"droid",
	"amp",
	"grok",
	"hermes",
	"kilo",
	"qodercli",
	"maki",
];

let kindsCache: string[] | null = null;

/**
 * Parse the trailing `kinds: a|b|c` line emitted by `herdr agent` (no
 * subcommand) into a lowercased kind list. Returns null when the line is absent.
 */
export function parseAgentKinds(text: string): string[] | null {
	if (typeof text !== "string") return null;
	const line = text
		.split(/\r?\n/)
		.map((l) => l.trim())
		.reverse()
		.find((l) => l.toLowerCase().startsWith("kinds:"));
	if (!line) return null;
	const kinds = line
		.slice("kinds:".length)
		.split("|")
		.map((k) => k.trim().toLowerCase())
		.filter(Boolean);
	return kinds.length ? kinds : null;
}

/**
 * The valid `agent start --kind` values for this herdr: fetched once per
 * session (cached) and falling back to {@link AGENT_KINDS_FALLBACK} when herdr
 * is unavailable or emits no kinds line. Never throws.
 */
export async function getAgentKinds(): Promise<string[]> {
	if (kindsCache) return kindsCache;
	const r = await herdr<string>(["agent"], {
		textOk: true,
		timeoutMs: 4_000,
	});
	const parsed =
		r.ok && typeof r.data === "string" ? parseAgentKinds(r.data) : null;
	kindsCache = parsed ?? [...AGENT_KINDS_FALLBACK];
	return kindsCache;
}

/** Drop the cached kind list so the next getAgentKinds() re-fetches (tests). */
export function resetAgentKindsCache(): void {
	kindsCache = null;
}
