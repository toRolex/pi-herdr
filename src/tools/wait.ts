import { readFileSync } from 'node:fs';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { parseExitSidecar } from '../sessionfile.js';
import { spawnRecords, type SpawnRecord } from '../spawn.js';
import { getAgentStatus } from './orchestration.js';

export type WaitEventStatus = 'available' | 'timeout' | 'cancelled';
export interface WaitEventResult { status: WaitEventStatus; eventId?: string; target?: string; agentId?: string; runId?: string; sequence?: number; kind?: 'blocked' }
export interface EventAvailabilityDeps { registry?: () => ReadonlyMap<string, SpawnRecord>; pollMs?: number; status?: typeof getAgentStatus; watch?: (sessionPath: string, notify: () => void) => () => void }
export interface EventAvailability {
  notify(): void;
  wait(params: { target: string; timeout: number; signal?: AbortSignal }, registry?: () => ReadonlyMap<string, SpawnRecord>): Promise<WaitEventResult>;
}

function findEvent(target: string, registry: () => ReadonlyMap<string, SpawnRecord>): WaitEventResult | undefined {
  const records = registry();
  for (const [name, record] of records) {
    if (!record.sessionPath) continue;
    try {
      const files = target === name || target === record.runId
        ? [`${record.sessionPath}.exit`]
        : [`${record.sessionPath}.completion-${target}.json`];
      if (target === name || target === record.runId) {
        const eventFiles = files;
        for (const file of eventFiles) {
          const parsed = parseExitSidecar(readFileSync(file, 'utf8'));
          if (parsed.ok && parsed.sidecar.type !== 'persistence-error' &&
            (!record.runId || parsed.sidecar.runId === record.runId) &&
            (!record.agentId || parsed.sidecar.agentId === record.agentId) &&
            (record.sequence === undefined || parsed.sidecar.sequence === record.sequence)) {
            const event = parsed.sidecar;
            return { status: 'available', eventId: event.eventId ?? record.runId, target: name, agentId: event.agentId ?? record.agentId, runId: event.runId ?? record.runId, sequence: event.sequence ?? record.sequence };
          }
        }
      }
      for (const file of files) {
        const parsed = parseExitSidecar(readFileSync(file, 'utf8'));
        if (!parsed.ok || parsed.sidecar.type === 'persistence-error') continue;
        if ((target === name || target === record.runId) &&
          ((record.runId && parsed.sidecar.runId !== record.runId) || (record.agentId && parsed.sidecar.agentId !== record.agentId) || (record.sequence !== undefined && parsed.sidecar.sequence !== record.sequence))) continue;
        const event = parsed.sidecar;
        if (target !== name && target !== record.runId && event.eventId !== target) continue;
        if (target === name || target === record.runId || event.eventId === target)
          return { status: 'available', eventId: event.eventId ?? record.runId, target: name, agentId: event.agentId ?? record.agentId, runId: event.runId ?? record.runId, sequence: event.sequence ?? record.sequence };
      }
    } catch { /* event has not been durably written */ }
  }
  return undefined;
}

export function createEventAvailability(deps: EventAvailabilityDeps = {}): EventAvailability {
  const listeners = new Set<() => void>();
  const registry = deps.registry ?? spawnRecords;
  const pollMs = deps.pollMs ?? 100;
  const discover = async (target: string, selectedRegistry: () => ReadonlyMap<string, SpawnRecord>) => {
    const terminal = findEvent(target, selectedRegistry);
    if (terminal) return terminal;
    const record = [...selectedRegistry().values()].find(item => item.name === target || item.runId === target || item.agentId === target);
    if (!record?.paneId) return undefined;
    const live = await (deps.status ?? getAgentStatus)(record.paneId);
    if (live.ok && live.data === 'blocked') return { status: 'available' as const, kind: 'blocked' as const, target: record.name, agentId: record.agentId, runId: record.runId, sequence: record.sequence };
    return undefined;
  };
  const api: EventAvailability = {
    notify() { for (const listener of [...listeners]) listener(); },
    async wait(params, selectedRegistry = registry) {
      const immediate = await discover(params.target, selectedRegistry);
      if (immediate) return immediate;
      const deadline = Date.now() + Math.max(0, params.timeout);
      const record = [...selectedRegistry().values()].find(item => item.name === params.target || item.runId === params.target || item.agentId === params.target);
      const unwatch = record?.sessionPath ? deps.watch?.(record.sessionPath, () => api.notify()) : undefined;
      try { while (true) {
        if (params.signal?.aborted) return { status: 'cancelled' };
        const remaining = deadline - Date.now();
        if (remaining <= 0) return { status: 'timeout' };
        await new Promise<void>(resolve => {
          let done = false;
          const finish = () => { if (done) return; done = true; clearTimeout(timer); listeners.delete(finish); params.signal?.removeEventListener('abort', finish); resolve(); };
          listeners.add(finish);
          const timer = setTimeout(finish, Math.min(pollMs, remaining));
          params.signal?.addEventListener('abort', finish, { once: true });
          if (params.signal?.aborted) finish();
        });
        const found = await discover(params.target, selectedRegistry);
        if (found) return found;
      } } finally { unwatch?.(); }
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
      return { content: [{ type: 'text', text: data.status === 'available' ? data.kind === 'blocked' ? `Agent ${data.target} is blocked; answer explicitly with herdr_message_agent or herdr_send_keys. No terminal result or ACK is available.` : `Event available: ${data.eventId}` : data.status === 'timeout' ? 'Wait timed out; no event consumed.' : 'Wait cancelled; child continues and no event was consumed.' }], details: data };
    },
  });
}
