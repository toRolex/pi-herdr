// Production child entry + real SDK/SessionManager; only provider and external I/O are controlled.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createJiti } from 'jiti';
import { syncBuiltinESMExports } from 'node:module';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

for (const key of Object.keys(process.env)) {
  if (/^(HERDR|PI_HERDR)/.test(key) || key === 'PI_SESSION_FILE') delete process.env[key];
}
process.env.PI_OFFLINE = '1';
const jiti = createJiti(import.meta.url, { fsCache: false });
const sdk = await import('../node_modules/@earendil-works/pi-coding-agent/dist/index.js');
const { createAssistantMessageEventStream } = await import('../node_modules/@earendil-works/pi-ai/dist/index.js');
const child = await jiti.import('../src/child.ts');
const lifecycle = await jiti.import('../src/tools/lifecycle.ts');
const spawn = await jiti.import('../src/spawn.ts');
const settings = await jiti.import('../src/settings.ts');
const selected = process.argv[2];
const cases = [];
const test = (name, run) => cases.push({ name, run });
const deferred = () => {
  let resolve;
  const promise = new Promise(r => resolve = r);
  return { promise, resolve };
};
const text = message => typeof message?.content === 'string' ? message.content
  : (message?.content ?? []).filter(p => p.type === 'text').map(p => p.text).join('\n');

async function fixture({ autoExit = false, output, tools = [], schema } = {}) {
  const dir = fs.mkdtempSync(join(tmpdir(), 'pr56-child-sdk-'));
  const manager = sdk.SessionManager.create(dir, join(dir, 'sessions'));
  const sessionPath = manager.getSessionFile();
  Object.assign(process.env, {
    PI_HERDR_SESSION: sessionPath, PI_HERDR_AGENT_ID: 'child-agent',
    PI_HERDR_RUN_ID: 'run-one', PI_HERDR_NAME: 'child', PI_HERDR_SEQUENCE: '1',
    PI_HERDR_AUTO_EXIT: autoExit ? '1' : '0',
  });
  delete process.env.PI_HERDR_SCHEMA;
  if (schema) {
    process.env.PI_HERDR_SCHEMA = join(dir, 'schema.json');
    fs.writeFileSync(process.env.PI_HERDR_SCHEMA, JSON.stringify(schema));
  }
  const contexts = [], errors = [], events = [];
  let shutdowns = 0;
  const model = {
    provider: 'child-regression', id: 'deterministic', name: 'offline', api: 'child-regression-api',
    baseUrl: 'http://localhost.invalid', reasoning: false, input: ['text', 'image'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 1024,
  };
  const provider = pi => {
    for (const tool of tools) pi.registerTool(tool);
    for (const name of ['input', 'agent_start', 'message_start', 'agent_settled']) {
      pi.on(name, event => events.push({ type: name, source: event.source, text: event.text, message: event.message }));
    }
    pi.registerProvider(model.provider, {
      api: model.api, baseUrl: model.baseUrl, apiKey: 'offline', models: [model],
      streamSimple(_model, context) {
        const index = contexts.length;
        contexts.push(structuredClone(context));
        const stream = createAssistantMessageEventStream();
        queueMicrotask(async () => {
          try {
            const result = await output(index, context);
            const content = typeof result === 'string' ? [{ type: 'text', text: result }] : result;
            const message = {
              role: 'assistant', api: model.api, provider: model.provider, model: model.id,
              content, stopReason: content.some(p => p.type === 'toolCall') ? 'toolUse' : 'stop',
              timestamp: Date.now(), usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0,
                totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
            };
            stream.push({ type: 'start', partial: message });
            stream.push({ type: 'done', reason: message.stopReason, message });
            stream.end();
          } catch (error) { stream.end(); errors.push(error); }
        });
        return stream;
      },
    });
  };
  const config = sdk.SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false }, cacheWarming: { enabled: false } });
  const loader = new sdk.DefaultResourceLoader({
    cwd: dir, agentDir: join(dir, 'agent'), settingsManager: config,
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    extensionFactories: [child.default, provider],
  });
  await loader.reload();
  const runtime = await sdk.ModelRuntime.create({ authPath: join(dir, 'auth.json'), modelsPath: null, refreshOnCreate: false });
  const { session } = await sdk.createAgentSession({
    cwd: dir, agentDir: join(dir, 'agent'), resourceLoader: loader, modelRuntime: runtime, model,
    thinkingLevel: 'off', settingsManager: config, sessionManager: manager,
  });
  await session.bindExtensions({ shutdownHandler: () => shutdowns++, onError: e => errors.push(e) });
  return {
    session, sessionPath, dir, contexts, errors, events, get shutdowns() { return shutdowns; },
    event: run => JSON.parse(fs.readFileSync(`${sessionPath}.completion-${run}.json`, 'utf8')),
    cleanup() { session.dispose(); fs.rmSync(dir, { recursive: true, force: true }); },
  };
}

