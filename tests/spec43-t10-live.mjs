import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, existsSync, cpSync, appendFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createJiti } from 'jiti';
const root=resolve('.'), folder=join(root,'.agents/evidence/spec43-t10',randomUUID()); mkdirSync(folder,{recursive:true});
const clean=Object.fromEntries(Object.entries(process.env).filter(([k])=>!k.startsWith('PI_HERDR_')&&!['HERDR_TAB_ID','HERDR_PANE_ID','HERDR_WORKSPACE_ID','PI_SESSION_FILE'].includes(k)));
const cli=args=>{const r=spawnSync('herdr',args,{env:clean,encoding:'utf8',timeout:30000}); appendFileSync(join(folder,'transport.jsonl'),JSON.stringify({args,status:r.status,stdout:args[0]==='pane'&&args[1]==='list'?JSON.stringify({panes:JSON.parse(r.stdout).result?.panes?.filter(p=>p.cwd?.startsWith(folder))}):r.stdout,stderr:r.stderr})+'\n'); assert.equal(r.status,0);if(!r.stdout.trim()||(args[0]==='pane'&&args[1]==='read'))return r.stdout;const data=JSON.parse(r.stdout);assert.ok(!data.error);return data.result;};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const until=async(check,label)=>{const end=Date.now()+45000;while(Date.now()<end){if(await check())return;await sleep(200);}throw Error(label);};
const jiti=createJiti(import.meta.url); const {waitForAgentEvent,createEventAvailability}=await jiti.import('../src/tools/wait.ts');
const {registerResultTool}=await jiti.import('../src/tools/result.ts');
const summaries=[];
for(const scenario of ['blocked','retry','failed']) {
 const cwd=join(folder,scenario);mkdirSync(join(cwd,'.pi'),{recursive:true});
 writeFileSync(join(cwd,'.pi/settings.json'),JSON.stringify({retry:{enabled:true,maxRetries:2,baseDelayMs:20,maxDelayMs:100}}));
 const session=join(cwd,'child.jsonl'),trace=join(cwd,'trace.jsonl'),run=`t10-${scenario}-${randomUUID()}`;
 const vars={PI_HERDR_SESSION:session,PI_HERDR_AGENT_ID:run,PI_HERDR_RUN_ID:run,PI_HERDR_SEQUENCE:'1',PI_HERDR_NAME:scenario,PI_HERDR_AUTO_EXIT:'1',PI_HERDR_ERROR_EXIT_GRACE_MS:'2000',T10_SCENARIO:scenario,T10_TRACE:trace};
 let workspace,pane;
 try {
  const created=cli(['workspace','create','--cwd',cwd,'--label',run,'--no-focus',...Object.entries(vars).flatMap(([k,v])=>['--env',`${k}=${v}`])]);workspace=created.workspace_id??created.workspace?.workspace_id;
  await until(()=>{pane=cli(['pane','list']).panes.find(p=>p.workspace_id===workspace)?.pane_id;return pane;},'shell');await sleep(800);
  writeFileSync(session+'.steer','Run T10 demo');
  cli(['agent','start',run.slice(0,32),'--kind','pi','--pane',pane,'--timeout','10000','--','-ne','-ns','-e',join(root,'tests/fixtures/spec43-t10-tui.ts'),'--model','t10-demo/deterministic','--thinking','off','--session',session]);
  cli(['agent','prompt',pane,'Run T10 demo']);
  const record={name:scenario,kind:'pi',paneId:pane,sessionPath:session,agentId:run,runId:run,sequence:1};const registry=()=>new Map([[scenario,record]]);
  if(scenario==='blocked') {
   await until(()=>existsSync(trace)&&readFileSync(trace,'utf8').includes('"blocked"'),'permission overlay');
   writeFileSync(join(cwd,'blocked-terminal.json'),JSON.stringify(cli(['pane','read',pane,'--source','recent','--lines','90','--format','text'])));
   assert.equal(existsSync(session+'.exit'),false);
   const wait=await waitForAgentEvent({target:scenario,timeout:3000},{availability:createEventAvailability({registry})});assert.equal(wait.data.kind,'blocked');writeFileSync(join(cwd,'wait.json'),JSON.stringify(wait));
   cli(['pane','send-keys',pane,'Enter']);
  }
  await until(()=>existsSync(session+'.exit'),'durable completion');const event=JSON.parse(readFileSync(session+'.exit','utf8'));
  assert.equal(event.type,scenario==='failed'?'error':'done');assert.equal(event.runId,run);
  if(scenario==='retry') {const rows=readFileSync(trace,'utf8').trim().split('\n').map(JSON.parse);assert.equal(rows.filter(r=>r.state==='provider').length,2);assert.ok(rows.filter(r=>r.state==='provider').every(r=>!r.sidecar));}
  if(scenario==='blocked') assert.ok(readFileSync(trace,'utf8').includes('"answer":"Allow"'));
  const host=join(cwd,'receiver.jsonl');writeFileSync(host,'');let tool;registerResultTool({on(){},registerTool(t){tool=t;}},{registry});
  const result=await tool.execute('result',{target:scenario},undefined,undefined,{sessionManager:{getSessionFile:()=>host}});assert.equal(result.details.status,event.type);assert.equal(result.details.result,event.text);writeFileSync(join(cwd,'result.json'),JSON.stringify(result,null,2));
  summaries.push({scenario,eventType:event.type,stableIdentity:true,realTUI:true,realSDK:true,explicitPermission:scenario==='blocked'?'Allow':undefined,providerOnlyDeterministic:true});
 } finally {if(workspace) {const r=spawnSync('herdr',['workspace','close',workspace],{env:clean,encoding:'utf8'});appendFileSync(join(folder,'cleanup.jsonl'),JSON.stringify({workspace,status:r.status,stdout:r.stdout,stderr:r.stderr})+'\n');}}
}
writeFileSync(join(folder,'summary.json'),JSON.stringify(summaries,null,2));cpSync(folder,folder.replace(join(root,'.agents/evidence'),'/tmp/spec43-notes/evidence'),{recursive:true});console.log('T10 REAL SDK/TUI blocked → explicit Allow → recovered; retry success; stable terminal failure PASS',folder);
