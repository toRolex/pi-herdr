import assert from 'node:assert/strict';import{createJiti}from'jiti';import{mkdtempSync,writeFileSync,readFileSync,rmSync,renameSync,mkdirSync}from'node:fs';import{join}from'node:path';import{tmpdir}from'node:os';
const jiti=createJiti(import.meta.url),sp=await jiti.import('../src/spawn.ts'),dl=await jiti.import('../src/delivery.ts');
const dir=mkdtempSync(join(tmpdir(),'registry-fail-'));const unhandled=[];const listener=e=>unhandled.push(String(e));process.on('unhandledRejection',listener);
try{
 const root=join(dir,'root'),leaf=join(dir,'leaf');writeFileSync(root,'');writeFileSync(leaf,'');
 const rec={name:'leaf',kind:'pi',paneId:'w1:leaf',sessionPath:leaf,stance:'autonomous',lineage:{ownerSession:root,rootSession:root}};
 writeFileSync(leaf+'.exit',JSON.stringify({type:'done',text:'final',eventId:'failure'}));sp.putSpawnRecordForTests(rec);mkdirSync(root+'.registry.json');
 await assert.rejects(dl.deliverOnce({sessionPath:root,load:()=>({notifications:'normal'}),fleet:{ok:true,data:[{paneId:rec.paneId,agentStatus:'done'}]},push(){},closePane:async()=>{}}),/persistence/);
 await new Promise(r=>setImmediate(r));assert.equal(unhandled.length,0,'own sidecar failure is awaited, never unhandled');
 sp.clearSpawnRegistry();rmSync(root+'.registry.json',{recursive:true});
 const mid=join(dir,'mid');writeFileSync(mid,'');const owner={name:'mid',kind:'pi',paneId:'w1:mid',sessionPath:mid,stance:'interactive'};
 const child={...rec,lineage:{ownerSession:mid,rootSession:root}};sp.writePersistedRegistry(mid,[child]);
 let closes=0;const deps={registry:()=>new Map([['mid',owner]]),sessionPath:root,load:()=>({notifications:'normal'}),fleet:{ok:true,data:[{paneId:rec.paneId,agentStatus:'done'}]},push(){},closePane:async()=>{closes++;renameSync(mid+'.registry.json',mid+'.backup');mkdirSync(mid+'.registry.json');}};
 await assert.rejects(dl.deliverOnce(deps),/persist|registry/i);
 assert.equal(JSON.parse(readFileSync(mid+'.backup','utf8'))[0].delivery?.kind,'done','adopted ack is persisted before close can fail outcome write');
 assert.equal(closes,1);
 console.log('delivery-registry-failure-sdk: passed');
}finally{process.off('unhandledRejection',listener);dl.stopDeliveryLoop();sp.clearSpawnRegistry();rmSync(dir,{recursive:true,force:true});}
