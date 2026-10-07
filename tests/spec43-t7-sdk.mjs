import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createJiti } from 'jiti';

// Sanitize before loading SDK/project modules; never inherit live fleet identity.
const strippedEnvironment = Object.keys(process.env).filter(key => /^(?:HERDR|PI_HERDR)/.test(key));
for (const key of strippedEnvironment) delete process.env[key];
process.env.PI_OFFLINE = '1';
const jiti = createJiti(import.meta.url);
const sdk = '../node_modules/@earendil-works/pi-coding-agent/dist/core/';
const { AgentSession } = await jiti.import(sdk + 'agent-session.js');
const { SessionManager } = await jiti.import(sdk + 'session-manager.js');
const { SettingsManager } = await jiti.import(sdk + 'settings-manager.js');
const { ModelRuntime } = await jiti.import(sdk + 'model-runtime.js');
const { AuthStorage } = await jiti.import(sdk + 'auth-storage.js');
const { convertToLlm } = await jiti.import(sdk + 'messages.js');
const { createExtensionRuntime, loadExtensionFromFactory } = await jiti.import(sdk + 'extensions/loader.js');
const { createEventBus } = await jiti.import(sdk + 'event-bus.js');
const { Agent } = await jiti.import('../node_modules/@earendil-works/pi-agent-core/dist/agent.js');
const { Type } = await jiti.import('typebox');
const { registerParentDelivery } = await jiti.import('../src/parent-delivery.ts');
const { makeDeliverySink } = await jiti.import('../src/push.ts');
const { ParentNotifyStore } = await jiti.import('../src/parent-notify-store.ts');
const { DeliveryLedger } = await jiti.import('../src/delivery-ledger.ts');
const model = { id: 'deterministic', provider: 't7-offline', api: 't7-offline', name: 'T7 deterministic', reasoning: false, input: ['text'], contextWindow: 100000, maxTokens: 1000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
const assistant = (content, stopReason = 'stop') => ({ role: 'assistant', content, stopReason, timestamp: Date.now(), api: model.api, provider: model.provider, model: model.id, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
const response = (text = 'finished') => assistant([{ type: 'text', text }]);
const stream = message => ({ async *[Symbol.asyncIterator]() { yield { type: 'done', reason: message.stopReason, message }; }, result: async () => message });
const latch = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const root = mkdtempSync(join(tmpdir(), 'spec43-t7-sdk-'));
const evidenceDir = new URL('../.agents/evidence/spec43-t7/', import.meta.url);
mkdirSync(evidenceDir, { recursive: true });
const cases = [], sessions = [];
const runtime = await ModelRuntime.create({ credentials: AuthStorage.inMemory(), modelsPath: null, refreshOnCreate: false });
runtime.registerProvider(model.provider, { api: model.api, baseUrl: 'http://127.0.0.1:1/not-used', apiKey: 'deterministic-not-a-real-secret', models: [model] });
await runtime.refresh({ allowNetwork: false });

async function fixture(name, factory, outputs = [response()]) {
 const dir = join(root, name); mkdirSync(dir);
 const manager = SessionManager.create(dir, dir);
 const requests = [], events = [], errors = [];
 let session, index = 0, extensionApi;
 const extensionRuntime = createExtensionRuntime();
 const ext = await loadExtensionFromFactory(pi => { extensionApi = pi; factory?.(pi, () => session, events); }, dir, createEventBus(), extensionRuntime);
 const loader = {
  getExtensions: () => ({ extensions: [ext], errors: [], runtime: extensionRuntime }),
  getSkills: () => ({ skills: [], diagnostics: [] }), getPrompts: () => ({ prompts: [], diagnostics: [] }),
  getThemes: () => ({ themes: [], diagnostics: [] }), getAgentsFiles: () => ({ agentsFiles: [] }),
  getSystemPrompt: () => 'T7 deterministic SDK proof', getSystemPromptSource: () => undefined,
  getAppendSystemPrompt: () => [], getAppendSystemPromptSources: () => [], extendResources() {}, async reload() {},
 };
 const settings = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false }, cacheWarming: { enabled: false } });
 const agent = new Agent({ initialState: { model, tools: [] }, convertToLlm, streamFn: (_model, context) => {
  requests.push(structuredClone(context));
  const output = outputs[index++] ?? response('extra provider request');
  return stream(output);
 } });
 session = new AgentSession({ agent, sessionManager: manager, settingsManager: settings, modelRuntime: runtime, resourceLoader: loader, cwd: dir, initialActiveToolNames: [] });
 sessions.push(session);
 await session.bindExtensions({ onError: error => errors.push(error) });
 session.subscribe(event => events.push({ type: event.type, role: event.message?.role, stopReason: event.message?.stopReason, agentStreaming: agent.state.isStreaming, sessionStreaming: session.isStreaming }));
 const save = extra => {
  assert.deepEqual(errors, [], `${name}: no swallowed extension errors`);
  const parentJSONL = readFileSync(manager.getSessionFile(), 'utf8');
  writeFileSync(new URL(`sdk-${name}-parent.jsonl`, evidenceDir), parentJSONL);
  writeFileSync(new URL(`sdk-${name}-provider.json`, evidenceDir), JSON.stringify(requests, null, 2) + '\n');
  cases.push({ name, requests: requests.length, events, ...extra });
 };
 return { session, agent, manager, pi: extensionApi, requests, events, save };
}

