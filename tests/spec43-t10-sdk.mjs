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
const root = mkdtempSync(join(tmpdir(), 'spec43-t10-sdk-'));
const evidenceDir = new URL('../.agents/evidence/spec43-t10/', import.meta.url);
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
 for (const policy of ['normal','quiet','none']) {
  let parent;
  const demo=await fixture('notices-'+policy,(pi,getSession)=>{
   const sink=makeDeliverySink(pi,{getBranch:()=>getSession().sessionManager.getBranch(),getSessionFile:()=>getSession()?.sessionManager.getSessionFile()},{allowCommit:d=>parent.allowCommit(d)});
   parent=registerParentDelivery(pi,sink,()=>policy);
  });
  await demo.session.prompt('finish',{expandPromptTemplates:false});
  for(const kind of ['blocked','blocked-recovered','error','stall-recovered']) parent.accept({content:'T10_'+kind,details:{name:'child',kind,agentId:'child',runId:'child-run',sequence:1,noticeId:'notice-'+kind},wake:true});
  assert.equal(demo.requests.length,1);
  await demo.session.prompt('natural continuation',{expandPromptTemplates:false});
  assert.equal(demo.requests.length,2);
  for(const kind of ['blocked','blocked-recovered','error','stall-recovered']) assert.equal(demo.requests[1].messages.filter(m=>m.content === 'T10_'+kind || (Array.isArray(m.content) && m.content.some(block=>block.type==='text' && block.text==='T10_'+kind))).length,policy==='none'?0:1);
  demo.save({policy,finishedRequests:1,naturalRequests:2,noticeKinds:['blocked','blocked-recovered','error','stall-recovered']});demo.session.dispose();
 }
 writeFileSync(new URL('parent-sdk-summary.json',evidenceDir),JSON.stringify(cases,null,2));
 console.log('T10 REAL SDK production blocked/failed/recovered finished hold and natural delivery policies PASS');
} finally {for(const session of sessions)session.dispose();rmSync(root,{recursive:true,force:true});}
