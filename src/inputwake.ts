import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export interface InputWake {
	readonly epoch: number;
	subscribe(listener: () => void): () => void;
}

export function createInputWake(): InputWake & { advance(): void } {
	let epoch = 0;
	const listeners = new Set<() => void>();
	return {
		get epoch() { return epoch; },
		subscribe(listener) {
			listeners.add(listener);
			return () => { listeners.delete(listener); };
		},
		advance() {
			epoch++;
			for (const listener of [...listeners]) listener();
		},
	};
}

const scopes = new Set<InputWake>();

export function defaultInputWake(): InputWake | undefined {
	if (scopes.size > 1)
		throw new Error("Multiple pi-herdr sessions share this engine; pass an explicit inputWake or null for background waits.");
	return scopes.values().next().value;
}

export function registerResultInputWake(pi: ExtensionAPI): void {
	let scope = createInputWake();
	scopes.add(scope);
	const retire = () => {
		scopes.delete(scope);
		scope.advance();
	};
	pi.on("input", () => { scope.advance(); });
	pi.on("session_start", () => {
		retire();
		scope = createInputWake();
		scopes.add(scope);
	});
	pi.on("session_shutdown", retire);
}

export function waitForInputOrPoll(
	wake: InputWake,
	epoch: number,
	ms: number,
	signal?: AbortSignal,
): Promise<void> {
	return new Promise((resolve) => {
		let timer: ReturnType<typeof setTimeout> | undefined;
		let unsubscribe = () => {};
		let finished = false;
		const finish = () => {
			if (finished) return;
			finished = true;
			if (timer !== undefined) clearTimeout(timer);
			unsubscribe();
			signal?.removeEventListener("abort", finish);
			resolve();
		};
		unsubscribe = wake.subscribe(finish);
		signal?.addEventListener("abort", finish, { once: true });
		if (finished) {
			unsubscribe();
			signal?.removeEventListener("abort", finish);
		}
		if (signal?.aborted || wake.epoch !== epoch) finish();
		if (!finished) timer = setTimeout(finish, ms);
	});
}
