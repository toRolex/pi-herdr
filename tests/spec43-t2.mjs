import assert from 'node:assert/strict';
import {createJiti} from 'jiti';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {chmodSync} from 'node:fs';
import {spawn} from 'node:child_process';
import fs from 'node:fs';
import childProcess from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
// Install forwarding system-boundary hooks before Jiti captures builtin exports.
const nativeIO={openSync:fs.openSync,writeFileSync:fs.writeFileSync,fsyncSync:fs.fsyncSync,linkSync:fs.linkSync,renameSync:fs.renameSync,spawn:childProcess.spawn};
const io={...nativeIO};
fs.openSync=(...args)=>io.openSync(...args);
fs.writeFileSync=(...args)=>io.writeFileSync(...args);
fs.fsyncSync=(...args)=>io.fsyncSync(...args);
fs.linkSync=(...args)=>io.linkSync(...args);
fs.renameSync=(...args)=>io.renameSync(...args);
childProcess.spawn=(...args)=>io.spawn(...args);
syncBuiltinESMExports();
const jiti=createJiti(import.meta.url,{fsCache:false});
const packageFiles=JSON.parse(readFileSync(new URL('../package.json',import.meta.url),'utf8')).files;
assert.ok(packageFiles.includes('src/**/*.mjs'),'published package includes native worker and shared transport');
assert.ok(packageFiles.includes('src/**/*.d.mts'),'published package includes strict TypeScript declarations for the shared transport');
const {registerChildExtension}=await jiti.import('../src/child.ts');
const {deliverOnce}=await jiti.import('../src/delivery.ts');
const {getAgentResult}=await jiti.import('../src/tools/result.ts');
const dir=mkdtempSync(join(tmpdir(),'spec43-t2-'));
const { ensureHerdrVersion, resolveHerdrBin, runHerdrCommand } = await import('../src/herdr-transport.mjs');
const fakeHerdr=join(dir,'herdr-fixture.mjs');
writeFileSync(fakeHerdr,`#!${process.execPath}\nif(process.argv[2]==='--version'){process.stdout.write('herdr '+(process.env.PI_HERDR_TEST_OLD?'0.8.9':'0.9.2')+'\\n');process.exit(0)} const mode=process.argv[2]; if(mode==='nonzero-success'){console.log(JSON.stringify({ok:true,result:{}}));console.error('fixture close diagnostic');process.exit(1)} if(mode==='stderr-error'){console.log(JSON.stringify({ok:true,result:{}}));console.error(JSON.stringify({ok:false,error:{code:'pane_not_found',message:'stderr fixture missing'}}));process.exit(1)} if(mode==='signal-success'){process.stdout.write(JSON.stringify({ok:true,result:{}}));process.kill(process.pid,'SIGTERM')} const error=mode==='failure'; console.log(JSON.stringify(error?{ok:false,error:{code:'pane_not_found',message:'fixture missing'}}:{ok:true,result:{agents:[]}})); process.exit(error?1:0);`);
chmodSync(fakeHerdr,0o700);
const keys=['PI_HERDR_SESSION','PI_HERDR_AGENT_ID','PI_HERDR_RUN_ID','PI_HERDR_SEQUENCE','PI_HERDR_AUTO_EXIT','PI_HERDR_ACTIVITY_FILE','HERDR_PANE_ID'];
const old=keys.map(k=>process.env[k]);
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function runWorkerCase(mode,{ownerMismatch=false,runMismatch=false}={}) {
 const session=join(dir,`worker-${mode}-${Date.now()}.jsonl`);
 const intentPath=`${session}.recycle.json`;
 const trace=join(dir,`worker-${mode}.jsonl`);
 const bin=join(dir,`herdr-${mode}.mjs`);
 writeFileSync(session+'.exit',JSON.stringify({eventId:'event',runId:runMismatch?'different-run':'run',agentId:'agent'}));
 const ownerSession=ownerMismatch?join(dir,'owner-session.jsonl'):undefined;
 if(ownerSession) writeFileSync(ownerSession+'.registry.json',JSON.stringify([{agentId:'agent',runId:'different-run',paneId:'w1:p1'}]));
 writeFileSync(intentPath,JSON.stringify({pending:true,eventId:'event',runId:'run',agentId:'agent',sequence:1,sessionPath:session,paneId:'w1:p1',name:'worker',...(ownerSession?{ownerSession}:{})}));
 writeFileSync(bin,`#!${process.execPath}\nimport {appendFileSync} from 'node:fs'; const mode=${JSON.stringify(mode)}; const args=process.argv.slice(2); appendFileSync(${JSON.stringify(trace)},JSON.stringify(args)+'\\n'); if(args[0]==='--version'){if(mode==='version-failure'){console.error(JSON.stringify({ok:false,error:{code:'herdr_unavailable',message:'version fixture failed'}}));process.exit(1)} console.log('herdr 0.9.3');process.exit(0)} if(args[0]==='agent'){console.log(JSON.stringify(mode==='malformed-list'?{ok:true,result:{agents:null}}:{ok:true,result:{agents:[]}}));process.exit(0)} if(args[0]==='pane'&&args[1]==='list'){console.log(JSON.stringify({ok:true,result:mode==='missing-pane-list'?{}:{panes:mode==='malformed-pane-list'?null:mode==='empty-pane-list'?[]:[{pane_id:'w1:p1'}]}}));process.exit(0)} if(args[0]==='pane'&&args[1]==='close'){if(mode==='close-failure'){console.error(JSON.stringify({ok:false,error:{code:'pane_close_failed',message:'close fixture failed'}}));process.exit(1)} console.log(JSON.stringify({ok:true,result:{}}));if(mode==='close-success-exit-failure'){console.error('fixture close diagnostic');process.exit(1)}process.exit(0)} process.exit(2);`);
 chmodSync(bin,0o700);
 const child=spawn(process.execPath,[join(new URL('../src/recycle-worker.mjs',import.meta.url).pathname),intentPath,bin],{stdio:'ignore'});
 const exited=new Promise(resolve=>child.once('close',resolve));
 const readIntent=()=>JSON.parse(readFileSync(intentPath,'utf8'));
 const wanted=mode==='pane-exists'?'pane-exists':mode==='empty-pane-list'?'empty-pane-list':ownerMismatch?'owner-mismatch':runMismatch?'run-mismatch':'error';
 const end=Date.now()+8000;
 while(Date.now()<end){
  const state=readIntent();
  if((wanted==='error'&&state.pending&&state.error)||(wanted==='owner-mismatch'&&!state.pending&&state.error==='registry ownership changed')||(wanted==='run-mismatch'&&!state.pending&&state.error==='stale close intent refused')||(wanted==='pane-exists'&&!state.pending&&!state.error)||(wanted==='empty-pane-list'&&!state.pending&&!state.error)) break;
  if(child.exitCode!==null) throw new Error(`worker exited before expected receipt for ${mode}: ${JSON.stringify(state)}`);
  await delay(20);
 }
 const state=readIntent();
 child.kill('SIGTERM'); await exited;
 return {state,commands:existsSync(trace)?readFileSync(trace,'utf8').trim().split('\n').filter(Boolean).map(JSON.parse):[]};
}
try {
 const previousHerdrBinPath=process.env.HERDR_BIN_PATH;
 process.env.HERDR_BIN_PATH=fakeHerdr;
 assert.equal(resolveHerdrBin(),fakeHerdr,'worker-specific binary override wins consistently in both entry points');
 previousHerdrBinPath===undefined?delete process.env.HERDR_BIN_PATH:process.env.HERDR_BIN_PATH=previousHerdrBinPath;
 assert.deepEqual(await ensureHerdrVersion(fakeHerdr), { ok: true, data: { major: 0, minor: 9, patch: 2 } });
 process.env.PI_HERDR_TEST_OLD='1';
 const tooOld=await ensureHerdrVersion(fakeHerdr);
 delete process.env.PI_HERDR_TEST_OLD;
 assert.equal(tooOld.ok,false);
 assert.equal(tooOld.error.code,'HERDR_TOO_OLD');
 const transportSuccess=await runHerdrCommand(fakeHerdr,['success']);
 assert.deepEqual(transportSuccess,{ok:true,data:{agents:[]}});
 const transportFailure=await runHerdrCommand(fakeHerdr,['failure']);
 assert.equal(transportFailure.ok,false);
 assert.equal(transportFailure.error.code,'NOT_FOUND');
 assert.equal(transportFailure.error.message,'fixture missing');
 const nonzeroSuccess=await runHerdrCommand(fakeHerdr,['nonzero-success']);
 assert.equal(nonzeroSuccess.ok,false,'success JSON cannot override a failed process exit');
 assert.equal(nonzeroSuccess.error.code,'VALIDATION_ERROR');
 assert.equal(nonzeroSuccess.error.details.exitCode,1);
 assert.match(nonzeroSuccess.error.details.stderr,/fixture close diagnostic/);
 const stderrError=await runHerdrCommand(fakeHerdr,['stderr-error']);
 assert.equal(stderrError.ok,false,'stderr error envelope wins over stdout success on nonzero exit');
 assert.equal(stderrError.error.code,'NOT_FOUND');
 assert.equal(stderrError.error.details.code,'pane_not_found');
 assert.equal(stderrError.error.message,'stderr fixture missing');
 const signalSuccess=await runHerdrCommand(fakeHerdr,['signal-success']);
 assert.equal(signalSuccess.ok,false,'unproven signal exit cannot become success');
 const failedCloseExit=await runWorkerCase('close-success-exit-failure');
 assert.equal(failedCloseExit.state.pending,true,'worker retains close intent when success JSON exits nonzero');
 assert.match(failedCloseExit.state.error,/VALIDATION_ERROR.*fixture close diagnostic/);
 assert.ok(failedCloseExit.commands.some(args=>args[0]==='pane'&&args[1]==='close'));
 const versionFailure=await runWorkerCase('version-failure');
 assert.equal(versionFailure.state.pending,true,'version probe failure stays retryable');
 assert.match(versionFailure.state.error,/VALIDATION_ERROR|HERDR_UNAVAILABLE/);
 const malformedList=await runWorkerCase('malformed-list');
 assert.equal(malformedList.state.pending,true,'non-array agent list is not an empty fleet');
 assert.match(malformedList.state.error,/agents.*array/i);
 for(const mode of ['missing-pane-list','malformed-pane-list']) {
  const invalidPanes=await runWorkerCase(mode);
  assert.equal(invalidPanes.state.pending,true,'missing/invalid pane list is not proof the pane is gone');
  assert.match(invalidPanes.state.error,/panes.*array/i);
  assert.ok(!invalidPanes.commands.some(args=>args[0]==='pane'&&args[1]==='close'));
 }
 const staleRun=await runWorkerCase('run-stale',{runMismatch:true});
 assert.equal(staleRun.state.pending,false);
 assert.equal(staleRun.state.error,'stale close intent refused','stale run cancellation is distinct from command failure');
 assert.deepEqual(staleRun.commands,[],'stale run is rejected before issuing CLI commands');
 const closeFailure=await runWorkerCase('close-failure');
 assert.equal(closeFailure.state.pending,true,'failed close remains retryable');
 assert.ok(closeFailure.commands.some(args=>args[0]==='pane'&&args[1]==='close'),'pane close response is awaited and observed');
 const paneExists=await runWorkerCase('pane-exists');
 assert.equal(paneExists.state.pending,false,'successful pane close clears durable intent');
 assert.ok(paneExists.commands.some(args=>args[0]==='pane'&&args[1]==='close'));
 const emptyPanes=await runWorkerCase('empty-pane-list');
 assert.equal(emptyPanes.state.pending,false,'authoritative empty pane list clears intent');
 assert.ok(!emptyPanes.commands.some(args=>args[0]==='pane'&&args[1]==='close'));
 const staleOwner=await runWorkerCase('owner-stale',{ownerMismatch:true});
 assert.equal(staleOwner.state.pending,false);
 assert.equal(staleOwner.state.error,'registry ownership changed','stale owner cancellation has an explicit reason');
 assert.ok(!staleOwner.commands.some(args=>args[0]==='pane'&&args[1]==='close'));
 const session=join(dir,'child.jsonl');
 Object.assign(process.env,{PI_HERDR_SESSION:session,PI_HERDR_AGENT_ID:'agent',PI_HERDR_RUN_ID:'run',PI_HERDR_SEQUENCE:'1',PI_HERDR_AUTO_EXIT:'1'});
 delete process.env.PI_HERDR_ACTIVITY_FILE;delete process.env.HERDR_PANE_ID;
 writeFileSync(session,'');
 const handlers={},tools=[];let shutdowns=0;
 registerChildExtension({on:(n,h)=>(handlers[n]??=[]).push(h),registerTool:t=>tools.push(t),registerShortcut(){}});
 const emit=async n=>{for(const h of handlers[n]??[])await h({}, {shutdown:()=>shutdowns++});};
 await emit('agent_start');
 const done=tools.find(t=>t.name==='agent_done');
 writeFileSync(session,JSON.stringify({type:'message',message:{role:'assistant',content:[{type:'text',text:'完整结果\nFINAL'}]}})+'\n');
 await done.execute('1',{},undefined,undefined,{shutdown:()=>shutdowns++});
 const eventPath=session+'.completion-run.json';
 const event=readFileSync(eventPath,'utf8');
 await emit('agent_start');
 await done.execute('2',{},undefined,undefined,{shutdown:()=>shutdowns++});
 assert.equal(readFileSync(eventPath,'utf8'),event,'retry never creates another completion event');
 assert.deepEqual(JSON.parse(event).sequence,1);
 const record={name:'child',kind:'pi',agentId:'agent',runId:'run',sequence:1,paneId:'w1:p1',sessionPath:session,stance:'autonomous',submitted:true};
 const recovered=await getAgentResult({target:'run'},{registry:()=>new Map([['child',record]])});
 assert.equal(recovered.data.result,'完整结果\nFINAL','event reference recovers immutable body');
 const bad={...record,delivery:undefined};let closes=0;const pushes=[];
 const deps={registry:()=>new Map([['child',bad]]),fleet:{ok:true,data:[]},load:()=>({notifications:'normal'}),push:p=>pushes.push(p),closePane:async()=>{closes++;return {ok:false,error:{message:'close failed'}}},readSidecar:()=>({state:'ok',sidecar:JSON.parse(event)})};
 await deliverOnce(deps);assert.equal(bad.paneClosePending,true);assert.equal(bad.paneCloseError,'close failed');
 const restored=JSON.parse(JSON.stringify(bad));
 await deliverOnce({...deps,registry:()=>new Map([['child',restored]]),closePane:async()=>{closes++;return {ok:true}}});
 assert.equal(pushes.length,1,'restored retry does not redeliver');assert.equal(restored.paneClosePending,false);
 const stale={...bad,runId:'new-run'};
 await deliverOnce({...deps,registry:()=>new Map([['child',stale]])});assert.equal(closes,2,'stale close cannot close new run');
 const {ParentNotifyStore,parentNotifyPath}=await jiti.import('../src/parent-notify-store.ts');
 const receiver=join(dir,'governance-parent.jsonl');writeFileSync(receiver,'');
 const missing={...record,delivery:undefined};const notices=[];
 const noticeDeps={...deps,sessionPath:receiver,registry:()=>new Map([['child',missing]]),
  readSidecar:()=>({state:'ok',sidecar:{type:'done',eventId:'run'}}),
  push:p=>{notices.push(p);new ParentNotifyStore(receiver).put(p);}};
 await deliverOnce(noticeDeps);
 assert.equal(missing.delivery,undefined);assert.equal(closes,2);assert.equal(notices[0].details.kind,'persistence-error');
 await deliverOnce(noticeDeps);
 assert.equal(notices.length,2,'a saved diagnostic is not evidence of receiver acceptance; retry admission');
 assert.equal(notices[1].details.eventId,notices[0].details.eventId,'retry retains the governance notice identity');
 assert.equal(notices[1].content,notices[0].content);
 const pending=new ParentNotifyStore(receiver).pending();
 assert.equal(pending.length,1,'disk-reopened durable receiver accepts the same notice once');
 assert.equal(pending[0].content,notices[0].content);
 assert.equal(pending[0].details.eventId,notices[0].details.eventId);
 assert.notEqual(pending[0].details.eventId,'run','governance cannot consume the completion identity');
 assert.notEqual(pending[0].details.eventId,pending[0].details.completionEventId,'notice identity stays separate from the referenced completion');
 // Acceptance is not host delivery. Real SDK/SessionManager commitment is verified separately.
 for(const failure of ['acceptance-eio','store-unreadable']) {
  const failedReceiver=join(dir,failure+'-parent.jsonl');writeFileSync(failedReceiver,'');
  const failedRecord={...record,delivery:undefined};const attempts=[];
  if(failure==='store-unreadable')mkdirSync(parentNotifyPath(failedReceiver));
  const retryDeps={...noticeDeps,sessionPath:failedReceiver,registry:()=>new Map([['child',failedRecord]]),push:p=>{
   attempts.push(p);
   if(failure==='acceptance-eio'&&attempts.length===1)throw Object.assign(new Error('injected receiver acceptance EIO'),{code:'EIO'});
   new ParentNotifyStore(failedReceiver).put(p);
  }};
  await assert.rejects(deliverOnce(retryDeps),error=>error.code===(failure==='acceptance-eio'?'EIO':'EISDIR'));
  assert.ok(failedRecord.pushError,'persisted diagnostic survives the rejected acceptance');
  if(failure==='store-unreadable')rmSync(parentNotifyPath(failedReceiver),{recursive:true});
  assert.equal(new ParentNotifyStore(failedReceiver).pending().length,0,'rejected acceptance saved no notice');
  await deliverOnce(retryDeps);await deliverOnce(retryDeps);
  assert.equal(attempts.length,3,'storage recovery retries acceptance despite the same saved diagnostic');
  assert.equal(new Set(attempts.map(p=>p.details.eventId)).size,1);
  const recoveredNotices=new ParentNotifyStore(failedReceiver).pending();
  assert.equal(recoveredNotices.length,1,'recovered receiver durably deduplicates successful retries');
  assert.equal(recoveredNotices[0].content,attempts[0].content);
  assert.equal(recoveredNotices[0].details.eventId,attempts[0].details.eventId);
  assert.equal(failedRecord.delivery,undefined);assert.equal(closes,2);
 }
 // Real extension registration; only filesystem, process and UI boundaries are controlled.
 function completionFixture(name,autoExit=true) {
  const session=join(dir,`${name}.jsonl`);
  writeFileSync(session,'');
  Object.assign(process.env,{PI_HERDR_SESSION:session,PI_HERDR_AGENT_ID:'agent',PI_HERDR_RUN_ID:'run',PI_HERDR_SEQUENCE:'1',PI_HERDR_AUTO_EXIT:autoExit?'1':'0',HERDR_PANE_ID:'offline-pane'});
  const callbacks={},registered=[],notices=[];
  let shutdowns=0;
  const ctx={shutdown:()=>shutdowns++,ui:{notify:(message,level)=>notices.push({message,level})}};
  registerChildExtension({on:(name,handler)=>(callbacks[name]??=[]).push(handler),registerTool:tool=>registered.push(tool),registerShortcut(){}});
  return {session,ctx,notices,get shutdowns(){return shutdowns;},
   emit:async(name,event={})=>{for(const handler of callbacks[name]??[])await handler(event,ctx);},
   done:()=>registered.find(tool=>tool.name==='agent_done').execute('done',{},undefined,undefined,ctx),
   final:()=>writeFileSync(session,JSON.stringify({type:'message',message:{role:'assistant',content:[{type:'text',text:'FULL FINAL RESULT'}]}})+'\n')};
 }
 async function doubleFailure(autoExit) {
  const f=completionFixture(`double-failure-${autoExit}`,autoExit);
  await f.emit('agent_start');f.final();
  await f.emit('agent_end',{messages:[{role:'assistant',stopReason:'stop'}]});
  const originals={...io};
  let eventFailures=0,diagnosticFailures=0,recycles=0;
  io.openSync=(path,...args)=>{
   if(String(path).startsWith(f.session+'.completion-run.json')){eventFailures++;throw new Error('injected completion ENOSPC');}
   return originals.openSync(path,...args);
  };
  io.writeFileSync=(path,...args)=>{
   if(path===f.session+'.exit.run.tmp'){diagnosticFailures++;throw new Error('injected diagnostic EIO');}
   return originals.writeFileSync(path,...args);
  };
  io.spawn=()=>{recycles++;return {on(){},unref(){}};};
  syncBuiltinESMExports();
  try {
   await f.emit('agent_settled');
   if(autoExit) {
    assert.equal(eventFailures,1,'fault reached the actual completion publication');assert.equal(diagnosticFailures,1,'diagnostic publication also failed');
    assert.ok(f.notices.some(n=>n.level==='error'&&/completion.*persist/i.test(n.message)&&/ENOSPC/.test(n.message)), 'autonomous double failure must remain visible even without a diagnostic file');
   } else {
    assert.equal(eventFailures,0,'interactive natural settle must not persist/exit');
    assert.deepEqual(f.notices,[]);
   }
   const result=await f.done();
   assert.equal(result.isError,true,'explicit done reports persistence failure');
   assert.match(result.content[0].text,/not persisted/);
   assert.equal(f.shutdowns,0);assert.equal(recycles,0);
   assert.equal(existsSync(f.session+'.recycle.json'),false);
  } finally {Object.assign(io,originals);}
 }
 await doubleFailure(true);
 await doubleFailure(false);
 async function directoryDurability(failedStage) {
  const f=completionFixture(`directory-sync-${failedStage||'success'}`);
  await f.emit('agent_start');f.final();
  const originals={...io},trace=[];
  let stage,failed=false,recycles=0;
  const eventPath=f.session+'.completion-run.json';
  const classify=path=>path===eventPath?'completion':path===f.session+'.exit'?'legacy':path===f.session+'.recycle.json'?'recycle':undefined;
  io.linkSync=(source,target)=>{
   try {return originals.linkSync(source,target);} finally {stage=classify(target);if(stage)trace.push(`publish:${stage}`);}
  };
  io.renameSync=(source,target)=>{
   const result=originals.renameSync(source,target);stage=classify(target);if(stage)trace.push(`publish:${stage}`);return result;
  };
  io.fsyncSync=fd=>{
   if(fs.fstatSync(fd).isDirectory()) {
    trace.push(`sync:${stage}`);
    if(stage===failedStage&&!failed){failed=true;throw new Error(`injected ${stage} directory fsync EIO`);}
   }
   return originals.fsyncSync(fd);
  };
  io.spawn=()=>{trace.push('recycle-worker');recycles++;return {on(){},unref(){}};};
  try {
   const result=await f.done();
   if(failedStage) {
    assert.equal(failed,true,`${failedStage} must reach directory fsync`);
    assert.equal(result.isError,true,'dirfsync failure must not claim durable success');
    assert.equal(f.shutdowns,0);assert.equal(recycles,0,'unsynced publication must not launch recycle');
    const archived=readFileSync(eventPath,'utf8');
    trace.length=0;
    const retry=await f.done();
    assert.notEqual(retry.isError,true,'same-run completion recovers when fsync recovers');
    assert.deepEqual(trace,['publish:completion','sync:completion','publish:legacy','sync:legacy','publish:recycle','sync:recycle','recycle-worker'],'retry must immediately sync every publication before worker launch');
    assert.equal(readFileSync(eventPath,'utf8'),archived,'retry preserves the already published event and full final');
    const completionFiles=fs.readdirSync(dir).filter(name=>name.startsWith(`directory-sync-${failedStage}.jsonl.completion-`)&&name.endsWith('.json'));
    assert.equal(completionFiles.length,1,'recovery does not mint another completion event');
    assert.equal(f.shutdowns,1);assert.equal(recycles,1);
   } else {
    assert.notEqual(result.isError,true);
    assert.deepEqual(trace,['publish:completion','sync:completion','publish:legacy','sync:legacy','publish:recycle','sync:recycle','recycle-worker'],'all publications must be directory-synced before recycle and completion success');
    assert.equal(f.shutdowns,1);assert.equal(recycles,1);
   }
  } finally {Object.assign(io,originals);}
 }
 // Simulation only: real file/link/rename I/O on Darwin, Windows platform capability.
 async function windowsCapability(settled=false) {
  const platform=Object.getOwnPropertyDescriptor(process,'platform'),originals={...io};
  Object.defineProperty(process,'platform',{...platform,value:'win32'});
  const f=completionFixture(`windows-simulation-${settled}`);
  let fileFlushes=0,recycles=0;
  io.openSync=(path,...args)=>{
   if(String(path)===dir)throw Object.assign(new Error('Windows directory open unsupported'),{code:'EISDIR'});
   return originals.openSync(path,...args);
  };
  io.fsyncSync=fd=>{assert.equal(fs.fstatSync(fd).isDirectory(),false,'Windows branch must not fsync directory descriptors');fileFlushes++;return originals.fsyncSync(fd);};
  io.spawn=()=>{recycles++;return {on(){},unref(){}};};
  try {
   await f.emit('agent_start');f.final();
   if(settled){await f.emit('agent_end',{messages:[{role:'assistant',stopReason:'stop'}]});await f.emit('agent_settled');}
   else assert.notEqual((await f.done()).isError,true,'Windows completion must succeed with file-flushed capability');
   const event=JSON.parse(readFileSync(f.session+'.completion-run.json','utf8'));
   assert.equal(event.persistenceCapability,'file-flushed/process-restart');
   assert.equal(event.text,'FULL FINAL RESULT');
   assert.ok(fileFlushes>=3,'archive, bridge and recycle intent files are flushed');
   assert.equal(f.shutdowns,1);assert.equal(recycles,1);
   const archived=readFileSync(f.session+'.completion-run.json','utf8');
   await f.done();
   assert.equal(readFileSync(f.session+'.completion-run.json','utf8'),archived);
   assert.equal(recycles,1,'retry cannot launch another recycle');
  } finally {Object.assign(io,originals);Object.defineProperty(process,'platform',platform);}
 }
 await windowsCapability();await windowsCapability(true);
 async function actualIOFailure(platformName,operation) {
  const platform=Object.getOwnPropertyDescriptor(process,'platform'),originals={...io};
  Object.defineProperty(process,'platform',{...platform,value:platformName});
  const f=completionFixture(`io-${platformName}-${operation}`);
  let failed=false,recycles=0;
  const fail=()=>{failed=true;throw Object.assign(new Error(`injected ${operation} EIO`),{code:'EIO'});};
  io.writeFileSync=(target,...args)=>{
   if(operation==='write'&&!failed&&typeof target==='number')fail();
   return originals.writeFileSync(target,...args);
  };
  io.fsyncSync=fd=>{
   if(operation==='file-fsync'&&!failed&&!fs.fstatSync(fd).isDirectory())fail();
   return originals.fsyncSync(fd);
  };
  io.linkSync=(source,target)=>{
   if(operation==='link'&&!failed)fail();return originals.linkSync(source,target);
  };
  io.renameSync=(source,target)=>{
   if(operation==='rename'&&!failed&&target===f.session+'.exit')fail();return originals.renameSync(source,target);
  };
  io.spawn=()=>{recycles++;return {on(){},unref(){}};};
  try {
   await f.emit('agent_start');f.final();
   assert.equal((await f.done()).isError,true);
   assert.equal(failed,true);assert.equal(f.shutdowns,0);assert.equal(recycles,0);
   assert.match(JSON.parse(readFileSync(f.session+'.exit','utf8')).errorMessage,/EIO/);
   const eventPath=f.session+'.completion-run.json';
   const archived=existsSync(eventPath)?readFileSync(eventPath,'utf8'):undefined;
   assert.notEqual((await f.done()).isError,true,'recovered I/O permits same-run retry');
   if(archived)assert.equal(readFileSync(eventPath,'utf8'),archived,'EEXIST recovery never replaces the committed body');
   assert.equal(JSON.parse(readFileSync(eventPath,'utf8')).text,'FULL FINAL RESULT');
   assert.equal(f.shutdowns,1);assert.equal(recycles,1);
  } finally {Object.assign(io,originals);Object.defineProperty(process,'platform',platform);}
 }
 for(const platformName of ['darwin','win32'])for(const operation of ['write','file-fsync','link','rename'])await actualIOFailure(platformName,operation);
 await directoryDurability();
 for(const stage of ['completion','legacy','recycle'])await directoryDurability(stage);
 console.log('spec43-t2: stable durable event, recovery, close reload/retry, stale guards, visible failures and directory durability passed');
}finally{Object.assign(fs,{openSync:nativeIO.openSync,writeFileSync:nativeIO.writeFileSync,fsyncSync:nativeIO.fsyncSync,linkSync:nativeIO.linkSync,renameSync:nativeIO.renameSync});childProcess.spawn=nativeIO.spawn;syncBuiltinESMExports();keys.forEach((k,i)=>old[i]===undefined?delete process.env[k]:process.env[k]=old[i]);rmSync(dir,{recursive:true,force:true});}
