import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { createJiti } from 'jiti';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn as launchProcess } from 'node:child_process';

for (const key of Object.keys(process.env)) if (/^(HERDR|PI_HERDR)/.test(key)) delete process.env[key];
process.env.PI_OFFLINE = '1';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const nativeIO = Object.fromEntries(['openSync', 'closeSync', 'writeFileSync', 'fsyncSync', 'linkSync', 'renameSync'].map(key => [key, fs[key]]));
const io = { ...nativeIO };
for (const key of Object.keys(io)) fs[key] = (...args) => io[key](...args);
syncBuiltinESMExports();
const jiti = createJiti(import.meta.url, { fsCache: false });
const sessionfile = await jiti.import(join(ROOT, 'src/sessionfile.ts'));
const spawn = await jiti.import(join(ROOT, 'src/spawn.ts'));
const lifecycle = await jiti.import(join(ROOT, 'src/tools/lifecycle.ts'));
const delivery = await jiti.import(join(ROOT, 'src/delivery.ts'));
const { DEFAULT_SETTINGS } = await jiti.import(join(ROOT, 'src/settings.ts'));
const { setProbeForTests } = await jiti.import(join(ROOT, 'src/herdr.ts'));
const tests = [];
const test = (name, run) => tests.push({ name, run });
const ok = data => ({ ok: true, data });
function fixture(root, overrides = {}) {
  const sessionPath = join(root, 'child.jsonl');
  const ownerSession = join(root, 'parent.jsonl');
  writeFileSync(sessionPath, ''); writeFileSync(ownerSession, '');
  const record = {
    name: 'child', agentId: 'agent-1', runId: 'old-run', sequence: 1,
    kind: 'pi', prompt: 'old task', agentArgs: [], depth: 1, isolated: false,
    spawnedAt: 1, startBeganAt: 1, startedAt: 2, paneId: 'pane-old',
    submitted: true, sawWorking: true, stance: 'autonomous', sessionPath,
    definition: { name: 'child', kind: 'pi' },
    lineage: { ownerSession, rootSession: ownerSession }, ...overrides,
  };
  spawn.clearSpawnRegistry(); spawn.putSpawnRecordForTests(record);
  const deps = {
    parentSession: ownerSession, env: {}, autodrain: false,
    load: () => ({ ...DEFAULT_SETTINGS, layout_mode: 'spiral', max_parallel_agents: 1 }),
    list: async () => [], fleet: async () => ok([]), paneList: async () => [],
    childExtension: join(ROOT, 'src/child.ts'), boot: async () => ok(true),
    start: async () => ok({ agent: { pane_id: 'pane-new' } }),
    submit: async () => ok(true), status: async () => ok('working'),
    readEditor: async () => ok({ status: 'working', text: '' }),
  };
  return { record, deps, sessionPath, ownerSession };
}

test('R3 gone followup and maintenance resume drain after capacity frees, including reload', async root => {
  for (const mode of ['followup', 'resume']) {
    const f = fixture(root, { delivery: { kind: 'done', at: 3 } });
    const blocker = { ...f.record, name: 'blocker', agentId: 'blocker', paneId: 'pane-blocker' };
    spawn.putSpawnRecordForTests(blocker);
    const full = { ...f.deps, fleet: async () => ok([{ paneId: 'pane-blocker', agentStatus: 'working' }]) };
    const accepted = mode === 'followup'
      ? await lifecycle.triggerTurn({ target: 'child', text: 'recover' }, full)
      : await lifecycle.resumeAgent({ target: 'child', message: 'recover' }, full);
    assert.equal(accepted.ok, true, JSON.stringify(accepted));
    assert.equal(accepted.data.status, 'queued');
    spawn.writePersistedRegistry(f.ownerSession, [...spawn.spawnRecords().values()]);
    spawn.clearSpawnRegistry(); spawn.restoreSpawnRegistry(f.ownerSession);
    let starts = 0;
    const drained = await spawn.drainQueueOnce({ ...f.deps, start: async () => { starts++; return ok({ agent: { pane_id: 'pane-new' } }); } });
    assert.equal(drained, 1, `${mode}: accepted recovery must not be excluded by prior run startup timestamp`);
    assert.equal(starts, 1);
    const restored = spawn.spawnRecords().get('child');
    assert.equal(restored.paneId, 'pane-new');
    assert.equal(restored.submitted, true);
    if (mode === 'followup') assert.equal(restored.runId, accepted.data.runId);
  }
});

