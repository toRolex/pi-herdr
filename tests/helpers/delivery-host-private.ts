import { inspectDeliveryReceipt, inspectToolResultReceipt, type HostDeliveryMode, type HostMessage } from "../../src/delivery-host.js";

type QueuedMessage = HostMessage & { role: string };
type SDKQueue = { messages: QueuedMessage[]; drain(): QueuedMessage[] };

/** Explicit SDK injection only: ExtensionContext does not expose AgentSession. */
export interface DeliveryHostSession {
	readonly isStreaming: boolean;
	sendCustomMessage(message: HostMessage, options: { deliverAs: HostDeliveryMode; triggerTurn: boolean }): Promise<void>;
	agent: { steeringQueue?: SDKQueue; followUpQueue?: SDKQueue };
	_pendingNextTurnMessages?: QueuedMessage[];
}


type SessionFile = () => string | undefined;
export type DrainCandidate = { token: string; message: HostMessage; mode: HostDeliveryMode };
/** false withdraws this queue item; retry/fallback remains the caller's durable-outbox responsibility. */
export type DrainArbiter = (candidate: DrainCandidate) => boolean;
export type HostCapabilities = {
	level: "sdk-private-queues" | "receipt-only";
	preciseCancellation: boolean;
	beforeDrain: boolean;
	arbitration: "synchronous-only" | "unavailable";
	wakeEnqueue: "busy-only" | "unavailable";
	durability: "jsonl-readback-no-fsync";
};

type PatchedQueue = { queue: SDKQueue; original: SDKQueue["drain"]; wrapped: SDKQueue["drain"] };
type PatchedArray = { array: QueuedMessage[]; original?: PropertyDescriptor; wrapped: () => ArrayIterator<QueuedMessage> };
const installed = new WeakSet<object>();

/**
 * Highest available host seam for this SDK. Private queue shape is checked, not assumed.
 * A public-extension-only caller gets honest receipt-only capability, never a fake cancel.
 * The caller must keep its own durable outbox: dequeue -> message_end append is a crash window.
 */
