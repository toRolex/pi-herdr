import assert from 'node:assert/strict';
import { createJiti } from 'jiti';
for (const key of Object.keys(process.env)) if (/^(HERDR|PI_HERDR)/.test(key)) delete process.env[key];
const jiti = createJiti(import.meta.url);
const { waitForAgentEvent, createEventAvailability } = await jiti.import('../src/tools/wait.ts');
const registry = () => new Map([['worker', { name: 'worker', paneId: 'fake-pane', agentId: 'agent', runId: 'run', sequence: 1 }]]);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
let receivedSignal;
const availability = createEventAvailability({ registry, pollMs: 1, status: async (_pane, signal) => {
 receivedSignal = signal;
 await pause(80);
 return { ok: true, data: 'blocked' };
} });
const started = Date.now();
const timed = await waitForAgentEvent({ target: 'worker', timeout: 10 }, { availability });
assert.equal(timed.data.status, 'timeout', 'late blocked response cannot beat the total wait budget');
assert.ok(Date.now() - started < 65, 'first status lookup is inside the total timeout, even if adapter ignores abort');
assert.equal(receivedSignal?.aborted, true, 'status receives a budget-constrained AbortSignal');
// Cancel during an asynchronous lookup; a later blocked response must not revive it.
const cancelled = new AbortController();
let release, entered;
const atStatus = new Promise(resolve => { entered = resolve; });
let lookupSignal;
const cancellable = createEventAvailability({ registry, status: async (_pane, signal) => {
 lookupSignal = signal; entered();
 await new Promise(resolve => { release = resolve; });
 return { ok: true, data: 'blocked' };
} });
const waiting = waitForAgentEvent({ target: 'worker', timeout: 5000 }, { availability: cancellable, signal: cancelled.signal });
await atStatus;
cancelled.abort();
assert.equal((await Promise.race([waiting, pause(100).then(() => ({ data: { status: 'still-pending' } }))])).data.status, 'cancelled');
assert.equal(lookupSignal.aborted, true);
release();
assert.equal((await waiting).data.status, 'cancelled');

// Recheck after an adapter aborts the caller synchronously just before returning availability.
const lateAbort = new AbortController();
const lateAvailability = createEventAvailability({ registry, status: async () => {
 lateAbort.abort(); return { ok: true, data: 'blocked' };
} });
assert.equal((await waitForAgentEvent({ target: 'worker', timeout: 5000 }, { availability: lateAvailability, signal: lateAbort.signal })).data.status, 'cancelled');
const alreadyAborted = new AbortController(); alreadyAborted.abort();
let lookups = 0;
const unavailable = createEventAvailability({ registry, status: async () => { lookups++; return { ok: true, data: 'blocked' }; } });
assert.equal((await waitForAgentEvent({ target: 'worker', timeout: 5000 }, { availability: unavailable, signal: alreadyAborted.signal })).data.status, 'cancelled');
assert.equal((await waitForAgentEvent({ target: 'worker', timeout: 0 }, { availability: unavailable })).data.status, 'timeout');
assert.equal(lookups, 0);
console.log('pr56-parent-wait: total discovery budget, abort during status, post-await recheck, pre-abort and zero budget passed');