async function until(check, label) {
  const deadline = Date.now() + 8000;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error(`Timed out: ${label}`);
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

test('R1 old close and new run share executor exclusion through real fleet transport', async root => {
  const nextRun = '22222222-2222-4222-8222-222222222222';
  const f = fixture(root, {
    delivery: { kind: 'done', at: 3 }, paneClosePending: true,
    paneCloseAuthorization: { agentId: 'agent-1', runId: 'old-run', paneId: 'pane-old' },
    pendingFollowups: [{ runId: nextRun, text: 'new work' }],
  });
  spawn.writePersistedRegistry(f.ownerSession, [f.record]);
  const event = { type: 'done', agentId: 'agent-1', runId: 'old-run', sequence: 1, eventId: 'old-run', text: 'old result' };
  writeFileSync(f.sessionPath + '.exit', JSON.stringify(event));
  writeFileSync(f.sessionPath + '.completion-old-run.json', JSON.stringify(event));
  const bin = join(root, 'fake-herdr.cjs');
  const entered = join(root, 'fleet-entered'); const released = join(root, 'fleet-released');
  const calls = join(root, 'calls.jsonl');
  writeFileSync(bin, `#!${process.execPath}\nconst fs=require('node:fs');const args=process.argv.slice(2);fs.appendFileSync(${JSON.stringify(calls)},JSON.stringify(args)+'\\n');if(args.join(' ')==='agent list'){fs.writeFileSync(${JSON.stringify(entered)},'');const t=setInterval(()=>{if(fs.existsSync(${JSON.stringify(released)})){clearInterval(t);console.log(JSON.stringify({ok:true,data:{agents:[]}}));}},5);}else if(args[0]==='pane'&&args[1]==='close')console.log(JSON.stringify({ok:true,data:{}}));else process.exit(99);`);
  chmodSync(bin, 0o700); process.env.HERDR_BIN_PATH = bin;
  setProbeForTests({ state: 'ok', version: { major: 0, minor: 9, patch: 0 } });
  const closing = delivery.deliverOnce({ fleet: ok([]), sessionPath: f.ownerSession, load: f.deps.load });
  try {
    await until(() => existsSync(entered), 'close awaits real fleetList');
    assert.equal(await spawn.drainQueueOnce(f.deps), 0, 'new executor must not start while old close owns transition');
    const followup = await lifecycle.triggerTurn({ target: 'child', text: 'third' }, f.deps);
    assert.equal(followup.ok, false, 'immediate followup also shares close exclusion');
    let resumeQueries = 0; let resumeStarts = 0;
    const resume = await lifecycle.resumeAgent({ target: 'child', message: 'maintenance recovery' }, {
      ...f.deps,
      fleet: async () => { resumeQueries++; return ok([]); },
      start: async () => { resumeStarts++; return ok({ agent: { pane_id: 'unexpected' } }); },
    });
    assert.equal(resume.ok, false, 'maintenance resume must not bypass an in-flight close claim');
    assert.equal(resumeQueries, 0, 'resume is refused before asynchronous ownership observations');
    assert.equal(resumeStarts, 0);
    assert.equal(f.record.runId, 'old-run');
    assert.equal(f.record.paneId, 'pane-old');
    assert.deepEqual(f.record.pendingFollowups, [{ runId: nextRun, text: 'new work' }]);
  } finally { writeFileSync(released, ''); await closing; }
  assert.deepEqual(readFileSync(calls, 'utf8').trim().split('\n').map(JSON.parse), [['agent', 'list'], ['pane', 'close', 'pane-old']]);
  assert.equal(await spawn.drainQueueOnce(f.deps), 1);
  assert.equal(f.record.runId, nextRun);
  assert.equal(f.record.paneId, 'pane-new');
  assert.equal(f.record.submitted, true);
  assert.equal(readFileSync(f.sessionPath + '.completion-event', 'utf8'), nextRun);
  assert.equal(spawn.readPersistedRegistry(f.ownerSession)[0].paneId, 'pane-new');
});

test('R4 resident interactive followups drain FIFO at idle or done even at pane capacity', async root => {
  for (const settled of ['idle', 'done']) {
    const f = fixture(root, { stance: 'interactive', definition: { name: 'child', kind: 'pi', interactive: true } });
    let state = 'working'; let starts = 0; const submissions = [];
    const panes = () => [{ paneId: 'pane-old', name: 'child', agentStatus: state }];
    const deps = { ...f.deps, list: async () => panes(), fleet: async () => ok(panes()),
      start: async () => { starts++; return ok({ agent: { pane_id: 'unexpected' } }); },
      submit: async (pane, text) => { submissions.push({ pane, text }); state = 'working'; return ok(true); },
    };
    const first = await lifecycle.triggerTurn({ target: 'child', text: 'first' }, deps);
    const second = await lifecycle.triggerTurn({ target: 'child', text: 'second' }, deps);
    assert.equal(first.data.status, 'queued'); assert.equal(second.data.status, 'queued');
    assert.equal(await spawn.drainQueueOnce(deps), 0, 'working executor must not receive queued run');
    state = 'blocked'; assert.equal(await spawn.drainQueueOnce(deps), 0);
    spawn.writePersistedRegistry(f.ownerSession, [...spawn.spawnRecords().values()]);
    spawn.clearSpawnRegistry(); spawn.restoreSpawnRegistry(f.ownerSession);
    const oldEvent = { type: 'done', agentId: 'agent-1', runId: 'old-run', eventId: 'old-run', sequence: 1, text: 'old immutable result' };
    writeFileSync(f.sessionPath + '.completion-old-run.json', JSON.stringify(oldEvent));
    for (const receipt of [first, second]) {
      state = settled;
      assert.equal(await spawn.drainQueueOnce(deps), 1, `${settled}: resident executor must execute accepted head run without a free pane slot`);
      const record = spawn.spawnRecords().get('child');
      assert.equal(record.runId, receipt.data.runId);
      assert.equal(record.paneId, 'pane-old');
      assert.equal(readFileSync(f.sessionPath + '.completion-event', 'utf8'), receipt.data.runId);
      assert.equal(await spawn.drainQueueOnce(deps), 0, 'next entry stays queued while preceding run works');
    }
    assert.equal(starts, 0, 'resident executor is reused, not replaced');
    assert.equal(submissions.length, 2);
    assert.equal(submissions[0].text, `<herdr-followup runId="${first.data.runId}">\nfirst\n</herdr-followup>`);
    assert.equal(submissions[1].text, `<herdr-followup runId="${second.data.runId}">\nsecond\n</herdr-followup>`);
    assert.equal(spawn.spawnRecords().get('child').pendingFollowups.length, 0);
    assert.deepEqual(JSON.parse(readFileSync(f.sessionPath + '.completion-old-run.json', 'utf8')), oldEvent);
  }
});

test('R4 autonomous settled executors are retired before queued followups can launch', async root => {
  for (const settled of ['idle', 'done']) {
    const f = fixture(root);
    let state = 'working'; let starts = 0; let submits = 0;
    const panes = () => [{ paneId: 'pane-old', name: 'child', agentStatus: state }];
    const deps = { ...f.deps, load: () => ({ ...DEFAULT_SETTINGS, layout_mode: 'spiral', max_parallel_agents: 2 }),
      list: async () => panes(), fleet: async () => ok(panes()),
      start: async () => { starts++; return ok({ agent: { pane_id: 'unexpected' } }); },
      submit: async () => { submits++; return ok(true); },
    };
    const accepted = await lifecycle.triggerTurn({ target: 'child', text: 'next autonomous task' }, deps);
    assert.equal(accepted.ok, true); assert.equal(accepted.data.status, 'queued');
    state = settled;
    assert.equal(await spawn.drainQueueOnce(deps), 0, 'a spare pane slot does not authorize reusing an autonomous settled executor');
    f.record.delivery = { kind: 'done', at: 3 };
    f.record.paneClosePending = true;
    assert.equal(await spawn.drainQueueOnce(deps), 0, 'pending retirement must not be overtaken by dispatch');
    assert.equal(starts, 0); assert.equal(submits, 0);
    assert.equal(f.record.runId, 'old-run'); assert.equal(f.record.paneId, 'pane-old');
    assert.deepEqual(f.record.pendingFollowups, [{ runId: accepted.data.runId, text: 'next autonomous task' }]);
  }
});

test('R4 rejected resident submission retries the accepted head after registry reload without overtaking', async root => {
  const f = fixture(root, { stance: 'interactive', definition: { name: 'child', kind: 'pi', interactive: true } });
  let state = 'working'; let fail = true; let starts = 0; const submissions = [];
  const panes = () => [{ paneId: 'pane-old', name: 'child', agentStatus: state }];
  const deps = { ...f.deps, list: async () => panes(), fleet: async () => ok(panes()),
    start: async () => { starts++; return ok({ agent: { pane_id: 'unexpected' } }); },
    submit: async (pane, text) => {
      submissions.push({ pane, text });
      if (fail) return { ok: false, error: { code: 'CLI_ERROR', message: 'prompt rejected before acceptance' } };
      state = 'working'; return ok(true);
    },
  };
  const first = await lifecycle.triggerTurn({ target: 'child', text: 'first' }, deps);
  const second = await lifecycle.triggerTurn({ target: 'child', text: 'second' }, deps);
  assert.equal(first.ok, true); assert.equal(second.ok, true);
  state = 'idle';
  assert.equal(await spawn.drainQueueOnce(deps), 0);
  assert.equal(f.record.runId, 'old-run', 'rejected submission must not replace the executing identity');
  assert.deepEqual(f.record.pendingFollowups.map(entry => entry.runId), [first.data.runId, second.data.runId]);
  assert.equal(readFileSync(f.sessionPath + '.completion-event', 'utf8'), 'old-run');
  spawn.clearSpawnRegistry(); spawn.restoreSpawnRegistry(f.ownerSession);
  assert.equal(spawn.spawnRecords().get('child').followupSubmitError, 'prompt rejected before acceptance', 'retryable rejection remains durably diagnosable');
  assert.equal(await spawn.drainQueueOnce(deps), 0);
  assert.equal(submissions.length, 2, 'a definite rejection must not permanently exclude the accepted head from retry');
  fail = false;
  assert.equal(await spawn.drainQueueOnce(deps), 1);
  const restored = spawn.spawnRecords().get('child');
  assert.equal(restored.runId, first.data.runId);
  assert.equal(restored.startError, undefined, 'resident submission failure must not become a terminal start error');
  assert.equal(restored.followupSubmitError, undefined, 'successful dispatch clears its transient rejection diagnostic');
  assert.equal(restored.submitted, true);
  assert.deepEqual(restored.pendingFollowups.map(entry => entry.runId), [second.data.runId]);
  assert.equal(await spawn.drainQueueOnce(deps), 0, 'second run waits until the first settles');
  state = 'done';
  assert.equal(await spawn.drainQueueOnce(deps), 1);
  assert.equal(restored.runId, second.data.runId);
  assert.equal(restored.pendingFollowups.length, 0);
  assert.equal(starts, 0);
  const firstEnvelope = `<herdr-followup runId="${first.data.runId}">\nfirst\n</herdr-followup>`;
  assert.deepEqual(submissions, [
    { pane: 'pane-old', text: firstEnvelope }, { pane: 'pane-old', text: firstEnvelope },
    { pane: 'pane-old', text: firstEnvelope },
    { pane: 'pane-old', text: `<herdr-followup runId="${second.data.runId}">\nsecond\n</herdr-followup>` },
  ]);
});

test('UNKNOWN-RETRY resident uncertain submission keeps accepted identity without replay after reload', async root => {
  for (const mode of ['timeout', 'abort', 'throw', 'unparseable']) {
    const f = fixture(root, { stance: 'interactive' });
    let state = 'working'; let attempts = 0;
    const panes = () => [{ paneId: 'pane-old', agentStatus: state }];
    const deps = { ...f.deps, list: async () => panes(), fleet: async () => ok(panes()),
      submit: async () => {
        attempts++;
        if (mode === 'throw') throw new Error('lost submission response');
        return { ok: false, error: mode === 'unparseable'
          ? { code: 'VALIDATION_ERROR', message: 'unparseable output', details: { exitCode: 1, stdout: '' } }
          : { code: 'TIMEOUT', message: mode } };
      } };
    const first = await lifecycle.triggerTurn({ target: 'child', text: 'first' }, deps);
    const second = await lifecycle.triggerTurn({ target: 'child', text: 'second' }, deps);
    state = 'idle'; await spawn.drainQueueOnce(deps);
    assert.equal(f.record.runId, first.data.runId, 'unknown response cannot roll back accepted run identity');
    assert.equal(f.record.promptSubmission, 'uncertain');
    assert.ok(f.record.startOutcomeUnknown);
    assert.equal(f.record.startError, undefined);
    spawn.clearSpawnRegistry(); spawn.restoreSpawnRegistry(f.ownerSession, { autodrain: false });
    const restored = spawn.spawnRecords().get('child');
    state = 'done'; await spawn.drainQueueOnce(deps); state = 'idle'; await spawn.drainQueueOnce(deps);
    assert.equal(attempts, 1, 'idle/done and parent-written marker do not prove non-submission');
    assert.deepEqual(restored.pendingFollowups.map(entry => entry.runId), [first.data.runId, second.data.runId]);
    assert.equal(readFileSync(f.sessionPath + '.completion-event', 'utf8'), first.data.runId);
  }
});

test('UNKNOWN-RETRY resident terminal evidence reconciles head before dispatching next run', async root => {
  const f = fixture(root, { stance: 'interactive', definition: { name: 'child', kind: 'pi', interactive: true } });
  let state = 'working'; const submitted = [];
  const panes = () => [{ paneId: 'pane-old', agentStatus: state }];
  const deps = { ...f.deps, list: async () => panes(), fleet: async () => ok(panes()), submit: async (_, text) => {
    submitted.push(text);
    if (submitted.length === 1) return { ok: false, error: { code: 'TIMEOUT', message: 'lost reply' } };
    state = 'working'; return ok(true);
  } };
  const first = await lifecycle.triggerTurn({ target: 'child', text: 'first' }, deps);
  const second = await lifecycle.triggerTurn({ target: 'child', text: 'second' }, deps);
  state = 'idle'; await spawn.drainQueueOnce(deps);
  const event = { type: 'done', agentId: f.record.agentId, runId: first.data.runId, eventId: first.data.runId, sequence: 1, text: 'FIRST RUN FINAL' };
  writeFileSync(f.sessionPath + '.completion-' + first.data.runId + '.json', JSON.stringify(event));
  writeFileSync(f.sessionPath + '.exit', JSON.stringify(event));
  // Seed the independently observed terminal marker; this is a control-flow test, not SDK execution evidence.
  f.record.delivery = { kind: 'done', at: 3 };
  assert.equal(await spawn.drainQueueOnce(deps), 1, 'matching durable child terminal evidence releases the uncertain head');
  assert.equal(f.record.runId, second.data.runId);
  assert.equal(submitted.length, 2);
  assert.match(submitted[1], /second/);
  assert.equal(f.record.startOutcomeUnknown, undefined);
});

test('UNKNOWN-RETRY registry failure refuses resident contact before uncertain submission', async root => {
  const f = fixture(root, { stance: 'interactive' });
  let state = 'working'; let attempts = 0;
  const panes = () => [{ paneId: 'pane-old', agentStatus: state }];
  const deps = { ...f.deps, list: async () => panes(), fleet: async () => ok(panes()),
    submit: async () => { attempts++; state = 'working'; return ok(true); } };
  const accepted = await lifecycle.triggerTurn({ target: 'child', text: 'first' }, deps);
  const registry = f.ownerSession + '.registry.json';
  const acceptedBytes = readFileSync(registry, 'utf8');
  rmSync(registry); mkdirSync(registry); state = 'idle';
  await spawn.drainQueueOnce(deps);
  assert.equal(attempts, 0, 'uncertainty must be durable before contacting executor');
  assert.equal(f.record.runId, 'old-run');
  rmSync(registry, { recursive: true }); writeFileSync(registry, acceptedBytes);
  spawn.clearSpawnRegistry(); spawn.restoreSpawnRegistry(f.ownerSession, { autodrain: false });
  assert.equal(await spawn.drainQueueOnce(deps), 1);
  assert.equal(attempts, 1); assert.equal(spawn.spawnRecords().get('child').runId, accepted.data.runId);
});

test('UNKNOWN-RETRY ownerless resident dispatch refuses executor contact', async root => {
  const f = fixture(root, { stance: 'interactive', lineage: undefined });
  let state = 'working'; let contacts = 0;
  const panes = () => [{ paneId: 'pane-old', agentStatus: state }];
  const deps = { ...f.deps, parentSession: undefined, list: async () => panes(), fleet: async () => ok(panes()),
    submit: async () => { contacts++; return ok(true); } };
  const accepted = await lifecycle.triggerTurn({ target: 'child', text: 'ownerless task' }, deps);
  assert.equal(accepted.ok, true); state = 'idle';
  assert.equal(await spawn.drainQueueOnce(deps), 0);
  assert.equal(contacts, 0, 'unknown outcome cannot be governed without a durable acceptance owner');
  assert.equal(f.record.runId, 'old-run');
  assert.deepEqual(f.record.pendingFollowups.map(entry => entry.runId), [accepted.data.runId]);
  assert.match(f.record.followupSubmitError, /owner unavailable/);
});

function worker(intentPath, bin) {
  const child = launchProcess(process.execPath, [join(ROOT, 'src/recycle-worker.mjs'), intentPath, bin], { stdio: 'pipe' });
  let stderr = ''; child.stderr.on('data', chunk => { stderr += chunk; });
  const done = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { child.kill(); reject(new Error(`worker timed out: ${stderr}`)); }, 8000);
    child.once('error', error => { clearTimeout(timeout); reject(error); });
    child.once('close', code => { clearTimeout(timeout); resolve({ code, stderr }); });
  });
  return { child, done };
}

