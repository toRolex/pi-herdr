import assert from 'node:assert/strict';
import {createJiti} from 'jiti';
import {mkdtempSync,writeFileSync,readFileSync,rmSync,renameSync,mkdirSync} from 'node:fs';
import {join} from 'node:path';import {tmpdir} from 'node:os';
const ROOT=new URL('../',import.meta.url).pathname;
for(const k of Object.keys(process.env))if(k.startsWith('PI_HERDR_'))delete process.env[k];
const jiti=createJiti(import.meta.url),imp=p=>jiti.import(join(ROOT,p));
const {AgentSession}=await imp('node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js');
const {SessionManager}=await imp('node_modules/@earendil-works/pi-coding-agent/dist/core/session-manager.js');
const {makeDeliverySink}=await imp('src/push.ts');const sp=await imp('src/spawn.ts'),dl=await imp('src/delivery.ts');
const dir=mkdtempSync(join(tmpdir(),'delta-sdk-'));
const manager=new SessionManager(dir,dir,undefined,true);
manager.appendMessage({role:'user',content:[{type:'text',text:'initial'}],timestamp:1});
const path=manager.getSessionFile();
const errors=[],followUps=[];let actions,now=0;
class OfflineSession extends AgentSession {
 _installAgentToolHooks(){} _installAgentNextTurnRefresh(){} _installAgentRequestProjection(){} _installAgentBoundaryHooks(){} _installHiddenDeclarationsProjection(){} _installAgentForcedPromptProjection(){} _buildRuntime(){} _restoreToolsFromTranscript(){}
}
const host=new OfflineSession({agent:{subscribe(){return()=>{}}},sessionManager:manager});
Object.assign(host,{sessionManager:manager,_isAgentRunActive:true,_pendingNextTurnMessages:[],_pendingCustomMessages:[],_eventListeners:[],_isEmittingAgentSettled:false,_entryIdsByMessage:new WeakMap(),_emitExtensionEvent:async()=>{},_refreshFinalizedContext(){},agent:{state:{isStreaming:true},followUp:m=>followUps.push(m),steer:m=>followUps.push(m)}});
AgentSession.prototype._bindExtensionCore.call(host,{bindCore:a=>actions=a,emitError:e=>errors.push(e)});
try{
 // Actual SDK quiet queue; clock advance only, no fake sleep/durable rows.
 const sink=makeDeliverySink({...actions,on(){}},{getBranch:()=>manager.getBranch(),getSessionFile:()=>manager.getSessionFile(),now:()=>now});
 const quiet={content:'quiet final',details:{name:'quiet',kind:'done',eventId:'q'},wake:false,deliverAs:'nextTurn'};
 assert.throws(()=>sink(quiet),/pending/);assert.equal(host._pendingNextTurnMessages.length,1);
 now=29_999;assert.throws(()=>sink(quiet),/pending/);assert.equal(host._pendingNextTurnMessages.length,1);
 now=30_001;assert.throws(()=>sink(quiet),/timeout/);
 now=32_500;assert.throws(()=>sink(quiet),/timeout/);assert.equal(host._pendingNextTurnMessages.length,1);
 const quietEntries=host._pendingNextTurnMessages.splice(0);
 for(const app of quietEntries)await host._handleAgentEvent({type:'message_end',message:app});
 sink(quiet);
 const reloadSink=makeDeliverySink({...actions,on(){}},{getBranch:()=>manager.getBranch(),getSessionFile:()=>manager.getSessionFile()});
 reloadSink(quiet);assert.equal(host._pendingNextTurnMessages.length,0,'durable event ID dedupes after sink reload');
 const diskQuiet=readFileSync(path,'utf8').trim().split('\n').map(JSON.parse).filter(r=>r.type==='custom_message');
 console.log('REAL_SDK_QUIET_TIMEOUT_DUPLICATE',JSON.stringify({queueCount:quietEntries.length,diskEntries:diskQuiet.length,tokens:diskQuiet.map(r=>r.details.deliveryToken)}));
 // Actual SDK busy followUp queue, same 30s retry creates duplicate.
 now=0;const busySink=makeDeliverySink({...actions,on(){}},{getBranch:()=>manager.getBranch(),getSessionFile:()=>manager.getSessionFile(),now:()=>now});
 const busy={content:'busy final',details:{name:'busy',kind:'done',eventId:'b'},wake:true,deliverAs:'followUp'};
 assert.throws(()=>busySink(busy),/pending/);now=30_001;assert.throws(()=>busySink(busy),/timeout/);now=32_500;assert.throws(()=>busySink(busy),/timeout/);
 assert.equal(followUps.length,1);console.log('REAL_SDK_BUSY_TIMEOUT_DUPLICATE',JSON.stringify({queued:followUps.length}));
 // Actual SDK sendCustomMessage + actual SessionManager disk write error mutates branch first.
 const root=path,mid=join(dir,'mid.jsonl'),leaf=join(dir,'leaf.jsonl');writeFileSync(mid,'');writeFileSync(leaf,'');
 const owner={name:'mid',kind:'pi',paneId:'fake:mid',sessionPath:mid,stance:'autonomous',lineage:{ownerSession:root,rootSession:root}};
 const child={name:'leaf',kind:'pi',paneId:'fake:leaf',sessionPath:leaf,stance:'autonomous',lineage:{ownerSession:mid,rootSession:root}};
 sp.writePersistedRegistry(mid,[child]);writeFileSync(leaf+'.exit',JSON.stringify({type:'done',text:'orphan final',rootSession:root,eventId:'persistence-failure'}));
 let closes=0;const diskSink=makeDeliverySink({...actions,on(){}},{getBranch:()=>manager.getBranch(),getSessionFile:()=>manager.getSessionFile()});
 const deps={registry:()=>new Map([['mid',owner]]),sessionPath:root,load:()=>({notifications:'normal'}),fleet:{ok:true,data:[{paneId:'fake:leaf',agentStatus:'done'}]},busy:()=>true,push:diskSink,closePane:async()=>{closes++;return{ok:true}},debug(){}};
 await dl.deliverOnce(deps);const app=followUps.at(-1);assert.equal(app.details.name,'leaf');assert.equal(closes,0);
 renameSync(path,path+'.backup');mkdirSync(path); // real filesystem EISDIR, no persistence stub.
 let failure;try{await host._handleAgentEvent({type:'message_end',message:app})}catch(e){failure=e.code}
 assert.equal(failure,'EISDIR');assert.equal(manager.getBranch().some(r=>r.details?.deliveryToken===app.details.deliveryToken),true);
 await dl.deliverOnce(deps);
 const saved=sp.readPersistedRegistry(mid)[0];
 console.log('REAL_SDK_FALSE_DURABLE_ACK',JSON.stringify({failure,branchHasToken:true,diskBackupHasToken:readFileSync(path+'.backup','utf8').includes(app.details.deliveryToken),closes,delivery:saved.delivery,pushError:saved.pushError??null}));
 assert.equal(closes,0);assert.equal(saved.delivery,undefined);assert.match(saved.pushError,/confirm|pending|ack/);assert.equal(readFileSync(path+'.backup','utf8').includes(app.details.deliveryToken),false);
}finally{dl.stopDeliveryLoop();sp.clearSpawnRegistry();rmSync(dir,{recursive:true,force:true});}