test('R2', async () => {
  const entered = deferred(), release = deferred();
  const f = await fixture({ autoExit: true, output: async (index, context) => {
    if (index === 0) { entered.resolve(); await release.promise; }
    return `FINAL:${text([...context.messages].reverse().find(m => m.role === 'user'))}`;
  } });
  spawn.clearSpawnRegistry();
  const record = {
    name: 'child', agentId: 'child-agent', runId: 'run-one', sequence: 1, kind: 'pi',
    paneId: 'offline-pane', sessionPath: f.sessionPath, stance: 'autonomous',
    prompt: 'first task', agentArgs: [], cwd: f.dir, depth: 1, spawnedAt: 1, startedAt: 1, submitted: true,
  };
  spawn.putSpawnRecordForTests(record);
  let running;
  try {
    running = f.session.prompt('first task');
    await entered.promise;
    const ownerSession = join(f.dir, 'parent.jsonl');
    fs.writeFileSync(ownerSession, '');
    record.lineage = { ownerSession, rootSession: ownerSession };
    const result = await lifecycle.triggerTurn({ target: 'child', text: 'second dispatched task' }, {
      parentSession: ownerSession,
      autodrain: false, env: {}, load: () => ({ ...settings.DEFAULT_SETTINGS, max_parallel_agents: 1 }),
      // Explicitly stale fleet observation; the real child is streaming.
      fleet: async () => ({ ok: true, data: [{ paneId: 'offline-pane', agentStatus: 'idle' }] }),
      submit: async (_pane, envelope) => { await f.session.prompt(envelope); return { ok: true, data: true }; },
      herdr: async () => { throw new Error('real Herdr forbidden'); },
    });
    assert.equal(result.ok, true);
    assert.equal(f.session.isStreaming, true);
    release.resolve(); await running;
    const event = f.event(result.data.runId);
    assert.equal(event.agentId, 'child-agent');
    assert.equal(event.runId, result.data.runId);
    assert.equal(event.sequence, 1);
    assert.match(event.text, /second dispatched task/);
    assert.equal(fs.existsSync(f.sessionPath + '.completion-run-one.json'), false, 'new body must not be archived under the old identity');
    assert.equal(JSON.parse(fs.readFileSync(f.sessionPath + '.exit', 'utf8')).runId, result.data.runId);
    assert.equal(f.contexts.length, 2);
    assert.equal(f.shutdowns, 1);
    assert.deepEqual(f.errors, []);
    assert.match(fs.readFileSync(f.sessionPath, 'utf8'), /second dispatched task/, 'actual SDK host persisted the dispatched input');
  } finally { release.resolve(); await running; f.cleanup(); spawn.clearSpawnRegistry(); }
});