export function createDeliveryHost(options: {
	/** Kept structural at the boundary: SDK private fields are absent from its public TS API. */
	session?: object;
	getSessionFile: SessionFile;
	beforeDrain?: DrainArbiter;
}) {
	const session = options.session as DeliveryHostSession | undefined;
	const owned = new Map<string, Record<string, unknown>>();
	let arbiter = options.beforeDrain ?? (() => true);
	let disposed = false;
	const patches: PatchedQueue[] = [];
	const arrays: PatchedArray[] = [];
	const validQueue = (queue: SDKQueue | undefined): queue is SDKQueue =>
		!!queue && Array.isArray(queue.messages) && typeof queue.drain === "function";
	const capable = !!session && typeof session.sendCustomMessage === "function" && typeof session.isStreaming === "boolean" &&
		validQueue(session.agent?.steeringQueue) && validQueue(session.agent?.followUpQueue) &&
		Array.isArray(session._pendingNextTurnMessages);
	if (capable && installed.has(session)) throw new Error("delivery host already installed on this SDK session");
	const capabilities: HostCapabilities = {
		level: capable ? "sdk-private-queues" : "receipt-only",
		preciseCancellation: capable,
		beforeDrain: capable,
		arbitration: capable ? "synchronous-only" : "unavailable",
		wakeEnqueue: capable ? "busy-only" : "unavailable",
		durability: "jsonl-readback-no-fsync",
	};
	const requireSDK = (): DeliveryHostSession => {
		if (disposed) throw new Error("delivery host disposed");
		if (!capable || !session) throw new Error("precise delivery queue seam unavailable; explicit compatible SDK AgentSession required");
		return session;
	};
	const tokenOf = (message: QueuedMessage): string | undefined => {
		const token = message.details?.deliveryToken;
		return message.role === "custom" && message.customType === "herdr-delivery" && typeof token === "string" && owned.get(token) === message.details
			? token : undefined;
	};
	const arbitrate = (messages: QueuedMessage[], mode: HostDeliveryMode): void => {
		// Decide before mutation so an arbiter exception leaves the queue intact.
		const rejected = new Set<QueuedMessage>();
		for (const message of messages.slice()) {
			const token = tokenOf(message);
			if (!token) continue;
			const accepted = arbiter({ token, message, mode });
			if (typeof accepted !== "boolean") throw new Error("delivery drain arbiter must return a synchronous boolean");
			if (!accepted) rejected.add(message);
		}
		for (let index = messages.length - 1; index >= 0; index--) {
			if (rejected.has(messages[index]!)) messages.splice(index, 1);
		}
	};
	const patchNextTurn = (): void => {
		const array = requireSDK()._pendingNextTurnMessages!;
		if (arrays.some(patch => patch.array === array)) return;
		const original = Object.getOwnPropertyDescriptor(array, Symbol.iterator);
		const iterator = array[Symbol.iterator];
		const wrapped = function () {
			arbitrate(array, "nextTurn");
			return iterator.call(array);
		};
		Object.defineProperty(array, Symbol.iterator, { configurable: true, writable: true, value: wrapped });
		arrays.push({ array, original, wrapped });
	};
	if (capable && session) {
		installed.add(session);
		for (const [queue, mode] of [[session.agent.steeringQueue!, "steer"], [session.agent.followUpQueue!, "followUp"]] as const) {
			const original = queue.drain;
			const wrapped = function () {
				arbitrate(queue.messages, mode);
				return original.call(queue);
			};
			queue.drain = wrapped;
			patches.push({ queue, original, wrapped });
		}
		patchNextTurn();
	}
	const allQueues = (): QueuedMessage[][] => {
		const host = requireSDK();
		return [host.agent.steeringQueue!.messages, host.agent.followUpQueue!.messages, host._pendingNextTurnMessages!];
	};
	return {
		capabilities,
		setDrainArbiter(next: DrainArbiter): void { requireSDK(); arbiter = next; },
		async enqueue(token: string, message: HostMessage, mode: HostDeliveryMode): Promise<void> {
			const host = requireSDK();
			if (!token || message.customType !== "herdr-delivery") throw new Error("owned delivery requires nonempty token and herdr-delivery type");
			if (owned.has(token)) throw new Error("delivery token already owned; inspect receipt or cancel instead of enqueueing twice");
			// Idle SDK wake bypasses queues and their drain gate. Fail explicitly rather than
			// claiming cancellation/arbitration for a run that may already have started.
			if (mode !== "nextTurn" && !host.isStreaming) throw new Error("wake delivery requires a busy SDK session; idle wake bypasses the queue arbitration seam");
			const details = { ...message.details, deliveryToken: token };
			owned.set(token, details);
			patchNextTurn(); // SDK replaces this array after each natural prompt.
			// Direct SDK call preserves async failures; ExtensionAPI's void binding hides them.
			await host.sendCustomMessage({ ...message, details }, {
				deliverAs: mode, triggerTurn: mode !== "nextTurn",
			});
		},
		cancel(token: string): { status: "cancelled" | "not-queued"; removed: number } {
			let removed = 0;
			for (const messages of allQueues()) {
				for (let index = messages.length - 1; index >= 0; index--) {
					if (tokenOf(messages[index]!) === token) { messages.splice(index, 1); removed++; }
				}
			}
			return { status: removed ? "cancelled" : "not-queued", removed };
		},
		receipt(token: string): HostReceipt { return inspectDeliveryReceipt(options.getSessionFile, token); },
		toolReceipt(toolCallId: string, matches?: (message: Record<string, unknown>) => boolean): HostReceipt {
			return inspectToolResultReceipt(options.getSessionFile, toolCallId, matches);
		},
		dispose(): void {
			if (disposed) return;
			// Do not silently unguard owned queue entries. Callers must cancel or drain first.
			if (capable && allQueues().some(messages => messages.some(message => tokenOf(message)))) {
				throw new Error("cannot dispose delivery host while owned messages remain queued");
			}
			for (const patch of patches) if (patch.queue.drain === patch.wrapped) patch.queue.drain = patch.original;
			for (const patch of arrays) {
				if (patch.array[Symbol.iterator] !== patch.wrapped) continue;
				if (patch.original) Object.defineProperty(patch.array, Symbol.iterator, patch.original);
				else Reflect.deleteProperty(patch.array, Symbol.iterator);
			}
			if (session) installed.delete(session);
			disposed = true;
		},
	};
}
