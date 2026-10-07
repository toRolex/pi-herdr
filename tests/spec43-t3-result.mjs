import assert from 'node:assert/strict';
import { createJiti } from 'jiti';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const jiti = createJiti(import.meta.url);
const { getAgentResult, registerResultTool } = await jiti.import('../src/tools/result.ts');
const { DeliveryLedger, deliveryLedgerPath } = await jiti.import('../src/delivery-ledger.ts');
const { SessionManager } = await jiti.import('../node_modules/@earendil-works/pi-coding-agent/dist/core/session-manager.js');
const { AgentSession } = await jiti.import('../node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js');
const { Agent } = await jiti.import('../node_modules/@earendil-works/pi-agent-core/dist/agent.js');
const { inspectToolResultReceipt } = await jiti.import('../src/delivery-host.ts');
const dir = mkdtempSync(join(tmpdir(), 'spec43-t3-result-'));
const final = 'COMPLETE DURABLE BODY\nfinal line';
const draft = 'PRIVATE DRAFT MUST NOT LEAK';
let counter = 0;
function fixture(sidecar, overrides = {}) {
 const folder = join(dir, `case-${++counter}`); mkdirSync(folder);
 const child = join(folder, 'child.jsonl');
 writeFileSync(child, JSON.stringify({ type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: draft }] } }) + '\n');
 const manager = new SessionManager(folder, folder, undefined, true);
 manager.appendMessage({ role: 'user', content: [{ type: 'text', text: 'start' }], timestamp: 1 });
 const hostFile = manager.getSessionFile();
 const eventId = `event-${counter}`;
 const record = { name: 'child', kind: 'pi', paneId: 'w1:p1', stance: 'autonomous', submitted: true, sawWorking: true, sessionPath: child, agentId: `agent-${counter}`, runId: eventId, sequence: 1 };
 const event = { type: 'done', text: final, eventId, agentId: record.agentId, runId: eventId, sequence: 1, ...sidecar };
 if (sidecar !== null) {
  writeFileSync(child + '.exit', JSON.stringify(event));
  writeFileSync(child + `.completion-${eventId}.json`, JSON.stringify(event));
 }
 const handlers = {}, tools = [];
 const deps = { registry: () => new Map([['child', record]]), status: async () => ({ ok: true, data: 'working' }), extract: () => { throw new Error('strict consumption must never extract drafts'); }, readTail: async () => { throw new Error('spawned pi must never read pane tail'); }, ...overrides };
 registerResultTool({ on: (name, handler) => (handlers[name] ??= []).push(handler), registerTool: tool => tools.push(tool) }, deps);
 const tool = tools.find(tool => tool.name === 'herdr_get_agent_result');
 const ctx = { sessionManager: manager };
 const execute = (id, target = 'child') => tool.execute(id, { target }, undefined, undefined, ctx);
 const emit = async name => { for (const handler of handlers[name] ?? []) await handler({}, ctx); };
 const ledger = new DeliveryLedger(hostFile);
 return { manager, hostFile, child, record, event, eventId, tool, execute, emit, ledger, deps, handlers };
}
function noBody(result) {
 assert.equal(result.details.result, undefined);
 assert.equal(result.details.message, undefined);
 assert.equal(result.details.error?.errorMessage, undefined);
 assert.equal(result.details.delivery?.bodyCommitted, undefined);
 assert.ok(!JSON.stringify(result).includes(final));
 assert.ok(!JSON.stringify(result).includes(draft));
}
function appendResult(f, result, id) {
 f.manager.appendMessage({ role: 'toolResult', toolCallId: id, toolName: f.tool.name, ...result, timestamp: Date.now() });
}
try {
 // Register/execute is mandatory here: no-host getAgentResult remains the old offline inspection API.
 for (const state of ['working', 'idle', 'done', 'blocked']) {
  const f = fixture(null, { status: async () => ({ ok: true, data: state }) });
  const result = await f.execute('midflight'); noBody(result);
  assert.notEqual(result.details.status, 'done');
  assert.equal(result.details.interim, true);
  assert.equal(f.ledger.reconcile(f.eventId), undefined);
 }
 const gone = fixture(null, { status: async () => ({ ok: false, error: { code: 'NOT_FOUND', message: 'gone' } }) });
 const goneResult = await gone.execute('gone'); noBody(goneResult); assert.equal(goneResult.details.status, 'gone');
 const invalid = fixture(null); writeFileSync(invalid.child + '.exit', '{broken'); noBody(await invalid.execute('invalid'));
 const stale = fixture({ runId: 'old-run', text: draft }); noBody(await stale.execute('stale'));
 const noSubstrate = fixture(null); noSubstrate.record.sessionPath = undefined; const substrateRefusal = await noSubstrate.execute('no-substrate'); noBody(substrateRefusal); assert.equal(substrateRefusal.details.status, 'error');
 const wrongIdentity = fixture({ agentId: 'foreign-agent', text: draft }); noBody(await wrongIdentity.execute('wrong-identity', wrongIdentity.eventId));
 const missingBody = fixture({ text: '' });
 const refusal = await missingBody.execute('missing-body'); noBody(refusal); assert.equal(refusal.details.status, 'error'); assert.equal(missingBody.ledger.reconcile(missingBody.eventId), undefined);
 const persistence = fixture({ type: 'persistence-error', errorMessage: draft }); noBody(await persistence.execute('persistence'));
 const legacySidecar = fixture({ eventId: undefined, text: undefined }); noBody(await legacySidecar.execute('legacy'));
 const fallback = fixture(null, { registry: () => new Map(), readTail: async () => ({ ok: true, data: { text: 'adopted tail' } }) });
 const adopted = await fallback.execute('adopted', 'external-agent'); assert.equal(adopted.details.source, 'pane-tail'); assert.equal(adopted.details.result, 'adopted tail');
 // Sidecar appearing during live status inspection wins, without draft extraction.
 const race = fixture(null);
 race.deps.status = async () => { writeFileSync(race.child + '.exit', JSON.stringify(race.event)); return { ok: false, error: { code: 'NOT_FOUND', message: 'gone' } }; };
 // deps are read at execute time, rather than copied when registering.
 const raced = await race.execute('raced'); assert.equal(raced.details.result, final);
 // Pull first: exact body is claimable once; return/hook/in-memory branch alone never confirms it.
 const pull = fixture({}); const winner = await pull.execute('pull-first');
 assert.equal(winner.details.result, final); assert.equal(winner.details.message, undefined);
 assert.equal(winner.details.delivery.bodyCommitted, true);
 assert.equal(pull.ledger.reconcile(pull.eventId).status, 'pending');
 await pull.emit('tool_result'); await pull.emit('turn_end'); assert.equal(pull.ledger.reconcile(pull.eventId).status, 'pending');
 const second = await pull.execute('pull-second'); noBody(second); assert.equal(second.details.delivery.status, 'pending');
 appendResult(pull, winner, 'pull-first'); await pull.emit('turn_end');
 assert.equal(pull.ledger.reconcile(pull.eventId).status, 'delivered');
 noBody(await pull.execute('after-commit'));
 // Durable event-id target recovers its immutable body (not a different current run's draft).
 const eventTarget = fixture({}); const byEvent = await eventTarget.execute('event-ref', eventTarget.eventId); assert.equal(byEvent.details.result, final);
 // Two concurrent registered pulls share a durable synchronous claim: exactly one body.
 const parallel = fixture({}); const replies = await Promise.all([parallel.execute('parallel-a'), parallel.execute('parallel-b')]);
 assert.equal(replies.filter(reply => reply.details.result === final).length, 1);
 noBody(replies.find(reply => reply.details.result === undefined));
 assert.equal(parallel.ledger.reconcile(parallel.eventId).status, 'pending');
 // Push first committed: a pull supplies only the event/status/channel reference, even after reload.
 const push = fixture({}); const queued = push.ledger.queuePush(push.event);
 assert.equal(push.ledger.claimPush(push.eventId, queued.record.token), true);
 const proof = push.ledger.proof(push.ledger.reconcile(push.eventId));
 writeFileSync(push.hostFile, readFileSync(push.hostFile, 'utf8') + JSON.stringify({ type: 'custom_message', customType: 'herdr-delivery', content: final, details: { eventId: push.eventId, delivery: proof } }) + '\n');
 const afterPush = await push.execute('push-first'); noBody(afterPush);
 assert.equal(afterPush.details.delivery.channel, 'push'); assert.equal(afterPush.details.delivery.status, 'delivered');
 const pushPending = fixture({}); const p = pushPending.ledger.queuePush(pushPending.event); pushPending.ledger.claimPush(pushPending.eventId, p.record.token); noBody(await pushPending.execute('push-pending'));
 // A queued (not accepted) push can be replaced; its stale proof cannot confirm the pull winner.
 const queuedPush = fixture({}); const q = queuedPush.ledger.queuePush(queuedPush.event); const staleProof = queuedPush.ledger.proof(q.record);
 const reclaimed = await queuedPush.execute('queued-to-pull'); assert.equal(reclaimed.details.result, final); assert.notEqual(reclaimed.details.delivery.token, staleProof.token);
 writeFileSync(queuedPush.hostFile, readFileSync(queuedPush.hostFile, 'utf8') + JSON.stringify({ type: 'custom_message', customType: 'herdr-delivery', details: { delivery: staleProof } }) + '\n');
 assert.equal(queuedPush.ledger.reconcile(queuedPush.eventId).status, 'pending');
 // Error completion is a business body too; loser receipts cannot leak errorMessage.
 const error = fixture({ type: 'error', text: final, stopReason: 'error', errorMessage: 'durable failure' });
 const failed = await error.execute('error-first'); assert.equal(failed.isError, true); assert.ok(failed.content[0].text.includes(final));
 assert.equal(failed.details.error.errorMessage, 'durable failure'); noBody(await error.execute('error-second'));
 // Suppressed tool receipts carry no body proof and cannot ACK the winner.
 const suppressed = fixture({}); const accepted = await suppressed.execute('real');
 appendResult(suppressed, { content: [{ type: 'text', text: 'status only' }], details: { eventId: suppressed.eventId, delivery: { ...accepted.details.delivery, bodyCommitted: false } } }, 'real');
 await suppressed.emit('agent_settled'); assert.equal(suppressed.ledger.reconcile(suppressed.eventId).status, 'pending');
 // A ledger write failure must fail closed before exposing any final body.
 const blockedLedger = fixture({}); mkdirSync(deliveryLedgerPath(blockedLedger.hostFile));
 const failClosed = await blockedLedger.execute('ledger-error'); assert.equal(failClosed.isError, true); noBody(failClosed);
 // Actual SessionManager mutates branch before an append error: no disk receipt, no commit.
 const disk = fixture({}); const diskReply = await disk.execute('disk-failed');
 renameSync(disk.hostFile, disk.hostFile + '.backup'); mkdirSync(disk.hostFile);
 assert.throws(() => appendResult(disk, diskReply, 'disk-failed'), { code: 'EISDIR' });
 assert.equal(disk.manager.getBranch().some(row => row.message?.toolCallId === 'disk-failed'), true);
 await disk.emit('turn_end'); assert.equal(disk.ledger.reconcile(disk.eventId).status, 'pending');
 rmSync(disk.hostFile, { recursive: true }); renameSync(disk.hostFile + '.backup', disk.hostFile);
 await disk.emit('turn_end'); assert.equal(disk.ledger.reconcile(disk.eventId).status, 'pending');
 assert.equal(inspectToolResultReceipt(() => disk.hostFile, 'disk-failed').status, 'absent');
 // Registered consumption refuses nonexistent or unreadable hosts before creating a ledger claim.
 const missingHost = fixture({}); rmSync(missingHost.hostFile); const missingHostResult = await missingHost.execute('host-missing'); noBody(missingHostResult); assert.equal(missingHostResult.isError, true); assert.equal(missingHost.ledger.reconcile(missingHost.eventId), undefined);
 const unreadableHost = fixture({}); renameSync(unreadableHost.hostFile, unreadableHost.hostFile + '.backup'); mkdirSync(unreadableHost.hostFile); const unreadableHostResult = await unreadableHost.execute('host-directory'); noBody(unreadableHostResult); assert.equal(unreadableHostResult.isError, true); assert.equal(unreadableHost.ledger.reconcile(unreadableHost.eventId), undefined);
 // ACK ledger write failure after real disk commit retains the claim and repairs from disk after recovery.
 const confirmationErrors = [];
 const ack = fixture({}, { onConfirmationError: (error, eventId) => confirmationErrors.push({ error: error.message, eventId }) });
 const ackReply = await ack.execute('ack-write-failed'); appendResult(ack, ackReply, 'ack-write-failed');
 const originalSave = DeliveryLedger.prototype.save;
 try {
  DeliveryLedger.prototype.save = function(events) { if (this.hostFile === ack.hostFile && events[ack.eventId]?.status === 'delivered') throw new Error('injected ledger ACK write failure'); return originalSave.call(this, events); };
  await ack.emit('turn_end');
  assert.equal(inspectToolResultReceipt(() => ack.hostFile, 'ack-write-failed').status, 'persisted');
  assert.equal(JSON.parse(readFileSync(deliveryLedgerPath(ack.hostFile), 'utf8')).events[ack.eventId].status, 'pending');
  assert.equal(confirmationErrors.length, 1);
 } finally { DeliveryLedger.prototype.save = originalSave; }
 await ack.emit('agent_settled'); assert.equal(new DeliveryLedger(ack.hostFile).reconcile(ack.eventId).status, 'delivered'); noBody(await ack.execute('after-ack-repair'));
 // Parent session scoping: the same event may independently be delivered to a different host.
 const otherHost = join(dir, 'other-host.jsonl'); writeFileSync(otherHost, '');
 assert.equal(new DeliveryLedger(otherHost).claimPull(pull.event, 'other-host').bodyAllowed, true);
 // Explicitly preserve old no-host offline inspection semantics.
 const offline = fixture(null);
 const inspected = await getAgentResult({ target: 'child' }, { registry: offline.deps.registry, status: async () => ({ ok: true, data: 'idle' }) });
 // New run-id records without a declaration are legacy interim inspections and still include drafts.
 assert.equal(inspected.data.result, draft);
 const noContext = await offline.tool.execute('no-context', { target: 'child' }); assert.equal(noContext.isError, true); noBody(noContext);
 // Execute the real registered tool through Agent + SDK AgentSession and real SessionManager.
 const real = fixture({}); const observed = []; let calls = 0;
 const assistant = (content, stopReason = 'stop') => ({ role: 'assistant', content, stopReason, timestamp: Date.now(), api: 'offline', provider: 'offline', model: 'offline', usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
 const stream = message => ({ async *[Symbol.asyncIterator]() { yield { type: 'done', reason: message.stopReason, message }; }, result: async () => message });
 class OfflineSession extends AgentSession {
  _installAgentToolHooks() {} _installAgentNextTurnRefresh() {} _installAgentRequestProjection() {} _installAgentBoundaryHooks() {} _installHiddenDeclarationsProjection() {} _installAgentForcedPromptProjection() {} _buildRuntime() {} _restoreToolsFromTranscript() {}
  async _emitExtensionEvent(event) {
   if (event.type === 'message_end' && event.message.role === 'toolResult') observed.push({ boundary: 'message_end', status: real.ledger.reconcile(real.eventId).status });
   for (const handler of real.handlers[event.type] ?? []) await handler(event, { sessionManager: real.manager });
  }
  _refreshFinalizedContext() {}
 }
 const tool = { ...real.tool, description: real.tool.description, execute: (id, params, signal, update) => real.tool.execute(id, params, signal, update, { sessionManager: real.manager }) };
 const model = { id: 'offline', provider: 'offline', api: 'offline', name: 'offline', input: ['text'], contextWindow: 10000, maxTokens: 1000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
 const agent = new Agent({ initialState: { model, tools: [tool] }, convertToLlm: messages => messages, streamFn: () => stream(calls++ === 0 ? assistant([{ type: 'toolCall', id: 'sdk-pull', name: tool.name, arguments: { target: 'child' } }], 'toolUse') : assistant([{ type: 'text', text: 'finished' }])) });
 const session = new OfflineSession({ agent, sessionManager: real.manager });
 Object.assign(session, { _eventListeners: [], _entryIdsByMessage: new WeakMap(), settingsManager: { getRetrySettings: () => ({ enabled: false }), getCompactionSettings: () => ({ enabled: false }), getImageAutoResize: () => false }, _extensionRunner: { hasHandlers: name => name === 'tool_result', emitToolResult: async () => { observed.push({ boundary: 'tool_result', status: real.ledger.reconcile(real.eventId).status }); return undefined; } } });
 agent.afterToolCall = context => session._afterToolCall(context);
 await agent.prompt('use registered result tool');
 assert.deepEqual(observed, [{ boundary: 'tool_result', status: 'pending' }, { boundary: 'message_end', status: 'pending' }]);
 assert.equal(inspectToolResultReceipt(() => real.hostFile, 'sdk-pull').status, 'persisted');
 assert.equal(real.ledger.reconcile(real.eventId).status, 'delivered');
 assert.equal(SessionManager.open(real.hostFile).getBranch().find(row => row.message?.toolCallId === 'sdk-pull').message.details.result, final);
 noBody(await real.execute('after-real-sdk'));
 // Actual ExtensionRunner handlers + public push sink + provider requests. No fabricated push disk rows.
 const { ExtensionRunner } = await jiti.import('../node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/runner.js');
 const { createExtensionRuntime, loadExtensionFromFactory } = await jiti.import('../node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/loader.js');
 const { createEventBus } = await jiti.import('../node_modules/@earendil-works/pi-coding-agent/dist/core/event-bus.js');
 const { makeDeliverySink } = await jiti.import('../src/push.ts');
 const cases = [], evidenceCases = [];
 const contentText = content => typeof content === 'string' ? content : Array.isArray(content) ? content.filter(block => block.type === 'text').map(block => block.text).join('\n') : '';
 for (const scenario of ['push-first', 'pull-first', 'queued-stale', 'parallel-pulls', 'concurrent-push-pull']) {
  const f = fixture({}); const runtime = createExtensionRuntime(), bus = createEventBus(), requests = [];
  let pushSink, index = 0;
  const ext = await loadExtensionFromFactory(pi => {
   registerResultTool(pi, f.deps);
   // Tools collected by ExtensionRunner are wrapped below with its real execution context.
   pushSink = makeDeliverySink(pi, { getBranch: () => f.manager.getBranch(), getSessionFile: () => f.hostFile });
  }, dir, bus, runtime);
  const runner = new ExtensionRunner([ext], runtime, dir, f.manager, {});
  const resultDef = runner.getToolDefinition('herdr_get_agent_result');
  assert.ok(resultDef, 'real ExtensionRunner owns the registered result tool');
  let simultaneousBoundary;
  const boundTool = { ...resultDef, execute: async (id, p, signal, update) => {
   if (scenario !== 'concurrent-push-pull') return resultDef.execute(id, p, signal, update, { sessionManager: f.manager });
   const order = [];
   const scheduled = await Promise.allSettled([
    Promise.resolve().then(() => { order.push('push'); return pushSink(pushMessage); }),
    Promise.resolve().then(() => { order.push('pull'); return resultDef.execute(id, p, signal, update, { sessionManager: f.manager }); }),
   ]);
   assert.deepEqual(order, ['push', 'pull']); assert.equal(scheduled[0].status, 'rejected'); assert.equal(scheduled[1].status, 'fulfilled');
   simultaneousBoundary = { scheduling: 'same execute boundary Promise.allSettled microtasks', order, pushOutcome: scheduled[0].reason.message, pullOutcome: scheduled[1].value.details.delivery };
   return scheduled[1].value;
  } };
  const commands = scenario === 'push-first' ? [] : scenario === 'parallel-pulls' ? [
   { type: 'toolCall', id: 'public-pull-a', name: boundTool.name, arguments: { target: 'child' } },
   { type: 'toolCall', id: 'public-pull-b', name: boundTool.name, arguments: { target: 'child' } },
  ] : [{ type: 'toolCall', id: 'public-pull', name: boundTool.name, arguments: { target: 'child' } }];
  const a = new Agent({ initialState: { model, tools: [boundTool] }, convertToLlm: messages => messages, streamFn: (_model, context) => {
   requests.push(JSON.stringify(context));
   return stream(index++ === 0 && commands.length ? assistant(commands, 'toolUse') : assistant([{ type: 'text', text: 'provider finished' }]));
  } });
  const s = new OfflineSession({ agent: a, sessionManager: f.manager });
  Object.assign(s, { _eventListeners: [], _entryIdsByMessage: new WeakMap(), settingsManager: { getRetrySettings: () => ({ enabled: false }), getCompactionSettings: () => ({ enabled: false }), getImageAutoResize: () => false }, _extensionRunner: runner });
  s._emitExtensionEvent = event => ['message_end', 'turn_end'].includes(event.type) ? AgentSession.prototype._emitExtensionEvent.call(s, event) : Promise.resolve();
  AgentSession.prototype._bindExtensionCore.call(s, runner);
  a.afterToolCall = context => s._afterToolCall(context);
  const pushMessage = { content: final, details: { name: 'child', kind: 'done', eventId: f.eventId, agentId: f.record.agentId, runId: f.record.runId, sequence: 1, sessionPath: f.child }, wake: true, deliverAs: 'followUp' };
  if (scenario === 'push-first' || scenario === 'queued-stale') {
   s._isAgentRunActive = true;
   assert.throws(() => pushSink(pushMessage), /pending durable confirmation/);
   assert.equal(f.ledger.reconcile(f.eventId).status, 'queued');
   s._isAgentRunActive = false;
  }
  if (scenario === 'concurrent-push-pull') s._isAgentRunActive = true;
  await a.prompt('execute real registered consumption and push gate');
  s._isAgentRunActive = false;
  const rows = SessionManager.open(f.hostFile).getBranch();
  const bodyPushes = rows.filter(row => row.type === 'custom_message' && row.customType === 'herdr-delivery' && !row.details?.deliveryHostWithdrawn && row.content === final);
  const bodyPulls = rows.filter(row => row.message?.role === 'toolResult' && contentText(row.message.content).includes(final));
  assert.equal(bodyPushes.length + bodyPulls.length, 1, `${scenario}: exactly one persisted full body`);
  assert.equal(requests.some(request => request.includes('PRIVATE DRAFT MUST NOT LEAK')), false);
  assert.equal(requests.filter(request => request.includes('COMPLETE DURABLE BODY')).length > 0, true);
  assert.equal(f.ledger.reconcile(f.eventId).status, 'delivered');
  if (scenario === 'push-first') {
   assert.equal(bodyPushes.length, 1); noBody(await f.execute('public-after-push'));
   assert.equal(bodyPushes[0].details.deliveryHostBodyCommitted, true);
  } else {
   assert.equal(bodyPulls.length, 1);
   if (scenario === 'queued-stale' || scenario === 'concurrent-push-pull') {
    assert.equal(rows.some(row => row.details?.eventId === f.eventId && row.details.deliveryHostWithdrawn === true && row.content.length === 0), true);
    const requestWithBody = requests.find(request => request.includes('COMPLETE DURABLE BODY'));
    const projected = JSON.parse(requestWithBody);
    assert.equal(projected.messages.filter(m => m.role === 'custom' && m.customType === 'herdr-delivery' && JSON.stringify(m.content).includes('COMPLETE DURABLE BODY')).length, 0, 'stale queued push never reaches provider body');
   }
   const before = requests.length;
   pushSink(pushMessage); assert.equal(requests.length, before, 'push after committed pull neither queues nor wakes');
  }
  const providerContexts = requests.map(request => JSON.parse(request));
  const providerBodyCounts = providerContexts.map(context => context.messages.filter(message => contentText(message.content).includes(final)).length);
  assert.equal(providerBodyCounts.every(count => count <= 1), true, `${scenario}: each actual provider context has at most one body-bearing message`);
  assert.equal(providerBodyCounts.some(count => count === 1), true);
  assert.equal(providerBodyCounts.slice(1).every(count => count === 1), true, `${scenario}: every actual provider request after the completion boundary contains exactly one full body`);
  evidenceCases.push({ scenario, sessionSnapshot: rows, actualProviderContexts: providerContexts, persistedBodyMessages: bodyPushes.length + bodyPulls.length, providerBodyCounts, simultaneousBoundary, ledger: f.ledger.reconcile(f.eventId), parentJSONL: readFileSync(f.hostFile, 'utf8') });
  cases.push(scenario);
 }
 const evidenceDir = new URL('../.agents/evidence/spec43-t3/', import.meta.url);
 mkdirSync(evidenceDir, { recursive: true });
 for (const entry of evidenceCases) {
  writeFileSync(new URL(`result-${entry.scenario}-parent.jsonl`, evidenceDir), entry.parentJSONL);
  writeFileSync(new URL(`result-${entry.scenario}-provider.json`, evidenceDir), JSON.stringify(entry.actualProviderContexts, null, 2) + '\n');
 }
 writeFileSync(new URL('result-sdk.json', evidenceDir), JSON.stringify({ sdkVersion: JSON.parse(readFileSync(new URL('../node_modules/@earendil-works/pi-coding-agent/package.json', import.meta.url), 'utf8')).version, realSDK: true, realExtensionRunner: true, realSessionManager: true, network: false, bodyCountSource: 'individual message.content; excludes details metadata; initial pre-completion request=0, every post-completion request=1', cases: evidenceCases, ledgerAckWriteFailure: { injected: true, diskReceiptBeforeRepair: 'persisted', ledgerBeforeRepair: 'pending', ledgerAfterRepair: 'delivered', errors: confirmationErrors }, result: 'passed', cleanup: { temporaryDirectoryRemovedInFinally: true, spawnedPanes: 0, otherSessionsTouched: false } }, null, 2) + '\n');
 console.log(`spec43-t3-result: registered consumption and real ExtensionRunner/provider ${cases.join(', ')} passed`);
} finally {
 rmSync(dir, { recursive: true, force: true });
}
