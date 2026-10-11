import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createJiti } from 'jiti';
const host = new URL('../', import.meta.url).pathname;
const jiti = createJiti(import.meta.url, { fsCache: false });
const imp = p => jiti.import(path.join(host, p));
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
const sp = await imp('src/spawn.js'), dl = await imp('src/delivery.ts');
const { ParentNotifyStore } = await imp('src/parent-notify-store.ts');
const root = fs.mkdtempSync(path.join(tmpdir(), 'reload-entry-'));
process.env.PI_CODING_AGENT_DIR = path.join(root, 'pi-agent');
const legacyHost = path.join(root, 'legacy-parent.jsonl'), legacyLeaf = path.join(root, 'legacy-leaf.jsonl');
fs.writeFileSync(legacyHost, ''); fs.writeFileSync(legacyLeaf, '');
const legacy = { name: 'legacy', kind: 'pi', paneId: 'fake:legacy', sessionPath: legacyLeaf, stance: 'autonomous', lineage: { ownerSession: legacyHost, rootSession: legacyHost } };
fs.writeFileSync(legacyLeaf + '.exit', JSON.stringify({ type: 'done', text: 'LEGACY EXACT BODY', eventId: 'legacy-event' }));
sp.writePersistedRegistry(legacyHost, [legacy]); sp.restoreSpawnRegistry(legacyHost, { autodrain: false });
const reviewed = sp.spawnRecords().get('legacy'), legacyNotices = []; let legacyCloses = 0;
assert.equal(reviewed.identityReviewRequired, true);
await dl.deliverOnce({ registry: () => sp.spawnRecords(), sessionPath: legacyHost, load: () => ({ notifications: 'normal' }), fleet: { ok: true, data: [{ paneId: 'fake:legacy', agentStatus: 'done' }] }, push: message => legacyNotices.push(message), closePane: async () => { legacyCloses++; } });
assert.equal(reviewed.delivery, undefined); assert.match(reviewed.pushError, /identity.*review/i);
assert.equal(legacyNotices.some(message => message.content.includes('LEGACY EXACT BODY')), false); assert.equal(legacyCloses, 0);
sp.clearSpawnRegistry();
const manager = SessionManager.create(root, root), requests = [], errors = [];
const model = { id: 'deterministic', provider: 'reload-proof', api: 'reload-proof', name: 'Reload proof', reasoning: false, input: ['text'], contextWindow: 100000, maxTokens: 1000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
const runtime = await ModelRuntime.create({ credentials: AuthStorage.inMemory(), modelsPath: null, refreshOnCreate: false });
runtime.registerProvider(model.provider, { api: model.api, baseUrl: 'http://127.0.0.1:1/not-used', apiKey: 'offline', models: [model] }); await runtime.refresh({ allowNetwork: false });
let extensionRuntime, extension, sink;
const loader = {
 getExtensions: () => ({ extensions: [extension], errors: [], runtime: extensionRuntime }), getSkills: () => ({ skills: [], diagnostics: [] }), getPrompts: () => ({ prompts: [], diagnostics: [] }), getThemes: () => ({ themes: [], diagnostics: [] }), getAgentsFiles: () => ({ agentsFiles: [] }),
 getSystemPrompt: () => 'Offline reload proof', getSystemPromptSource: () => undefined, getAppendSystemPrompt: () => [], getAppendSystemPromptSources: () => [], extendResources() {},
 async reload() { extensionRuntime = createExtensionRuntime(); extension = await loadExtensionFromFactory(api => { dl.registerDelivery(api); sink = dl.makeDeliverySink(api); dl.stopDeliveryLoop(); }, root, createEventBus(), extensionRuntime); },
};
await loader.reload();
const agent = new Agent({ initialState: { model, tools: [] }, convertToLlm, streamFn: (_model, context) => {
 requests.push(structuredClone(context));
 const message = { role: 'assistant', content: [{ type: 'text', text: 'finished' }], stopReason: 'stop', timestamp: Date.now(), api: model.api, provider: model.provider, model: model.id, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
 return { async *[Symbol.asyncIterator]() { yield { type: 'done', reason: 'stop', message }; }, result: async () => message };
} });
const session = new AgentSession({ agent, sessionManager: manager, settingsManager: SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false }, cacheWarming: { enabled: false } }), modelRuntime: runtime, resourceLoader: loader, cwd: root, initialActiveToolNames: [] });
try {
 await session.bindExtensions({ onError: error => errors.push(error) }); dl.stopDeliveryLoop(); await session.prompt('initialize parent', { expandPromptTemplates: false }); dl.stopDeliveryLoop();
 const hostFile = manager.getSessionFile(), leaf = path.join(root, 'leaf.jsonl'); fs.writeFileSync(leaf, '');
 const record = { name: 'leaf', kind: 'pi', agentId: 'leaf-agent', runId: 'own-final', sequence: 1, paneId: 'fake:leaf', sessionPath: leaf, stance: 'interactive', submitted: true, lineage: { ownerSession: hostFile, rootSession: hostFile } };
 const event = { type: 'done', text: 'letter', eventId: 'own-final', runId: 'own-final', agentId: 'leaf-agent', sequence: 1, rootSession: hostFile };
 fs.writeFileSync(leaf + '.exit', JSON.stringify(event)); fs.writeFileSync(leaf + '.completion-own-final.json', JSON.stringify(event)); sp.putSpawnRecordForTests(record); sp.writePersistedRegistry(hostFile, [record]);
 const deps = { sessionPath: hostFile, load: () => ({ notifications: 'normal' }), fleet: { ok: true, data: [{ paneId: 'fake:leaf', agentStatus: 'done' }] }, push: message => sink(message), closePane: async () => { throw new Error('interactive pane must remain'); } };
 await dl.deliverOnce(deps); assert.equal(requests.length, 1, 'production admission does not wake a finished parent'); assert.equal(new ParentNotifyStore(hostFile).pending().length, 1);
 await session.prompt('natural receive', { expandPromptTemplates: false }); dl.stopDeliveryLoop(); await dl.deliverOnce(deps);
 const rows = () => SessionManager.open(hostFile).getBranch().filter(row => row.type === 'custom_message' && row.details?.eventId === event.eventId && JSON.stringify(row.content).includes('letter'));
 assert.equal(rows().length, 1); assert.equal(sp.readPersistedRegistry(hostFile)[0].delivery?.kind, 'done');
 await session.reload(); dl.stopDeliveryLoop(); assert.equal(sp.spawnRecords().get('leaf').delivery?.kind, 'done'); await dl.deliverOnce(deps);
 await session.prompt('natural after reload', { expandPromptTemplates: false }); dl.stopDeliveryLoop(); assert.equal(rows().length, 1, 'actual SDK reload never re-appends the same final');
 const local = sp.spawnRecords().get('leaf'); local.delivery = undefined;
 await assert.rejects(dl.deliverOnce({ ...deps, writeRegistry: () => { throw new Error('disk refused'); } }), /persistence failed/);
 assert.equal(local.delivery, undefined, 'failed persist rolls back volatile dedupe'); assert.match(local.pushError, /persistence failed/); assert.equal(rows().length, 1);
 const counts = requests.map(request => request.messages.filter(message => (typeof message.content === 'string' ? message.content : message.content.filter(part => part.type === 'text').map(part => part.text).join('\n')).includes('letter')).length);
 assert.deepEqual(counts, [0, 1, 1], 'later requests retain the original context, not a duplicate host append'); assert.deepEqual(errors, []);
 const summary = { root, hostFile, hostBodies: rows().length, providerBodyCounts: counts, actualSessionReload: true, productionAdmission: true, registryFailureRolledBack: true };
 fs.writeFileSync(path.join(root, 'provider-contexts.json'), JSON.stringify(requests, null, 2)); fs.writeFileSync(path.join(root, 'trace.json'), JSON.stringify(summary, null, 2)); console.log('delivery-reload-sdk: passed', JSON.stringify(summary));
} finally { dl.stopDeliveryLoop(); session.dispose(); sp.clearSpawnRegistry(); fs.rmSync(root, { recursive: true, force: true }); }
