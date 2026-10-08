import assert from 'node:assert/strict';
import { createJiti } from 'jiti';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const jiti = createJiti(import.meta.url);
const { waitForAgentEvent, createEventAvailability } = await jiti.import('../src/tools/wait.ts');
const dir = mkdtempSync(join(tmpdir(), 'spec43-t6-'));
try {
 const session = join(dir, 'child.jsonl');
 const sidecar = (id, text='SECRET BODY') => { const data=JSON.stringify({type:'done', eventId:id, agentId:'a1', runId:'r1', sequence:1, text}); writeFileSync(`${session}.completion-${id}.json`, data); writeFileSync(`${session}.exit`, data); };
 const registry=()=>new Map([['worker', {name:'worker',agentId:'a1',runId:'r1',sequence:1,sessionPath:session}]]);
 const available = createEventAvailability({ registry, pollMs:2 });
 sidecar('evt-first');
 assert.deepEqual(await waitForAgentEvent({target:'evt-first',timeout:10}, { availability:available }), { ok:true, data:{ status:'available', eventId:'evt-first', agentId:'a1', runId:'r1', sequence:1, target:'worker' } });
 assert.equal(JSON.stringify(await waitForAgentEvent({target:'worker',timeout:2},{availability:available})).includes('SECRET BODY'),false);
 sidecar('evt-later');
 const waiting = waitForAgentEvent({target:'worker',timeout:5000},{availability:available});
 await new Promise(resolve=>setTimeout(resolve,5)); available.notify();
 const result = await waiting;
 assert.equal(result.data.status,'available'); assert.equal(result.data.eventId,'evt-later');
 const cancelled = new AbortController(); const pending=waitForAgentEvent({target:'missing',timeout:5000},{availability:available,signal:cancelled.signal}); cancelled.abort();
 assert.equal((await pending).data.status,'cancelled');
 const timeout = await waitForAgentEvent({target:'missing',timeout:1},{availability:available}); assert.equal(timeout.data.status,'timeout');
 sidecar('evt-multi');
 const w1=waitForAgentEvent({target:'worker',timeout:5000},{availability:available}); const w2=waitForAgentEvent({target:'worker',timeout:5000},{availability:available});
 await new Promise(resolve=>setTimeout(resolve,5)); available.notify(); assert.equal((await w1).data.eventId,'evt-multi'); assert.equal((await w2).data.eventId,'evt-multi');
 console.log('spec43-t6: persistent availability, independent waiters, timeout/cancel without consuming event passed');
} finally { rmSync(dir,{recursive:true,force:true}); }
