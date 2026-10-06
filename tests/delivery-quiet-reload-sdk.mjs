import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,writeFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createJiti} from 'jiti';
const root=new URL('../',import.meta.url).pathname;
const jiti=createJiti(import.meta.url);
const sp=await jiti.import(join(root,'src/spawn.ts'));
const dl=await jiti.import(join(root,'src/delivery.ts'));
const sdk=join(process.env.PI_HERDR_TEST_SDK_ROOT??join(root,'node_modules/@earendil-works/pi-coding-agent'),'dist');
const imp=p=>import(pathToFileURL(join(sdk,p)).href);
const {AgentSession}=await imp('core/agent-session.js');
const {SessionManager}=await imp('core/session-manager.js');
const {loadExtensions}=await imp('core/extensions/loader.js');
const {ExtensionRunner}=await imp('core/extensions/runner.js');
const dir=mkdtempSync('/tmp/closed-quiet-reload-');
const manager=new SessionManager(dir,dir,undefined,true);
manager.appendMessage({role:'user',content:[{type:'text',text:'initial'}],timestamp:1});
const extension=join(dir,'sink.ts');
// Minimal actual extension runner: production sink, real host void binding and lifecycle.
writeFileSync(extension,`import {makeDeliverySink} from ${JSON.stringify(join(root,'src/push.ts'))}; export default function(pi){globalThis.__closedSink=makeDeliverySink(pi);}`);
let loaded;
const host=Object.create(AgentSession.prototype);
Object.assign(host,{_pendingNextTurnMessages:[],_pendingCustomMessages:[],_cwd:dir,sessionManager:manager,_pendingToolNames:new Set(),_extensionUIContext:{},_isEmittingAgentSettled:false,
 settingsManager:{reload:async()=>{},getDefaultTools:()=>[]},_usesDefaultTools:false,
 syncQueueModesFromSettings(){},getActiveToolNames(){return[]},extendResourcesFromExtensions:async()=>{},
 _resourceLoader:{reload:async()=>{loaded=await loadExtensions([extension],dir)}},
 _buildRuntime(){this._extensionRunner=new ExtensionRunner(loaded.extensions,loaded.runtime,dir,manager,{});this._bindExtensionCore(this._extensionRunner)},
});
Object.defineProperty(host,'isStreaming',{value:false});
const session=manager.getSessionFile(),mid=join(dir,'mid.jsonl'),leaf=join(dir,'leaf.jsonl');writeFileSync(mid,'');writeFileSync(leaf,'');
const owner={name:'mid',kind:'pi',paneId:'fake:mid',sessionPath:mid,stance:'interactive',lineage:{ownerSession:session,rootSession:session}};
const child={name:'leaf',kind:'pi',paneId:'fake:leaf',sessionPath:leaf,stance:'autonomous',lineage:{ownerSession:mid,rootSession:session}};
sp.writePersistedRegistry(mid,[child]);writeFileSync(leaf+'.exit',JSON.stringify({type:'done',text:'QUIET_FINAL',eventId:'quiet-reload-event',rootSession:session}));
let closes=0;
const deps={registry:()=>new Map([['mid',owner]]),sessionPath:session,load:()=>({notifications:'quiet'}),fleet:{ok:true,data:[{paneId:'fake:leaf',agentStatus:'unknown'}]},push:m=>globalThis.__closedSink(m),debug(){},closePane:async()=>{closes++;return{ok:true}}};
try{
 await host._resourceLoader.reload();host._buildRuntime();
 await host._extensionRunner.emit({type:'session_start',reason:'startup'});
 await dl.deliverOnce(deps);
 assert.match(sp.readPersistedRegistry(mid)[0].pushError,/pending/);
 assert.equal(closes,0);assert.equal(host._pendingNextTurnMessages.length,1);
 // Actual SDK reload: old shutdown/invalidation -> resources -> new runtime -> session_start.
 await host.reload();
 assert.equal(host._pendingNextTurnMessages.length,1,'actual reload retains original SDK quiet queue');
 await dl.deliverOnce(deps);
 assert.equal(closes,0);assert.equal(sp.readPersistedRegistry(mid)[0].delivery,undefined);
 const queued=host._pendingNextTurnMessages;
 assert.equal(queued.length,1,'same-session reload must retain original pending delivery identity');
 for(const m of queued)manager.appendCustomMessageEntry(m.customType,m.content,m.display,m.details);
 const rows=readFileSync(manager.getSessionFile(),'utf8').trim().split('\n').map(JSON.parse).filter(e=>e.type==='custom_message');
 assert.equal(rows.length,1);assert.equal(new Set(rows.map(e=>e.details.deliveryToken)).size,1);
 await dl.deliverOnce(deps); assert.equal(host._pendingNextTurnMessages.length,1);
 console.log('ACTUAL_SDK_RELOAD_QUIET_DEDUPE',JSON.stringify({queue:queued.length,eventIds:rows.map(e=>e.details.eventId),tokens:rows.map(e=>e.details.deliveryToken),actualReload:true}));
}finally{await host._extensionRunner?.emit({type:'session_shutdown',reason:'exit'});dl.stopDeliveryLoop();sp.clearSpawnRegistry();delete globalThis.__closedSink;rmSync(dir,{recursive:true,force:true});}
