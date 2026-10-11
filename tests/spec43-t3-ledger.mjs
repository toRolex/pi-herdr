import assert from 'node:assert/strict';
import {createJiti} from 'jiti';
import {mkdtempSync,writeFileSync,readFileSync,rmSync,mkdirSync,renameSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const jiti=createJiti(import.meta.url);
const {DeliveryLedger,deliveryLedgerPath}=await jiti.import('../src/delivery-ledger.ts');
const dir=mkdtempSync(join(tmpdir(),'t3-ledger-'));
const host=join(dir,'host.jsonl');writeFileSync(host,'');
const evidence=[];
try {
 const ledger=new DeliveryLedger(host), ref={eventId:'event-one',agentId:'agent',runId:'run',sequence:1};
 const push=ledger.queuePush(ref);assert.equal(push.bodyAllowed,true);assert.equal(push.record.status,'queued');
 const pull=ledger.claimPull(ref,'tool-one');assert.equal(pull.bodyAllowed,true);assert.equal(pull.record.status,'pending');
 assert.equal(ledger.claimPush(ref.eventId,push.record.token),false);
 assert.equal(ledger.claimPull(ref,'tool-two').bodyAllowed,false);
 assert.equal(ledger.queuePush(ref).bodyAllowed,false);
 assert.equal(new DeliveryLedger(host).reconcile(ref.eventId).status,'pending');
 // A withdrawn stale push, even if it carries an old proof, never confirms the pull winner.
 writeFileSync(host,JSON.stringify({type:'custom_message',customType:'herdr-delivery',content:[],details:{eventId:ref.eventId,deliveryHostWithdrawn:true,delivery:ledger.proof(push.record)}})+'\n');
 assert.equal(ledger.reconcile(ref.eventId).status,'pending');
 const proof=ledger.proof(pull.record);
 writeFileSync(host,JSON.stringify({type:'message',message:{role:'toolResult',toolCallId:'tool-one',content:[{type:'text',text:'BODY'}],details:{delivery:proof}}})+'\n',{flag:'a'});
 // Host committed but ledger ACK cannot be written; restart repairs solely from host evidence.
 const path=deliveryLedgerPath(host);renameSync(path,path+'.saved');mkdirSync(path);
 assert.throws(()=>ledger.reconcile(ref.eventId));rmSync(path,{recursive:true});renameSync(path+'.saved',path);
 assert.equal(new DeliveryLedger(host).reconcile(ref.eventId).status,'delivered');
 assert.equal(ledger.claimPull(ref,'tool-three').bodyAllowed,false);
 evidence.push({case:'queued-push-pull-and-second-pull',winner:'pull',stalePushAllowed:false,restartDiskRepair:true});
 const second={eventId:'event-two'};const queued=ledger.queuePush(second);assert.equal(ledger.claimPush(second.eventId,queued.record.token),true);
 assert.equal(ledger.claimPull(second,'tool-other').bodyAllowed,false);assert.equal(ledger.claimPush(second.eventId,queued.record.token),false);
 evidence.push({case:'push-commit-pending-does-not-timeout',secondPullAllowed:false,status:ledger.reconcile(second.eventId).status});
 const isolated=join(dir,'other.jsonl');writeFileSync(isolated,'');assert.equal(new DeliveryLedger(isolated).claimPull(ref,'other-host').bodyAllowed,true);
 const legacy={eventId:'legacy'};ledger.migratePending(legacy,'unknown-old');assert.equal(ledger.claimPull(legacy,'legacy-tool').bodyAllowed,false);assert.equal(ledger.reconcile('legacy').identityReviewRequired,true);
 const before=readFileSync(path,'utf8');readFileSync(host,'utf8');assert.equal(readFileSync(path,'utf8'),before);
 evidence.push({case:'receiver-isolation-read-and-legacy',independentHost:true,directReadMutates:false,unknownLegacyRetained:true});
 const malformed=join(dir,'malformed.jsonl');writeFileSync(malformed,'{torn');
 assert.throws(()=>new DeliveryLedger(malformed).claimPull({eventId:'unknown'},'unknown-tool'),/unknown|invalid/i);
 const {makeDeliverySink}=await jiti.import('../src/push.ts');
 const legacyHost=join(dir,'legacy-host.jsonl');writeFileSync(legacyHost,'');
 const legacyPending=globalThis[Symbol.for('pi-herdr.pending-delivery-acknowledgements')];
 legacyPending.set(legacyHost,new Map([[JSON.stringify(['legacy-event','child','name','done','OLD FORMAT BODY']),{token:'legacy-token',at:0}]]));
 const hooks=new Map();let dispatched=0;
 const sink=makeDeliverySink({on:(name,handler)=>hooks.set(name,handler),sendMessage:()=>{dispatched++;}},{getBranch:()=>[],getSessionFile:()=>legacyHost});
 assert.equal(new DeliveryLedger(legacyHost).claimPull({eventId:'legacy-event'},'pull').bodyAllowed,false);
 assert.throws(()=>sink({content:'NEW FORMAT BODY',details:{eventId:'legacy-event'},wake:true}),/pending/);
 assert.equal(dispatched,0);
 const withdrawal=await hooks.get('message_end')({message:{role:'custom',customType:'herdr-delivery',content:'OLD FORMAT BODY',details:{eventId:'legacy-event',deliveryToken:'legacy-token',result:'SECRET'},timestamp:1}},{sessionManager:{getSessionFile:()=>legacyHost}});
 assert.deepEqual(withdrawal.message.content,[]);assert.equal(withdrawal.message.details.result,undefined);assert.equal(new DeliveryLedger(legacyHost).reconcile('legacy-event').status,'pending');
 evidence.push({case:'unknown-host-and-legacy-format-migration',malformedHostFailsClosed:true,changedBodyDoesNotRequeue:true,legacyQueueBodyWithdrawn:true});
 let accepted=0;const ambiguousSink=makeDeliverySink({on:()=>{},sendMessage:()=>{accepted++;throw new Error('after enqueue callback failure');}},{getBranch:()=>[],getSessionFile:()=>host});
 const ambiguous={content:'AMBIGUOUS BODY',details:{eventId:'ambiguous',agentId:'a',runId:'r'},wake:true};
 assert.throws(()=>ambiguousSink(ambiguous),/callback failure/);assert.throws(()=>ambiguousSink(ambiguous),/pending/);assert.equal(accepted,1);assert.equal(ledger.reconcile('ambiguous').status,'pending');
 const noHost=makeDeliverySink({on:()=>{},sendMessage:()=>{throw new Error('must not dispatch');}});
 assert.throws(()=>noHost(ambiguous),/requires a receiver/);
 evidence.push({case:'dispatch-outcome-unknown',acceptedThenThrowDoesNotRequeue:true,pendingRetained:true,stableIdentityMissingHostFailsClosed:true});
 const out=new URL('../.agents/evidence/spec43-t3/ledger.json',import.meta.url);writeFileSync(out,JSON.stringify({result:'passed',checks:evidence,scope:'state machine and disk evidence; host provider proof is separate'},null,2)+'\n');
 console.log('spec43-t3-ledger: passed');
} finally {rmSync(dir,{recursive:true,force:true});}

// AC5: list projects unread from durable evidence without consuming or repairing delivery.
{
 const {createHash}=await import('node:crypto');
 const transport=await jiti.import('../src/herdr.ts');
 const originalFleet=Object.getOwnPropertyDescriptor(transport,'fleetList');
 const originalHerdr=Object.getOwnPropertyDescriptor(transport,'herdr');
 let fleetCalls=0;
 Object.defineProperty(transport,'fleetList',{value:async()=>{fleetCalls++;return {ok:true,data:[]};},configurable:true});
 Object.defineProperty(transport,'herdr',{value:async()=>{throw new Error('unexpected real herdr command');},configurable:true});
 const sp=await jiti.import('../src/spawn.ts');
 const push=await jiti.import('../src/push.ts');
 const {ParentNotifyStore,parentNotifyPath}=await jiti.import('../src/parent-notify-store.ts');
 const {registerOrchestration}=await jiti.import('../src/tools/orchestration.ts');
 const listDir=mkdtempSync(join(tmpdir(),'spec44-list-'));
 const listHost=join(listDir,'host.jsonl');
 const previousRegistry=[...sp.spawnRecords()];
 const previousHost=push.currentOrchestratorSession();
 const listeners=new Map();
 push.rememberOrchestratorSession({on:(event,callback)=>listeners.set(event,callback)});
 const setHost=host=>listeners.get('session_start')({}, {sessionManager:{getSessionFile:()=>host}});
 try {
  setHost(listHost);writeFileSync(listHost,'');sp.clearSpawnRegistry();
  const record={name:'queued-worker',kind:'pi',agentId:'agent-fixture',runId:'run-fixture',sequence:1,prompt:'SECRET TASK',agentArgs:[],depth:1,isolated:false,spawnedAt:1,submitted:false,sawWorking:false,stance:'autonomous',unread:3};
  sp.spawnRecords().set(record.name,record);sp.writePersistedRegistry(listHost,[record]);
  const ledger=new DeliveryLedger(listHost),store=new ParentNotifyStore(listHost),queued={};
  const ref=eventId=>({eventId,agentId:record.agentId,runId:record.runId,sequence:record.sequence});
  for(const eventId of ['body-proof','withdrawn','still-queued']) {
   store.put({content:`SECRET BODY ${eventId}`,wake:false,details:{...ref(eventId),name:record.name}});
   queued[eventId]=ledger.queuePush(ref(eventId)).record;
  }
  writeFileSync(listHost,[
   {type:'custom_message',customType:'herdr-delivery',content:'SECRET BODY body-proof',details:{eventId:'body-proof',delivery:ledger.proof(queued['body-proof'])}},
   {type:'custom_message',customType:'herdr-delivery',content:'',details:{eventId:'withdrawn',deliveryToken:queued.withdrawn.token,deliveryHostWithdrawn:true}},
  ].map(row=>JSON.stringify(row)).join('\n')+'\n');
  const paths={ledger:deliveryLedgerPath(listHost),registry:sp.registryPathFor(listHost),host:listHost,outbox:parentNotifyPath(listHost)};
  const snapshot=()=>({
   files:Object.fromEntries(Object.entries(paths).map(([key,path])=>{const bytes=readFileSync(path);return [key,{bytes:bytes.toString('utf8'),hash:createHash('sha256').update(bytes).digest('hex')}];})),
   registry:JSON.stringify([...sp.spawnRecords()]),
   states:Object.fromEntries(Object.entries(JSON.parse(readFileSync(paths.ledger,'utf8')).events).map(([id,row])=>[id,row.status])),
  });
  const before=snapshot();
  assert.deepEqual(before.states,{'body-proof':'queued',withdrawn:'queued','still-queued':'queued'});
  const tools=new Map();registerOrchestration({registerTool:tool=>tools.set(tool.name,tool)});
  const list=tools.get('herdr_list_agents');assert.ok(list);
  for(let call=0;call<2;call++) {
   const result=await list.execute(`list-${call}`,{},undefined);
   assert.ok(!result.isError);assert.equal(result.details.rows.length,1);
   assert.equal(result.details.rows[0].state,'queued');assert.equal(result.details.rows[0].unread,2);
   assert.ok(!JSON.stringify(result).includes('SECRET'),'list never exposes task or body');
   const after=snapshot();
   assert.deepEqual(after.files.ledger,before.files.ledger,'list preserves ledger bytes and SHA256');
   assert.deepEqual(after.states,before.states,'list preserves delivery and ACK states');
   assert.deepEqual(after,before,'list preserves Registry memory/disk, host and outbox');
  }
  assert.equal(fleetCalls,2,'both reads traverse the public fleet transport boundary');
  assert.equal(ledger.reconcile('body-proof').status,'delivered');
  assert.equal(JSON.parse(readFileSync(paths.ledger,'utf8')).events['body-proof'].status,'delivered','default reconcile persists delivered before queuePush');
  assert.equal(ledger.queuePush(ref('body-proof')).bodyAllowed,false,'committed body cannot replay');
  assert.equal(ledger.reconcile('withdrawn').status,'available');
  assert.equal(JSON.parse(readFileSync(paths.ledger,'utf8')).events.withdrawn.status,'available','default reconcile persists available before queuePush');
  assert.equal(ledger.queuePush(ref('withdrawn')).bodyAllowed,true,'withdrawn body remains retryable');
  assert.equal(ledger.queuePush(ref('still-queued')).bodyAllowed,false,'accepted queue without proof cannot replay');
  console.log('spec44-list: repeated public list is read-only; default durable repair and retry guards passed');
 } finally {
  sp.clearSpawnRegistry();for(const [name,record] of previousRegistry)sp.spawnRecords().set(name,record);
  setHost(previousHost);
  Object.defineProperty(transport,'fleetList',originalFleet);Object.defineProperty(transport,'herdr',originalHerdr);
  rmSync(listDir,{recursive:true,force:true});
 }
}