try {
 // Baseline counterexample: final-answer busy remains true and followUp starts another request.
 let finalSnapshot, inserted = false;
 const baseline = await fixture('closing-followup-counterexample', (pi, getSession) => {
  pi.on('message_end', async event => {
   if (event.message.role !== 'assistant' || inserted) return;
   inserted = true;
   finalSnapshot = { agentStreaming: getSession().agent.state.isStreaming, sessionStreaming: getSession().isStreaming };
   await getSession().sendCustomMessage({ customType: 'herdr-delivery', content: 'LATE BASELINE FOLLOWUP', display: true }, { deliverAs: 'followUp', triggerTurn: true });
  });
 });
 await baseline.session.prompt('finish baseline', { expandPromptTemplates: false });
 assert.deepEqual(finalSnapshot, { agentStreaming: true, sessionStreaming: true });
 assert.equal(baseline.requests.length, 2);
 baseline.save({ finalSnapshot, expectedCounterexample: 'busy-only followUp after final answer causes extra request' });
 baseline.session.dispose();

 // Counterexample: agent_end is not settled; queued work triggers another low-level run.
 let endSnapshot, endInserted = false;
 const ended = await fixture('agent-end-counterexample', (pi, getSession) => {
  pi.on('agent_end', async () => {
   if (endInserted) return; endInserted = true;
   endSnapshot = { agentStreaming: getSession().agent.state.isStreaming, sessionStreaming: getSession().isStreaming };
   await getSession().sendCustomMessage({ customType: 'herdr-delivery', content: 'LATE AGENT_END FOLLOWUP', display: true }, { deliverAs: 'followUp', triggerTurn: true });
  });
 });
 await ended.session.prompt('finish before end handler', { expandPromptTemplates: false });
 assert.deepEqual(endSnapshot, { agentStreaming: true, sessionStreaming: true });
 assert.equal(ended.requests.length, 2);
 ended.save({ endSnapshot, expectedCounterexample: 'agent_end handler followUp causes fresh low-level run before settled' });
 ended.session.dispose();

 // SDK nextTurn is passive in closing/finished and enters the next natural Session.prompt.
 let parkedClosing = false;
 const natural = await fixture('nextturn-natural-run', (pi, getSession) => {
  pi.on('message_end', async event => {
   if (event.message.role !== 'assistant' || parkedClosing) return;
   parkedClosing = true;
   await getSession().sendCustomMessage({ customType: 'herdr-delivery', content: 'CLOSING PARKED BODY', display: true }, { deliverAs: 'nextTurn', triggerTurn: false });
  });
 });
 await natural.session.prompt('finish before late notifications', { expandPromptTemplates: false });
 assert.equal(natural.requests.length, 1);
 assert.equal(natural.session.isIdle, true);
 await natural.session.sendCustomMessage({ customType: 'herdr-delivery', content: 'FINISHED PARKED BODY', display: true }, { deliverAs: 'nextTurn', triggerTurn: false });
 assert.equal(natural.requests.length, 1, 'finished late nextTurn never calls provider');
 assert.equal(readFileSync(natural.manager.getSessionFile(), 'utf8').includes('PARKED BODY'), false, 'queue acceptance is not durable body receipt');
 await natural.session.prompt('next natural user run', { expandPromptTemplates: false });
 assert.equal(natural.requests.length, 2, 'one request per natural run');
 for (const body of ['CLOSING PARKED BODY', 'FINISHED PARKED BODY']) {
  assert.equal(natural.requests[1].messages.filter(message => JSON.stringify(message.content).includes(body)).length, 1);
  assert.equal(SessionManager.open(natural.manager.getSessionFile()).getBranch().filter(row => row.type === 'custom_message' && row.content === body).length, 1);
 }
 await natural.session.sendCustomMessage({ customType: 'herdr-delivery', content: 'EXPLICIT WAKE AUTHORIZED', display: true }, { deliverAs: 'followUp', triggerTurn: true });
 assert.equal(natural.requests.length, 3, 'idle explicit wake intentionally starts exactly one request');
 natural.save({ closingRequests: 1, finishedRequests: 1, afterNaturalRun: 2, afterExplicitWake: 3 });
 natural.session.dispose();

 // Hold a real SDK tool execution. followUp queues, cannot abort or bypass its result.
 const toolEntered = latch(), releaseTool = latch();
 let toolFinished = false, aborts = 0;
 const toolFixture = await fixture('tool-followup-noninterrupt', pi => {
  pi.registerTool({ name: 't7_hold', description: 'Hold tool until released', parameters: Type.Object({}), execute: async (_id, _params, signal) => {
   signal.addEventListener('abort', () => { aborts++; });
   toolEntered.resolve(); await releaseTool.promise;
   assert.equal(signal.aborted, false); toolFinished = true;
   return { content: [{ type: 'text', text: 'REAL TOOL FINISHED' }], details: {} };
  } });
 }, [assistant([{ type: 'toolCall', id: 't7-real-tool', name: 't7_hold', arguments: {} }], 'toolUse'), response('tool natural response'), response('explicit followup response')]);
 const toolRun = toolFixture.session.prompt('run real tool', { expandPromptTemplates: false });
 await toolEntered.promise;
 assert.equal(toolFixture.requests.length, 1);
 await toolFixture.session.sendCustomMessage({ customType: 'herdr-delivery', content: 'BUSY FOLLOWUP BODY', display: true }, { deliverAs: 'followUp', triggerTurn: true });
 assert.equal(toolFixture.requests.length, 1, 'cannot request while running tool');
 assert.equal(toolFinished, false); assert.equal(aborts, 0);
 releaseTool.resolve(); await toolRun;
 assert.equal(toolFinished, true); assert.equal(aborts, 0);
 assert.equal(toolFixture.requests.length, 3, 'followUp is active after natural tool run, not interruptive');
 assert.equal(toolFixture.requests[1].messages.some(message => message.role === 'toolResult' && message.toolCallId === 't7-real-tool'), true);
 assert.equal(JSON.stringify(toolFixture.requests[1]).includes('BUSY FOLLOWUP BODY'), false);
 assert.equal(JSON.stringify(toolFixture.requests[2]).includes('BUSY FOLLOWUP BODY'), true);
 toolFixture.save({ toolFinished, aborts, whileToolRunningRequests: 1, afterToolNaturalResponseRequests: 2, finalRequests: 3 });
 toolFixture.session.dispose();

 // Production controller + production sink, through actual ExtensionAPI/Runner binding.
 let parent, closingAccepted = false, parentClosingSnapshot;
 const production = await fixture('production-closing-finished-natural', (pi, getSession) => {
  const sink = makeDeliverySink(pi, { getBranch: () => getSession().sessionManager.getBranch(), getSessionFile: () => getSession()?.sessionManager.getSessionFile() }, { allowCommit: details => parent.allowCommit(details) });
  parent = registerParentDelivery(pi, sink, () => 'normal');
  pi.on('message_end', event => {
   if (event.message.role !== 'assistant' || closingAccepted) return;
   closingAccepted = true;
   parentClosingSnapshot = { phase: parent.phase(), streaming: getSession().isStreaming };
   parent.accept({ content: 'PRODUCTION CLOSING BODY', details: { eventId: 't7-closing' }, wake: true });
  });
 });
 await production.session.prompt('production final answer', { expandPromptTemplates: false });
 assert.deepEqual(parentClosingSnapshot, { phase: 'closing', streaming: true });
 assert.equal(parent.phase(), 'finished'); assert.equal(production.requests.length, 1);
 parent.accept({ content: 'PRODUCTION FINISHED BODY', details: { eventId: 't7-finished' }, wake: true });
 assert.equal(production.requests.length, 1);
 const productionStore = new ParentNotifyStore(production.manager.getSessionFile());
 assert.equal(productionStore.pending().length, 2);
 assert.equal(readFileSync(production.manager.getSessionFile(), 'utf8').includes('PRODUCTION CLOSING BODY'), false);
 await production.session.prompt('production natural next run', { expandPromptTemplates: false });
 assert.equal(production.requests.length, 2);
 for (const [body, eventId] of [['PRODUCTION CLOSING BODY', 't7-closing'], ['PRODUCTION FINISHED BODY', 't7-finished']]) {
  assert.equal(production.requests[1].messages.filter(message => JSON.stringify(message.content).includes(body)).length, 1);
  assert.equal(new DeliveryLedger(production.manager.getSessionFile()).reconcile(eventId).status, 'delivered');
  assert.equal(SessionManager.open(production.manager.getSessionFile()).getBranch().filter(row => row.type === 'custom_message' && row.content === body).length, 1);
 }
 productionStore.subscribe({ eventId: 't7-explicit' }, 60000, 'normal');
 parent.accept({ content: 'PRODUCTION EXPLICIT BODY', details: { eventId: 't7-explicit', kind: 'done' }, wake: true });
 await production.session.waitForIdle();
 assert.equal(production.requests.length, 3);
 assert.equal(productionStore.listSubscriptions().length, 0);
 assert.equal(production.requests[2].messages.filter(message => JSON.stringify(message.content).includes('PRODUCTION EXPLICIT BODY')).length, 1);
 production.save({ parentClosingSnapshot, automaticFinishedRequests: 1, afterNaturalRun: 2, afterExplicitWake: 3, oneShotSubscriptions: 0 });
 production.session.dispose();

 // Production holds every busy arrival until the next user-initiated natural run.
 // toolResults do not expose terminate; no test assumes tool completion guarantees continuation.
 for (const terminate of [false, true]) {
  let busyParent, productionToolFinished = false, productionToolAborts = 0;
  const productionEntered = latch(), productionRelease = latch();
  const body = `PRODUCTION BUSY HELD BODY terminate=${terminate}`;
  const eventId = `t7-tool-held-${terminate}`;
  const productionBusy = await fixture(`production-tool-held-${terminate}`, (pi, getSession) => {
   const sink = makeDeliverySink(pi, { getBranch: () => getSession().sessionManager.getBranch(), getSessionFile: () => getSession()?.sessionManager.getSessionFile() }, { allowCommit: details => busyParent.allowCommit(details) });
   busyParent = registerParentDelivery(pi, sink, () => 'normal');
   pi.registerTool({ name: 't7_production_hold', description: 'Hold production run tool', parameters: Type.Object({}), execute: async (_id, _params, signal) => {
    signal.addEventListener('abort', () => { productionToolAborts++; });
    productionEntered.resolve(); await productionRelease.promise;
    assert.equal(signal.aborted, false); productionToolFinished = true;
    return { content: [{ type: 'text', text: 'PRODUCTION TOOL DONE' }], details: {}, terminate };
   } });
  }, [assistant([{ type: 'toolCall', id: 't7-production-tool', name: 't7_production_hold', arguments: {} }], 'toolUse'), response('production natural response')]);
  const productionRun = productionBusy.session.prompt('production run tool', { expandPromptTemplates: false });
  await productionEntered.promise;
  assert.equal(busyParent.phase(), 'busy');
  busyParent.accept({ content: body, details: { eventId }, wake: true });
  assert.equal(productionBusy.requests.length, 1);
  assert.equal(productionToolFinished, false); assert.equal(productionToolAborts, 0);
  productionRelease.resolve(); await productionRun;
  assert.equal(productionToolFinished, true); assert.equal(productionToolAborts, 0);
  const afterToolRequests = terminate ? 1 : 2;
  assert.equal(productionBusy.requests.length, afterToolRequests, 'busy notification must not manufacture a continuation');
  assert.equal(productionBusy.requests.some(request => JSON.stringify(request).includes(body)), false);
  assert.equal(readFileSync(productionBusy.manager.getSessionFile(), 'utf8').includes(body), false);
  assert.equal(new ParentNotifyStore(productionBusy.manager.getSessionFile()).pending().filter(message => message.content === body).length, 1);
  assert.equal(new DeliveryLedger(productionBusy.manager.getSessionFile()).reconcile(eventId), undefined);
  await productionBusy.session.prompt('natural next user run consumes held completion', { expandPromptTemplates: false });
  assert.equal(productionBusy.requests.length, afterToolRequests + 1);
  assert.equal(productionBusy.requests.at(-1).messages.filter(message => JSON.stringify(message.content).includes(body)).length, 1);
  assert.equal(productionBusy.requests.at(-1).messages.some(message => message.role === 'toolResult' && message.toolCallId === 't7-production-tool'), true);
  assert.equal(new DeliveryLedger(productionBusy.manager.getSessionFile()).reconcile(eventId).status, 'delivered');
  productionBusy.save({ terminate, productionToolFinished, productionToolAborts, requestsAfterTool: afterToolRequests, requestsAfterNaturalUserRun: afterToolRequests + 1, heldUntilNaturalUserRun: true });
  productionBusy.session.dispose();
 }

 for (const reason of ['closing', 'old-run', 'policy-none']) {
  let gateParent, gateSink, policy = 'normal', queued = false, policyDenied = false;
  const staleBody = `REJECTED SDK BODY ${reason}`;
  const eventId = `t7-negative-${reason}`;
  const negative = await fixture(`production-gate-${reason}`, (pi, getSession) => {
   gateSink = makeDeliverySink(pi, { getBranch: () => getSession().sessionManager.getBranch(), getSessionFile: () => getSession()?.sessionManager.getSessionFile() }, { allowCommit: details => gateParent.allowCommit(details) });
   gateParent = registerParentDelivery(pi, gateSink, () => policy);
   pi.on('message_end', event => {
    if (event.message.role !== 'assistant' || queued) return;
    queued = true;
    const message = { content: staleBody, details: { eventId, deliveryParentRun: reason === 'old-run' ? -1 : 1 }, wake: reason === 'closing', deliverAs: reason === 'closing' ? 'followUp' : 'nextTurn' };
    // Preserve caller durable intent separately; deliberately submit a stale SDK envelope.
    new ParentNotifyStore(getSession().sessionManager.getSessionFile()).put(message);
    assert.throws(() => gateSink(message), /pending durable confirmation/);
   });
   pi.on('message_start', event => {
    if (reason === 'policy-none' && !policyDenied && event.message.details?.eventId === eventId) { policy = 'none'; policyDenied = true; }
   });
  });
  await negative.session.prompt('establish prior run', { expandPromptTemplates: false });
  if (reason !== 'closing') await negative.session.prompt('natural run with denied stale body', { expandPromptTemplates: false });
  assert.equal(negative.requests.length, 2, 'closing gate strips body but cannot retract already selected followUp request');
  assert.equal(negative.requests.some(request => JSON.stringify(request).includes(staleBody)), false);
  assert.equal(readFileSync(negative.manager.getSessionFile(), 'utf8').includes(staleBody), false);
  const rejectedRows = SessionManager.open(negative.manager.getSessionFile()).getBranch().filter(row => row.details?.eventId === eventId);
  assert.equal(rejectedRows.length, 1); assert.equal(rejectedRows[0].details.deliveryHostWithdrawn, true);
  assert.equal(new DeliveryLedger(negative.manager.getSessionFile()).reconcile(eventId).status, 'available');
  policy = 'normal';
  await negative.session.prompt('permitted recovery natural run', { expandPromptTemplates: false });
  assert.equal(negative.requests.length, 3);
  assert.equal(negative.requests[2].messages.filter(message => JSON.stringify(message.content).includes(staleBody)).length, 1);
  assert.equal(new DeliveryLedger(negative.manager.getSessionFile()).reconcile(eventId).status, 'delivered');
  negative.save({ rejectionReason: reason, rejectedBeforeJSONLAndProvider: true, recoveredExactlyOnce: true });
  negative.session.dispose();
 }

 console.log('spec43-t7-sdk: real SDK lifecycle, nextTurn, tool noninterrupt, production closing/finished/natural/explicit wake, busy hold with ordinary/terminate tools and gate rejection/recovery passed');
 writeFileSync(new URL('sdk-summary.json', evidenceDir), JSON.stringify({ sdkVersion: JSON.parse(readFileSync(new URL(sdk + '../../package.json', import.meta.url), 'utf8')).version, realSDK: true, subclass: false, lifecycleOverrides: false, realSessionManager: true, realExtensionRunner: true, network: false, strippedEnvironment, cases, cleanup: { temporaryDirectoryRemovedInFinally: true, spawnedPanes: 0 } }, null, 2) + '\n');
} finally {
 for (const session of sessions) session.dispose();
 rmSync(root, { recursive: true, force: true });
}
