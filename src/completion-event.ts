import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

/** Local same-OS-user correlation marker; not an authentication token. */
export function validEventId(value: unknown): value is string {
	return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
}
export function completionEventPath(session: string): string {
	return `${session}.completion-event`;
}
export function resetCompletionEvent(session: string): string {
	const id = randomUUID();
	writeFileSync(completionEventPath(session), id, { mode: 0o600 });
	return id;
}
export function readCompletionEvent(session: string): string | undefined {
	try {
		const id = readFileSync(completionEventPath(session), "utf8").trim();
		return validEventId(id) ? id : undefined;
	} catch { return undefined; }
}
