import assert from 'node:assert/strict';
import { createJiti } from 'jiti';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

for (const key of Object.keys(process.env)) if (/^(HERDR|PI_HERDR)/.test(key)) delete process.env[key];
process.env.PI_OFFLINE = '1';
const root = mkdtempSync(join(tmpdir(), 'spec43-pr56-delivery-sdk-'));
process.env.PI_CODING_AGENT_DIR = join(root, 'pi-agent');
const fakeHerdr = join(root, 'fake-herdr.cjs');
writeFileSync(fakeHerdr, '#!/usr/bin/env node\nprocess.stderr.write("unexpected offline Herdr call: "+JSON.stringify(process.argv.slice(2)));process.exit(90);\n', { mode: 0o700 });
// An unexpected default adapter call can reach only this fake, never a real pane.
process.env.HERDR_BIN_PATH = fakeHerdr;
const jiti = createJiti(import.meta.url);
const imp = p => jiti.import(new URL('../' + p, import.meta.url).pathname);
const sdk = 'node_modules/@earendil-works/pi-coding-agent/dist/core/';
const { AgentSession } = await imp(sdk + 'agent-session.js');
const { SessionManager } = await imp(sdk + 'session-manager.js');
const { SettingsManager } = await imp(sdk + 'settings-manager.js');
const { ModelRuntime } = await imp(sdk + 'model-runtime.js');
const { AuthStorage } = await imp(sdk + 'auth-storage.js');
const { convertToLlm } = await imp(sdk + 'messages.js');
const { createExtensionRuntime, loadExtensionFromFactory } = await imp(sdk + 'extensions/loader.js');
const { createEventBus } = await imp(sdk + 'event-bus.js');
const { Agent } = await imp('node_modules/@earendil-works/pi-agent-core/dist/agent.js');
const { registerDelivery, stopDeliveryLoop, deliverOnce, makeDeliverySink } = await imp('src/delivery.ts');
const { ParentNotifyStore } = await imp('src/parent-notify-store.ts');
const { DeliveryLedger } = await imp('src/delivery-ledger.ts');
const sp = await imp('src/spawn.ts');
const model = { id: 'deterministic', provider: 'delivery-fixes-offline', api: 'delivery-fixes-offline', name: 'Delivery fixes offline', reasoning: false, input: ['text'], contextWindow: 100000, maxTokens: 1000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
const assistant = (content = [{ type: 'text', text: 'parent final' }], stopReason = 'stop') => ({ role: 'assistant', content, stopReason, timestamp: Date.now(), api: model.api, provider: model.provider, model: model.id, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
const stream = message => ({ async *[Symbol.asyncIterator]() { yield { type: 'done', reason: message.stopReason, message }; }, result: async () => message });
const runtime = await ModelRuntime.create({ credentials: AuthStorage.inMemory(), modelsPath: null, refreshOnCreate: false });
runtime.registerProvider(model.provider, { api: model.api, baseUrl: 'http://127.0.0.1:1/not-used', apiKey: 'offline', models: [model] });
await runtime.refresh({ allowNetwork: false });
const sessions = [];
async function fixture(name, factory, output) {
 const cwd = join(root, name); mkdirSync(cwd);
 const manager = SessionManager.create(cwd, cwd), requests = [], errors = [];
 let pi; const extensionRuntime = createExtensionRuntime();
 const ext = await loadExtensionFromFactory(api => {
  pi = api; registerDelivery(api); stopDeliveryLoop(); factory?.(api, manager);
 }, cwd, createEventBus(), extensionRuntime);
 const loader = { getExtensions: () => ({ extensions: [ext], errors: [], runtime: extensionRuntime }), getSkills: () => ({ skills: [], diagnostics: [] }), getPrompts: () => ({ prompts: [], diagnostics: [] }), getThemes: () => ({ themes: [], diagnostics: [] }), getAgentsFiles: () => ({ agentsFiles: [] }), getSystemPrompt: () => 'Offline SDK delivery regression', getSystemPromptSource: () => undefined, getAppendSystemPrompt: () => [], getAppendSystemPromptSources: () => [], extendResources() {}, async reload() {} };
 const agent = new Agent({ initialState: { model, tools: [] }, convertToLlm, streamFn: (_model, context) => {
  requests.push(structuredClone(context)); return stream(output?.(requests.length) ?? assistant());
 } });
 const session = new AgentSession({ agent, sessionManager: manager, settingsManager: SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false }, cacheWarming: { enabled: false } }), modelRuntime: runtime, resourceLoader: loader, cwd, initialActiveToolNames: [] });
 sessions.push(session); await session.bindExtensions({ onError: error => errors.push(error) });
 return { cwd, manager, requests, errors, pi, session };
}
const selected = process.argv[2];
try {
 if (!selected || selected === 'SP3') {
  const { registerResultTool, getAgentResult } = await imp('src/tools/result.ts');
  const { registerWaitTool } = await imp('src/tools/wait.ts');
  const { spawnFromTool } = await imp('src/tools/agents.ts');
  const { triggerTurn } = await imp('src/tools/lifecycle.ts');
  const { DEFAULT_SETTINGS } = await imp('src/settings.ts');
  sp.clearSpawnRegistry();
  let commands = [], commandIndex = 0;
  const fx = await fixture('accepted-start-failure', pi => {
   registerResultTool(pi, { status: async () => ({ ok: true, data: 'working' }) }); registerWaitTool(pi);
  }, () => {
   const command = commands[commandIndex++];
   return command ? assistant([{ type: 'toolCall', id: 'failure-tool-' + commandIndex, name: command.name, arguments: command.args }], 'toolUse') : assistant();
  });
  await fx.session.prompt('establish receiver', { expandPromptTemplates: false });
  const host = fx.manager.getSessionFile(), live = [{ paneId: 'fake-full-slot', name: 'other', agentStatus: 'working' }];
  let worktreeAttempts = 0;
  // Capacity is scoped to this receiver's registry, not arbitrary fleet panes.
  sp.putSpawnRecordForTests({ name: 'other', kind: 'pi', paneId: 'fake-full-slot', submitted: true });
  const options = { load: () => ({ ...DEFAULT_SETTINGS, max_parallel_agents: 1, layout_mode: 'spiral', notifications: 'none' }), env: {}, autodrain: false,
   kinds: async () => ['pi'], list: async () => live, fleet: async () => ({ ok: true, data: live }), paneList: async () => [], parentSession: host,
   worktree: async () => { worktreeAttempts++; return { ok: false, error: { code: 'AGENT_START_FAILED', message: 'FAILED ACCEPTED RUN: worktree rejected before seeding' } }; },
   start: async () => { throw new Error('worktree rejection must prevent pane start'); } };
  const accepted = await spawnFromTool({ name: 'accepted-failure', agent: { kind: 'pi' }, prompt: 'offline task', isolated: true }, options);
  assert.equal(accepted.ok, true, JSON.stringify(accepted)); assert.equal(accepted.data.status, 'queued');
  const failed = sp.spawnRecords().get(accepted.data.name);
  assert.equal(failed.sessionPath, undefined); assert.equal(failed.submitted, false);
  live.length = 0; await sp.drainQueueOnce(options);
  assert.match(failed.startError, /worktree rejected/);
  // Optional adapter seam verifies the helper and all subsequent real SDK
  // behavior while production spawn/wait wiring belongs to the merger. The
  // default command must remain a genuine no-tick production regression.
  const helperWired = process.argv.includes('--persist-accepted-failure');
  if (!helperWired) {
   assert.ok(failed.sessionPath, 'production failure point persists before wait can recover it');
   const archivePath = failed.sessionPath + '.completion-' + accepted.data.runId + '.json';
   const failureBytes = readFileSync(archivePath, 'utf8');
   assert.equal(JSON.parse(failureBytes).runId, accepted.data.runId);
   assert.equal(sp.readPersistedRegistry(host).find(row => row.name === failed.name).sessionPath, failed.sessionPath);
   await sp.drainQueueOnce(options);
   assert.equal(worktreeAttempts, 1, 'second drain cannot restart the definitively failed accepted run');
   assert.equal(readFileSync(archivePath, 'utf8'), failureBytes);
  }
  if (helperWired) {
   const { saveAcceptedStartFailure } = await imp('src/sessionfile.ts');
   saveAcceptedStartFailure(failed);
   sp.writePersistedRegistry(host, [...sp.spawnRecords().values()]);
  }
  // Default: no delivery tick, result query, or direct helper has run;
  // production failure recording itself must make the acceptance waitable.
  const oldRun = accepted.data.runId, agentId = accepted.data.agentId;
  commands = [
   { name: 'herdr_wait_agent_event', args: { target: failed.name, timeout: 0 } },
   { name: 'herdr_get_agent_result', args: { target: failed.name } },
   { name: 'herdr_get_agent_result', args: { target: oldRun, ack: { hostFile: host, eventId: oldRun, agentId, runId: oldRun, sequence: 1 } } },
   { name: 'herdr_get_agent_result', args: { target: oldRun } },
  ]; commandIndex = 0;
  fx.session.setActiveToolsByName(['herdr_wait_agent_event', 'herdr_get_agent_result']);
  await fx.session.prompt('wait and handle failed accepted spawn', { expandPromptTemplates: false });
  const replies = SessionManager.open(host).getBranch().filter(row => row.type === 'message' && row.message?.role === 'toolResult').map(row => row.message);
  assert.equal(replies.length, 4);
  assert.equal(replies[0].details.status, 'available', 'production accepted spawn failure is waitable without a delivery tick');
  assert.equal(replies[0].details.eventId, oldRun); assert.equal(replies[0].details.result, undefined);
  assert.equal(replies[1].details.status, 'error'); assert.match(replies[1].details.result, /FAILED ACCEPTED RUN/);
  assert.equal(replies[1].details.runId, oldRun); assert.equal(replies[1].details.agentId, agentId);
  assert.equal(replies[2].details.acknowledged, true); assert.equal(replies[3].details.result, undefined);
  assert.equal(new DeliveryLedger(host).reconcile(oldRun).status, 'acked');
  assert.equal(replies.filter(reply => reply.details?.result?.includes('FAILED ACCEPTED RUN')).length, 1, 'one host-committed failure body');
  assert.equal(fx.requests.some(context => context.messages.some(msg => JSON.stringify(msg.content).includes('FAILED ACCEPTED RUN'))), true);
  assert.equal(failed.submitted, false); assert.equal(failed.startedAt, undefined);
  const substrate = failed.sessionPath;
  const continued = await triggerTurn({ target: failed.name, text: 'explicit recovery dispatch' }, { ...options,
   worktree: async () => ({ ok: true, data: fx.cwd }), start: async () => ({ ok: true, data: { agent: { pane_id: 'fake-recovered' } } }),
   boot: async () => ({ ok: true, data: true }), submit: async () => ({ ok: true, data: true }),
   readEditor: async () => ({ ok: true, data: { text: '', status: 'working' } }), status: async () => ({ ok: true, data: 'working' }),
  });
  assert.equal(continued.ok, true, JSON.stringify(continued));
  assert.equal(continued.data.agentId, agentId); assert.notEqual(continued.data.runId, oldRun);
  assert.equal(failed.sessionPath, substrate, 'explicit followup resumes failure substrate, not a new logical agent');
  const retained = await getAgentResult({ target: oldRun, reread: true }, { hostFile: host, toolCallId: 'retained-old-failure' });
  assert.equal(retained.ok, true); assert.equal(retained.data.runId, oldRun); assert.match(retained.data.result, /FAILED ACCEPTED RUN/);
  assert.deepEqual(fx.errors, []);
  console.log('PASS SP3', helperWired ? 'EXPLICIT HELPER ADAPTER (not production wiring)' : 'PRODUCTION NO-TICK', '/ accepted queued spawn / real SDK wait+Pull+ACK / explicit followup with retained failure');
  fx.session.dispose();
 }
 if (!selected || selected === 'SP3-owner') {
  const { createEventAvailability } = await imp('src/tools/wait.ts');
  const { getAgentResult } = await imp('src/tools/result.ts');
  sp.clearSpawnRegistry();
  const fx = await fixture('owner-conflict'); await fx.session.prompt('establish trusted receiver', { expandPromptTemplates: false });
  const host = fx.manager.getSessionFile(), other = join(fx.cwd, 'other-owner.jsonl'); writeFileSync(other, '');
  const rec = { name: 'conflict-owner', kind: 'pi', agentId: 'conflict-agent', runId: 'conflict-run', sequence: 1,
   stance: 'autonomous', startError: 'original definite launch failure', submitted: false, spawnedAt: 1,
   lineage: { ownerSession: other, rootSession: other } };
  sp.putSpawnRecordForTests(rec); sp.writePersistedRegistry(host, [rec]); sp.writePersistedRegistry(other, [rec]);
  const otherBytes = readFileSync(other + '.registry.json', 'utf8');
  const found = await createEventAvailability().wait({ target: rec.name, timeout: 0 });
  assert.equal(found.status, 'timeout', 'conflicting ambient/lineage owner cannot seed failure in wait');
  assert.equal(rec.sessionPath, undefined); assert.match(rec.startFailurePersistenceError, /owner.*conflict/i);
  const pulled = await getAgentResult({ target: rec.name }, { hostFile: host, toolCallId: 'conflict-owner-pull' });
  assert.equal(pulled.ok, true); assert.equal(pulled.data.result, undefined); assert.match(pulled.data.note, /persistence|owner/i);
  assert.equal(rec.sessionPath, undefined, 'Pull checks owner before helper seeding');
  await deliverOnce({ fleet: { ok: true, data: [] }, load: () => ({ notifications: 'none' }), sessionPath: host });
  assert.equal(rec.sessionPath, undefined, 'delivery tick checks owner before helper seeding');
  assert.equal(readFileSync(other + '.registry.json', 'utf8'), otherBytes);
  assert.equal(rec.startError, 'original definite launch failure');
  fx.session.dispose(); sp.clearSpawnRegistry(); console.log('PASS SP3-owner / real SDK receiver / wait Pull tick all reject conflicting registry owner before seed');
 }
 if (!selected || selected === 'R11') {
  for (const commitNoticeFirst of [false, true]) {
   sp.clearSpawnRegistry();
   const fx = await fixture('governance-' + commitNoticeFirst);
   await fx.session.prompt('establish parent', { expandPromptTemplates: false });
   const host = fx.manager.getSessionFile(), child = join(fx.cwd, 'child.jsonl'), completionId = 'current-run';
   writeFileSync(child, ''); writeFileSync(child + '.completion-event', completionId);
   const record = { name: 'worker', kind: 'pi', stance: 'autonomous', paneId: 'fake-child', sessionPath: child, agentId: 'current-agent', runId: completionId, sequence: 1 };
   const deps = { registry: () => new Map([['worker', record]]), sessionPath: host, load: () => ({ notifications: 'normal' }), fleet: { ok: true, data: [{ paneId: 'fake-child', agentStatus: 'idle' }] }, push: makeDeliverySink(fx.pi), closePane: async () => ({ ok: true }) };
   await deliverOnce(deps);
   const initial = new ParentNotifyStore(host).pending(); assert.equal(initial.length, 1);
   assert.equal(initial[0].details.kind, 'persistence-error');
   if (commitNoticeFirst) await fx.session.prompt('consume governance warning first', { expandPromptTemplates: false });
   // Retry a persisted diagnostic both before and after warning host commit.
   await deliverOnce(deps);
   const before = new DeliveryLedger(host).reconcile(completionId);
   assert.equal(before, undefined, 'governance must not reserve or commit the completion ledger entry');
   assert.notEqual(initial[0].details.eventId, completionId, 'warning arbitration identity is not the completion identity');
   assert.equal(initial[0].details.completionEventId, completionId, 'original reference is non-arbitrating metadata');
   const body = 'ACTUAL COMPLETE FINAL BODY';
   writeFileSync(child + '.exit', JSON.stringify({ type: 'done', text: body, eventId: completionId, agentId: 'current-agent', runId: completionId, sequence: 1 }));
   deps.fleet = { ok: true, data: [] }; await deliverOnce(deps);
   assert.equal(record.delivery?.kind, 'done');
   await fx.session.prompt('natural next run after durable completion', { expandPromptTemplates: false });
   await fx.session.prompt('another natural run verifies no replay', { expandPromptTemplates: false });
   const rows = SessionManager.open(host).getBranch();
   const finals = rows.filter(row => row.type === 'custom_message' && row.details?.eventId === completionId && row.content === body);
   assert.equal(finals.length, 1, 'complete body actually committed once to SDK host JSONL');
   assert.equal(rows.filter(row => row.type === 'custom_message' && row.details?.kind === 'persistence-error').length, 1, 'accepted governance warning does not replay');
   assert.equal(fx.requests.some(context => context.messages.some(msg => JSON.stringify(msg.content).includes(body))), true, 'provider receives complete body');
   assert.equal(new DeliveryLedger(host).reconcile(completionId).status, 'delivered');
   assert.deepEqual(fx.errors, []);
   console.log('PASS R11 actual registerDelivery / SDK / SessionManager', { commitNoticeFirst, completeHostBodies: finals.length });
   fx.session.dispose();
  }
 }
} finally { stopDeliveryLoop(); sp.clearSpawnRegistry(); for (const session of sessions) session.dispose(); rmSync(root, { recursive: true, force: true }); }
