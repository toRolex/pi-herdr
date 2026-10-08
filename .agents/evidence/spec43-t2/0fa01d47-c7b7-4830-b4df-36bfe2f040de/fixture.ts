// @ts-nocheck -- generated runtime evidence fixture; annotation added after capture.
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai';
import { appendFileSync, readFileSync } from 'node:fs';
import child from "/Users/rolex/Documents/Codes/githubProject/MyProject/pi-herdr.spec43-t2/src/child.ts";
const trace = "/Users/rolex/Documents/Codes/githubProject/MyProject/pi-herdr.spec43-t2/.agents/evidence/spec43-t2/0fa01d47-c7b7-4830-b4df-36bfe2f040de/child-trace.jsonl";
const record = (event, extra = {}) => appendFileSync(trace, JSON.stringify({event, at:Date.now(), pid:process.pid, ...extra})+'\n');
export default function(pi) {
 record('boot', {env:Object.fromEntries(['PI_HERDR_AGENT_ID','PI_HERDR_RUN_ID','PI_HERDR_SEQUENCE','HERDR_PANE_ID','PI_HERDR_AUTO_EXIT'].map(k=>[k,process.env[k]]))});
 pi.registerProvider('spec43-t2', {api:'spec43-t2-api', baseUrl:'http://localhost.invalid', apiKey:'fixture', models:[{id:'deterministic',name:'T2 deterministic',reasoning:false,input:['text'],cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:128000,maxTokens:8000}],
 streamSimple(model) {
  record('provider');
  const stream = createAssistantMessageEventStream();
  setTimeout(()=>{
   const message = {role:'assistant',api:model.api,provider:model.provider,model:model.id,content:[{type:'text',text:readFileSync("/Users/rolex/Documents/Codes/githubProject/MyProject/pi-herdr.spec43-t2/.agents/evidence/spec43-t2/0fa01d47-c7b7-4830-b4df-36bfe2f040de/expected-result.txt",'utf8')}],stopReason:'stop',timestamp:Date.now(),usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}}};
   stream.push({type:'start',partial:message}); stream.push({type:'done',reason:'stop',message}); stream.end();
  }, 5000);
  return stream;
 }});
 pi.on('agent_end',()=>record('agent_end'));
 pi.on('agent_settled',()=>record('agent_settled'));
 pi.on('session_shutdown',()=>record('session_shutdown'));
 child(pi);
}