test('R8', async () => {
  const { Type } = await jiti.import('typebox');
  const entered = deferred(), release = deferred();
  const image = { type: 'image', mimeType: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==' };
  let toolFinished = false;
  const f = await fixture({
    tools: [{ name: 'hold_input', description: 'Hold offline tool', parameters: Type.Object({}),
      execute: async (_id, _params, signal) => {
        entered.resolve(); await release.promise;
        assert.equal(signal?.aborted, false, 'ordinary busy input must not interrupt the tool');
        toolFinished = true;
        return { content: [{ type: 'text', text: 'held tool finished' }], details: {} };
      } }],
    output: index => index === 0 ? [{ type: 'toolCall', id: 'hold', name: 'hold_input', arguments: {} }] : 'finished',
  });
  let running;
  try {
    running = f.session.prompt('initial task');
    await entered.promise;
    await f.session.prompt('VIEW_ATTACHED_SCREENSHOT', { images: [image] });
    release.resolve(); await running;
    assert.equal(toolFinished, true);
    const received = f.contexts.flatMap(c => c.messages).filter(m => m.role === 'user' && text(m).includes('VIEW_ATTACHED_SCREENSHOT'));
    assert.ok(received.length > 0, 'queued input text reached the provider');
    assert.ok(received.some(m => m.content.some(p => p.type === 'image' && p.data === image.data && p.mimeType === image.mimeType)), 'queued input image reached the provider unchanged');
    const persisted = f.session.sessionManager.getEntries().filter(e => e.message?.role === 'user' && text(e.message).includes('VIEW_ATTACHED_SCREENSHOT'));
    assert.equal(persisted.length, 1);
    assert.ok(persisted[0].message.content.some(p => p.type === 'image' && p.data === image.data), 'real SDK JSONL retains the image');
    assert.deepEqual(f.errors, []);
    assert.equal(f.shutdowns, 0, 'interactive child remains resident');
  } finally { release.resolve(); await running; f.cleanup(); }
});

test('R10', async () => {
  const oldValue = 'RESULT PRODUCED BY RUN ONE', newValue = 'RESULT PRODUCED BY RUN TWO';
  const call = (id, name, args = {}) => [{ type: 'toolCall', id, name, arguments: args }];
  const outputs = [
    call('structured-one', 'StructuredOutput', { value: oldValue }), 'first interactive run settled',
    call('invalid-done-two', 'agent_done'), call('structured-two', 'StructuredOutput', { value: newValue }),
    call('valid-done-two', 'agent_done'), 'finished',
  ];
  const f = await fixture({
    schema: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'], additionalProperties: false },
    output: index => outputs[index] ?? 'unexpected request',
  });
  try {
    await f.session.prompt('First task: produce structured output');
    assert.equal(fs.existsSync(f.sessionPath + '.exit'), false, 'interactive settle does not complete the first run');
    await f.session.prompt('<herdr-followup runId="run-two">\nSecond task requires its own answer\n</herdr-followup>');
    const refused = f.session.sessionManager.getEntries().find(e => e.message?.toolCallId === 'invalid-done-two');
    assert.equal(refused?.message.isError, true, 'R1 capture cannot satisfy bare agent_done in R2');
    const event = f.event('run-two');
    assert.equal(event.runId, 'run-two');
    assert.equal(event.structured, JSON.stringify({ value: newValue }), 'the registered StructuredOutput tool still captures this run');
    assert.equal(JSON.stringify(event).includes(oldValue), false);
    assert.equal(f.shutdowns, 1, 'only completion with R2 payload may request shutdown');
    assert.deepEqual(f.errors, []);
  } finally { f.cleanup(); }
});

test('R5', async () => {
  const originals = { openSync: fs.openSync, writeFileSync: fs.writeFileSync, closeSync: fs.closeSync };
  const descriptors = new Map();
  let injected = false, observedFailure, f;
  const body = 'FULL DURABLE RESULT AFTER A TRANSIENT DISK FAILURE';
  f = await fixture({ output: index => {
    if (index === 1) {
      observedFailure = {
        injected, published: fs.existsSync(f.sessionPath + '.completion-run-one.json'),
        failure: JSON.parse(fs.readFileSync(f.sessionPath + '.exit', 'utf8')), shutdowns: f.shutdowns,
      };
    }
    return index < 2 ? [{ type: 'text', text: body }, { type: 'toolCall', id: `done-${index}`, name: 'agent_done', arguments: {} }] : 'finished';
  } });
  fs.openSync = (path, ...args) => {
    const fd = originals.openSync(path, ...args); descriptors.set(fd, String(path)); return fd;
  };
  fs.closeSync = fd => { descriptors.delete(fd); return originals.closeSync(fd); };
  fs.writeFileSync = (target, data, ...args) => {
    if (!injected && typeof target === 'number' && descriptors.get(target)?.startsWith(f.sessionPath + '.completion-run-one.json')) {
      injected = true;
      originals.writeFileSync(target, String(data).slice(0, 12));
      throw Object.assign(new Error('injected transient ENOSPC during event write'), { code: 'ENOSPC' });
    }
    return originals.writeFileSync(target, data, ...args);
  };
  syncBuiltinESMExports();
  try {
    await f.session.prompt('Produce a durable completion; retry if storage recovers');
    assert.equal(observedFailure?.injected, true, 'fault must target the actual child event write');
    assert.equal(observedFailure.published, false, 'a partial write must not publish a terminal event');
    assert.equal(observedFailure.failure.type, 'persistence-error');
    assert.match(observedFailure.failure.errorMessage, /ENOSPC/);
    assert.equal(observedFailure.shutdowns, 0, 'failed publication keeps the child open');
    const entries = f.session.sessionManager.getEntries();
    assert.equal(entries.find(e => e.message?.toolCallId === 'done-0')?.message.isError, true);
    assert.equal(entries.find(e => e.message?.toolCallId === 'done-1')?.message.isError, false, 'same-run retry must recover without manual repair');
    const event = f.event('run-one');
    assert.equal(event.type, 'done'); assert.equal(event.text, body); assert.equal(event.runId, 'run-one');
    assert.deepEqual(JSON.parse(fs.readFileSync(f.sessionPath + '.exit', 'utf8')), event);
    assert.equal(f.shutdowns, 1);
    assert.deepEqual(f.errors, []);
    assert.equal(fs.readdirSync(join(f.dir, 'sessions')).some(name => name.includes('.completion-run-one.json') && name.endsWith('.tmp')), false, 'unpublished scratch is cleaned after recovery');
  } finally { Object.assign(fs, originals); syncBuiltinESMExports(); f.cleanup(); }
});

test('R5-sidecar', async () => {
  const rename = fs.renameSync;
  let injected = false, archiveBeforeRetry, f;
  const body = 'IMMUTABLE BODY BEFORE SIDECAR RECOVERY';
  f = await fixture({ output: index => {
    if (index === 1) archiveBeforeRetry = fs.readFileSync(f.sessionPath + '.completion-run-one.json', 'utf8');
    return index < 2 ? [{ type: 'text', text: body }, { type: 'toolCall', id: `sidecar-done-${index}`, name: 'agent_done', arguments: {} }] : 'finished';
  } });
  fs.renameSync = (source, target) => {
    if (!injected && target === f.sessionPath + '.exit') {
      injected = true;
      throw Object.assign(new Error('injected EIO publishing the legacy bridge'), { code: 'EIO' });
    }
    return rename(source, target);
  };
  syncBuiltinESMExports();
  try {
    await f.session.prompt('Retry completion after sidecar storage recovers');
    assert.equal(injected, true);
    assert.equal(f.session.sessionManager.getEntries().find(e => e.message?.toolCallId === 'sidecar-done-0').message.isError, true);
    assert.equal(f.session.sessionManager.getEntries().find(e => e.message?.toolCallId === 'sidecar-done-1').message.isError, false);
    assert.equal(fs.readFileSync(f.sessionPath + '.completion-run-one.json', 'utf8'), archiveBeforeRetry, 'sidecar retry cannot replace the already published event');
    assert.equal(f.event('run-one').text, body);
    assert.equal(JSON.parse(fs.readFileSync(f.sessionPath + '.exit', 'utf8')).text, body);
    assert.equal(f.shutdowns, 1); assert.deepEqual(f.errors, []);
  } finally { fs.renameSync = rename; syncBuiltinESMExports(); f.cleanup(); }
});

test('R5-existing', async () => {
  for (const conflict of [false, true]) {
    const archived = '{"type":"done","text":"PREEXISTING COMPLETE RESULT","eventId":"run-one","agentId":"child-agent","runId":"run-one","sequence":1}';
    const f = await fixture({ output: index => index === 0 ? [
      { type: 'text', text: conflict ? 'A DIFFERENT RESULT' : 'PREEXISTING COMPLETE RESULT' },
      { type: 'toolCall', id: 'declare', name: 'agent_done', arguments: {} },
    ] : 'finished' });
    try {
      fs.writeFileSync(f.sessionPath + '.completion-run-one.json', archived);
      await f.session.prompt('Declare completion with an existing immutable event');
      assert.equal(fs.readFileSync(f.sessionPath + '.completion-run-one.json', 'utf8'), archived, 'no writer may replace a committed event');
      const toolResult = f.session.sessionManager.getEntries().find(e => e.message?.toolCallId === 'declare').message;
      assert.equal(toolResult.isError, conflict);
      assert.equal(f.shutdowns, conflict ? 0 : 1);
      const sidecar = JSON.parse(fs.readFileSync(f.sessionPath + '.exit', 'utf8'));
      if (conflict) {
        assert.equal(sidecar.type, 'persistence-error');
        assert.match(sidecar.errorMessage, /already committed with different content/);
      } else assert.equal(sidecar.text, 'PREEXISTING COMPLETE RESULT');
      assert.deepEqual(f.errors, []);
    } finally { f.cleanup(); }
  }
});

test('R5-windows-capability-simulation', async () => {
  // Platform selection only is simulated; the SDK and filesystem remain real.
  const platform = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { ...platform, value: 'win32' });
  let f;
  try {
    f = await fixture({ autoExit: true, output: () => 'FULL WINDOWS CAPABILITY RESULT' });
    await f.session.prompt('Persist completion under the Windows file-flush capability');
    const event = f.event('run-one');
    assert.equal(event.persistenceCapability, 'file-flushed/process-restart');
    assert.equal(event.text, 'FULL WINDOWS CAPABILITY RESULT');
    assert.deepEqual(JSON.parse(fs.readFileSync(f.sessionPath + '.exit', 'utf8')), event);
    assert.equal(f.shutdowns, 1); assert.deepEqual(f.errors, []);
  } finally { f?.cleanup(); Object.defineProperty(process, 'platform', platform); }
});

