// Run inside a running Herdr: node tests/spec43-t2-live.mjs
// Real pi TUI + checkout child.ts. Only the model boundary is deterministic.
// No parent extension, delivery loop, ACK, agent_done call, or test-side close
// runs before the autonomous exit/pane disappearance assertions.
import { spawnSync } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, cpSync, appendFileSync, chmodSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
assert.equal(process.env.HERDR_ENV, '1', 'requires running Herdr');
const restartWorker = process.env.T2_RESTART_WORKER === '1';
const id = randomUUID();
const evidence = join(ROOT, '.agents/evidence/spec43-t2', id);
mkdirSync(evidence, { recursive: true, mode: 0o700 });
const session = join(evidence, 'child.jsonl');
const trace = join(evidence, 'child-trace.jsonl');
const failedWorkerTrace = join(evidence, 'failed-worker.jsonl');
const failBin = join(evidence, 'fail-herdr.mjs');
if (restartWorker) {
 writeFileSync(failBin, `#!${process.execPath}\nimport {appendFileSync} from 'node:fs'; appendFileSync(${JSON.stringify(failedWorkerTrace)}, JSON.stringify({at:Date.now(),workerPid:process.ppid,args:process.argv.slice(2)})+'\\n'); process.exit(1);\n`);
 chmodSync(failBin, 0o700);
}
const runId = `t2-${id}`;
const agentId = `agent-${id}`;
const name = `t2-${id.slice(0, 8)}`;
const final = 'SPEC43_T2_FINAL_BEGIN\n' + Array.from({length: 160}, (_, i) => `retained-result-${i}: complete autonomous result, no parent ACK.`).join('\n') + '\nSPEC43_T2_FINAL_END';
writeFileSync(join(evidence, 'expected-result.txt'), final);
const hash = path => createHash('sha256').update(readFileSync(path)).digest('hex');
let workspace, pane, cleanupStarted = false;
const log = value => appendFileSync(join(evidence, 'transport.jsonl'), JSON.stringify({at: new Date().toISOString(), ...value}) + '\n');
function cli(args) {
 const r = spawnSync('herdr', args, { encoding: 'utf8', timeout: 45000 });
 let decoded;
 try { decoded = JSON.parse(r.stdout.trim().split('\n').at(-1)); } catch { decoded = null; }
 // Shared-server list commands are filtered to this owned workspace only.
 let captured = decoded;
 if (args[1] === 'list' && decoded?.result) {
  captured = {...decoded, result: {...decoded.result}};
  for (const key of ['panes','agents']) if (captured.result[key]) captured.result[key] = captured.result[key].filter(p => p.workspace_id === workspace || p.pane_id === pane);
 }
 log({args, status: r.status, response: captured, stderr: r.stderr, ...(decoded ? {} : {stdout:r.stdout})});
 assert.equal(r.status, 0, `herdr ${args.join(' ')}: ${r.stderr}`);
 assert.ok(decoded && !decoded.error && decoded.ok !== false, JSON.stringify(decoded));
 return decoded.result ?? decoded.data ?? decoded;
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(pred, budget, label) {
 const end = Date.now() + budget;
 while (Date.now() < end) { if (await pred()) return; await sleep(500); }
 throw new Error(`timeout: ${label}`);
}
const alive = pid => { try { process.kill(pid, 0); return true; } catch (e) { if (e.code === 'ESRCH') return false; throw e; } };
const fixture = join(evidence, 'fixture.ts');
writeFileSync(fixture, `// @ts-nocheck -- generated runtime evidence fixture, not production TypeScript.
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai';
import { appendFileSync, readFileSync } from 'node:fs';
import child from ${JSON.stringify(join(ROOT, 'src/child.ts'))};
const trace = ${JSON.stringify(trace)};
const record = (event, extra = {}) => appendFileSync(trace, JSON.stringify({event, at:Date.now(), pid:process.pid, ...extra})+'\\n');
export default function(pi) {
 ${restartWorker ? `process.env.HERDR_BIN_PATH = ${JSON.stringify(failBin)};` : ''}
 record('boot', {env:Object.fromEntries(['PI_HERDR_AGENT_ID','PI_HERDR_RUN_ID','PI_HERDR_SEQUENCE','HERDR_PANE_ID','PI_HERDR_AUTO_EXIT'].map(k=>[k,process.env[k]]))});
 pi.registerProvider('spec43-t2', {api:'spec43-t2-api', baseUrl:'http://localhost.invalid', apiKey:'fixture', models:[{id:'deterministic',name:'T2 deterministic',reasoning:false,input:['text'],cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:128000,maxTokens:8000}],
 streamSimple(model) {
  record('provider');
  const stream = createAssistantMessageEventStream();
  setTimeout(()=>{
   const message = {role:'assistant',api:model.api,provider:model.provider,model:model.id,content:[{type:'text',text:readFileSync(${JSON.stringify(join(evidence,'expected-result.txt'))},'utf8')}],stopReason:'stop',timestamp:Date.now(),usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}}};
   stream.push({type:'start',partial:message}); stream.push({type:'done',reason:'stop',message}); stream.end();
  }, 5000);
  return stream;
 }});
 pi.on('agent_end',()=>record('agent_end'));
 pi.on('agent_settled',()=>record('agent_settled'));
 pi.on('session_shutdown',()=>record('session_shutdown'));
 child(pi);
}
`);
const summary = {id, evidence, runId, agentId, finalBytes:Buffer.byteLength(final), childSource:join(ROOT,'src/child.ts'), childSha256:hash(join(ROOT,'src/child.ts')), recycleSha256:hash(join(ROOT,'src/recycle-worker.mjs')), deliveryPasses:0, ackWrites:0, parentMode:'inert node tracer; delivery module never imported', restartWorker};
try {
 const env = {PI_HERDR_SESSION:session,PI_HERDR_NAME:name,PI_HERDR_AUTO_EXIT:'1',PI_HERDR_AGENT_ID:agentId,PI_HERDR_RUN_ID:runId,PI_HERDR_SEQUENCE:'1',PI_OFFLINE:'1', ...(restartWorker ? {HERDR_BIN_PATH:failBin} : {})};
 const created = cli(['workspace','create','--cwd',evidence,'--label',name,'--no-focus',...Object.entries(env).flatMap(([k,v])=>['--env',`${k}=${v}`])]);
 workspace = created.workspace_id ?? created.workspace?.workspace_id;
 assert.ok(workspace, JSON.stringify(created));
 await until(()=> {const rows=cli(['pane','list']).panes ?? []; pane=rows.find(p=>p.workspace_id===workspace)?.pane_id; return pane;},10000,'workspace shell');
 summary.workspace = workspace; summary.pane = pane;
 await sleep(1500); // Allow the newly created interactive shell to become available.
 // Match the spawn engine's initial-submit watermark: not an ACK.
 writeFileSync(`${session}.steer`, 'Produce the deterministic retained final result.');
 cli(['agent','start',name,'--kind','pi','--pane',pane,'--timeout','30000','--','-ne','-ns','-nc','-np','--no-mcp','--offline','-e',fixture,'--model','spec43-t2/deterministic','--thinking','off','--session',session]);
 cli(['agent','prompt',pane,'Produce the deterministic retained final result.']);
 await until(()=>existsSync(`${session}.completion-${runId}.json`),45000,'completion declaration');
 summary.completionObservedAt = Date.now();
 const declarationPath = `${session}.completion-${runId}.json`;
 const declarationBytes = readFileSync(declarationPath,'utf8');
 const declaration = JSON.parse(declarationBytes);
 assert.ok(!existsSync(`${session}.takeover`), 'initial spawn prompt not misclassified as human takeover');
 assert.equal(declaration.type,'done'); assert.equal(declaration.text,final);
 assert.equal(declaration.eventId,runId); assert.equal(declaration.runId,runId); assert.equal(declaration.agentId,agentId); assert.equal(declaration.sequence,1);
 const entries = readFileSync(trace,'utf8').trim().split('\n').map(JSON.parse);
 const boot = entries.find(e=>e.event==='boot');
 assert.equal(boot.env.HERDR_PANE_ID,pane);
 for(const [k,v] of Object.entries({PI_HERDR_AGENT_ID:agentId,PI_HERDR_RUN_ID:runId,PI_HERDR_SEQUENCE:'1',PI_HERDR_AUTO_EXIT:'1'})) assert.equal(boot.env[k],v);
 summary.childPid = boot.pid;
 await until(()=>!alive(boot.pid),20000,'child process exits without parent delivery');
 summary.childExitObservedAt = Date.now();
 if (restartWorker) {
  await until(()=>existsSync(failedWorkerTrace),10000,'worker transport failure');
  const failed = JSON.parse(readFileSync(failedWorkerTrace,'utf8').trim().split('\n')[0]);
  assert.equal(JSON.parse(readFileSync(`${session}.recycle.json`,'utf8')).pending,true);
  assert.ok((cli(['pane','list']).panes ?? []).some(p=>p.pane_id===pane),'failed worker leaves shell');
  process.kill(failed.workerPid, 'SIGTERM');
  await until(()=>!alive(failed.workerPid),10000,'failed worker stopped');
  summary.failedWorkerPid=failed.workerPid;
  summary.restartStartedAt=Date.now();
  const replay=spawnSync(process.execPath,[join(ROOT,'src/recycle-worker.mjs'),`${session}.recycle.json`,'herdr'],{encoding:'utf8',timeout:30000});
  log({action:'restart-worker',status:replay.status,stdout:replay.stdout,stderr:replay.stderr});
  assert.equal(replay.status,0);
  summary.restartFinishedAt=Date.now();
 }
 await until(()=>!(cli(['pane','list']).panes ?? []).some(p=>p.pane_id===pane),30000,'detached worker removes pane');
 summary.paneGoneObservedAt = Date.now();
 assert.equal(cleanupStarted,false);
 await until(()=>JSON.parse(readFileSync(`${session}.recycle.json`,'utf8')).pending === false,5000,'recycle receipt');
 const intent = JSON.parse(readFileSync(`${session}.recycle.json`,'utf8'));
 assert.equal(intent.paneId,pane); assert.equal(intent.runId,runId); if (!restartWorker) assert.ok(!intent.error,JSON.stringify(intent));
 assert.equal(readFileSync(declarationPath,'utf8'),declarationBytes,'immutable event remains after pane disappears');
 // Recover using a fresh Node process, not in-memory provider state.
 const recovered = spawnSync(process.execPath,['--input-type=module','-e',`import {readFileSync} from 'node:fs'; const d=JSON.parse(readFileSync(process.argv[1],'utf8')); process.stdout.write(d.text);`,declarationPath],{encoding:'utf8'});
 assert.equal(recovered.status,0); assert.equal(recovered.stdout,final);
 writeFileSync(join(evidence,'recovered-result.txt'),recovered.stdout);
 const sessionEntries = readFileSync(session,'utf8').trim().split('\n').map(JSON.parse);
 assert.ok(sessionEntries.some(e=>e.message?.role==='assistant' && e.message.content?.some(c=>c.type==='text' && c.text===final)),'full result also remains in session');
 assert.ok(!readdirSync(evidence).some(f=>/ack/i.test(f)),'no ACK artifacts');
 summary.declarationSha256 = hash(declarationPath); summary.sessionSha256 = hash(session); summary.success = true;
 console.log('PASS: final durable; child exited; pane gone; full result recovered; no delivery/ACK');
} catch(error) {
 summary.success=false; summary.error=error.stack; process.exitCode=1; console.error(error);
 if(pane) try { summary.failurePane = cli(['pane','read',pane]); } catch {}
} finally {
 cleanupStarted=true;
 if(workspace) try {
  const remaining = cli(['workspace','get',workspace]);
  if(remaining) cli(['workspace','close',workspace]);
  summary.cleanup='owned workspace closed after assertions';
 } catch(error) {
  // Herdr removes a workspace automatically when its last pane disappears.
  if(String(error).includes('workspace_not_found')) summary.cleanup='already removed with final pane';
  else {summary.cleanupError=String(error);process.exitCode=1;}
 }
 writeFileSync(join(evidence,'summary.json'),JSON.stringify(summary,null,2));
 const mirror=join('/tmp/spec43-notes/evidence/spec43-t2',id);
 mkdirSync(dirname(mirror),{recursive:true}); cpSync(evidence,mirror,{recursive:true});
 console.log(`Evidence: ${evidence}\nMirror: ${mirror}`);
}
