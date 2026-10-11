import { readFileSync } from 'node:fs';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { parseExitSidecar, resolveAcceptedFailureOwner, saveAcceptedStartFailure } from '../sessionfile.js';
import { spawnRecords, writePersistedRegistry, type SpawnRecord } from '../spawn.js';
import { currentOrchestratorSession } from '../push.js';
import { getAgentStatus } from './orchestration.js';

export type WaitEventStatus = 'available' | 'timeout' | 'cancelled';
export interface WaitEventResult { status: WaitEventStatus; eventId?: string; target?: string; agentId?: string; runId?: string; sequence?: number; kind?: 'blocked' }
export interface EventAvailabilityDeps { registry?: () => ReadonlyMap<string, SpawnRecord>; pollMs?: number; status?: typeof getAgentStatus; watch?: (sessionPath: string, notify: () => void) => () => void }
export interface EventAvailability {
  notify(): void;
  wait(params: { target: string; timeout: number; signal?: AbortSignal }, registry?: () => ReadonlyMap<string, SpawnRecord>): Promise<WaitEventResult>;
}

function readRecordEvent(target: string, name: string, record: SpawnRecord): WaitEventResult | undefined {
  if (!record.sessionPath || record.startFailurePersistenceError) return undefined;
  const current = target === name || target === record.runId;
  const eventId = current ? record.runId! : target;
  if (!/^[A-Za-z0-9_-]+$/.test(eventId)) return undefined;
  const files = [`${record.sessionPath}.completion-${eventId}.json`, ...(current ? [`${record.sessionPath}.exit`] : [])];
  for (const file of files) {
    try {
      const parsed = parseExitSidecar(readFileSync(file, 'utf8'));
      if (!parsed.ok || parsed.sidecar.type === 'persistence-error') continue;
      const event = parsed.sidecar;
      let hasBody = Boolean(event.text?.trim());
      if (!hasBody && event.type === 'done' && event.structured?.trim()) {
        JSON.parse(event.structured); hasBody = true;
      }
      if (event.eventId !== eventId || event.runId !== eventId || event.agentId !== record.agentId ||
        !Number.isInteger(event.sequence) || event.sequence! < 1 || !hasBody ||
        (current && (event.runId !== record.runId || event.sequence !== record.sequence))) continue;
      return { status: 'available', eventId: event.eventId, target: name, agentId: event.agentId, runId: event.runId, sequence: event.sequence };
    } catch { /* This candidate is absent/invalid; another archive or bridge may still be valid. */ }
  }
  return undefined;
}

function findEvent(target: string, registry: () => ReadonlyMap<string, SpawnRecord>): WaitEventResult | undefined {
  const records = registry();
  for (const [name, record] of records) {
    if (record.identityReviewRequired || !record.agentId || !record.runId) continue;
    const existing = readRecordEvent(target, name, record);
    if (existing) return existing;
    if ((target === name || target === record.runId) && record.startError && !record.paneId && !record.submitted &&
      record.promptSubmission !== 'uncertain' && (!record.startAttemptPhase || record.startAttemptPhase === 'prelaunch') &&
      (!record.pendingRunId || record.pendingRunId === record.runId)) {
      try {
        const owner = resolveAcceptedFailureOwner(record, undefined, currentOrchestratorSession());
        saveAcceptedStartFailure(record);
        record.startFailurePersistenceError = undefined;
        writePersistedRegistry(owner, [...records.values()]);
      } catch (error) {
        record.startFailurePersistenceError = error instanceof Error ? error.message : String(error);
        record.pushError = `accepted start failure persistence: ${record.startFailurePersistenceError}`;
        console.error(`[herdr] ${record.name}: ${record.pushError}`);
        continue;
      }
      const recovered = readRecordEvent(target, name, record);
      if (recovered) return recovered;
    }
  }
  return undefined;
}

