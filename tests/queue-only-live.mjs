import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,existsSync,realpathSync,cpSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
const root=resolve(import.meta.dirname,'..');
const artifacts=resolve(process.argv[2]??'.agents/evidence/spec43-t4',`run-${Date.now()}`);
mkdirSync(artifacts,{recursive:true});
const scratch=realpathSync(mkdtempSync(join(tmpdir(),'pi-herdr-queue-demo-')));
const token=randomUUID();
writeFileSync(join(scratch,'.owner.json'),JSON.stringify({token,artifacts}));
const env={...process.env};
for(const key of Object.keys(env)) if(key.startsWith('HERDR_')||key==='PI_SESSION_FILE'||key.startsWith('PI_HERDR_')) delete env[key];
const cli=args=>{
 const r=spawnSync('herdr',args,{env,encoding:'utf8',timeout:20000});
 writeFileSync(join(artifacts,'transport.jsonl'),JSON.stringify({at:Date.now(),command:['herdr',...args],exitCode:r.status,stdout:r.stdout,stderr:r.stderr})+'\n',{flag:'a'});
 assert.equal(r.status,0,r.stderr);if(!r.stdout.trim())return {};const v=JSON.parse(r.stdout);assert(!v.error,JSON.stringify(v.error));return v.result;
};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const rows=name=>existsSync(join(scratch,name))?readFileSync(join(scratch,name),'utf8').trim().split('\n').filter(Boolean).map(JSON.parse):[];
const wait=async(test,label,ms=15000)=>{const deadline=Date.now()+ms;while(Date.now()<deadline){if(test())return;await sleep(100);}throw Error(`timeout: ${label}`);};
const streams=()=>rows('receiver-events.jsonl').filter(e=>e.kind==='stream');
const transcript=()=>rows('receiver.jsonl');
let workspace,panes=[];let success=false;
try{
 const created=cli(['workspace','create','--cwd',scratch,'--label',`queue-demo-${token.slice(0,8)}`,'--no-focus']);
 workspace=created.workspace.workspace_id;
 writeFileSync(join(artifacts,'run.json'),JSON.stringify({root,scratch,token,workspace},null,2));
 const receiver=created.root_pane?.pane_id??cli(['pane','list','--workspace',workspace]).panes[0].pane_id;
 panes.push(receiver);
 const senderTab=cli(['tab','create','--workspace',workspace,'--cwd',scratch,'--label','queue-sender','--no-focus']);
 const sender=senderTab.root_pane.pane_id;panes.push(sender);
 assert.equal(senderTab.tab.workspace_id,workspace);
 const versions={node:process.version,herdr:spawnSync('herdr',['--version'],{env,encoding:'utf8'}).stdout,pi:spawnSync('pi',['--version'],{env,encoding:'utf8'}).stdout,sourceSha256:createHash('sha256').update(readFileSync(join(root,'src/index.ts'))).digest('hex')};
 writeFileSync(join(artifacts,'doctor.json'),JSON.stringify(versions,null,2));
 // TUI shells also sanitize inherited session identity before invoking pi.
 const clear="for key in $(env | cut -d= -f1 | grep -E '^(HERDR_|PI_HERDR_|PI_SESSION_FILE$)'); do unset \"$key\"; done";
 for(const [pane,name] of [[receiver,'receiver'],[sender,'sender']]){
  cli(['pane','run',pane,`${clear}; export QUEUE_DEMO_LOG=${JSON.stringify(join(scratch,`${name}-events.jsonl`))} QUEUE_DEMO_TARGET=${JSON.stringify(receiver)} ${name==='sender'?`QUEUE_DEMO_RECEIVER_SESSION=${JSON.stringify(join(scratch,'receiver.jsonl'))}`:''}; printf QUEUE_ENV_CLEARED`]);
  await sleep(500);
  cli(['agent','start',`queue-demo-${name}-${token.slice(0,8)}`,'--kind','pi','--pane',pane,'--timeout','10000','--','-ne','-ns','-e',join(root,'tests/fixtures/turn-probe-entry.ts'),'-e',join(root,'tests/fixtures/queue-only-demo.ts'),'--model','queue-only-demo/deterministic','--thinking','off','--session',join(scratch,`${name}.jsonl`)]);
 }
 cli(['agent','prompt',receiver,'busy-start']);
 await wait(()=>streams().length===1,'receiver started busy tool');
 cli(['agent','prompt',sender,'send:QUEUE_BUSY_PAYLOAD']);
 await wait(()=>rows('sender.jsonl').some(e=>e.message?.toolName==='herdr_send_agent'),'busy send receipt');
 const busyReceipt=rows('sender.jsonl').find(e=>e.message?.toolName==='herdr_send_agent');
 assert(!busyReceipt.message.isError,JSON.stringify(busyReceipt));
 assert(existsSync(join(scratch,'receiver.jsonl.queue-only-inbox.json')),'durable queue sidecar exists');
 cpSync(join(scratch,'receiver.jsonl.queue-only-inbox.json'),join(artifacts,'busy-inbox.json'));
 await wait(()=>transcript().some(e=>e.message?.role==='assistant'&&JSON.stringify(e.message.content).includes('QUEUE_RECEIVER_BUSY_DONE')),'busy tool continued');
 assert(transcript().some(e=>e.message?.toolName==='bash'&&!e.message.isError&&JSON.stringify(e.message.content).includes('QUEUE_BUSY_TOOL_FINISHED')),'busy tool not interrupted');
 assert(!JSON.stringify(streams()).includes('QUEUE_BUSY_PAYLOAD'),'busy send does not steer tool continuation');
 assert.equal(JSON.parse(readFileSync(join(scratch,'receiver.jsonl.queue-only-inbox.json'),'utf8')).messages.length,1,'busy message retained after settle');
 const before=streams().length;await sleep(1200);assert.equal(streams().length,before,'settle does not wake receiver');
 cli(['agent','prompt',sender,'send:QUEUE_IDLE_PAYLOAD']);
 await wait(()=>rows('sender.jsonl').filter(e=>e.message?.toolName==='herdr_send_agent').length===2,'idle send receipt');
 assert(rows('sender.jsonl').filter(e=>e.message?.toolName==='herdr_send_agent').every(e=>!e.message.isError),'both sender tool calls succeeded');
 await sleep(1200);assert.equal(streams().length,before,'idle send causes no model call');
 cpSync(join(scratch,'receiver.jsonl.queue-only-inbox.json'),join(artifacts,'idle-inbox.json'));
 cli(['agent','prompt',receiver,'next-user-turn']);
 await wait(()=>streams().length===before+1,'natural next receiver turn');
 const next=JSON.stringify(streams().at(-1).value);
 assert(next.includes('QUEUE_BUSY_PAYLOAD')&&next.includes('QUEUE_IDLE_PAYLOAD'),'both queue messages visible on natural turn');
 assert.equal(streams().filter(e=>JSON.stringify(e.value).includes('QUEUE_BUSY_PAYLOAD')).length,1,'no premature consume');
 await wait(()=>transcript().some(e=>e.message?.role==='assistant'&&JSON.stringify(e.message.content).includes('QUEUE_RECEIVER_NEXT_TURN_DONE')),'next turn complete');
 assert.equal(JSON.parse(readFileSync(join(scratch,'receiver.jsonl.queue-only-inbox.json'),'utf8')).messages.length,0,'both messages acknowledged after persistence');
 const queueEntries=transcript().filter(e=>e.type==='custom_message'&&e.customType==='herdr-queue-only-messages');
 assert.equal(queueEntries.length,1,'one persisted aggregate custom message');
 const naturalTurn=transcript().findIndex(e=>e.message?.role==='user'&&JSON.stringify(e.message.content).includes('next-user-turn'));
 assert(transcript().findIndex(e=>e.id===queueEntries[0].id)>naturalTurn,'queue persisted only after legitimate user input');
 success=true;
 writeFileSync(join(artifacts,'result.json'),JSON.stringify({exitCode:0,busyToolContinues:true,noIdleModelCall:true,consumedOnNaturalTurn:true,receiverStreamCount:streams().length,boundary:'Real Herdr CLI + pi TUI + checkout extension + installed SDK. Deterministic provider replaces model decisions only.'},null,2));
 console.log(`GREEN QueueOnly busy/idle/next-turn ${artifacts}`);
}catch(error){writeFileSync(join(artifacts,'failure.json'),JSON.stringify({message:error.message,stack:error.stack},null,2));console.error(error);process.exitCode=1;}
finally{
 for(const name of ['receiver.jsonl','sender.jsonl','receiver-events.jsonl','sender-events.jsonl'])if(existsSync(join(scratch,name)))cpSync(join(scratch,name),join(artifacts,name));
 for(const pane of panes)try{writeFileSync(join(artifacts,`terminal-${pane.replace(':','-')}.json`),JSON.stringify(cli(['pane','read',pane,'--source','recent','--lines','120','--format','text']),null,2));}catch{}
 writeFileSync(join(artifacts,'evidence.json'),JSON.stringify({success,artifacts,scratch,workspace,panes},null,2));
 if(workspace){
  assert.deepEqual(JSON.parse(readFileSync(join(scratch,'.owner.json'),'utf8')),{token,artifacts});
  assert(cli(['pane','list','--workspace',workspace]).panes.every(p=>realpathSync(p.cwd)===scratch),'cleanup refuses foreign cwd');
  cli(['workspace','close',workspace]);
  assert(!cli(['workspace','list']).workspaces.some(w=>w.workspace_id===workspace));
 }
 rmSync(scratch,{recursive:true,force:true});
 writeFileSync(join(artifacts,'cleanup.json'),JSON.stringify({workspaceGone:true,scratchGone:!existsSync(scratch),evidenceRetained:true},null,2));
 const dest=join('/tmp/spec43-notes/evidence/spec43-t4',artifacts.split('/').at(-1));mkdirSync(dest,{recursive:true});cpSync(artifacts,dest,{recursive:true});
}
