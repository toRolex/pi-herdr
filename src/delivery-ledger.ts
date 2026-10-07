import { randomUUID } from "node:crypto";
import { closeSync, fsyncSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";

export type DeliveryState = "available" | "queued" | "pending" | "delivered" | "acked";
export interface EventReference {
	eventId: string;
	agentId?: string;
	runId?: string;
	sequence?: number;
	sessionPath?: string;
}
export interface DeliveryRecord extends EventReference {
	status: DeliveryState;
	token?: string;
	channel?: "push" | "pull";
	toolCallId?: string;
	updatedAt: number;
	diagnostic?: string;
	identityReviewRequired?: boolean;
}
export interface DeliveryProof {
	eventId: string;
	token: string;
	hostFile: string;
	channel: "push" | "pull";
	bodyCommitted: true;
}
export const deliveryLedgerPath = (hostFile: string): string => `${hostFile}.herdr-delivery-ledger.json`;

/** All decisions are synchronous, durable-before-body, and scoped to a receiver session. */
export class DeliveryLedger {
	constructor(readonly hostFile: string) {}
	private load(): Record<string, DeliveryRecord> {
		try {
			const data = JSON.parse(readFileSync(deliveryLedgerPath(this.hostFile), "utf8"));
			if (data.version !== 1 || data.hostFile !== this.hostFile || !data.events || typeof data.events !== "object") throw new Error("invalid delivery ledger");
			return data.events;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
			throw error;
		}
	}
	private save(events: Record<string, DeliveryRecord>): void {
		const path = deliveryLedgerPath(this.hostFile);
		const temporary = `${path}.${randomUUID()}.tmp`;
		let fd: number | undefined;
		try {
			fd = openSync(temporary, "wx", 0o600);
			writeFileSync(fd, JSON.stringify({ version: 1, hostFile: this.hostFile, events }));
			fsyncSync(fd);
			closeSync(fd); fd = undefined;
			renameSync(temporary, path);
		} finally {
			if (fd !== undefined) closeSync(fd);
			try { unlinkSync(temporary); } catch { /* successful rename removed temporary */ }
		}
	}
	private durableEvidence(eventId: string, record?: DeliveryRecord): { committed: boolean; unknown?: string } {
		try {
			const text = readFileSync(this.hostFile, "utf8");
			for (const line of text.split("\n")) {
				if (!line) continue;
				let row;
				try { row = JSON.parse(line); } catch { return { committed: false, unknown: "incomplete or invalid host JSONL" }; }
				const details = row.type === "custom_message" && row.customType === "herdr-delivery" ? row.details : row.type === "message" && row.message?.role === "toolResult" ? row.message.details : undefined;
				if (!details || details.deliveryHostWithdrawn) continue;
				const proof = details.delivery;
				if (proof?.eventId === eventId && proof.hostFile === this.hostFile && proof.bodyCommitted === true && (!record?.token || (proof.token === record.token && proof.channel === record.channel)) && (proof.channel !== "pull" || !record?.toolCallId || row.message?.toolCallId === record.toolCallId)) return { committed: true };
				// Existing persisted push rows predate body proof metadata. Never replay them.
				if (!proof && row.type === "custom_message" && details.eventId === eventId) return { committed: true };
			}
			return { committed: false };
		} catch (error) { return { committed: false, unknown: `host outcome unknown: ${String(error)}` }; }
	}
	reconcile(eventId: string): DeliveryRecord | undefined {
		const events = this.load();
		const record = events[eventId];
		const evidence = this.durableEvidence(eventId, record);
		if (evidence.committed) {
			if (record?.status === "delivered" || record?.status === "acked") return record;
			const repaired: DeliveryRecord = { ...record, eventId, status: "delivered", updatedAt: Date.now() };
			delete repaired.diagnostic;
			events[eventId] = repaired; this.save(events); return repaired;
		}
		if (record && evidence.unknown) return { ...record, diagnostic: evidence.unknown };
		return record;
	}
	ensure(ref: EventReference): DeliveryRecord {
		const previous = this.reconcile(ref.eventId);
		if (previous) return previous;
		const events = this.load();
		const evidence = this.durableEvidence(ref.eventId);
		if (evidence.unknown && !evidence.unknown.includes("ENOENT")) throw new Error(evidence.unknown);
		const record: DeliveryRecord = { ...ref, status: "available", updatedAt: Date.now() };
		events[ref.eventId] = record; this.save(events); return record;
	}
	queuePush(ref: EventReference): { bodyAllowed: boolean; record: DeliveryRecord } {
		const record = this.ensure(ref);
		if (record.status !== "available") return { bodyAllowed: false, record };
		const queued: DeliveryRecord = { ...record, status: "queued", token: randomUUID(), channel: "push", updatedAt: Date.now(), diagnostic: "SDK queue acceptance is not body delivery; no timeout retry" };
		const events = this.load(); events[ref.eventId] = queued; this.save(events);
		return { bodyAllowed: true, record: queued };
	}
	claimPull(ref: EventReference, toolCallId: string): { bodyAllowed: boolean; record: DeliveryRecord } {
		const record = this.ensure(ref);
		if (record.status !== "available" && record.status !== "queued") return { bodyAllowed: false, record };
		const pending: DeliveryRecord = { ...record, status: "pending", token: randomUUID(), channel: "pull", toolCallId, updatedAt: Date.now(), diagnostic: "tool result accepted; awaiting host disk commit" };
		const events = this.load(); events[ref.eventId] = pending; this.save(events);
		return { bodyAllowed: true, record: pending };
	}
	claimPush(eventId: string, token: string): boolean {
		const record = this.reconcile(eventId);
		if (!record || record.token !== token || record.channel !== "push" || record.status !== "queued") return false;
		const events = this.load();
		events[eventId] = { ...record, status: "pending", updatedAt: Date.now(), diagnostic: "SDK accepted; awaiting host disk commit (no timeout retry)" };
		this.save(events); return true;
	}
	uncertain(eventId: string, token: string, error: string): void {
		const events = this.load(), record = events[eventId];
		if (!record || record.token !== token || record.status === "delivered" || record.status === "acked") return;
		events[eventId] = { ...record, status: "pending", diagnostic: `dispatch outcome unknown: ${error}; do not retry`, updatedAt: Date.now() };
		this.save(events);
	}
	/** Only explicit dispatch rejection proves no SDK acceptance. Unknown outcomes retain their token. */
	reject(eventId: string, token: string, error: string): void {
		const events = this.load(), record = events[eventId];
		if (!record || record.token !== token || record.status !== "queued") return;
		events[eventId] = { ...record, status: "available", token: undefined, channel: undefined, updatedAt: Date.now(), diagnostic: `definitely not submitted: ${error}` };
		this.save(events);
	}
	migratePending(ref: EventReference, token: string): DeliveryRecord {
		const existing = this.reconcile(ref.eventId);
		if (existing) return existing;
		const record: DeliveryRecord = { ...ref, token, channel: "push", status: "pending", identityReviewRequired: !ref.agentId || !ref.runId, diagnostic: "legacy pending outcome unknown; review host evidence; not retryable", updatedAt: Date.now() };
		const events = this.load(); events[ref.eventId] = record; this.save(events); return record;
	}
	acknowledge(ref: EventReference): DeliveryRecord {
		const record = this.ensure(ref);
		if (record.identityReviewRequired || record.agentId !== ref.agentId || record.runId !== ref.runId || record.sequence !== ref.sequence) throw new Error("ACK identity does not match delivery ledger");
		if (record.status === "pending") throw new Error("ACK refused: submission outcome pending; wait for durable host confirmation");
		if (record.status === "acked") return record;
		const acked: DeliveryRecord = { ...record, status: "acked", updatedAt: Date.now(), diagnostic: "caller declared handled; not evidence of model reading or understanding" };
		const events = this.load(); events[ref.eventId] = acked; this.save(events);
		return acked;
	}
	proof(record: DeliveryRecord): DeliveryProof {
		if (!record.token || !record.channel) throw new Error("delivery claim has no proof token");
		return { eventId: record.eventId, token: record.token, channel: record.channel, hostFile: this.hostFile, bodyCommitted: true };
	}
}