test('R6 stale independent worker preserves replacement intent on refusal and command failure', async root => {
  for (const failFleet of [false, true]) {
    const f = fixture(root);
    const path = f.sessionPath + '.recycle.json';
    const initial = { pending: true, eventId: 'old-run', runId: 'old-run', agentId: 'agent-1', sequence: 1,
      sessionPath: f.sessionPath, paneId: 'pane-old', name: 'child', ownerSession: f.ownerSession };
    const next = { ...initial, eventId: 'new-run', runId: 'new-run', paneId: 'pane-new' };
    const entered = join(root, 'version-entered'); const released = join(root, 'version-released');
    const failed = join(root, 'fail-fleet'); const calls = join(root, 'worker-calls.jsonl'); const bin = join(root, 'worker-herdr.mjs');
    for (const marker of [entered, released, failed, calls]) rmSync(marker, { force: true });
    writeFileSync(path, JSON.stringify(initial)); writeFileSync(f.sessionPath + '.exit', JSON.stringify(initial));
    writeFileSync(f.ownerSession + '.registry.json', JSON.stringify([initial]));
    writeFileSync(bin, `#!${process.execPath}\nimport * as fs from 'node:fs';const args=process.argv.slice(2);fs.appendFileSync(${JSON.stringify(calls)},JSON.stringify(args)+'\\n');if(args[0]==='--version'){fs.writeFileSync(${JSON.stringify(entered)},'');while(!fs.existsSync(${JSON.stringify(released)}))await new Promise(r=>setTimeout(r,5));console.log('herdr 0.9.3');}else if(args.join(' ')==='agent list'){if(fs.existsSync(${JSON.stringify(failed)})){console.log(JSON.stringify({ok:false,error:{code:'CLI_ERROR',message:'fleet failed'}}));process.exit(1);}console.log(JSON.stringify({ok:true,data:{agents:[]}}));}else if(args.join(' ')==='pane list')console.log(JSON.stringify({ok:true,data:{panes:[{pane_id:'pane-new'}]}}));else if(args[0]==='pane'&&args[1]==='close')console.log(JSON.stringify({ok:true,data:{}}));else process.exit(99);`);
    chmodSync(bin, 0o700);
    const stale = worker(path, bin);
    try {
      await until(() => existsSync(entered), 'old worker awaits version transport');
      writeFileSync(f.ownerSession + '.registry.json', JSON.stringify([next]));
      writeFileSync(f.sessionPath + '.exit', JSON.stringify(next));
      writeFileSync(path, JSON.stringify(next));
      if (failFleet) writeFileSync(failed, '');
      writeFileSync(released, '');
      assert.equal((await stale.done).code, 0);
      assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), next, 'old worker must not cancel or annotate the new durable close intent');
    } finally { stale.child.kill(); writeFileSync(released, ''); }
    rmSync(failed, { force: true });
    const successor = worker(path, bin);
    try { assert.equal((await successor.done).code, 0); }
    finally { successor.child.kill(); }
    const final = JSON.parse(readFileSync(path, 'utf8'));
    assert.equal(final.runId, 'new-run'); assert.equal(final.pending, false);
    const closes = readFileSync(calls, 'utf8').trim().split('\n').map(JSON.parse).filter(args => args[0] === 'pane' && args[1] === 'close');
    assert.deepEqual(closes, [['pane', 'close', 'pane-new']], 'successor worker still recycles only the authorized new pane');
  }
});

