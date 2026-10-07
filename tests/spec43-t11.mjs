import assert from 'node:assert/strict';
import { createJiti } from 'jiti';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, rmSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const jiti = createJiti(import.meta.url);
const { registerResultTool } = await jiti.import('../src/tools/result.ts');
const { DeliveryLedger, deliveryLedgerPath } = await jiti.import('../src/delivery-ledger.ts');
const { SessionManager } = await jiti.import('../node_modules/@earendil-works/pi-coding-agent/dist/core/session-manager.js');
const dir = mkdtempSync(join(tmpdir(), 'spec43-t11-'));
const body = 'T11 EXACT ORIGINAL\nfinal line';
let count = 0;
function fixture() {
 const folder = join(dir, String(++count)); mkdirSync(folder);
 const manager = new SessionManager(folder, folder, undefined, true);
 manager.appendMessage({ role: 'user', content: [{ type: 'text', text: 'start' }], timestamp: 1 });
 const hostFile = manager.getSessionFile(), child = join(folder, 'child.jsonl');
 writeFileSync(child, '');
 const event = { type: 'done', text: body, eventId: `event-${count}`, agentId: `agent-${count}`, runId: `run-${count}`, sequence: 1 };
 const record = { name: 'child', kind: 'pi', paneId: 'w1:p1', sessionPath: child, ...event }; delete record.text;
 writeFileSync(child + '.exit', JSON.stringify(event)); writeFileSync(child + `.completion-${event.eventId}.json`, JSON.stringify(event));
 let tool;
 registerResultTool({ on() {}, registerTool(t) { tool = t; } }, { registry: () => new Map([['child', record]]), status: async () => ({ ok: true, data: 'blocked' }) });
 const call = (params = {}) => tool.execute(`call-${++count}`, { target: 'child', ...params }, undefined, undefined, { sessionManager: { getSessionFile: () => hostFile } });
 const ack = { eventId: event.eventId, agentId: event.agentId, runId: event.runId, sequence: 1, hostFile };
 return { manager, event, record, hostFile, child, tool, call, ack, ledger: new DeliveryLedger(hostFile) };
}
async function sdkDemo() {
 const { AgentSession } = await jiti.import('../node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js');
 const { Agent } = await jiti.import('../node_modules/@earendil-works/pi-agent-core/dist/agent.js');
 const { ExtensionRunner } = await jiti.import('../node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/runner.js');
 const { createExtensionRuntime, loadExtensionFromFactory } = await jiti.import('../node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/loader.js');
 const { createEventBus } = await jiti.import('../node_modules/@earendil-works/pi-coding-agent/dist/core/event-bus.js');
 const { makeDeliverySink } = await jiti.import('../src/push.ts');
 const evidence = [];
 for (const scenario of ['queued-ack', 'pull-ack-reread']) {
  const f = fixture(), runtime = createExtensionRuntime(), bus = createEventBus(); let sink;
  const ext = await loadExtensionFromFactory(pi => {
   registerResultTool(pi, { registry: () => new Map([['child', f.record]]) });
   sink = makeDeliverySink(pi, { getBranch: () => f.manager.getBranch(), getSessionFile: () => f.hostFile });
  }, dir, bus, runtime);
  const runner = new ExtensionRunner([ext], runtime, dir, f.manager, {});
  const def = runner.getToolDefinition('herdr_get_agent_result');
  const tool = { ...def, execute: (id, p, signal, update) => def.execute(id, p, signal, update, { sessionManager: f.manager }) };
  const commands = scenario === 'queued-ack' ? [{ target: 'child', ack: f.ack }, { target: 'child' }] : [{ target: 'child' }, { target: 'child', ack: f.ack }, { target: 'child' }, { target: 'child', reread: true }];
  let index = 0; const requests = [];
  const model = { id: 'offline', provider: 'offline', api: 'offline', name: 'offline', input: ['text'], contextWindow: 10000, maxTokens: 1000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
  const agent = new Agent({ initialState: { model, tools: [tool] }, convertToLlm: messages => messages, streamFn: (_model, context) => {
   requests.push(JSON.stringify(context));
   const p = commands[index++];
   const message = { role: 'assistant', content: p ? [{ type: 'toolCall', id: `sdk-${index}`, name: tool.name, arguments: p }] : [{ type: 'text', text: 'demo complete' }], stopReason: p ? 'toolUse' : 'stop', timestamp: Date.now(), api: 'offline', provider: 'offline', model: 'offline', usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
   return { async *[Symbol.asyncIterator]() { yield { type: 'done', reason: message.stopReason, message }; }, result: async () => message };
  } });
  class DemoSession extends AgentSession {
   _installAgentToolHooks() {} _installAgentNextTurnRefresh() {} _installAgentRequestProjection() {} _installAgentBoundaryHooks() {} _installHiddenDeclarationsProjection() {} _installAgentForcedPromptProjection() {} _buildRuntime() {} _restoreToolsFromTranscript() {} _refreshFinalizedContext() {}
  }
  const session = new DemoSession({ agent, sessionManager: f.manager });
  Object.assign(session, { _eventListeners: [], _entryIdsByMessage: new WeakMap(), settingsManager: { getRetrySettings: () => ({ enabled: false }), getCompactionSettings: () => ({ enabled: false }), getImageAutoResize: () => false }, _extensionRunner: runner });
  session._emitExtensionEvent = event => ['message_end', 'turn_end'].includes(event.type) ? AgentSession.prototype._emitExtensionEvent.call(session, event) : Promise.resolve();
  AgentSession.prototype._bindExtensionCore.call(session, runner); agent.afterToolCall = ctx => session._afterToolCall(ctx);
  if (scenario === 'queued-ack') {
   session._isAgentRunActive = true;
   assert.throws(() => sink({ content: body, details: { name: 'child', kind: 'done', ...f.ack, sessionPath: f.child }, wake: true, deliverAs: 'followUp' }), /pending durable confirmation/);
   session._isAgentRunActive = false;
  }
  await agent.prompt('run explicit completion handling demo');
  const rows = SessionManager.open(f.hostFile).getBranch();
  const replies = rows.filter(row => row.message?.role === 'toolResult').map(row => row.message);
  assert.equal(new DeliveryLedger(f.hostFile).reconcile(f.event.eventId).status, 'acked');
  const normalBodies = replies.filter(r => r.details?.result === body && !r.details.reread);
  const rereads = replies.filter(r => r.details?.reread);
  assert.equal(normalBodies.length, scenario === 'queued-ack' ? 0 : 1);
  assert.equal(rereads.length, scenario === 'queued-ack' ? 0 : 1);
  const pushes = rows.filter(row => row.type === 'custom_message' && row.customType === 'herdr-delivery');
  if (scenario === 'queued-ack') { assert.equal(pushes.length, 1); assert.equal(pushes[0].details.deliveryHostWithdrawn, true); assert.equal(requests.some(r => r.includes(body.replaceAll('\n', '\\n'))), false); }
  const ackReply = replies.find(r => r.details?.acknowledged); assert.match(ackReply.content[0].text, /caller declared handled/); noBody(ackReply);
  const folder = '.agents/evidence/spec43-t11'; mkdirSync(folder, { recursive: true });
  copyFileSync(f.hostFile, join(folder, `${scenario}.jsonl`)); copyFileSync(deliveryLedgerPath(f.hostFile), join(folder, `${scenario}.ledger.json`));
  writeFileSync(join(folder, `${scenario}.provider.json`), JSON.stringify(requests, null, 2));
  evidence.push({ scenario, sdk: '1.0.4', normalBodies: normalBodies.length, rereadBodies: rereads.length, stateAfterReopen: 'acked', ackUI: ackReply.content[0].text, withdrawnPushes: pushes.filter(p => p.details?.deliveryHostWithdrawn).length });
 }
 writeFileSync('.agents/evidence/spec43-t11/sdk-demo.json', JSON.stringify(evidence, null, 2));
}
const noBody = r => { assert.ok(!JSON.stringify(r).includes(body)); assert.equal(r.details.result, undefined); };
try {
 const f = fixture();
 const first = await f.call(); assert.equal(first.details.result, body);
 writeFileSync(f.hostFile, JSON.stringify({ type: 'message', message: { role: 'toolResult', toolCallId: first.details.delivery && f.ledger.reconcile(f.event.eventId).toolCallId, details: first.details } }) + '\n');
 noBody(await f.call());
 const before = readFileSync(deliveryLedgerPath(f.hostFile), 'utf8');
 const reread = await f.call({ reread: true }); assert.equal(reread.details.result, body); assert.equal(reread.details.reread, true); assert.equal(reread.details.eventId, f.event.eventId); assert.match(reread.content[0].text, /reread/i);
 assert.equal(readFileSync(deliveryLedgerPath(f.hostFile), 'utf8'), before);
 const acked = await f.call({ ack: f.ack }); noBody(acked); assert.equal(acked.details.delivery.status, 'acked'); assert.match(acked.content[0].text, /caller.*handled/i);
 assert.equal(new DeliveryLedger(f.hostFile).reconcile(f.event.eventId).status, 'acked');
 noBody(await f.call()); assert.equal((await f.call({ reread: true })).details.result, body);
 for (const field of ['eventId', 'agentId', 'runId', 'sequence', 'hostFile']) {
  const bad = await f.call({ ack: { ...f.ack, [field]: field === 'sequence' ? 2 : 'foreign' } }); assert.equal(bad.isError, true); noBody(bad);
 }
 const queued = fixture(); const q = queued.ledger.queuePush(queued.event);
 noBody(await queued.call({ ack: queued.ack })); assert.equal(queued.ledger.claimPush(queued.event.eventId, q.record.token), false);
 const parallel = fixture(); const replies = await Promise.all([parallel.call({ ack: parallel.ack }), parallel.call()]); replies.forEach(noBody); assert.equal(parallel.ledger.reconcile(parallel.event.eventId).status, 'acked');
 const pending = fixture(); await pending.call(); const refusal = await pending.call({ ack: pending.ack }); assert.equal(refusal.isError, true); assert.equal(pending.ledger.reconcile(pending.event.eventId).status, 'pending');
 const blocked = fixture(); rmSync(blocked.child + '.exit'); assert.equal((await blocked.call({ ack: blocked.ack })).isError, true); assert.equal((await blocked.call({ reread: true })).isError, true);
 const conflict = await f.call({ reread: true, ack: f.ack }); assert.equal(conflict.isError, true);
 const failed = fixture(); const originalSave = DeliveryLedger.prototype.save;
 try { DeliveryLedger.prototype.save = function(events) { if (this.hostFile === failed.hostFile && events[failed.event.eventId]?.status === 'acked') throw new Error('injected ACK write failure'); return originalSave.call(this, events); }; const reply = await failed.call({ ack: failed.ack }); assert.equal(reply.isError, true); noBody(reply); }
 finally { DeliveryLedger.prototype.save = originalSave; }
 assert.equal((await failed.call()).details.result, body);
 const old = fixture(); noBody(await old.call({ ack: old.ack })); old.record.runId = 'future-run'; old.record.sequence = 2;
 const next = { ...old.event, eventId: 'future-event', runId: 'future-run', sequence: 2 }; writeFileSync(old.child + '.exit', JSON.stringify(next));
 assert.equal((await old.call()).details.result, body); assert.equal((await old.call({ target: old.event.eventId, reread: true })).details.runId, old.event.runId);
 await sdkDemo();
 console.log('spec43 T11: explicit reread/ACK + real SDK persisted body/UI receipts passed');
} finally { rmSync(dir, { recursive: true, force: true }); }