test('R2-R8-R10-busy', async () => {
  const { Type } = await jiti.import('typebox');
  const entered = deferred(), release = deferred();
  const image = { type: 'image', mimeType: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==' };
  const call = (id, name, args = {}) => [{ type: 'toolCall', id, name, arguments: args }];
  const outputs = [call('old-structured', 'StructuredOutput', { value: 'OLD RUN CAPTURE' }),
    call('held', 'hold_schema'), 'first task finished', call('empty-new-done', 'agent_done'),
    call('new-structured', 'StructuredOutput', { value: 'NEW RUN CAPTURE' }), call('new-done', 'agent_done'), 'finished'];
  const f = await fixture({
    schema: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'], additionalProperties: false },
    tools: [{ name: 'hold_schema', description: 'Hold old run tool', parameters: Type.Object({}), execute: async () => {
      entered.resolve(); await release.promise; return { content: [{ type: 'text', text: 'tool finished' }], details: {} };
    } }], output: index => outputs[index] ?? 'unexpected request',
  });
  let running;
  try {
    running = f.session.prompt('First structured task'); await entered.promise;
    await f.session.prompt('<herdr-followup runId="run-two">\nSecond structured task with image\n</herdr-followup>', { images: [image] });
    assert.equal(fs.readFileSync(f.sessionPath + '.completion-event', 'utf8'), 'run-one', 'input replay cannot bind R2 while R1 tool is running');
    release.resolve(); await running;
    const refused = f.session.sessionManager.getEntries().find(e => e.message?.toolCallId === 'empty-new-done');
    assert.equal(refused?.message.isError, true, 'busy queued R2 cannot reuse R1 structured capture');
    const event = f.event('run-two');
    assert.equal(event.structured, '{"value":"NEW RUN CAPTURE"}');
    assert.equal(f.contexts[3].messages.filter(m => m.role === 'user' && text(m).includes('Second structured task')).some(m => m.content.some(p => p.type === 'image' && p.data === image.data)), true);
    assert.equal(fs.existsSync(f.sessionPath + '.completion-run-one.json'), false);
    assert.equal(f.shutdowns, 1); assert.deepEqual(f.errors, []);
  } finally { release.resolve(); await running; f.cleanup(); }
});

assert.ok(!selected || cases.some(item => item.name === selected), 'unknown regression case');
for (const item of cases) {
  if (selected && selected !== item.name) continue;
  if (selected) {
    await item.run();
    console.log(`GREEN ${item.name}: production child + real SDK/SessionManager`);
  } else {
    // Isolate provider registrations and FS fault injection across real hosts.
    const result = spawnSync(process.execPath, [fileURLToPath(import.meta.url), item.name], {
      encoding: 'utf8', timeout: 30000, env: process.env,
    });
    assert.equal(result.status, 0, `${item.name}: ${result.stderr || result.error || result.stdout}`);
    process.stdout.write(result.stdout);
  }
}