test('LIVE-CANCEL accepted registered spawn survives cancellation of the parent wait', async root => {
  const { registerAgents } = await jiti.import(join(ROOT, 'src/tools/agents.ts'));
  const { registerWaitTool } = await jiti.import(join(ROOT, 'src/tools/wait.ts'));
  const oldCwd = process.cwd();
  const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
  const agentDir = join(root, 'agent-config'); mkdirSync(agentDir);
  writeFileSync(join(agentDir, 'herdr.json'), JSON.stringify({ layout_mode: 'spiral' }));
  process.env.PI_CODING_AGENT_DIR = agentDir; process.chdir(root);
  const owner = join(root, 'parent.jsonl'); writeFileSync(owner, '');
  const entered = join(root, 'starting'); const release = join(root, 'release');
  const submitted = join(root, 'submitted'); const calls = join(root, 'calls.jsonl');
  const bin = join(root, 'startup-herdr.mjs');
  writeFileSync(bin, `#!${process.execPath}
import * as fs from 'node:fs';
const a=process.argv.slice(2),root=${JSON.stringify(root)};
fs.appendFileSync(root+'/calls.jsonl',JSON.stringify(a)+'\\n');
const reply=data=>console.log(JSON.stringify({result:data}));
if(a[0]==='--version')console.log('herdr 0.9.3');
else if(a.length===1&&a[0]==='agent')console.log('kinds: pi');
else if(a[0]==='agent'&&a[1]==='list')reply({agents:[]});
else if(a[0]==='pane'&&a[1]==='list')reply({panes:[]});
else if(a[0]==='pane'&&a[1]==='split')reply({pane:{pane_id:'test-child'}});
else if(a[0]==='pane'&&a[1]==='send-text')reply({});
else if(a[0]==='agent'&&a[1]==='start'){
 fs.writeFileSync(root+'/starting','');
 while(!fs.existsSync(root+'/release'))await new Promise(r=>setTimeout(r,5));
 reply({agent:{pane_id:'test-child',agent_status:'idle'}});
}else if(a[0]==='agent'&&a[1]==='get')reply({agent:{pane_id:'test-child',agent_status:fs.existsSync(root+'/submitted')?'working':'idle'}});
else if(a[0]==='agent'&&a[1]==='prompt'){fs.writeFileSync(root+'/submitted',a[3]);reply({});}
else {console.error(JSON.stringify(a));process.exit(99);}
`);
  chmodSync(bin, 0o700); process.env.HERDR_BIN_PATH = bin;
  setProbeForTests({ state: 'ok', version: { major: 0, minor: 9, patch: 3 } });
  const tools = new Map(); const pi = { on() {}, registerTool(tool) { tools.set(tool.name, tool); } };
  registerAgents(pi, { dirs: { project: join(root, 'project'), global: join(root, 'global') } });
  registerWaitTool(pi);
  const controller = new AbortController();
  try {
    const accepted = await tools.get('herdr_spawn_agent').execute('spawn', {
      name: 'cancel-safe', agent: { name: 'cancel-safe', kind: 'pi', interactive: true }, prompt: 'accepted task',
    }, controller.signal, undefined, { cwd: root, sessionManager: { getSessionFile: () => owner } });
    assert.equal(accepted.isError, undefined, JSON.stringify(accepted));
    assert.equal(accepted.details.status, 'starting');
    await until(() => existsSync(entered), 'accepted child is in its asynchronous startup');
    const waiting = tools.get('herdr_wait_agent_event').execute('wait', { target: 'cancel-safe', timeout: 5000 }, controller.signal);
    controller.abort();
    assert.equal((await waiting).details.status, 'cancelled');
    writeFileSync(release, '');
    const record = spawn.spawnRecords().get('cancel-safe');
    await until(() => record.submitted || record.startOutcomeUnknown, 'background startup reaches its outcome');
    assert.equal(record.submitted, true, 'cancelling an accepted parent wait must not cancel child startup');
    assert.equal(record.startOutcomeUnknown, undefined);
    assert.equal(readFileSync(submitted, 'utf8'), 'accepted task');
    const commands = readFileSync(calls, 'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(commands.filter(a => a[0] === 'agent' && a[1] === 'start').length, 1);
    assert.equal(commands.filter(a => a[0] === 'agent' && a[1] === 'prompt').length, 1);
    rmSync(submitted); // The transport adapter's next fresh executor boots idle.
    const control = await tools.get('herdr_spawn_agent').execute('control', {
      name: 'uncancelled', agent: { name: 'uncancelled', kind: 'pi', interactive: true }, prompt: 'uncancelled task',
    }, new AbortController().signal, undefined, { cwd: root, sessionManager: { getSessionFile: () => owner } });
    assert.equal(control.details.status, 'starting');
    await until(() => spawn.spawnRecords().get('uncancelled')?.submitted, 'uncancelled control starts normally');
    assert.equal(readFileSync(submitted, 'utf8'), 'uncancelled task');
    const beforeAcceptance = new AbortController(); beforeAcceptance.abort();
    const refused = await tools.get('herdr_spawn_agent').execute('pre-cancelled', {
      name: 'pre-cancelled', agent: { name: 'pre-cancelled', kind: 'pi', interactive: true }, prompt: 'must not be accepted',
    }, beforeAcceptance.signal, undefined, { cwd: root, sessionManager: { getSessionFile: () => owner } });
    assert.equal(refused.isError, true, 'a cancellation before acceptance must still refuse work');
    assert.equal(spawn.spawnRecords().has('pre-cancelled'), false);
  } finally {
    writeFileSync(release, ''); process.chdir(oldCwd);
    if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
  }
});

test('LIVE-RESTORE ordinary queued spawn resumes autonomously in a fresh process after capacity frees', async root => {
  const f = fixture(root, { name: 'holder', agentId: 'holder-agent', paneId: 'holder-pane' });
  const accepted = await spawn.spawnAgent({ name: 'ordinary-queued', agent: { name: 'ordinary-queued', kind: 'pi', interactive: true }, prompt: 'queued task', detach: true }, {
    ...f.deps, list: async () => [{ name: 'holder', paneId: 'holder-pane', agentStatus: 'working' }],
    kinds: async () => ['pi'],
  });
  assert.equal(accepted.ok, true, JSON.stringify(accepted));
  assert.equal(accepted.data.status, 'queued');
  const original = spawn.readPersistedRegistry(f.ownerSession).find(r => r.name === 'ordinary-queued');
  assert.equal(original.pendingFollowups, undefined);
  assert.equal(original.paneId, undefined);
  const heldBack = [
    { ...original, name: 'unknown', startOutcomeUnknown: 'submission outcome must be reconciled' },
    { ...original, name: 'creating', startBeganAt: 1, startAttemptPhase: 'creating' },
    { ...original, name: 'terminal', delivery: { kind: 'done', at: 1 } },
    { ...original, name: 'identity-review', agentId: undefined, runId: undefined },
  ];
  spawn.writePersistedRegistry(f.ownerSession, [f.record, ...heldBack, original]);
  const childFile = join(root, 'restore.mjs');
  writeFileSync(childFile, `import fs from 'node:fs';
import {createJiti} from ${JSON.stringify(import.meta.resolve('jiti'))};
const root=${JSON.stringify(root)},owner=${JSON.stringify(f.ownerSession)};
const timer=globalThis.setTimeout;
globalThis.setTimeout=(fn,ms,...args)=>timer(fn,ms===3000?25:ms===1500?0:ms,...args);
const j=createJiti(import.meta.url,{fsCache:false});
const sp=await j.import(${JSON.stringify(join(ROOT, 'src/spawn.ts'))});
const {DEFAULT_SETTINGS}=await j.import(${JSON.stringify(join(ROOT, 'src/settings.ts'))});
const starts=[];
const parentTurn=new AbortController();parentTurn.abort();
const deps={parentSession:owner,env:{},signal:parentTurn.signal,load:()=>({...DEFAULT_SETTINGS,layout_mode:'spiral',max_parallel_agents:1}),
 list:async()=>{if(!fs.existsSync(root+'/capacity-free')){fs.writeFileSync(root+'/observed-full','');return [{name:'holder',paneId:'holder-pane',agentStatus:'working'}];}return [];},
 paneList:async()=>[],
 start:async input=>{if(input.signal?.aborted)return {ok:false,error:{code:'TIMEOUT',message:'expired parent turn cancelled background startup'}};starts.push(input.name);return {ok:true,data:{agent:{pane_id:'resumed-pane'}}};},
 boot:async()=>({ok:true,data:true}),submit:async()=>({ok:true,data:true}),
 status:async()=>({ok:true,data:'working'}),readEditor:async()=>({ok:true,data:{status:'working'}})};
sp.restoreSpawnRegistry(owner,deps);
await new Promise((resolve,reject)=>{const tick=()=>{const r=sp.spawnRecords().get('ordinary-queued');if(r?.submitted){fs.writeFileSync(root+'/restored.json',JSON.stringify({pid:process.pid,record:r,starts}));resolve();}else timer(tick,5);};tick();timer(()=>reject(new Error('restored queued task never started without manual re-arm')),1200).unref();});
`);
  const child = launchProcess(process.execPath, [childFile], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = ''; child.stderr.on('data', chunk => { stderr += chunk; });
  let exited = false;
  const exit = new Promise(resolve => child.once('exit', code => { exited = true; resolve(code); }));
  try {
    await until(() => existsSync(join(root, 'observed-full')) || exited, 'restored timer observes full capacity');
    assert.equal(exited, false, stderr);
    assert.equal(existsSync(join(root, 'restored.json')), false, 'capacity must still gate restored work');
    writeFileSync(join(root, 'capacity-free'), '');
    assert.equal(await exit, 0, stderr);
    const restored = JSON.parse(readFileSync(join(root, 'restored.json'), 'utf8'));
    assert.notEqual(restored.pid, process.pid);
    assert.deepEqual(restored.starts, ['ordinary-queued']);
    assert.equal(restored.record.agentId, original.agentId);
    assert.equal(restored.record.runId, original.runId);
    assert.equal(restored.record.sequence, original.sequence);
    assert.equal(restored.record.submitted, true);
  } finally { child.kill(); }
});

test('STARTFAIL platform publication simulation preserves fatal storage errors and immutable retries', async root => {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform');
  const descriptors = new Map();
  let fault, directoryAttempts = 0, fileFlushes = 0;
  const failure = () => Object.assign(new Error(`injected ${fault}`), { code: fault === 'directory' ? 'EISDIR' : 'EIO' });
  io.openSync = (path, ...args) => {
    if (String(path) === root) {
      directoryAttempts++;
      if (fault === 'directory') throw failure();
    }
    if (fault === 'open' && String(path).endsWith('.tmp')) throw failure();
    const fd = nativeIO.openSync(path, ...args); descriptors.set(fd, String(path)); return fd;
  };
  io.closeSync = fd => { descriptors.delete(fd); return nativeIO.closeSync(fd); };
  io.writeFileSync = (target, ...args) => {
    if (fault === 'write' && descriptors.get(target)?.endsWith('.tmp')) throw failure();
    return nativeIO.writeFileSync(target, ...args);
  };
  io.fsyncSync = fd => {
    if (descriptors.get(fd)?.endsWith('.tmp')) {
      fileFlushes++;
      if (fault === 'fsync') throw failure();
    }
    return nativeIO.fsyncSync(fd);
  };
  for (const key of ['linkSync', 'renameSync']) io[key] = (...args) => {
    if (fault === key) throw failure();
    return nativeIO[key](...args);
  };
  const record = name => ({ name, kind: 'pi', agentId: 'agent-1', runId: name, sequence: 1,
    sessionPath: join(root, name + '.jsonl'), startError: 'launch rejected' });
  try {
    Object.defineProperty(process, 'platform', { ...platform, value: 'win32' });
    fault = 'directory';
    const windows = record('windows-start');
    const event = sessionfile.saveAcceptedStartFailure(windows);
    assert.equal(directoryAttempts, 0, 'Windows must not open unsupported directory descriptors');
    assert.equal(fileFlushes, 2, 'both archive and bridge files must flush');
    assert.equal(event.persistenceCapability, 'file-flushed/process-restart');
    assert.deepEqual(JSON.parse(readFileSync(windows.sessionPath + '.exit', 'utf8')), event);
    assert.deepEqual(JSON.parse(readFileSync(windows.sessionPath + '.completion-windows-start.json', 'utf8')), event);
    for (const operation of ['open', 'write', 'fsync', 'linkSync', 'renameSync']) {
      fault = operation;
      const failed = record('windows-' + operation);
      assert.throws(() => sessionfile.saveAcceptedStartFailure(failed), /injected/, `${operation} must remain fatal on Windows`);
      if (operation === 'renameSync') {
        const archivePath = failed.sessionPath + '.completion-' + failed.runId + '.json';
        const archived = readFileSync(archivePath, 'utf8');
        fault = 'directory';
        sessionfile.saveAcceptedStartFailure(failed);
        assert.equal(readFileSync(archivePath, 'utf8'), archived);
        assert.equal(readFileSync(failed.sessionPath + '.exit', 'utf8'), archived);
      }
    }
    fault = 'directory';
    const legacy = record('legacy-start');
    const saved = { type: 'error', agentId: legacy.agentId, runId: legacy.runId, sequence: 1,
      eventId: legacy.runId, stopReason: 'start-error', errorMessage: 'original error', text: 'original failure' };
    const encoded = JSON.stringify(saved);
    const legacyPath = legacy.sessionPath + '.completion-' + legacy.runId + '.json';
    writeFileSync(legacyPath, encoded);
    sessionfile.saveAcceptedStartFailure(legacy);
    assert.equal(readFileSync(legacyPath, 'utf8'), encoded, 'legacy immutable event must not acquire new metadata');
    assert.equal(readFileSync(legacy.sessionPath + '.exit', 'utf8'), encoded);
    Object.defineProperty(process, 'platform', { ...platform, value: 'linux' });
    assert.throws(() => sessionfile.saveAcceptedStartFailure(record('posix-start')), { code: 'EISDIR' });
    assert.equal(directoryAttempts, 1, 'POSIX directory publication remains strict');
  } finally {
    Object.assign(io, nativeIO);
    Object.defineProperty(process, 'platform', platform);
  }
});

for (const { name, run } of tests) {
  if (process.argv[2] && !name.startsWith(process.argv[2])) continue;
  const root = mkdtempSync(join(tmpdir(), 'spec43-pr56-lifecycle-'));
  try { await run(root); console.log(`PASS ${name}`); }
  finally { spawn.clearSpawnRegistry(); delete process.env.HERDR_BIN_PATH; rmSync(root, { recursive: true, force: true }); }
}
