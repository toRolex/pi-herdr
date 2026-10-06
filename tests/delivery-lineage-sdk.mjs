import assert from 'node:assert/strict';
import {createJiti} from 'jiti';
import {mkdtempSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
const jiti=createJiti(import.meta.url);
const sp=await jiti.import('../src/spawn.ts'), dl=await jiti.import('../src/delivery.ts');
const {normalizeAgent}=await jiti.import('../src/env.ts');
const {SessionManager}=await jiti.import('../node_modules/@earendil-works/pi-coding-agent/dist/core/session-manager.js');
const {AgentSession}=await jiti.import('../node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js');
const {makeDeliverySink}=await jiti.import('../src/push.ts');
const dir=mkdtempSync(join(tmpdir(),'lineage-sdk-'));
try {
 const manager=new SessionManager(dir,dir,undefined,true);
 manager.appendMessage({role:'user',content:[{type:'text',text:'initial'}],timestamp:1});
 const root=manager.getSessionFile(),mid=join(dir,'mid.jsonl'),leaf=join(dir,'leaf.jsonl');
 writeFileSync(mid,'');writeFileSync(leaf,'');
 const owner={name:'c-mid',kind:'pi',paneId:'w74:p3',sessionPath:mid,orchestratorPane:'w74:p2',stance:'interactive',lineage:{ownerSession:root,rootSession:root}};
 const child={name:'c-leaf',kind:'pi',paneId:'w74:p4',sessionPath:leaf,orchestratorPane:'w74:p3',stance:'autonomous',lineage:{ownerSession:mid,rootSession:root}};
 const queue=[];let actions;
 const host=Object.create(AgentSession.prototype);
 Object.assign(host,{_isAgentRunActive:true,_pendingNextTurnMessages:[],_pendingCustomMessages:[],sessionManager:manager,agent:{followUp:m=>queue.push(m),steer:m=>queue.push(m)}});
 AgentSession.prototype._bindExtensionCore.call(host,{bindCore:a=>actions=a,emitError(){}});
 let push=makeDeliverySink({...actions,on(){}},{getBranch:()=>manager.getBranch(),getSessionFile:()=>root});
 let closes=0,status='unknown',failFleet=false,includeOwner=false,includeLeaf=true;
 const deps={registry:()=>new Map([['c-mid',owner]]),sessionPath:root,load:()=>({notifications:'normal'}),busy:()=>true,debug(){},push:m=>push(m),
  list:async()=>failFleet?{ok:false,error:{code:'HERDR_UNAVAILABLE',message:'fleet down'}}:{ok:true,data:[
   {pane_id:'w74:p2',name:'c-root-resume',agent:'pi',agent_status:'idle'},
   ...(includeOwner?[{pane_id:'w74:p3',agent_status:'unknown'}]:[]),
   ...(includeLeaf?[{pane_id:'w74:p4',agent_status:status,terminal_title:'zsh in scratch'}]:[]),
  ].map(normalizeAgent)},
  closePane:async pane=>{assert.equal(pane,'w74:p4');assert.equal(sp.readPersistedRegistry(mid)[0].delivery.kind,'done','mark is durable before close');assert.ok(readFileSync(root,'utf8').includes('full orphan final'),'disk ack precedes close');closes++;return {ok:true};}};
 const seed=(over={},sidecar={})=>{
  sp.writePersistedRegistry(mid,[{...child,...over}]);
  writeFileSync(leaf+'.exit',JSON.stringify({type:'done',text:'full orphan final',eventId:'live-leaf-terminal',rootSession:root,...sidecar}));
 };
 seed();
 // Successful fleet observation with owner absent, shell leaf unknown.
 await dl.deliverOnce(deps);await new Promise(r=>setImmediate(r));
 assert.equal(queue.length,1,'typed terminal unknown shell is adopted into actual SDK queue');
 assert.equal(closes,0,'SDK enqueue is not a durable acknowledgement');
 assert.equal(sp.readPersistedRegistry(mid)[0].delivery,undefined);
 const app=queue[0];manager.appendCustomMessageEntry(app.customType,app.content,app.display,app.details);
 await dl.deliverOnce(deps);assert.equal(closes,1);
 push=makeDeliverySink({...actions,on(){}},{getBranch:()=>manager.getBranch(),getSessionFile:()=>root});
 await dl.deliverOnce(deps);assert.equal(queue.length,1,'fresh sink and disk registry dedupe recovery');assert.equal(closes,1);
 // Negative gates still require exact lineage/session and healthy observation.
 for(const blocked of ['working','blocked']){seed();status=blocked;await dl.deliverOnce(deps);assert.equal(sp.readPersistedRegistry(mid)[0].delivery,undefined,blocked+' cannot be adopted');}
 status='unknown';seed();includeOwner=true;await dl.deliverOnce(deps);assert.equal(sp.readPersistedRegistry(mid)[0].delivery,undefined,'present owner shell is not dead-owner evidence');includeOwner=false;
 seed();failFleet=true;await dl.deliverOnce(deps);assert.equal(sp.readPersistedRegistry(mid)[0].delivery,undefined,'failed fleet is not absence');failFleet=false;
 seed({lineage:{ownerSession:join(dir,'other.jsonl'),rootSession:root}});await dl.deliverOnce(deps);assert.equal(sp.readPersistedRegistry(mid)[0].delivery,undefined,'mismatched owner is not this registry child');
 seed({lineage:{ownerSession:mid,rootSession:join(dir,'other-root.jsonl')}});await dl.deliverOnce(deps);assert.equal(sp.readPersistedRegistry(mid)[0].delivery,undefined,'different root not adopted');
 seed({}, {rootSession:join(dir,'other-root.jsonl')});await dl.deliverOnce(deps);assert.equal(sp.readPersistedRegistry(mid)[0].delivery,undefined,'sidecar root conflict not adopted');
 seed();writeFileSync(leaf+'.exit','{"type":"progress"}');await dl.deliverOnce(deps);assert.equal(sp.readPersistedRegistry(mid)[0].delivery,undefined,'untyped terminal is not exit evidence');
 seed();writeFileSync(leaf+'.takeover','{}');await dl.deliverOnce(deps);assert.equal(sp.readPersistedRegistry(mid)[0].delivery.kind,'done');assert.equal(closes,1,'current takeover prevents close of adopted unknown shell');
 rmSync(leaf+'.takeover');seed();includeLeaf=false;await dl.deliverOnce(deps);assert.equal(sp.readPersistedRegistry(mid)[0].delivery.kind,'done','absent leaf with typed terminal is recoverable too');assert.equal(closes,2);
 assert.equal(queue.length,1,'all recovery retries keep one business event');
 // Real SDK dispatch wrapped by a transport that throws before enqueue.
 includeLeaf=true;seed({}, {eventId:'sync-throw-terminal'});
 let broken=true,attempts=0;
 push=makeDeliverySink({...actions,on(){},sendMessage(...args){attempts++;if(broken)throw Error('injected before SDK enqueue');return actions.sendMessage(...args);}}, {getBranch:()=>manager.getBranch(),getSessionFile:()=>root});
 await dl.deliverOnce(deps);assert.equal(queue.length,1);assert.equal(closes,2);
 assert.match(sp.readPersistedRegistry(mid)[0].pushError,/injected/);
 broken=false;await dl.deliverOnce(deps);await new Promise(r=>setImmediate(r));
 assert.equal(attempts,2,'known synchronous non-enqueue failure retries in the same sink');
 assert.equal(queue.length,2);assert.equal(closes,2,'repaired SDK enqueue still waits for disk ack');
 await dl.deliverOnce(deps);assert.equal(attempts,2,'unknown pending SDK outcome is never enqueued twice');
 const repaired=queue[1];manager.appendCustomMessageEntry(repaired.customType,repaired.content,repaired.display,repaired.details);
 await dl.deliverOnce(deps);assert.equal(closes,3);assert.equal(sp.readPersistedRegistry(mid)[0].delivery.kind,'done');
 await dl.deliverOnce(deps);assert.equal(attempts,2);assert.equal(closes,3);
 console.log('delivery-lineage-sdk: passed');
}finally{dl.stopDeliveryLoop();sp.clearSpawnRegistry();rmSync(dir,{recursive:true,force:true});}
