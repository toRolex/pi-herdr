import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { createJiti } from 'jiti';
for (const key of Object.keys(process.env)) if (/^(HERDR|PI_HERDR)/.test(key)) delete process.env[key];
process.env.PI_OFFLINE = '1';
const [stage = 'all', directory, reopenedHost] = process.argv.slice(2);
if (stage === 'all') {
 const root = mkdtempSync(join(tmpdir(), 'pr56-parent-sdk-'));
 const run = (stage, host) => {
  const result = spawnSync(process.execPath, [fileURLToPath(import.meta.url), stage, root, ...(host ? [host] : [])], { encoding: 'utf8', timeout: 30000, env: process.env });
  assert.equal(result.status, 0, `${stage}: ${result.stderr || result.error || result.stdout}`);
  return JSON.parse(result.stdout.trim());
 };
 try {
  const before = run('queue');
  const after = run('restart', before.hostFile);
  assert.notEqual(before.pid, after.pid);
  assert.equal(before.hostFile, after.hostFile);
  assert.equal(after.ledgerStatus, 'delivered');
  assert.equal(after.hostBodies, 1);
  assert.equal(after.firstRequestBodies, 1);
  const cases = {};
  for (const name of ['continuation', 'terminate', 'mixed', 'quiet', 'withdrawal', 'batch-claim-failure', 'batch-queue-failure', 'unknown-pending', 'mismatch-receipt']) cases[name] = run(name);
  const pendingBefore = run('pending-exit');
  const pendingAfter = run('pending-restart', pendingBefore.hostFile);
  assert.notEqual(pendingBefore.pid, pendingAfter.pid);
  assert.equal(pendingAfter.ledgerStatus, 'pending');
  const summary = { crossProcessQueueLoss: { before, after }, crossProcessUnknownPending: { before: pendingBefore, after: pendingAfter }, cases };
  const evidence = new URL('../.agents/evidence/pr56-parent/', import.meta.url);
  mkdirSync(evidence, { recursive: true });
  writeFileSync(new URL('sdk-summary.json', evidence), JSON.stringify(summary, null, 2) + '\n');
  console.log('pr56-parent-sdk: ' + JSON.stringify(summary));
 } finally { rmSync(root, { recursive: true, force: true }); }
} else {
 const batchFailure = stage === 'batch-claim-failure' || stage === 'batch-queue-failure';
 let faultTarget, injected = false, faultArmed = stage === 'withdrawal' || batchFailure;
 const originalRename = fs.renameSync;
 if (faultArmed) {
  fs.renameSync = (source, destination) => {
   if (faultArmed && destination === faultTarget && !injected && JSON.parse(readFileSync(source, 'utf8')).events[batchFailure ? 'pr56-batch-second' : 'pr56-queued-restart']?.status === (stage === 'batch-queue-failure' ? 'queued' : 'pending')) {
    injected = true; const error = new Error(`injected ${stage === 'batch-queue-failure' ? 'queue' : 'claim pending'} rename EIO`); error.code = 'EIO'; throw error;
   }
   return originalRename(source, destination);
  };
  syncBuiltinESMExports();
 }
 const jiti = createJiti(import.meta.url, { fsCache: false, tryNative: false });
 const sdk = '../node_modules/@earendil-works/pi-coding-agent/dist/core/';
 const load = name => jiti.import(sdk + name + '.js');
 const { AgentSession } = await load('agent-session');
 const { SessionManager } = await load('session-manager');
 const { SettingsManager } = await load('settings-manager');
 const { ModelRuntime } = await load('model-runtime');
 const { AuthStorage } = await load('auth-storage');
 const { convertToLlm } = await load('messages');
 const { createExtensionRuntime, loadExtensionFromFactory } = await load('extensions/loader');
 const { createEventBus } = await load('event-bus');
 const { Agent } = await jiti.import('../node_modules/@earendil-works/pi-agent-core/dist/agent.js');
 const { registerDelivery, stopDeliveryLoop } = await jiti.import('../src/delivery.ts');
 const { makeDeliverySink } = await jiti.import('../src/push.ts');
 const { DeliveryLedger, deliveryLedgerPath } = await jiti.import('../src/delivery-ledger.ts');
 const { getSettingsPaths } = await jiti.import('../src/settings.ts');
 const { Type } = await jiti.import('typebox');
 const { ParentNotifyStore } = await jiti.import('../src/parent-notify-store.ts');
 const dir = join(directory, stage); mkdirSync(dir, { recursive: true });
 // If a regression accidentally reaches transport, it cannot mutate a real pane.
 const fakeBin = join(directory, 'fake-bin'); mkdirSync(fakeBin, { recursive: true });
 writeFileSync(join(fakeBin, 'herdr'), '#!/bin/sh\nexit 91\n', { mode: 0o755 });
 process.env.PATH = `${fakeBin}:${process.env.PATH}`;
 const manager = reopenedHost ? SessionManager.open(reopenedHost) : SessionManager.create(dir, dir);
 const hostFile = manager.getSessionFile();
 if (!reopenedHost) manager.appendMessage({ role: 'user', content: [{ type: 'text', text: 'durable seed' }], timestamp: 1 });
 const eventId = 'pr56-queued-restart', body = 'PR56 QUEUED RESTART UNIQUE BODY';
 const requests = [], errors = [];
 const hasTool = ['continuation', 'terminate', 'mixed', 'quiet'].includes(stage) || batchFailure;
 let enterTool, releaseTool, toolFinished = false, aborts = 0;
 const atTool = new Promise(resolve => { enterTool = resolve; });
 const heldTool = new Promise(resolve => { releaseTool = resolve; });
 process.chdir(dir);
 const settingsPath = getSettingsPaths(dir).projectPath;
 mkdirSync(join(dir, '.pi'), { recursive: true });
 writeFileSync(settingsPath, JSON.stringify({ notifications: stage === 'quiet' ? 'quiet' : 'normal' }));
 const model = { id: 'deterministic', provider: 'pr56-parent-offline', api: 'pr56-parent-offline', name: 'PR56 offline', reasoning: false, input: ['text'], contextWindow: 100000, maxTokens: 1000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
 const runtime = await ModelRuntime.create({ credentials: AuthStorage.inMemory(), modelsPath: null, refreshOnCreate: false });
 runtime.registerProvider(model.provider, { api: model.api, baseUrl: 'http://127.0.0.1:1/not-used', apiKey: 'offline', models: [model] });
 await runtime.refresh({ allowNetwork: false });
 let session, sink;
 const extensionRuntime = createExtensionRuntime();
 const extension = await loadExtensionFromFactory(pi => {
  registerDelivery(pi);
  sink = makeDeliverySink(pi);
  if (hasTool) {
   pi.registerTool({ name: 'pr56_hold', description: 'Hold a real SDK tool without interruption', parameters: Type.Object({}), execute: async (_id, _params, signal) => {
    signal.addEventListener('abort', () => { aborts++; });
    enterTool(); await heldTool;
    assert.equal(signal.aborted, false); toolFinished = true;
    return { content: [{ type: 'text', text: 'REAL TOOL FINISHED' }], details: {}, terminate: stage === 'terminate' || stage === 'mixed' };
   } });
   pi.registerTool({ name: 'pr56_continue', description: 'Non-terminating member of a mixed batch', parameters: Type.Object({}), execute: async () => ({ content: [{ type: 'text', text: 'NONTERMINATING RESULT' }], details: {}, terminate: false }) });
  }
  if (stage === 'queue' || stage === 'pending-exit') {
   manager.appendMessage({ role: 'user', content: [{ type: 'text', text: 'seed' }], timestamp: 1 });
   pi.on('session_start', () => sink({ content: body, details: { eventId, agentId: 'agent', runId: 'run', sequence: 1, kind: 'done' }, wake: true }));
   // Exit after production flush accepts into SDK, before SDK drain/message_end.
   pi.on('before_agent_start', () => {
    assert.equal(new DeliveryLedger(hostFile).reconcile(eventId).status, 'queued');
    assert.equal(session._pendingNextTurnMessages.length, 1, 'observe only, never alter SDK queue');
    assert.equal(readFileSync(hostFile, 'utf8').includes(body), false);
    if (stage === 'pending-exit') {
     const ledger = new DeliveryLedger(hostFile);
     ledger.uncertain(eventId, ledger.reconcile(eventId).token, 'injected ambiguous dispatch outcome');
    }
    console.log(JSON.stringify({ pid: process.pid, hostFile, ledgerStatus: stage === 'pending-exit' ? 'pending' : 'queued', sdkQueue: 1, hostBodies: 0 }));
    process.exit(0);
   });
  }
 }, dir, createEventBus(), extensionRuntime);
 const loader = {
  getExtensions: () => ({ extensions: [extension], errors: [], runtime: extensionRuntime }),
  getSkills: () => ({ skills: [], diagnostics: [] }), getPrompts: () => ({ prompts: [], diagnostics: [] }),
  getThemes: () => ({ themes: [], diagnostics: [] }), getAgentsFiles: () => ({ agentsFiles: [] }),
  getSystemPrompt: () => 'PR56 offline SDK proof', getSystemPromptSource: () => undefined,
  getAppendSystemPrompt: () => [], getAppendSystemPromptSources: () => [], extendResources() {}, async reload() {},
 };
 const agent = new Agent({ initialState: { model, tools: [] }, convertToLlm, streamFn: (_model, context) => {
  requests.push(structuredClone(context));
  const content = hasTool && requests.length === 1
   ? [{ type: 'toolCall', id: 'pr56-tool', name: 'pr56_hold', arguments: {} }, ...(stage === 'mixed' ? [{ type: 'toolCall', id: 'pr56-tool-two', name: 'pr56_continue', arguments: {} }] : [])]
   : [{ type: 'text', text: 'finished' }];
  const stopReason = content[0].type === 'toolCall' ? 'toolUse' : 'stop';
  const message = { role: 'assistant', content, stopReason, timestamp: Date.now(), api: model.api, provider: model.provider, model: model.id, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
  return { async *[Symbol.asyncIterator]() { yield { type: 'done', reason: stopReason, message }; }, result: async () => message };
 } });
 session = new AgentSession({ agent, sessionManager: manager, settingsManager: SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false }, cacheWarming: { enabled: false } }), modelRuntime: runtime, resourceLoader: loader, cwd: dir, initialActiveToolNames: [] });
 try {
  await session.bindExtensions({ onError: error => errors.push(error) });
  stopDeliveryLoop();
  const bodyCount = request => request.messages.filter(message => JSON.stringify(message.content).includes(body)).length;
  const hostRows = () => SessionManager.open(hostFile).getBranch().filter(row => row.type === 'custom_message' && row.content === body);
  const send = () => sink({ content: body, details: { eventId, agentId: 'agent', runId: 'run', sequence: 1, kind: 'done' }, wake: true });
  let extra = {};
  if (batchFailure) {
   const secondId = 'pr56-batch-second', secondBody = 'PR56 SECOND DRAFT UNIQUE BODY';
   const secondCount = request => request.messages.filter(message => JSON.stringify(message.content).includes(secondBody)).length;
   const secondRows = () => SessionManager.open(hostFile).getBranch().filter(row => row.type === 'custom_message' && row.content === secondBody);
   const running = session.prompt('run tool with two accepted notifications', { expandPromptTemplates: false });
   await atTool; send();
   sink({ content: secondBody, details: { eventId: secondId, agentId: 'agent', runId: 'second-run', sequence: 2, kind: 'done' }, wake: true });
   faultTarget = deliveryLedgerPath(hostFile);
   releaseTool();
   try { await running; }
   finally { faultArmed = false; fs.renameSync = originalRename; syncBuiltinESMExports(); }
   assert.equal(injected, true);
   assert.equal(requests.length, 2, 'keep the SDK natural continuation, without extra turns');
   assert.equal(aborts, 0);
   assert.equal(bodyCount(requests[1]), 1, 'a later failed claim must not discard an earlier accepted draft');
   assert.equal(hostRows().length, 1);
   assert.equal(new DeliveryLedger(hostFile).reconcile(eventId).status, 'delivered');
   assert.equal(secondCount(requests[1]), 0); assert.equal(secondRows().length, 0);
   assert.equal(new DeliveryLedger(hostFile).reconcile(secondId).status, 'available', 'failed unsubmitted draft remains retryable on durable rejection evidence');
   await session.prompt('natural recovery for only the failed notification', { expandPromptTemplates: false });
   await session.prompt('another natural run without duplicate append', { expandPromptTemplates: false });
   assert.deepEqual(requests.map(bodyCount), [0, 1, 1, 1]);
   assert.deepEqual(requests.map(secondCount), [0, 0, 1, 1]);
   assert.equal(hostRows().length, 1); assert.equal(secondRows().length, 1);
   assert.equal(new DeliveryLedger(hostFile).reconcile(secondId).status, 'delivered');
   extra = { injectedSecondWriteEIO: injected, failedState: stage === 'batch-queue-failure' ? 'queued' : 'pending', firstDraftPreserved: true, secondProviderBodyCounts: requests.map(secondCount), aborts };
  } else if (hasTool) {
   const running = session.prompt('run real tool', { expandPromptTemplates: false });
   await atTool; send();
   assert.equal(requests.length, 1); assert.equal(toolFinished, false); assert.equal(aborts, 0);
   releaseTool(); await running;
   const requestsAfterTool = stage === 'terminate' ? 1 : 2;
   const currentRunDelivered = stage === 'continuation' || stage === 'mixed';
   assert.equal(requests.length, requestsAfterTool, 'never manufacture a new turn');
   assert.equal(aborts, 0); assert.equal(toolFinished, true);
   assert.equal(hostRows().length, currentRunDelivered ? 1 : 0);
   assert.equal(requests.some(request => bodyCount(request) > 0), currentRunDelivered);
   if (currentRunDelivered) {
    assert.equal(bodyCount(requests[1]), 1);
    assert.equal(hostRows()[0].details.deliveryHostBoundary, 'turn_end');
    assert.equal(new DeliveryLedger(hostFile).reconcile(eventId).status, 'delivered');
   }
   await session.prompt('next natural run', { expandPromptTemplates: false });
   assert.equal(requests.length, requestsAfterTool + 1);
   assert.equal(bodyCount(requests.at(-1)), 1); assert.equal(hostRows().length, 1);
   extra = { requestsAfterTool, currentRunDelivered, aborts, toolFinished };
  } else if (stage === 'withdrawal') {
   send();
   faultTarget = deliveryLedgerPath(hostFile);
   try { await session.prompt('first natural run with failed claim', { expandPromptTemplates: false }); }
   finally { faultArmed = false; fs.renameSync = originalRename; syncBuiltinESMExports(); }
   assert.equal(injected, true); assert.equal(bodyCount(requests[0]), 0); assert.equal(hostRows().length, 0);
   const receipts = SessionManager.open(hostFile).getBranch().filter(row => row.type === 'custom_message' && row.details?.eventId === eventId && row.details.deliveryHostWithdrawn === true);
   assert.equal(receipts.length, 1);
   assert.equal(new DeliveryLedger(hostFile).reconcile(eventId).status, 'available', 'same-token persisted withdrawal proves no body committed');
   await session.prompt('natural recovery after storage repair', { expandPromptTemplates: false });
   await session.prompt('another natural run must not duplicate append', { expandPromptTemplates: false });
   assert.deepEqual(requests.map(bodyCount), [0, 1, 1]); assert.equal(hostRows().length, 1);
   extra = { injectedClaimEIO: injected, matchingWithdrawal: true, providerBodyCounts: requests.map(bodyCount) };
  } else if (['unknown-pending', 'mismatch-receipt', 'pending-restart'].includes(stage)) {
   if (stage !== 'pending-restart') {
    const ledger = new DeliveryLedger(hostFile), ref = { eventId, agentId: 'agent', runId: 'run', sequence: 1 };
    new ParentNotifyStore(hostFile).put({ content: body, details: { ...ref, kind: 'done' }, wake: true });
    const queued = ledger.queuePush(ref);
    ledger.uncertain(eventId, queued.record.token, 'ambiguous dispatch; no timeout unlock');
    if (stage === 'mismatch-receipt') manager.appendCustomMessageEntry('herdr-delivery', [], false, { eventId, deliveryToken: 'another-token', deliveryHostWithdrawn: true });
    const path = deliveryLedgerPath(hostFile), data = JSON.parse(readFileSync(path, 'utf8'));
    data.events[eventId].updatedAt = 0; writeFileSync(path, JSON.stringify(data));
   }
   await session.prompt('natural run with unknown pending', { expandPromptTemplates: false });
   await session.prompt('second natural run with unknown pending', { expandPromptTemplates: false });
   assert.equal(new DeliveryLedger(hostFile).reconcile(eventId).status, 'pending');
   assert.equal(hostRows().length, 0); assert.deepEqual(requests.map(bodyCount), [0, 0]);
   assert.equal(new ParentNotifyStore(hostFile).pending().length, 1);
   extra = { neverUnlockedUnknownPending: true };
  } else {
   await session.prompt('first natural run', { expandPromptTemplates: false });
   assert.equal(stage, 'restart');
   await session.prompt('second natural run', { expandPromptTemplates: false });
   assert.equal(new DeliveryLedger(hostFile).reconcile(eventId).status, 'delivered', 'known lost SDK queue must recover Push on next natural run');
   assert.equal(hostRows().length, 1); assert.equal(bodyCount(requests[0]), 1);
  }
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ pid: process.pid, hostFile, ledgerStatus: new DeliveryLedger(hostFile).reconcile(eventId)?.status, hostBodies: hostRows().length, firstRequestBodies: bodyCount(requests[0]), requests: requests.length, outbox: new ParentNotifyStore(hostFile).pending().length, realSDK: true, realSessionManager: true, productionRegisterDelivery: true, ...extra }));
 } finally { stopDeliveryLoop(); session.dispose(); }
}