export function createEventAvailability(deps: EventAvailabilityDeps = {}): EventAvailability {
  const listeners = new Set<() => void>();
  const registry = deps.registry ?? spawnRecords;
  const pollMs = deps.pollMs ?? 100;
  const discover = async (target: string, selectedRegistry: () => ReadonlyMap<string, SpawnRecord>, signal: AbortSignal) => {
    const terminal = findEvent(target, selectedRegistry);
    if (terminal) return terminal;
    const record = [...selectedRegistry().values()].find(item => item.name === target || item.runId === target || item.agentId === target);
    if (!record?.paneId) return undefined;
    if (signal.aborted) return undefined;
    let onAbort: () => void = () => {};
    const aborted = new Promise<undefined>(resolve => {
      onAbort = () => resolve(undefined);
      signal.addEventListener('abort', onAbort, { once: true });
    });
    let live;
    try {
      // Bound even adapters which ignore cancellation; production status receives it too.
      live = await Promise.race([(deps.status ?? getAgentStatus)(record.paneId, signal), aborted]);
    } finally { signal.removeEventListener('abort', onAbort); }
    if (!signal.aborted && live?.ok && live.data === 'blocked') return { status: 'available' as const, kind: 'blocked' as const, target: record.name, agentId: record.agentId, runId: record.runId, sequence: record.sequence };
    return undefined;
  };
  const api: EventAvailability = {
    notify() { for (const listener of [...listeners]) listener(); },
    async wait(params, selectedRegistry = registry) {
      const deadline = Date.now() + Math.max(0, params.timeout);
      if (params.signal?.aborted) return { status: 'cancelled' };
      // A pre-existing durable event remains immediately available even for timeout=0.
      const immediate = findEvent(params.target, selectedRegistry);
      if (immediate) return immediate;
      const controller = new AbortController();
      const cancel = () => controller.abort();
      params.signal?.addEventListener('abort', cancel, { once: true });
      const budgetTimer = setTimeout(cancel, Math.max(0, deadline - Date.now()));
      let unwatch: (() => void) | undefined;
      try {
        const record = [...selectedRegistry().values()].find(item => item.name === params.target || item.runId === params.target || item.agentId === params.target);
        unwatch = record?.sessionPath ? deps.watch?.(record.sessionPath, () => api.notify()) : undefined;
        while (true) {
          if (params.signal?.aborted) return { status: 'cancelled' };
          if (Date.now() >= deadline) return { status: 'timeout' };
          const found = await discover(params.target, selectedRegistry, controller.signal);
          // Never prefer a late response over cancellation or the original total budget.
          if (params.signal?.aborted) return { status: 'cancelled' };
          const remaining = deadline - Date.now();
          if (controller.signal.aborted || remaining <= 0) return { status: 'timeout' };
          if (found) return found;
          await new Promise<void>(resolve => {
            let done = false;
            const finish = () => { if (done) return; done = true; clearTimeout(timer); listeners.delete(finish); controller.signal.removeEventListener('abort', finish); resolve(); };
            listeners.add(finish);
            const timer = setTimeout(finish, Math.min(pollMs, remaining));
            controller.signal.addEventListener('abort', finish, { once: true });
            if (controller.signal.aborted) finish();
          });
        }
      } finally {
        unwatch?.();
        clearTimeout(budgetTimer);
        params.signal?.removeEventListener('abort', cancel);
        controller.abort();
      }
    },
  };
  return api;
}

const defaultAvailability = createEventAvailability();
export async function waitForAgentEvent(params: { target: string; timeout?: number }, deps: { registry?: () => ReadonlyMap<string, SpawnRecord>; signal?: AbortSignal; availability?: EventAvailability } = {}) {
  return { ok: true as const, data: await (deps.availability ?? defaultAvailability).wait({ target: params.target, timeout: params.timeout ?? 30_000, signal: deps.signal }, deps.registry) };
}

export function registerWaitTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: 'herdr_wait_agent_event', label: 'Wait for herdr agent event',
    description: 'Wait for a completion event or recoverable blocked state to become available. Returns only its status and reference; does not read, consume, acknowledge, or alter unread state. Timeout/cancellation never stops the child.',
    promptSnippet: 'Wait for a child completion event reference (no result body)',
    promptGuidelines: ['Use herdr_wait_agent_event to wait for event availability; then use herdr_get_agent_result to retrieve the result body.'],
    parameters: Type.Object({ target: Type.String({ description: 'Spawn handle, run id, or completion event id.' }), timeout: Type.Optional(Type.Integer({ minimum: 0, description: 'Wait duration in milliseconds (default 30000).' })) }),
    async execute(_id, params, signal) {
      const result = await waitForAgentEvent(params, { signal });
      const data = result.data;
      return { content: [{ type: 'text', text: data.status === 'available' ? data.kind === 'blocked' ? `Agent ${data.target} is blocked; answer via the legacy herdr_message_agent (raw text becomes its answer) or herdr_send_keys (option lists). No terminal result or ACK is available.` : `Event available: ${data.eventId}` : data.status === 'timeout' ? 'Wait timed out; no event consumed.' : 'Wait cancelled; child continues and no event was consumed.' }], details: data };
    },
  });
}
