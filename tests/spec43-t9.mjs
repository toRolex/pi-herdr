import assert from 'node:assert/strict';
import {createJiti} from 'jiti';
import {mkdtempSync,writeFileSync,existsSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';import {join} from 'node:path';
const jiti=createJiti(import.meta.url),{registerChildExtension}=await jiti.import('../src/child.ts');
const dir=mkdtempSync(join(tmpdir(),'t9-')),session=join(dir,'child.jsonl');
const saved={...process.env};
try{
 process.env.PI_HERDR_SESSION=session;process.env.PI_HERDR_AUTO_EXIT='1';delete process.env.PI_HERDR_ACTIVITY_FILE;
 writeFileSync(session,'');const events={},tools=[],queue=[];let shuts=0;
 registerChildExtension({on:(n,h)=>(events[n]??=[]).push(h),registerTool:t=>tools.push(t),registerShortcut(){},sendUserMessage:(text,options)=>queue.push({text,options})});
 const ctx={shutdown:()=>shuts++,hasPendingMessages:()=>queue.length>0};const emit=async(n,e={})=>{let result;for(const h of events[n]??[])result=await h(e,ctx);return result;};
 await emit('agent_start');assert.equal((await emit('input',{source:'interactive',text:'ordinary input'})).action,'handled');assert.deepEqual(queue,[{text:'ordinary input',options:{deliverAs:'followUp'}}]);assert.ok(!existsSync(session+'.takeover'));
 writeFileSync(session,JSON.stringify({type:'message',message:{role:'assistant',content:[{type:'text',text:'final'}]}})+'\n');
 await tools.find(t=>t.name==='agent_done').execute('done',{},undefined,undefined,ctx);assert.equal(shuts,0);assert.ok(!existsSync(session+'.exit'));
 await emit('agent_end',{messages:[{role:'assistant',stopReason:'stop'}]});await emit('agent_settled');assert.equal(shuts,0,'queued submitted input keeps pending run alive');
 queue.length=0;await emit('agent_settled');assert.equal(shuts,1,'durably saved completion recycles without re-arm');
 console.log('GREEN T9 direct followUp queue / pending input / no marker / durable recycle');
}finally{for(const k of Object.keys(process.env))if(!(k in saved))delete process.env[k];Object.assign(process.env,saved);rmSync(dir,{recursive:true,force:true});}
