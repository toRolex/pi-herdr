import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai';
import { appendFileSync, existsSync } from 'node:fs';
import { Type } from 'typebox';
import child from '../../src/child.js';
import { registerSelfReport } from '../../src/selfreport.js';

export default function(pi: ExtensionAPI) {
 child(pi); registerSelfReport(pi);
 const trace = process.env.T10_TRACE!;
 const log = (data: unknown) => appendFileSync(trace, JSON.stringify(data)+'\n');
 let attempt = 0;
 pi.registerTool({name:'t10_permission',label:'T10 permission',description:'Explicit permission response demo',parameters:Type.Object({}),
  async execute(_id,_params,_signal,_update,ctx) {
   pi.events.emit('herdr:blocked',{active:true}); log({state:'blocked',sidecar:existsSync(process.env.PI_HERDR_SESSION+'.exit')});
   const answer = await ctx.ui.select('T10 permission required', ['Allow','Deny']);
   pi.events.emit('herdr:blocked',{active:false}); log({state:'recovered',answer});
   return {content:[{type:'text',text:`permission=${answer}`}],details:{answer}};
  }});
 pi.registerProvider('t10-demo',{api:'t10-demo-api',baseUrl:'http://localhost.invalid',apiKey:'fixture',models:[{id:'deterministic',name:'T10 deterministic',reasoning:false,input:['text'],cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:128000,maxTokens:1024}],
  streamSimple(model,context) {
   const stream=createAssistantMessageEventStream();
   const scenario=process.env.T10_SCENARIO;
   const failed=scenario==='failed'||(scenario==='retry'&&attempt++===0);
   const first=!context.messages.some(m=>m.role==='toolResult');
   const content=failed?[]:scenario==='blocked'&&first?[{type:'toolCall',id:'permission',name:'t10_permission',arguments:{}}]:[{type:'text',text:scenario==='retry'?'T10_RETRY_SUCCESS':'T10_PERMISSION_RECOVERED'}];
   const stopReason=failed?'error':scenario==='blocked'&&first?'toolUse':'stop';
   log({state:'provider',scenario,attempt,stopReason,sidecar:existsSync(process.env.PI_HERDR_SESSION+'.exit')});
   queueMicrotask(()=>{
    const message:any={role:'assistant',api:model.api,provider:model.provider,model:model.id,content,stopReason,...(failed?{errorMessage:scenario==='retry'?'overloaded':'T10 unrecoverable failure'}:{}),timestamp:Date.now(),usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}}};
    stream.push({type:'start',partial:message}); stream.push(failed?{type:'error',reason:'error',error:message}:{type:'done',reason:stopReason as any,message});stream.end();
   });return stream;
  }});
 pi.on('agent_settled',()=>log({state:'settled'}));
}
