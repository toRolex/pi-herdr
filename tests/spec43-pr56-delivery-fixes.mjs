import assert from 'node:assert/strict';
import { createJiti } from 'jiti';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// No inherited real pane, CLI override, or model provider identity.
for (const key of Object.keys(process.env)) if (/^(HERDR|PI_HERDR)/.test(key)) delete process.env[key];
process.env.PI_OFFLINE = '1';
const jiti = createJiti(import.meta.url);
const imp = p => jiti.import(new URL('../' + p, import.meta.url).pathname);
const sp = await imp('src/spawn.ts');
const { deliverOnce, stopDeliveryLoop } = await imp('src/delivery.ts');
const { getAgentResult } = await imp('src/tools/result.ts');
const { DeliveryLedger } = await imp('src/delivery-ledger.ts');
const root = mkdtempSync(join(tmpdir(), 'spec43-pr56-delivery-fixes-'));
process.env.PI_CODING_AGENT_DIR = join(root, 'pi-agent');
const fakeHerdr = join(root, 'fake-herdr.cjs');
writeFileSync(fakeHerdr, '#!/usr/bin/env node\nprocess.stderr.write("unexpected offline Herdr call: "+JSON.stringify(process.argv.slice(2)));process.exit(90);\n', { mode: 0o700 });
process.env.HERDR_BIN_PATH = fakeHerdr;
const selected = process.argv[2];
const cases = [];
async function check(name, fn) {
 if (selected && selected !== name) return;
 await fn(); cases.push(name); console.log('PASS', name);
}
const statusDone = async () => ({ ok: true, data: 'done' });
const noClose = async () => { throw new Error('an identity held for review may not authorize pane close'); };
function record(name, over = {}) {
 const sessionPath = join(root, name + '.jsonl'); writeFileSync(sessionPath, '');
 return { name, kind: 'pi', agentId: 'agent-' + name, runId: 'run-' + name, sequence: 1,
  sessionPath, paneId: 'fake-' + name, stance: 'autonomous', submitted: true, ...over };
}
function deps(rec, push, host) {
 return { registry: () => new Map([[rec.name, rec]]), fleet: { ok: true, data: [] },
  load: () => ({ notifications: 'normal' }), sessionPath: host, push, closePane: noClose };
}
try {
 await check('SP1', async () => {
  const host = join(root, 'legacy-host.jsonl'); writeFileSync(host, '');
  const legacy = record('legacy', { agentId: undefined, runId: undefined, sequence: undefined });
  writeFileSync(host + '.registry.json', JSON.stringify([legacy]));
  const eventId = 'legacy-event';
  const old = { type: 'done', eventId, text: 'UNVERIFIED LEGACY FINAL' };
  writeFileSync(legacy.sessionPath + '.exit', JSON.stringify(old));
  writeFileSync(legacy.sessionPath + '.completion-' + eventId + '.json', JSON.stringify(old));
  sp.restoreSpawnRegistry(host, { autodrain: false });
  const restored = sp.spawnRecords().get('legacy');
  assert.equal(restored.identityReviewRequired, true);
  const pushes = [];
  await deliverOnce(deps(restored, m => pushes.push(m), host));
  assert.equal(pushes.some(m => m.content.includes(old.text)), false, 'no new legacy Push body');
  assert.equal(restored.delivery, undefined, 'review does not invent terminal delivery');
  for (const target of ['legacy', eventId]) {
   const result = await getAgentResult({ target }, { hostFile: host, toolCallId: 'legacy-' + target,
    registry: () => sp.spawnRecords(), status: statusDone });
   assert.equal(result.ok, true);
   assert.equal(result.data.result, undefined, 'no new legacy Pull body, including retained event address');
   assert.match(result.data.note, /identity.*review/i);
  }
  assert.equal(new DeliveryLedger(host).reconcile(eventId), undefined, 'review may not create a completion claim');
  // Pre-existing unknown acceptance remains pending, not replayable.
  new DeliveryLedger(host).migratePending({ eventId, sessionPath: legacy.sessionPath }, 'legacy-token');
  const pending = await getAgentResult({ target: 'legacy' }, { hostFile: host, toolCallId: 'legacy-pending', registry: () => sp.spawnRecords() });
  assert.equal(pending.data.result, undefined); assert.equal(pending.data.delivery.status, 'pending');
  // Old durable host receipt repairs status only; no body may be reclaimed.
  writeFileSync(host, JSON.stringify({ type: 'custom_message', customType: 'herdr-delivery', content: old.text, details: { eventId } }) + '\n');
  const delivered = await getAgentResult({ target: eventId }, { hostFile: host, toolCallId: 'legacy-receipt', registry: () => sp.spawnRecords() });
  assert.equal(delivered.data.result, undefined); assert.equal(delivered.data.delivery.status, 'delivered');
  sp.clearSpawnRegistry();
 });
 await check('RETAINED-IDENTITY', async () => {
  const host = join(root, 'retained-host.jsonl'); writeFileSync(host, '');
  const rec = record('retained', { runId: 'current-run', sequence: 9 });
  const reg = () => new Map([[rec.name, rec]]);
  const good = { type: 'done', eventId: 'historical', runId: 'historical', agentId: rec.agentId, sequence: 2, text: 'HISTORICAL FINAL' };
  const archive = rec.sessionPath + '.completion-historical.json';
  for (const invalid of [{ runId: undefined }, { runId: 'other-run' }, { sequence: undefined }, { sequence: -1 }, { sequence: 0 }, { text: '', structured: '{malformed' }]) {
   writeFileSync(archive, JSON.stringify({ ...good, ...invalid }));
   for (const explicit of [{}, { reread: true }, { ack: { hostFile: host, eventId: 'historical', agentId: rec.agentId, runId: 'historical', sequence: 2 } }]) {
    const result = await getAgentResult({ target: 'historical', ...explicit }, { hostFile: host, toolCallId: 'invalid-retained', registry: reg });
    assert.equal(result.data?.result, undefined, 'invalid retained identity/body cannot be consumed or reread');
    assert.equal(result.data?.acknowledged, undefined);
    assert.equal(new DeliveryLedger(host).reconcile('historical'), undefined, 'invalid retained archive must not claim/ACK');
   }
  }
  for (const payload of [good, { ...good, text: '', structured: '{"answer":"valid"}' }, { ...good, structured: '{ignored invalid JSON' }]) {
   writeFileSync(archive, JSON.stringify(payload));
   const reread = await getAgentResult({ target: 'historical', reread: true }, { hostFile: host, toolCallId: 'valid-reread', registry: reg });
   assert.equal(reread.ok, true); assert.equal(reread.data.result, payload.text || payload.structured);
  }
  writeFileSync(archive, JSON.stringify(good));
  const valid = await getAgentResult({ target: 'historical' }, { hostFile: host, toolCallId: 'valid-retained', registry: reg });
  assert.equal(valid.data.result, 'HISTORICAL FINAL'); assert.equal(valid.data.sequence, 2);
 });
 await check('SP3', async () => {
  const { createEventAvailability } = await imp('src/tools/wait.ts');
  for (const policy of ['normal', 'quiet', 'none']) {
   const host = join(root, 'failed-host-' + policy + '.jsonl'); writeFileSync(host, '');
   const failed = record('failed-' + policy, { paneId: undefined, startError: 'deterministic launch rejection' });
   const pushes = [];
   await deliverOnce({ ...deps(failed, m => pushes.push(m), host), load: () => ({ notifications: policy }) });
   const found = await createEventAvailability({ registry: () => new Map([[failed.name, failed]]), status: statusDone }).wait({ target: failed.name, timeout: 0 });
   assert.equal(found.status, 'available', 'accepted start failure is a waitable terminal event');
   assert.equal(found.agentId, failed.agentId); assert.equal(found.runId, failed.runId); assert.equal(found.sequence, 1);
   assert.equal(JSON.stringify(found).includes(failed.startError), false, 'wait has no body');
   if (policy !== 'none') {
    assert.equal(pushes.length, 1); assert.equal(pushes[0].details.kind, 'error');
    assert.equal(pushes[0].details.eventId, found.eventId);
   }
   const reg = () => new Map([[failed.name, { ...failed }]]);
   const first = await getAgentResult({ target: failed.name }, { hostFile: host, toolCallId: 'failed-pull', registry: reg });
   assert.equal(first.ok, true); assert.equal(first.data.status, 'error');
   assert.equal(first.data.eventId, found.eventId); assert.match(first.data.result, /launch rejection/);
   writeFileSync(host, JSON.stringify({ type: 'message', message: { role: 'toolResult', toolCallId: 'failed-pull', details: first.data } }) + '\n');
   const again = await getAgentResult({ target: found.eventId }, { hostFile: host, toolCallId: 'failed-again', registry: reg });
   assert.equal(again.data.result, undefined); assert.equal(again.data.delivery.status, 'delivered');
   const acknowledged = await getAgentResult({ target: found.eventId, ack: { hostFile: host, eventId: found.eventId, agentId: failed.agentId, runId: failed.runId, sequence: 1 } },
    { hostFile: host, toolCallId: 'failed-ack', registry: reg });
   assert.equal(acknowledged.ok, true); assert.equal(acknowledged.data.acknowledged, true);
   assert.equal(acknowledged.data.result, undefined);
  }
 });
 await check('SP3-detached', async () => {
  const { spawnFromTool } = await imp('src/tools/agents.ts');
  const { DEFAULT_SETTINGS } = await imp('src/settings.ts');
  const { createEventAvailability } = await imp('src/tools/wait.ts');
  for (const mode of ['result', 'rejection']) {
   sp.clearSpawnRegistry();
   const host = join(root, 'detached-' + mode + '.jsonl'); writeFileSync(host, '');
   let release; const gate = new Promise(resolve => { release = resolve; });
   const options = { env: {}, parentSession: host, autodrain: false,
    load: () => ({ ...DEFAULT_SETTINGS, layout_mode: 'spiral' }),
    kinds: async () => ['pi'], fleet: async () => ({ ok: true, data: [] }), list: async () => [], paneList: async () => [],
    worktree: async () => { await gate; if (mode === 'rejection') throw new Error('definite prelaunch rejection');
     return { ok: false, error: { code: 'AGENT_START_FAILED', message: 'definite prelaunch result failure' } }; },
    start: async () => { throw new Error('must not launch'); } };
   const accepted = await spawnFromTool({ name: 'detached-' + mode, agent: { kind: 'pi' }, prompt: 'task', isolated: true }, options);
   assert.equal(accepted.ok, true, JSON.stringify(accepted)); assert.equal(accepted.data.status, 'starting');
   release();
   const rec = sp.spawnRecords().get(accepted.data.name);
   for (let i = 0; i < 100 && !rec.startError; i++) await new Promise(resolve => setTimeout(resolve, 5));
   assert.match(rec.startError, /definite prelaunch/);
   assert.ok(rec.sessionPath, 'detached definitive failure seeds durable acceptance without a tick');
   const archive = JSON.parse(readFileSync(rec.sessionPath + '.completion-' + accepted.data.runId + '.json', 'utf8'));
   assert.equal(archive.runId, accepted.data.runId); assert.equal(archive.stopReason, 'start-error');
   assert.equal(sp.readPersistedRegistry(host).find(row => row.name === rec.name).sessionPath, rec.sessionPath);
   const found = await createEventAvailability().wait({ target: rec.name, timeout: 0 });
   assert.equal(found.status, 'available'); assert.equal(found.eventId, accepted.data.runId);
   assert.equal(rec.submitted, false); assert.equal(rec.startedAt, undefined);
  }
  sp.clearSpawnRegistry();
 });
 await check('SP3-followup-FIFO', async () => {
  const { triggerTurn } = await imp('src/tools/lifecycle.ts');
  const { DEFAULT_SETTINGS } = await imp('src/settings.ts');
  const { createEventAvailability } = await imp('src/tools/wait.ts');
  sp.clearSpawnRegistry();
  const host = join(root, 'fifo-host.jsonl'); writeFileSync(host, '');
  const rec = record('fifo', { prompt: 'old', agentArgs: [], depth: 1, isolated: true, spawnedAt: 1,
   startedAt: 2, startBeganAt: 1, lineage: { ownerSession: host, rootSession: host } });
  const oldEvent = { type: 'done', agentId: rec.agentId, runId: rec.runId, sequence: 1, eventId: rec.runId, text: 'OLD FINAL' };
  const oldBytes = JSON.stringify(oldEvent);
  writeFileSync(rec.sessionPath + '.completion-' + rec.runId + '.json', oldBytes);
  writeFileSync(rec.sessionPath + '.exit', oldBytes);
  sp.putSpawnRecordForTests(rec);
  let live = [{ paneId: rec.paneId, agentStatus: 'working' }], attempts = 0;
  const options = { env: {}, autodrain: false, parentSession: host,
   load: () => ({ ...DEFAULT_SETTINGS, layout_mode: 'spiral', max_parallel_agents: 1 }),
   kinds: async () => ['pi'], list: async () => live, fleet: async () => ({ ok: true, data: live }), paneList: async () => [],
   worktree: async () => { attempts++; return { ok: false, error: { code: 'AGENT_START_FAILED', message: 'accepted FIFO launch failed' } }; },
   start: async () => { throw new Error('worktree must fail first'); } };
  const first = await triggerTurn({ target: rec.name, text: 'first' }, options);
  const second = await triggerTurn({ target: rec.name, text: 'second' }, options);
  assert.equal(first.ok, true); assert.equal(second.ok, true);
  assert.equal(first.data.status, 'queued'); assert.equal(second.data.status, 'queued');
  live = []; rec.delivery = { kind: 'done', at: 3 };
  await sp.drainQueueOnce(options);
  assert.equal(rec.runId, first.data.runId, 'early worktree failure belongs to accepted head, not preceding run');
  assert.equal(rec.pendingRunId, undefined);
  assert.deepEqual(rec.pendingFollowups.map(row => row.runId), [second.data.runId]);
  assert.equal(readFileSync(rec.sessionPath + '.exit', 'utf8'), oldBytes, 'early failure preserves another run bridge');
  const failurePath = rec.sessionPath + '.completion-' + first.data.runId + '.json';
  const failedBytes = readFileSync(failurePath, 'utf8');
  const found = await createEventAvailability().wait({ target: rec.name, timeout: 0 });
  assert.equal(found.status, 'available'); assert.equal(found.eventId, first.data.runId);
  sp.restoreSpawnRegistry(host, { autodrain: false });
  const resumed = sp.spawnRecords().get(rec.name), launches = [];
  const good = { ...options, worktree: async () => { attempts++; return { ok: true, data: root }; },
   childExtension: new URL('../src/child.ts', import.meta.url).pathname,
   start: async () => { launches.push(resumed.runId); return { ok: true, data: { agent: { pane_id: 'fake-next' } } }; },
   boot: async () => ({ ok: true, data: true }), submit: async () => ({ ok: true, data: true }),
   readEditor: async () => ({ ok: true, data: { status: 'working', text: '' } }), status: async () => ({ ok: true, data: 'working' }) };
  await sp.drainQueueOnce(good);
  assert.deepEqual(launches, [second.data.runId], 'second drain starts only the already accepted next run');
  assert.equal(attempts, 2, 'failed head was attempted once, next accepted run once');
  assert.equal(resumed.pendingFollowups.length, 0);
  assert.equal(readFileSync(failurePath, 'utf8'), failedBytes);
  await sp.drainQueueOnce(good); assert.equal(attempts, 2, 'empty queue must not restart failed or successful runs');
  const historical = await createEventAvailability().wait({ target: first.data.runId, timeout: 0 });
  assert.equal(historical.status, 'available'); assert.equal(historical.runId, first.data.runId);
  sp.clearSpawnRegistry();
 });
 await check('SP3-wait-restoration', async () => {
  const { createEventAvailability } = await imp('src/tools/wait.ts');
  const host = join(root, 'wait-restore-host.jsonl'); writeFileSync(host, '');
  const failed = record('wait-restore', { sessionPath: undefined, paneId: undefined, submitted: false,
   startError: 'persisted accepted prelaunch failure', spawnedAt: 123, cwd: root,
   lineage: { ownerSession: host, rootSession: host } });
  sp.writePersistedRegistry(host, [failed]); sp.restoreSpawnRegistry(host, { autodrain: false });
  const found = await createEventAvailability().wait({ target: failed.name, timeout: 0 });
  assert.equal(found.status, 'available', 'old accepted startError restores without tick or Pull');
  const restored = sp.spawnRecords().get(failed.name);
  assert.equal(found.eventId, restored.runId); assert.equal(found.result, undefined);
  assert.equal(sp.readPersistedRegistry(host)[0].sessionPath, restored.sessionPath);
  const archive = restored.sessionPath + '.completion-' + restored.runId + '.json';
  const bytes = readFileSync(archive, 'utf8');
  const other = JSON.stringify({ type: 'done', agentId: restored.agentId, runId: 'other-run', sequence: 1, eventId: 'other-run', text: 'OTHER BODY' });
  writeFileSync(restored.sessionPath + '.exit', other);
  assert.equal((await createEventAvailability().wait({ target: restored.runId, timeout: 0 })).status, 'available');
  assert.equal(readFileSync(restored.sessionPath + '.exit', 'utf8'), other);
  assert.equal(readFileSync(archive, 'utf8'), bytes);
  sp.clearSpawnRegistry();
 });
 await check('SP3-wait-identity', async () => {
  const { createEventAvailability } = await imp('src/tools/wait.ts');
  const rec = record('wait-identity', { paneId: undefined });
  const reg = () => new Map([[rec.name, rec]]);
  const availability = createEventAvailability({ registry: reg });
  const valid = { type: 'done', agentId: rec.agentId, runId: rec.runId, sequence: 1, eventId: rec.runId, text: 'FINAL BODY' };
  const path = rec.sessionPath + '.completion-' + rec.runId + '.json';
  for (const invalid of [{ ...valid, eventId: 'wrong' }, { ...valid, agentId: 'another-agent' }, { ...valid, sequence: 2 },
   { ...valid, text: '' }, { type: 'persistence-error', eventId: rec.runId, errorMessage: 'governance' }]) {
   writeFileSync(path, JSON.stringify(invalid));
   assert.equal((await availability.wait({ target: rec.name, timeout: 0 })).status, 'timeout');
  }
  writeFileSync(path, JSON.stringify(valid)); writeFileSync(rec.sessionPath + '.exit', 'invalid bridge');
  assert.equal((await availability.wait({ target: rec.name, timeout: 0 })).status, 'available');
  rec.identityReviewRequired = true;
  assert.equal((await availability.wait({ target: rec.name, timeout: 0 })).status, 'timeout');
  rec.identityReviewRequired = false;
  const old = { ...valid, runId: 'historical', eventId: 'historical', sequence: 7 };
  writeFileSync(rec.sessionPath + '.completion-historical.json', JSON.stringify(old));
  assert.equal((await availability.wait({ target: 'historical', timeout: 0 })).sequence, 7);
  writeFileSync(rec.sessionPath + '.completion-historical.json', JSON.stringify({ ...old, agentId: 'another-agent' }));
  assert.equal((await availability.wait({ target: 'historical', timeout: 0 })).status, 'timeout');
  writeFileSync(rec.sessionPath + '.completion-historical.json', JSON.stringify({ ...old, runId: 'different-run' }));
  assert.equal((await availability.wait({ target: 'historical', timeout: 0 })).status, 'timeout', 'retained eventId/runId must be self-consistent');
 });
 await check('SP3-unknown-start', async () => {
  const { spawnFromTool } = await imp('src/tools/agents.ts');
  const { DEFAULT_SETTINGS } = await imp('src/settings.ts');
  for (const mode of ['create-rejection', 'create-result', 'submit-rejection', 'boot-result']) {
   sp.clearSpawnRegistry();
   const host = join(root, 'unknown-' + mode + '.jsonl'); writeFileSync(host, '');
   let ready; const gate = new Promise(resolve => { ready = resolve; });
   const options = { env: {}, autodrain: false, parentSession: host,
    load: () => ({ ...DEFAULT_SETTINGS, layout_mode: 'spiral' }), kinds: async () => ['pi'],
    fleet: async () => ({ ok: true, data: [] }), list: async () => [], paneList: async () => [],
    start: async () => { await gate; if (mode === 'create-rejection') throw new Error('create acknowledgement lost');
     if (mode === 'create-result') return { ok: false, error: { code: 'AGENT_START_FAILED', message: 'launcher may have created before failure' } };
     return { ok: true, data: { agent: { pane_id: 'fake-unknown' } } }; },
    boot: async () => mode === 'boot-result' ? { ok: false, error: { code: 'TIMEOUT', message: 'executor boot unknown' } } : { ok: true, data: true },
    submit: async () => { throw new Error('submission acknowledgement lost'); } };
   const accepted = await spawnFromTool({ name: 'unknown-' + mode, agent: { kind: 'pi' }, prompt: 'task' }, options);
   assert.equal(accepted.ok, true); ready();
   const rec = sp.spawnRecords().get(accepted.data.name);
   for (let i = 0; i < 1600 && !rec.pushError && !rec.startError; i++) await new Promise(resolve => setTimeout(resolve, 5));
   assert.equal(rec.startError, undefined, 'unknown executor outcome must not be declared never-started');
   assert.match(rec.pushError, /outcome unknown/);
   assert.equal(existsSync(rec.sessionPath + '.completion-' + rec.runId + '.json'), false);
  }
  sp.clearSpawnRegistry();
 });
 await check('SP3-storage-no-relaunch', async () => {
  const { spawnFromTool } = await imp('src/tools/agents.ts');
  const { DEFAULT_SETTINGS } = await imp('src/settings.ts');
  const { createEventAvailability } = await imp('src/tools/wait.ts');
  sp.clearSpawnRegistry();
  const host = join(root, 'storage-no-relaunch.jsonl'); writeFileSync(host, '');
  const blocker = record('storage-blocker'); sp.putSpawnRecordForTests(blocker);
  let live = [{ paneId: blocker.paneId, agentStatus: 'working' }], attempts = 0;
  const options = { env: {}, autodrain: false, parentSession: host,
   load: () => ({ ...DEFAULT_SETTINGS, layout_mode: 'spiral', max_parallel_agents: 1 }), kinds: async () => ['pi'],
   fleet: async () => ({ ok: true, data: live }), list: async () => live, paneList: async () => [],
   worktree: async () => { attempts++; return { ok: false, error: { code: 'AGENT_START_FAILED', message: 'storage launch rejected' } }; } };
  const accepted = await spawnFromTool({ name: 'storage-failure', agent: { kind: 'pi' }, prompt: 'task', isolated: true }, options);
  assert.equal(accepted.ok, true); assert.equal(accepted.data.status, 'queued');
  const rec = sp.spawnRecords().get(accepted.data.name);
  const blockedDir = join(root, 'seed-storage-blocked'); writeFileSync(blockedDir, 'ENOTDIR');
  process.env.PI_CODING_AGENT_DIR = blockedDir; live = [];
  await sp.drainQueueOnce(options);
  assert.match(rec.startError, /storage launch rejected/); assert.ok(rec.startFailurePersistenceError);
  await sp.drainQueueOnce(options); assert.equal(attempts, 1, 'failed launch is not a storage retry');
  rmSync(blockedDir); mkdirSync(blockedDir);
  await sp.drainQueueOnce(options);
  assert.equal(rec.startFailurePersistenceError, undefined, 'drain retries persistence, not execution');
  assert.equal(attempts, 1); assert.ok(rec.sessionPath);
  assert.equal((await createEventAvailability().wait({ target: rec.name, timeout: 0 })).status, 'available');
  // A committed archive cannot mask an unpublishable receiver registry.
  const registryPath = sp.registryPathFor(host); rmSync(registryPath); mkdirSync(registryPath);
  rec.startFailurePersistenceError = 'previous registry write failure';
  const unavailable = await createEventAvailability().wait({ target: rec.name, timeout: 0 });
  assert.equal(unavailable.status, 'timeout'); assert.ok(rec.startFailurePersistenceError);
  rmSync(registryPath, { recursive: true });
  await sp.drainQueueOnce(options); // The trusted explicit receiver republishes the missing registry; a bare lineage string cannot.
  assert.equal((await createEventAvailability().wait({ target: rec.name, timeout: 0 })).status, 'available');
  assert.equal(attempts, 1);
  process.env.PI_CODING_AGENT_DIR = join(root, 'pi-agent'); sp.clearSpawnRegistry();
 });
 await check('SP3-unknown-FIFO-reconciliation', async () => {
  const { triggerTurn } = await imp('src/tools/lifecycle.ts');
  const { DEFAULT_SETTINGS } = await imp('src/settings.ts');
  for (const mode of ['submit', 'grid-post']) {
  sp.clearSpawnRegistry();
  const host = join(root, 'unknown-fifo-host-' + mode + '.jsonl'); writeFileSync(host, '');
  const rec = record('unknown-fifo-' + mode, { prompt: 'old', agentArgs: [], depth: 1, isolated: false, spawnedAt: 1,
   startedAt: 2, startBeganAt: 1, lineage: { ownerSession: host, rootSession: host } });
  sp.putSpawnRecordForTests(rec);
  let live = [{ paneId: rec.paneId, agentStatus: 'working' }], starts = 0;
  if (mode === 'grid-post') sp.putSpawnRecordForTests(record('grid-below', { paneId: 'fake-below', gridTab: 'fake-tab', gridAt: { row: 2, col: 2 } }));
  const options = { env: {}, autodrain: false, parentSession: host,
   load: () => ({ ...DEFAULT_SETTINGS, layout_mode: mode === 'grid-post' ? 'grid' : 'spiral', max_parallel_agents: 3 }),
   herdr: async args => {
    if (args[0] === 'pane' && args[1] === 'current') return { ok: true, data: { pane: { pane_id: 'fake-main', tab_id: 'fake-tab' } } };
    if (args[0] === 'pane' && args[1] === 'list') return { ok: true, data: { panes: [{ pane_id: 'fake-main', tab_id: 'fake-tab' }, { pane_id: 'fake-below', tab_id: 'fake-tab' }] } };
    if (args[0] === 'pane' && args[1] === 'swap') return { ok: false, error: { code: 'AGENT_START_FAILED', message: 'grid post-create outcome unknown' } };
    throw new Error('unexpected fake grid command: ' + JSON.stringify(args));
   },
   kinds: async () => ['pi'], list: async () => live, fleet: async () => ({ ok: true, data: live }), paneList: async () => [],
   start: async () => { starts++; return { ok: true, data: { agent: { pane_id: 'fake-unknown-fifo' } } }; },
   boot: async () => ({ ok: true, data: true }), submit: async () => { throw new Error('prompt submission outcome unknown'); } };
  const first = await triggerTurn({ target: rec.name, text: 'first' }, options);
  const second = await triggerTurn({ target: rec.name, text: 'second' }, options);
  assert.equal(first.ok, true); assert.equal(second.ok, true);
  live = []; rec.delivery = { kind: 'done', at: 3 };
  await sp.drainQueueOnce(options);
  assert.equal(rec.runId, first.data.runId); assert.equal(rec.startError, undefined);
  assert.match(rec.startOutcomeUnknown, /(?:submission|post-create) outcome unknown/);
  if (mode === 'grid-post') { assert.equal(rec.startedAt, undefined); assert.ok(rec.startBeganAt); assert.equal(rec.paneId, 'fake-unknown-fifo'); }
  await sp.drainQueueOnce(options); assert.equal(starts, 1, 'unknown run cannot be replayed');
  const completed = { type: 'done', agentId: rec.agentId, runId: rec.runId, eventId: rec.runId, sequence: 1, text: 'ACTUAL UNKNOWN RUN COMPLETED' };
  const eventPath = rec.sessionPath + '.completion-' + rec.runId + '.json';
  const bytes = JSON.stringify(completed);
  // A bad archive cannot reconcile unknown execution, even if a stale delivery marker exists.
  writeFileSync(eventPath, JSON.stringify({ ...completed, agentId: 'wrong-agent' }));
  rec.delivery = { kind: 'done', at: 4 }; rec.paneId = undefined;
  await sp.drainQueueOnce(options); assert.equal(starts, 1);
  writeFileSync(eventPath, JSON.stringify({ ...completed, text: undefined, structured: '{malformed JSON' }));
  await sp.drainQueueOnce(options);
  assert.ok(rec.startOutcomeUnknown, 'malformed structured without text cannot reconcile unknown execution');
  assert.equal(rec.pendingFollowups[0].runId, first.data.runId);
  rec.delivery = undefined; rec.paneId = 'fake-unknown-fifo';
  writeFileSync(eventPath, bytes); writeFileSync(rec.sessionPath + '.exit', bytes);
  live = [{ paneId: rec.paneId, agentStatus: 'idle' }];
  await deliverOnce({ fleet: { ok: true, data: live }, load: () => ({ notifications: 'none' }),
   sessionPath: host, closePane: async () => ({ ok: true }) });
  live = [];
  await deliverOnce({ fleet: { ok: true, data: live }, load: () => ({ notifications: 'none' }),
   sessionPath: host, closePane: async () => ({ ok: true }) });
  assert.equal(rec.delivery.kind, 'done'); assert.equal(rec.paneId, undefined, 'real delivery seam retires the completed executor');
  const registryPath = sp.registryPathFor(host), registryBytes = readFileSync(registryPath, 'utf8');
  const beforeClock = rec.startBeganAt, beforePhase = rec.startAttemptPhase;
  rmSync(registryPath); mkdirSync(registryPath); live = [];
  await sp.drainQueueOnce(options);
  assert.ok(rec.startOutcomeUnknown, 'failed reconciliation publication restores unknown marker');
  assert.equal(rec.startBeganAt, beforeClock); assert.equal(rec.startAttemptPhase, beforePhase);
  assert.equal(rec.pendingFollowups[0].runId, first.data.runId, 'failed publication restores the completed head too');
  if (mode === 'grid-post') assert.equal(rec.startedAt, undefined, 'rollback never fabricates a start timestamp');
  assert.equal(starts, 1);
  rmSync(registryPath, { recursive: true }); writeFileSync(registryPath, registryBytes);
  const persisted = sp.readPersistedRegistry(host); sp.restoreSpawnRegistry(host, { autodrain: false });
  const restored = sp.spawnRecords().get(rec.name); live = [];
  await sp.drainQueueOnce({ ...options, load: () => ({ ...DEFAULT_SETTINGS, layout_mode: 'spiral', max_parallel_agents: 3 }),
   submit: async () => ({ ok: true, data: true }),
   readEditor: async () => ({ ok: true, data: { status: 'working', text: '' } }), status: async () => ({ ok: true, data: 'working' }) });
  assert.equal(starts, 2, 'legal completion plus retirement releases only the different accepted next run: ' + JSON.stringify(restored));
  assert.equal(restored.runId, second.data.runId); assert.equal(restored.pendingFollowups.length, 0);
  assert.equal(restored.startOutcomeUnknown, undefined); assert.equal(readFileSync(eventPath, 'utf8'), bytes);
  assert.ok(persisted.find(row => row.name === rec.name).startOutcomeUnknown);
  sp.clearSpawnRegistry();
  }
 });
 await check('SP3-owner-contract', async () => {
  const { spawnFromTool } = await imp('src/tools/agents.ts');
  const { DEFAULT_SETTINGS } = await imp('src/settings.ts');
  const { createEventAvailability } = await imp('src/tools/wait.ts');
  for (const mode of ['missing', 'conflict']) {
   sp.clearSpawnRegistry();
   const host = join(root, 'owner-' + mode + '.jsonl'), other = join(root, 'owner-' + mode + '-other.jsonl');
   writeFileSync(host, ''); writeFileSync(other + '.registry.json', '[]');
   let release; const gate = new Promise(resolve => { release = resolve; });
   const options = { env: {}, autodrain: false, ...(mode === 'conflict' ? { parentSession: host } : {}),
    load: () => ({ ...DEFAULT_SETTINGS, layout_mode: 'spiral' }), kinds: async () => ['pi'],
    fleet: async () => ({ ok: true, data: [] }), list: async () => [], paneList: async () => [],
    worktree: async () => { await gate; return { ok: false, error: { code: 'AGENT_START_FAILED', message: 'OWNER TEST ORIGINAL FAILURE' } }; } };
   const accepted = await spawnFromTool({ name: 'owner-' + mode, agent: { kind: 'pi' }, prompt: 'task', isolated: true }, options);
   assert.equal(accepted.ok, true);
   const rec = sp.spawnRecords().get(accepted.data.name);
   if (mode === 'conflict') rec.lineage = { ownerSession: other, rootSession: other };
   release();
   for (let i = 0; i < 200 && !rec.startFailurePersistenceError; i++) await new Promise(resolve => setTimeout(resolve, 5));
   assert.equal(rec.startError, 'OWNER TEST ORIGINAL FAILURE'); assert.match(rec.startFailurePersistenceError, /owner.*(?:unavailable|conflict)/i);
   assert.equal(rec.sessionPath, undefined, 'owner gate runs before accepted failure helper seed');
   assert.equal(readFileSync(other + '.registry.json', 'utf8'), '[]');
   assert.equal((await createEventAvailability().wait({ target: rec.name, timeout: 0 })).status, 'timeout');
  }
  // Lineage alone must carry matching durable acceptance evidence, not an arbitrary registry filename.
  for (const trusted of [false, true]) {
   sp.clearSpawnRegistry();
   const host = join(root, 'lineage-' + trusted + '.jsonl'); writeFileSync(host, '');
   const rec = record('lineage-' + trusted, { sessionPath: undefined, paneId: undefined, submitted: false,
    startError: 'trusted lineage failure', spawnedAt: 1, lineage: { ownerSession: host, rootSession: host } });
   sp.writePersistedRegistry(host, trusted ? [rec] : [{ ...rec, agentId: 'another-agent' }]);
   sp.putSpawnRecordForTests(rec);
   const found = await createEventAvailability().wait({ target: rec.name, timeout: 0 });
   assert.equal(found.status, trusted ? 'available' : 'timeout');
   if (!trusted) { assert.equal(rec.sessionPath, undefined); assert.match(rec.startFailurePersistenceError, /does not own/); }
   else assert.equal(sp.readPersistedRegistry(host)[0].sessionPath, rec.sessionPath);
  }
  // A pure immutable read needs no owner repair or registry publication.
  sp.clearSpawnRegistry();
  const rec = record('ownerless-immutable', { paneId: undefined, submitted: false, startError: 'archived failure' });
  writeFileSync(rec.sessionPath + '.completion-' + rec.runId + '.json', JSON.stringify({ type: 'error', agentId: rec.agentId,
   runId: rec.runId, eventId: rec.runId, sequence: 1, text: 'ARCHIVED FAILURE BODY', errorMessage: 'archived failure', stopReason: 'start-error' }));
  sp.putSpawnRecordForTests(rec);
  assert.equal((await createEventAvailability().wait({ target: rec.name, timeout: 0 })).status, 'available');
  const receiver = join(root, 'immutable-reader.jsonl'); writeFileSync(receiver, '');
  const result = await getAgentResult({ target: rec.name }, { hostFile: receiver, toolCallId: 'immutable-reader' });
  assert.equal(result.ok, true); assert.match(result.data.result, /ARCHIVED FAILURE BODY/);
  assert.equal(existsSync(receiver + '.registry.json'), false, 'reading a saved event does not manufacture registry ownership');
  sp.clearSpawnRegistry();
 });
 await check('SP3-recovery', async () => {
  const { createEventAvailability } = await imp('src/tools/wait.ts');
  const { saveAcceptedStartFailure } = await imp('src/sessionfile.ts');
  const host = join(root, 'unseeded-host.jsonl'); writeFileSync(host, '');
  const failed = record('unseeded', { sessionPath: undefined, paneId: undefined, submitted: false,
   startError: 'worktree setup rejected before session seed', spawnedAt: 1234, cwd: root,
   lineage: { rootSession: host, ownerSession: host, ownerPane: 'fake-owner' } });
  const savedLineage = structuredClone(failed.lineage), notices = [];
  const agentDir = join(root, 'blocked-pi-agent'); writeFileSync(agentDir, 'injected seed ENOTDIR');
  process.env.PI_CODING_AGENT_DIR = agentDir;
  sp.putSpawnRecordForTests(failed);
  const options = { ...deps(failed, m => notices.push(m), host), registry: undefined };
  await deliverOnce(options);
  assert.equal(failed.sessionPath, undefined); assert.equal(failed.delivery, undefined);
  assert.equal(failed.submitted, false); assert.equal(failed.startedAt, undefined);
  assert.equal(notices[0].details.kind, 'persistence-error');
  const notSaved = await getAgentResult({ target: failed.name }, { hostFile: host, toolCallId: 'failed-storage' });
  assert.equal(notSaved.data.result, undefined); assert.match(notSaved.data.note, /persistence failed/);
  rmSync(agentDir); mkdirSync(agentDir);
  sp.restoreSpawnRegistry(host, { autodrain: false });
  await deliverOnce(options);
  const recovered = sp.spawnRecords().get(failed.name), path = recovered.sessionPath;
  assert.equal(readFileSync(path, 'utf8'), '', 'failure storage adds no fabricated assistant history');
  assert.deepEqual(recovered.lineage, savedLineage);
  assert.equal(recovered.submitted, false); assert.equal(recovered.startedAt, undefined);
  const found = await createEventAvailability({ registry: () => sp.spawnRecords(), status: statusDone }).wait({ target: failed.name, timeout: 0 });
  assert.equal(found.status, 'available'); assert.equal(found.eventId, recovered.runId);
  // Reconstruct the same acceptance after a registry-path write was lost.
  const replayedAcceptance = { ...recovered, sessionPath: undefined };
  saveAcceptedStartFailure(replayedAcceptance); assert.equal(replayedAcceptance.sessionPath, path);
  const result = await getAgentResult({ target: found.eventId }, { hostFile: host, toolCallId: 'failed-recovered' });
  assert.equal(result.data.status, 'error'); assert.match(result.data.result, /worktree setup rejected/);
  const archived = readFileSync(path + '.completion-' + found.eventId + '.json', 'utf8');
  // A later bridge-write failure is visible, retryable, and cannot corrupt the immutable archive.
  rmSync(path + '.exit'); mkdirSync(path + '.exit');
  assert.throws(() => saveAcceptedStartFailure(recovered));
  rmSync(path + '.exit', { recursive: true }); saveAcceptedStartFailure(recovered);
  assert.equal(readFileSync(path + '.completion-' + found.eventId + '.json', 'utf8'), archived);
  assert.equal(JSON.parse(archived).rootSession, host);
  assert.equal(notices.some(m => m.details.kind === 'error' && m.details.eventId === found.eventId), true);
  sp.clearSpawnRegistry(); process.env.PI_CODING_AGENT_DIR = join(root, 'pi-agent');
 });
 await check('SP3-committed-retry', async () => {
  const { saveAcceptedStartFailure } = await imp('src/sessionfile.ts');
  const failed = record('committed-retry', { paneId: undefined, submitted: false, startError: 'original definitive rejection' });
  const first = saveAcceptedStartFailure(failed);
  const archive = failed.sessionPath + '.completion-' + failed.runId + '.json';
  const committed = readFileSync(archive, 'utf8');
  // Retry after restart must recover the accepted event, not generate a new
  // failure body from a changed diagnostic or mutable display name.
  const replay = { ...failed, name: 'renamed-worker', startError: 'later diagnostic context' };
  assert.deepEqual(saveAcceptedStartFailure(replay), first);
  assert.equal(readFileSync(archive, 'utf8'), committed);
  const host = join(root, 'retry-host.jsonl'); writeFileSync(host, '');
  const result = await getAgentResult({ target: replay.name }, { hostFile: host, toolCallId: 'retry-pull', registry: () => new Map([[replay.name, replay]]) });
  assert.equal(result.data.status, 'error'); assert.match(result.data.result, /original definitive rejection/);
  assert.equal(result.data.result.includes('later diagnostic context'), false);
 });
 await check('SP3-late-pull', async () => {
  const { saveAcceptedStartFailure } = await imp('src/sessionfile.ts');
  const failed = record('late-pull', { paneId: undefined, submitted: false, startError: 'older accepted rejection' });
  saveAcceptedStartFailure(failed);
  const archive = failed.sessionPath + '.completion-' + failed.runId + '.json';
  const committed = readFileSync(archive, 'utf8');
  const newer = JSON.stringify({ type: 'done', eventId: 'run-newer', agentId: failed.agentId, runId: 'run-newer', sequence: 2, text: 'NEWER RUN FINAL' });
  writeFileSync(failed.sessionPath + '.exit', newer);
  const host = join(root, 'late-pull-host.jsonl'); writeFileSync(host, '');
  // A delayed/reloaded older acceptance still reads its own archive, without
  // rewriting the shared latest-run bridge or claiming the newer event.
  const result = await getAgentResult({ target: failed.name }, { hostFile: host, toolCallId: 'late-pull', registry: () => new Map([[failed.name, failed]]) });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.data.runId, failed.runId); assert.match(result.data.result, /older accepted rejection/);
  assert.equal(readFileSync(failed.sessionPath + '.exit', 'utf8'), newer, 'late Pull cannot overwrite another run bridge');
  assert.equal(readFileSync(archive, 'utf8'), committed);
  assert.equal(new DeliveryLedger(host).reconcile('run-newer'), undefined);
 });
 await check('UNPUBLISHED-ARCHIVE', async () => {
  const { saveAcceptedStartFailure } = await imp('src/sessionfile.ts');
  const host = join(root, 'unpublished-host.jsonl'); writeFileSync(host, '');
  const rec = record('unpublished', { paneId: undefined, submitted: false, startError: 'accepted rejection' });
  const saved = saveAcceptedStartFailure(rec);
  const archive = rec.sessionPath + '.completion-' + rec.runId + '.json';
  const bytes = readFileSync(archive, 'utf8');
  const reg = () => new Map([[rec.name, rec]]);
  mkdirSync(host + '.registry.json');
  const byName = await getAgentResult({ target: rec.name }, { hostFile: host, toolCallId: 'name-unpublished', registry: reg });
  assert.equal(byName.data.result, undefined); assert.ok(rec.startFailurePersistenceError);
  for (const explicit of [{}, { reread: true }, { ack: { hostFile: host, eventId: rec.runId, agentId: rec.agentId, runId: rec.runId, sequence: 1 } }]) {
   const byEvent = await getAgentResult({ target: rec.runId, ...explicit }, { hostFile: host, toolCallId: 'event-unpublished', registry: reg });
   assert.equal(byEvent.data?.result, undefined, 'eventId cannot bypass failed registry publication');
   assert.equal(byEvent.data?.acknowledged, undefined);
   assert.equal(new DeliveryLedger(host).reconcile(rec.runId), undefined);
  }
  // An unrelated current fault does not revoke an already published historical immutable event.
  const historical = { type: 'done', eventId: 'published-history', runId: 'published-history', agentId: rec.agentId, sequence: 3, text: 'PUBLISHED HISTORY' };
  writeFileSync(rec.sessionPath + '.completion-published-history.json', JSON.stringify(historical));
  const history = await getAgentResult({ target: 'published-history' }, { hostFile: host, toolCallId: 'published-history', registry: reg });
  assert.equal(history.data.result, 'PUBLISHED HISTORY');
  rmSync(host + '.registry.json', { recursive: true });
  const recovered = await getAgentResult({ target: saved.eventId }, { hostFile: host, toolCallId: 'event-recovered', registry: reg });
  assert.match(recovered.data.result, /accepted rejection/); assert.equal(rec.startFailurePersistenceError, undefined);
  assert.equal(readFileSync(archive, 'utf8'), bytes);
  assert.equal(sp.readPersistedRegistry(host).find(row => row.name === rec.name).runId, saved.eventId);
  // Lost in-memory error marker and valid stale registry are not publication proof.
  const staleHost = join(root, 'stale-unpublished-host.jsonl'); writeFileSync(staleHost, '');
  const staleOwner = join(root, 'missing-owner', 'owner.jsonl');
  const stale = { ...rec, startFailurePersistenceError: undefined, lineage: { ownerSession: staleOwner, rootSession: staleOwner } };
  writeFileSync(staleHost + '.registry.json', '[]');
  const unpublished = await getAgentResult({ target: stale.runId }, { hostFile: staleHost, toolCallId: 'stale-event', registry: () => new Map([[stale.name, stale]]) });
  assert.equal(unpublished.data?.result, undefined, 'parseable stale registry does not prove current failure publication');
  assert.equal(new DeliveryLedger(staleHost).reconcile(stale.runId), undefined);
 });
 await check('SP3-archive-recovery', async () => {
  const { saveAcceptedStartFailure } = await imp('src/sessionfile.ts');
  const absent = { name: 'archive-recovery', kind: 'pi', agentId: 'archive-agent', runId: 'archive-run', sequence: 1,
   sessionPath: join(root, 'missing-archive-dir', 'session.jsonl'), startError: 'accepted launch rejected' };
  assert.throws(() => saveAcceptedStartFailure(absent), /ENOENT/);
  mkdirSync(join(root, 'missing-archive-dir')); writeFileSync(absent.sessionPath, '');
  const saved = saveAcceptedStartFailure(absent);
  assert.equal(saved.eventId, 'archive-run');
  const archive = absent.sessionPath + '.completion-archive-run.json';
  const committed = readFileSync(archive, 'utf8');
  assert.throws(() => saveAcceptedStartFailure({ ...absent, agentId: 'wrong-agent' }), /conflicts/);
  assert.throws(() => saveAcceptedStartFailure({ ...absent, sequence: 2 }), /conflicts/);
  assert.throws(() => saveAcceptedStartFailure({ ...absent, identityReviewRequired: true }), /identity requires review/);
  assert.equal(readFileSync(archive, 'utf8'), committed);
  assert.equal(saveAcceptedStartFailure({ ...absent, kind: 'other' }), undefined);
  assert.equal(saveAcceptedStartFailure({ ...absent, startError: undefined }), undefined);
  // Registry publication must succeed before Pull may claim the body. A
  // durable event survives the failure and is consumable after recovery.
  const host = join(root, 'archive-recovery-host.jsonl'); writeFileSync(host, '');
  sp.clearSpawnRegistry(); sp.putSpawnRecordForTests(absent);
  mkdirSync(host + '.registry.json');
  const failed = await getAgentResult({ target: absent.name }, { hostFile: host, toolCallId: 'registry-failure' });
  assert.equal(failed.ok, true); assert.equal(failed.data.result, undefined);
  assert.match(failed.data.note, /persistence failed/);
  assert.equal(new DeliveryLedger(host).reconcile(absent.runId), undefined);
  rmSync(host + '.registry.json', { recursive: true });
  const recovered = await getAgentResult({ target: absent.name }, { hostFile: host, toolCallId: 'registry-recovery' });
  assert.equal(recovered.ok, true); assert.match(recovered.data.result, /accepted launch rejected/);
  assert.equal(readFileSync(archive, 'utf8'), committed);
  sp.clearSpawnRegistry();
 });
 await check('SP3-pending-identity', async () => {
  const { saveAcceptedStartFailure } = await imp('src/sessionfile.ts');
  const failed = record('pending-identity', { paneId: undefined, submitted: false, pendingRunId: 'accepted-next-run', startError: 'worktree failed before run activation' });
  assert.throws(() => saveAcceptedStartFailure(failed), /run identity is not activated/);
  assert.throws(() => readFileSync(failed.sessionPath + '.completion-' + failed.runId + '.json'), /ENOENT/);
  assert.throws(() => readFileSync(failed.sessionPath + '.exit'), /ENOENT/);
  // The merger must activate the accepted identity before finalizing failure.
  failed.runId = failed.pendingRunId; failed.pendingRunId = undefined;
  assert.equal(saveAcceptedStartFailure(failed).runId, 'accepted-next-run');
 });
 await check('R9', async () => {
  const { ParentNotifyStore } = await imp('src/parent-notify-store.ts');
  const { registerParentDelivery } = await imp('src/parent-delivery.ts');
  const host = join(root, 'governance-host.jsonl'); writeFileSync(host, '');
  const child = record('disk-full');
  writeFileSync(child.sessionPath + '.exit', JSON.stringify({ type: 'persistence-error', errorMessage: 'child disk full' }));
  const handlers = new Map();
  const parent = registerParentDelivery({ on(n, fn) { handlers.set(n, fn); } }, () => { throw new Error('finished parent must not dispatch'); }, () => 'normal');
  handlers.get('session_start')({}, { sessionManager: { getSessionFile: () => host } });
  sp.putSpawnRecordForTests(child);
  const originalPut = ParentNotifyStore.prototype.put; let attempts = 0;
  ParentNotifyStore.prototype.put = function (msg) {
   attempts++; if (attempts === 1) throw new Error('injected notification acceptance EIO');
   return originalPut.call(this, msg);
  };
  try {
   const options = { ...deps(child, m => parent.accept(m), host), registry: undefined };
   await assert.rejects(deliverOnce(options), /notification acceptance EIO/);
   sp.restoreSpawnRegistry(host, { autodrain: false }); // Durable diagnostic survives process-style registry reload.
   await deliverOnce(options); await deliverOnce(options);
   assert.ok(attempts >= 2, 'failed durable acceptance must be retried despite the saved diagnostic');
   const pending = new ParentNotifyStore(host).pending();
   assert.equal(pending.length, 1, 'idempotent receiver acceptance deduplicates retries');
   assert.equal(pending[0].details.kind, 'persistence-error');
   assert.equal(sp.spawnRecords().get(child.name).delivery, undefined, 'governance is not terminal delivery');
   assert.match(sp.spawnRecords().get(child.name).pushError, /child disk full/);
  } finally { ParentNotifyStore.prototype.put = originalPut; sp.clearSpawnRegistry(); }
 });
 console.log('Delivery regression cases:', cases.join(', '));
} finally {
 sp.clearSpawnRegistry(); stopDeliveryLoop(); rmSync(root, { recursive: true, force: true });
}
