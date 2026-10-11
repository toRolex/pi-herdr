import assert from 'node:assert/strict';
import {createJiti} from 'jiti';
import {mkdtempSync, readFileSync, writeFileSync, rmSync, renameSync, mkdirSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
const jiti=createJiti(import.meta.url);
const {AgentSession}=await jiti.import('../node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js');
const {SessionManager}=await jiti.import('../node_modules/@earendil-works/pi-coding-agent/dist/core/session-manager.js');
const {Agent}=await jiti.import('../node_modules/@earendil-works/pi-agent-core/dist/agent.js');
const {Type}=await jiti.import('typebox');
const {inspectToolResultReceipt,registerDeliveryMessageGate,assertDeliveryDispatchOptions}=await jiti.import('../src/delivery-host.ts');
const {createDeliveryHost}=await jiti.import('./helpers/delivery-host-private.ts');
const {ExtensionRunner}=await jiti.import('../node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/runner.js');
const {createExtensionRuntime,loadExtensionFromFactory}=await jiti.import('../node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/loader.js');
const {createEventBus}=await jiti.import('../node_modules/@earendil-works/pi-coding-agent/dist/core/event-bus.js');
const dir=mkdtempSync(join(tmpdir(),'spec43-t3-host-'));
const evidence={sdkVersion:JSON.parse(readFileSync(new URL('../node_modules/@earendil-works/pi-coding-agent/package.json',import.meta.url),'utf8')).version,realSDK:true,realSessionManager:true,network:false,checks:[],limitations:[
 'Private queue seam requires explicit AgentSession injection; public ExtensionAPI has no per-message cancel or pre-drain hook.',
 'Re-arbitration is synchronous only; a Promise is rejected before draining.',
 'Idle wake bypasses queue arbitration and is explicitly rejected by this adapter; wake enqueue is busy-only.',
 'Arbiter false withdraws the owned queue item, not a hold; caller durable outbox must drive fallback/retry.',
 'Cancellation after dequeue is not-queued, never proof of retraction.',
 'Dequeue to message_end persistence is a process-crash window; caller needs durable outbox retry.',
 'tool_result hook and message_end listeners run before SessionManager append; they are not durable acknowledgement.',
 'SessionManager mutates branch before disk append; filesystem error leaves branch-only false acknowledgement.',
 'SDK appendFileSync has no fsync; JSONL readback is not power-loss-safe durability.'
]};
const assistant=(content=[{type:'text',text:'offline response'}],stopReason='stop')=>({role:'assistant',content,stopReason,timestamp:Date.now(),api:'offline',provider:'offline',model:'offline',usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}}});
const model={id:'offline',provider:'offline',api:'offline',name:'offline',input:['text'],contextWindow:10000,maxTokens:1000,cost:{input:0,output:0,cacheRead:0,cacheWrite:0}};
const stream=message=>({async *[Symbol.asyncIterator](){yield {type:'done',reason:message.stopReason,message};},result:async()=>message});
class OfflineSession extends AgentSession {
 _installAgentToolHooks(){} _installAgentNextTurnRefresh(){} _installAgentRequestProjection(){} _installAgentBoundaryHooks(){} _installHiddenDeclarationsProjection(){} _installAgentForcedPromptProjection(){} _buildRuntime(){} _restoreToolsFromTranscript(){}
 async _emitExtensionEvent(event){await this.prePersist?.(event);}
 _refreshFinalizedContext(){}
}
const message=(text,details={})=>({customType:'herdr-delivery',content:text,display:true,details});
function fixture(name,tools=[],streamFn=()=>stream(assistant())) {
 const folder=join(dir,name);mkdirSync(folder);
 const manager=new SessionManager(folder,folder,undefined,true);
 manager.appendMessage({role:'user',content:[{type:'text',text:'initial'}],timestamp:1});
 const agent=new Agent({initialState:{model,tools},streamFn,convertToLlm:messages=>messages});
 const session=new OfflineSession({agent,sessionManager:manager});
 Object.assign(session,{_eventListeners:[],_entryIdsByMessage:new WeakMap(),settingsManager:{getRetrySettings:()=>({enabled:false}),getCompactionSettings:()=>({enabled:false}),getImageAutoResize:()=>false},_extensionRunner:{hasHandlers:()=>false}});
 const host=createDeliveryHost({session,getSessionFile:()=>manager.getSessionFile()});
 return {session,agent,manager,host};
}
try {
 const fallback=createDeliveryHost({getSessionFile:()=>undefined});
 assert.equal(fallback.capabilities.level,'receipt-only');
 assert.throws(()=>fallback.cancel('x'),/unavailable/);
 assert.equal(fallback.receipt('x').status,'unknown');fallback.dispose();
 evidence.checks.push({case:'extension-only',preciseCancellation:false,beforeDrain:false});
 const f=fixture('queues');
 await assert.rejects(()=>f.host.enqueue('idle-wake',message('idle must reject'),'followUp'),/idle wake bypasses/);
 assert.equal(f.agent.state.messages.length,0);
 f.agent.clearAllQueues=()=>{throw new Error('full queue clear forbidden');};
 f.agent.clearSteeringQueue=()=>{throw new Error('full steering clear forbidden');};
 f.agent.clearFollowUpQueue=()=>{throw new Error('full followUp clear forbidden');};
 evidence.checks.push({case:'idle-wake',status:'rejected-before-run',wakeEnqueue:'busy-only'});
 f.session._isAgentRunActive=true;
 for(const mode of ['steer','followUp','nextTurn']) {
  const queue=mode==='nextTurn'?f.session._pendingNextTurnMessages:f.agent[mode==='steer'?'steeringQueue':'followUpQueue'].messages;
  const foreign={role:'user',content:[{type:'text',text:`human ${mode}`}],timestamp:1};
  queue.push(foreign);
  await f.host.enqueue(`cancel-${mode}`,message(`owned ${mode}`),mode);
  await f.session.sendCustomMessage(message(`other extension ${mode}`,{deliveryToken:`cancel-${mode}`}),{deliverAs:mode,triggerTurn:mode!=='nextTurn'});
  assert.equal(f.host.cancel(`foreign-${mode}`).status,'not-queued');
  assert.deepEqual(f.host.cancel(`cancel-${mode}`),{status:'cancelled',removed:1});
  assert.equal(queue.length,2);assert.equal(queue[0],foreign);
  assert.equal(queue[1].details.deliveryToken,`cancel-${mode}`);
  assert.equal(f.host.cancel(`cancel-${mode}`).status,'not-queued','same token with foreign details identity cannot be cancelled');
  evidence.checks.push({case:`precise-cancel-${mode}`,removed:1,unrelatedPreserved:2});
  if(mode==='nextTurn')queue.splice(0);else {const sdkQueue=f.agent[mode==='steer'?'steeringQueue':'followUpQueue'];while(sdkQueue.messages.length)sdkQueue.drain();}
 }
 let allowed=true;const arbitrated=[];
 f.host.setDrainArbiter(candidate=>{arbitrated.push(candidate.token);return allowed;});
 await f.host.enqueue('late-follow',message('queued while allowed'),'followUp');allowed=false;
 assert.deepEqual(await f.agent.createLoopConfig().getFollowUpMessages(),[]);
 assert.deepEqual(arbitrated,['late-follow']);
 await f.host.enqueue('async-invalid',message('async must fail closed'),'steer');
 assert.throws(()=>f.host.dispose(),/owned messages remain queued/);
 f.host.setDrainArbiter(()=>Promise.resolve(true));
 assert.throws(()=>f.agent.steeringQueue.drain(),/synchronous boolean/);
 assert.equal(f.agent.steeringQueue.messages.length,1);
 f.host.cancel('async-invalid');
 f.host.setDrainArbiter(()=>{throw new Error('arbiter unavailable');});
 await f.host.enqueue('throw-arbiter',message('keep on error'),'steer');
 assert.throws(()=>f.agent.steeringQueue.drain(),/arbiter unavailable/);assert.equal(f.agent.steeringQueue.messages.length,1);f.host.cancel('throw-arbiter');
 evidence.checks.push({case:'last-moment-sdk-drain',lateDecisionRejected:true,asyncDecisionFailsClosed:true,throwLeavesQueue:true});
 f.host.setDrainArbiter(()=>true);
 await f.host.enqueue('drain-crash-window',message('dequeued but not persisted'),'steer');
 await assert.rejects(()=>f.host.enqueue('drain-crash-window',message('duplicate'),'steer'),/already owned/);
 const dequeued=await f.agent.createLoopConfig().getSteeringMessages();
 assert.equal(dequeued.length,1);assert.equal(f.host.cancel('drain-crash-window').status,'not-queued');
 assert.equal(f.host.receipt('drain-crash-window').status,'absent');
 assert.equal(SessionManager.open(f.manager.getSessionFile()).getBranch().some(r=>r.details?.deliveryToken==='drain-crash-window'),false);
 evidence.checks.push({case:'dequeue-before-append-crash-window',dequeued:1,receipt:'absent',cancel:'not-queued',reopenedHasMessage:false,duplicateTokenRejected:true,processKilled:false});
 // Exercise the SDK AgentSession.prompt for-of, not a fabricated nextTurn drain.
 f.session._isAgentRunActive=false;f.host.setDrainArbiter(()=>false);
 Object.assign(f.session,{_runInputHandlers:async text=>({text,images:[]}),_flushPendingBashMessages(){},_modelRuntime:{hasConfiguredAuth:()=>true},_baseSystemPromptOptions:{selectedTools:[]},_extensionRunner:{hasHandlers:()=>false,emitBeforeAgentStart:async()=>({systemPromptOptions:{selectedTools:[]},messages:[]})},_normalizePromptImages:async()=>({hints:[],images:[]}),_preparePromptAndToolLoadout:()=>undefined,_runAgentPrompt:async messages=>f.agent.prompt(messages)});
 await f.host.enqueue('late-natural-1',message('must not enter prompt'),'nextTurn');
 await f.session.prompt('natural turn',{expandPromptTemplates:false});
 assert.equal(f.agent.state.messages.some(m=>m.details?.deliveryToken==='late-natural-1'),false);
 await f.host.enqueue('late-natural-2',message('new SDK array also guarded'),'nextTurn');
 await f.session.prompt('second natural turn',{expandPromptTemplates:false});
 assert.equal(f.agent.state.messages.some(m=>m.details?.deliveryToken==='late-natural-2'),false);
 evidence.checks.push({case:'actual-sdk-natural-prompt',rejectedBeforeConsume:true,arrayReplacementRepatched:true});
 // Persist an accepted queue through the real agent loop and SDK event subscription.
 f.host.setDrainArbiter(()=>true);f.session._isAgentRunActive=true;
 await f.host.enqueue('accepted',message('accepted exact body'),'followUp');
 assert.equal(f.host.receipt('accepted').status,'absent');f.session._isAgentRunActive=false;
 await f.agent.prompt('run and drain');
 assert.equal(f.host.receipt('accepted').status,'persisted');
 assert.equal(f.host.cancel('accepted').status,'not-queued');
 const reopened=SessionManager.open(f.manager.getSessionFile());
 assert.equal(reopened.getBranch().some(r=>r.details?.deliveryToken==='accepted'),true);
 evidence.checks.push({case:'real-sdk-loop-and-reopen',receiptBefore:'absent',receiptAfter:'persisted',afterDequeueCancel:'not-queued'});
 f.host.dispose();
 // Real tool execution and SDK _afterToolCall: hook/public listener both precede disk.
 const hookObservations=[];let calls=0,t;
 const tool={name:'receipt_probe',description:'offline probe',parameters:Type.Object({}),execute:async()=>({content:[{type:'text',text:'actual tool result'}],details:{eventId:'tool-event'}})};
 t=fixture('tools',[tool],()=>stream(calls++===0?assistant([{type:'toolCall',id:'tc-real',name:'receipt_probe',arguments:{}}],'toolUse'):assistant()));
 t.session._extensionRunner={hasHandlers:n=>n==='tool_result',emitToolResult:async()=>{hookObservations.push({boundary:'tool_result',receipt:t.host.toolReceipt('tc-real').status});return undefined;}};
 t.session.prePersist=async event=>{if(event.type==='message_end'&&event.message.role==='toolResult')hookObservations.push({boundary:'message_end-extension',receipt:t.host.toolReceipt('tc-real').status});};
 t.session.subscribe(event=>{if(event.type==='message_end'&&event.message.role==='toolResult')hookObservations.push({boundary:'message_end-public',receipt:t.host.toolReceipt('tc-real').status});});
 t.agent.afterToolCall=context=>t.session._afterToolCall(context);
 await t.agent.prompt('use offline tool');
 assert.deepEqual(hookObservations.map(x=>x.receipt),['absent','absent','absent']);
 assert.equal(t.host.toolReceipt('tc-real',m=>m.details?.eventId==='tool-event').status,'persisted');
 assert.equal(t.host.toolReceipt('tc-real',m=>m.details?.eventId==='wrong-event').status,'absent');
 evidence.checks.push({case:'real-tool-pipeline-persistence-boundary',observations:hookObservations,afterRun:'persisted'});t.host.dispose();
 const d=fixture('disk-failure');const path=d.manager.getSessionFile();
 renameSync(path,path+'.backup');mkdirSync(path);
 const toolResult={role:'toolResult',toolCallId:'tc-failed',toolName:'receipt_probe',content:[{type:'text',text:'not saved'}],details:{eventId:'failed'},isError:false,timestamp:Date.now()};
 await assert.rejects(()=>d.session._handleAgentEvent({type:'message_end',message:toolResult}),{code:'EISDIR'});
 assert.equal(d.manager.getBranch().some(r=>r.message?.toolCallId==='tc-failed'),true);
 assert.equal(d.host.toolReceipt('tc-failed').status,'unknown');
 rmSync(path,{recursive:true});renameSync(path+'.backup',path);
 assert.equal(inspectToolResultReceipt(()=>path,'tc-failed').status,'absent');
 assert.equal(SessionManager.open(path).getBranch().some(r=>r.message?.toolCallId==='tc-failed'),false);
 const partial=join(dir,'partial.jsonl');writeFileSync(partial,'{"type":"message"');
 assert.equal(inspectToolResultReceipt(()=>partial,'tc-failed').status,'unknown');
 evidence.checks.push({case:'real-filesystem-failure',failure:'EISDIR',branchHasResult:true,diskHasResult:false,receiptOnFailure:'unknown',receiptAfterRestoringDisk:'absent',reopenedHasResult:false,partialTail:'unknown'});d.host.dispose();
 // Public pi.on -> real ExtensionRunner -> real AgentSession replacement -> real disk.
 for(const options of [{},{triggerTurn:false},{deliverAs:'followUp',triggerTurn:false},{deliverAs:'steer'},{deliverAs:'unknown',triggerTurn:true}])assert.throws(()=>assertDeliveryDispatchOptions(options),/bypasses/);
 for(const options of [{deliverAs:'nextTurn',triggerTurn:false},{deliverAs:'followUp',triggerTurn:true},{deliverAs:'steer',triggerTurn:true}])assertDeliveryDispatchOptions(options);
 const publicFixture=fixture('public-message-end');
 const runtime=createExtensionRuntime(),bus=createEventBus(),errors=[],observed=[],requests=[];
 let gateDecision=true,removeGate,gateRelease,gateEntered;
 const entered=new Promise(resolve=>gateEntered=resolve);
 let gateCompleted=false;
 const order=[];
 const ext=await loadExtensionFromFactory(pi=>{removeGate=registerDeliveryMessageGate(pi,{
  owns:details=>details.deliveryToken==='public-owned',
  allow:async()=>{
   if(gateDecision==='blocked'){order.push('arbiter-enter');gateEntered();await new Promise(resolve=>gateRelease=resolve);gateCompleted=true;order.push('arbiter-complete');return false;}
   if(gateDecision==='throw')throw new Error('arbiter failed');return gateDecision;
  },
  onError:error=>errors.push(error.message),
 });},dir,bus,runtime);
 const runner=new ExtensionRunner([ext],runtime,dir,publicFixture.manager,{});
 publicFixture.session._extensionRunner=runner;
 publicFixture.session._emitExtensionEvent=event=>event.type==='message_end'?AgentSession.prototype._emitExtensionEvent.call(publicFixture.session,event):Promise.resolve();
 AgentSession.prototype._bindExtensionCore.call(publicFixture.session,runner);
 publicFixture.agent.streamFunction=(_model,context)=>{
  if(gateDecision==='blocked'&&requests.length>0)assert.equal(gateCompleted,true,'provider invocation must await message_end handler');
  order.push('provider-request');requests.push(JSON.stringify(context));return stream(assistant());
 };
 let messageStartHadBody=false;
 publicFixture.session.subscribe(event=>{
  if(event.type==='message_start'&&event.message.details?.deliveryToken==='public-owned'&&event.message.content==='OLD SECRET PUSH')messageStartHadBody=true;
  if(event.type==='message_end'&&event.message.details?.deliveryToken==='public-owned')observed.push(event.message);
 });
 publicFixture.session._isAgentRunActive=true;
 runtime.sendMessage(message('OLD SECRET PUSH',{deliveryToken:'public-owned',eventId:'public-event',result:'METADATA SECRET RESULT',message:'METADATA SECRET MESSAGE',error:'METADATA SECRET ERROR',bodyCommitted:true}),{deliverAs:'followUp',triggerTurn:true});
 runtime.sendMessage(message('UNRELATED PUSH',{deliveryToken:'public-foreign'}),{deliverAs:'followUp',triggerTurn:true});
 const queuedOwned=publicFixture.agent.followUpQueue.messages[0];
 gateDecision='blocked';
 publicFixture.session._isAgentRunActive=false;
 const runningPublic=publicFixture.agent.prompt('drain actual public binding');
 await entered;
 assert.equal(requests.length,1,'only initial request occurred; queued body cannot sample during awaited arbitration');
 assert.equal(readFileSync(publicFixture.manager.getSessionFile(),'utf8').includes('OLD SECRET PUSH'),false);
 gateRelease();await runningPublic;
 assert.equal(order.indexOf('arbiter-complete')<order.lastIndexOf('provider-request'),true);
 assert.equal(messageStartHadBody,true,'public gate cannot undo earlier message_start observers');
 assert.equal(queuedOwned.content.length,0);assert.equal(queuedOwned.display,false);assert.equal(observed[0],queuedOwned);
 assert.equal(publicFixture.agent.state.messages.includes(queuedOwned),true);
 assert.equal(readFileSync(publicFixture.manager.getSessionFile(),'utf8').includes('OLD SECRET PUSH'),false);
 assert.equal(readFileSync(publicFixture.manager.getSessionFile(),'utf8').includes('UNRELATED PUSH'),true);
 assert.equal(requests.some(request=>request.includes('OLD SECRET PUSH')),false);
 assert.equal(publicFixture.host.receipt('public-owned').entry.details.deliveryHostWithdrawn,true);
 assert.equal(publicFixture.host.receipt('public-owned').withdrawn,true);
 assert.equal(publicFixture.host.receipt('public-owned').status,'absent','withdrawal row is never committed-body acknowledgement');
 assert.deepEqual(queuedOwned.details,{eventId:'public-event',deliveryToken:'public-owned',deliveryHostWithdrawn:true});
 assert.equal(readFileSync(publicFixture.manager.getSessionFile(),'utf8').includes('METADATA SECRET'),false);
 assert.equal(requests.some(request=>request.includes('METADATA SECRET')),false);
 publicFixture.session._isAgentRunActive=true;
 runtime.sendMessage(message('ERROR SECRET PUSH',{deliveryToken:'public-owned'}),{deliverAs:'steer',triggerTurn:true});
 gateDecision='throw';publicFixture.session._isAgentRunActive=false;
 await publicFixture.agent.prompt('error decision must redact');
 assert.deepEqual(errors,['arbiter failed']);
 assert.equal(readFileSync(publicFixture.manager.getSessionFile(),'utf8').includes('ERROR SECRET PUSH'),false);
 assert.equal(requests.some(request=>request.includes('ERROR SECRET PUSH')),false);
 const diskRows=SessionManager.open(publicFixture.manager.getSessionFile()).getBranch();
 assert.equal(diskRows.filter(row=>row.details?.deliveryToken==='public-owned').every(row=>row.details.deliveryHostWithdrawn&&row.content.length===0),true);
 publicFixture.session._isAgentRunActive=true;
 runtime.sendMessage(message('ALLOWED PUBLIC BODY',{deliveryToken:'public-owned',eventId:'allowed-event'}),{deliverAs:'followUp',triggerTurn:true});
 gateDecision=true;publicFixture.session._isAgentRunActive=false;
 await publicFixture.agent.prompt('allowed body gets explicit commit marker');
 assert.equal(publicFixture.manager.getBranch().some(row=>row.details?.eventId==='allowed-event'&&row.details.deliveryHostBodyCommitted===true),true);
 // Prove the known SDK bypass exists; a governed caller must reject it before dispatch.
 const ownedBefore=observed.length;
 await publicFixture.session.sendCustomMessage(message('UNGUARDED CONTEXT APPEND',{deliveryToken:'public-owned'}),{triggerTurn:false});
 assert.equal(observed.length,ownedBefore+1);
 assert.equal(readFileSync(publicFixture.manager.getSessionFile(),'utf8').includes('UNGUARDED CONTEXT APPEND'),true);
 removeGate();publicFixture.host.dispose();
 evidence.checks.push({case:'public-message-end-real-extension-runner',publicSendMessageBinding:true,queuedDecisionChanged:true,sameObjectStateAndDisk:true,oldBodyInModel:false,oldBodyInDisk:false,foreignBodyPreserved:true,arbiterExceptionRedacted:true,messageStartObservedOldBody:true,reopenedWithdrawnRecords:2,withdrawalMetadataWhitelisted:true,withdrawalReceiptNotBodyAck:true,allowedBodyCommitMarker:true,actualProviderRequestsIntercepted:requests.length,awaitedArbitrationBeforeProvider:true,immediateAppendBypassProven:true,unsafeDispatchOptionsRejected:true});
 evidence.limitations.push('Public message_end gate withdraws body before model request/persistence, not dequeue; message_start/UI may already have observed body.');
 evidence.limitations.push('Public message_end handlers compose in registration order; a later trusted extension can undo replacement. Ownership matcher must be total and reliably recognize owned details.');
 evidence.result='passed';
 console.log('spec43-t3-host: real SDK queue cancellation, drain re-arbitration and disk receipt boundaries passed');
} finally {
 rmSync(dir,{recursive:true,force:true});
 evidence.cleanup={temporaryDirectoryRemoved:true,spawnedPanes:0,otherSessionsTouched:false};
 const folder=new URL('../.agents/evidence/spec43-t3/',import.meta.url);mkdirSync(folder,{recursive:true});
 writeFileSync(new URL('host-sdk.json',folder),JSON.stringify(evidence,null,2)+'\n');
}
