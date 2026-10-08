// T12 real-host acceptance: registered legacy message, gone-pane followup, workflow aggregation.
// Run: node tests/spec43-t12-live-verify.mjs
import assert from 'node:assert/strict';
import { createJiti } from 'jiti';
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';

assert.equal(process.env.HERDR_ENV, '1', 'must run inside a Herdr-managed pane');
const root = resolve('.');
const evidence = join(root, '.agents/evidence/spec43-t12/verify-live-rescue', randomUUID());
const scratch = join(evidence, 'project');
mkdirSync(scratch, { recursive: true });
mkdirSync(join(scratch, '.pi'), { recursive: true });
mkdirSync(join(evidence, 'sessions'), { recursive: true });
const parentSession = join(evidence, 'sessions/receiver.jsonl');
writeFileSync(parentSession, '');
const transport = join(evidence, 'transport.jsonl');
const cleanEnv = { ...process.env };
for (const key of Object.keys(cleanEnv)) {
  if (/^(HERDR_(?!ENV)|PI_HERDR_|PI_SESSION_FILE$)/.test(key)) delete cleanEnv[key];
}
const call = (command, args) => {
  const result = spawnSync(command, args, { cwd: scratch, env: cleanEnv, encoding: 'utf8', timeout: 30000 });
  appendFileSync(transport, JSON.stringify({ command: [command, ...args], status: result.status, signal: result.signal, stdout: (result.stdout ?? '').slice(0, 6000), stderr: (result.stderr ?? '').slice(0, 3000) }) + '\n');
  assert.equal(result.status, 0, `${command} ${args.join(' ')} failed: ${result.stderr}`);
  return result.stdout ?? '';
};
const cli = args => {
  const output = call('herdr', args);
  if (!output.trim() || (args[0] === 'pane' && args[1] === 'read')) return output;
  const response = JSON.parse(output);
  assert.ok(!response.error, JSON.stringify(response.error));
  return response.result;
};
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const until = async (check, label, timeoutMs = 90000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await sleep(250);
  }
  throw new Error(`T12 timeout: ${label}`);
};
const summaries = [];
let workspaceId;

try {
  const settingsPath = join(scratch, '.pi/herdr.json');
  writeFileSync(settingsPath, JSON.stringify({ agents_kill_switch: false, max_parallel_agents: 4, max_spawn_depth: 3, default_kind: 'pi', notifications: 'none', idle_rearm_minutes: 3 }));
  const workspace = cli(['workspace', 'create', '--cwd', scratch, '--label', 't12-live-rescue', '--no-focus']);
  workspaceId = workspace.workspace?.workspace_id ?? workspace.workspace_id;
  const pane = workspace.root_pane?.pane_id ?? workspace.root_pane?.id;
  const tabId = workspace.tab?.tab_id ?? workspace.tab_id;
  assert.ok(workspaceId && pane && tabId, JSON.stringify(workspace));
  process.env.HERDR_ENV = '1';
  process.env.HERDR_WORKSPACE_ID = workspaceId;
  process.env.HERDR_TAB_ID = tabId;
  process.env.HERDR_PANE_ID = pane;
  process.env.PI_HERDR_SESSION = parentSession;
  process.env.PI_HERDR_ROOT_SESSION = parentSession;
  process.env.PI_HERDR_AGENT_LABEL = 't12-parent';
  process.chdir(scratch);

  const jiti = createJiti(import.meta.url);
  const spawn = await jiti.import(join(root, 'src/spawn.ts'), { parent: root });
  const settings = await jiti.import(join(root, 'src/settings.ts'), { parent: root });
  const delivery = await jiti.import(join(root, 'src/delivery.ts'), { parent: root });
  const messageModule = await jiti.import(join(root, 'src/tools/message.ts'), { parent: root });
  const lifecycleModule = await jiti.import(join(root, 'src/tools/lifecycle.ts'), { parent: root });
  const workflowModule = await jiti.import(join(root, 'src/tools/workflow.ts'), { parent: root });
  const registry = { find: (provider, id) => ({ provider, id }), hasConfiguredAuth: () => true };
  const load = () => ({ ...settings.DEFAULT_SETTINGS, max_parallel_agents: 4, max_spawn_depth: 3, notifications: 'none', workflows_enabled: true });
  const deps = { parentSession, env: process.env, autodrain: false, load, registry };
  const pushes = [];
  const tick = async () => {
    await delivery.deliverOnce({ push: message => pushes.push(message), sessionPath: parentSession, load, storePullOnly: true });
    if (![...spawn.spawnRecords().values()].some(record => record.startBeganAt && !record.submitted && !record.startError && !record.delivery)) await spawn.drainQueueOnce(deps);
  };
  const waitFor = async predicate => until(async () => { await tick(); return predicate(); }, 'child event');
  const fixture = join(root, 'tests/fixtures/spec43-t12-verify-child.ts');
  assert.ok(existsSync(fixture), `missing deterministic child fixture: ${fixture}`);
  const launch = async ({ name, prompt, interactive }) => {
    const result = await spawn.spawnAgent({
      name,
      prompt,
      detach: true,
      cwd: scratch,
      agent: { name, kind: 'pi', interactive, auto_exit: !interactive, agent_args: ['-ne', '-ns', '-e', fixture, '--model', 't12-demo/deterministic', '--thinking', 'off'] },
    }, deps);
    assert.ok(result.ok, JSON.stringify(result));
    return spawn.spawnRecords().get(name);
  };
  const defs = [];
  const mockPi = { registerTool: definition => defs.push(definition), on: () => {}, sendMessage: (message, options) => pushes.push({ msg: message, opts: options }) };
  messageModule.registerMessageTool(mockPi);
  lifecycleModule.registerLifecycle(mockPi);
  const tool = name => defs.find(definition => definition.name === name);
  const messageTool = tool('herdr_message_agent');
  const followupTool = tool('herdr_trigger_turn');
  assert.ok(messageTool && followupTool, 'production legacy and followup tools registered');

  // L1 — execute the registered production tool handler; child is a real pi TUI.
  {
    const child = await launch({ name: 't12-legacy', prompt: 'BUSY PANDA', interactive: true });
    const trace = `${child.sessionPath}.t12-trace.jsonl`;
    await waitFor(() => existsSync(trace) && readFileSync(trace, 'utf8').includes('"state":"tool"'));
    const receipt = await messageTool.execute('t12-live-message', { target: child.name, text: 'LEGACY PANDA' }, undefined);
    assert.equal(receipt.isError, undefined, JSON.stringify(receipt));
    assert.equal(receipt.details?.delivery, 'message');
    await waitFor(() => existsSync(trace) && readFileSync(trace, 'utf8').includes('T12_FINAL') && readFileSync(trace, 'utf8').includes('LEGACY PANDA'));
    const transcript = readFileSync(child.sessionPath, 'utf8');
    assert.ok(transcript.includes('T12_FINAL') && transcript.includes('LEGACY PANDA'), 'registered legacy call injected the envelope into the live child session');
    const traceRows = readFileSync(trace, 'utf8').trim().split('\n').map(JSON.parse);
    const busy = traceRows.find(row => row.state === 'tool');
    const final = traceRows.find(row => row.state === 'final' && row.text.includes('LEGACY PANDA'));
    assert.ok(busy && final && busy.timestamp <= final.timestamp, 'message was queued behind the in-flight child tool');
    assert.equal(existsSync(`${child.sessionPath}.takeover`), false);
    assert.equal(existsSync(`${child.sessionPath}.steer`), false);
    assert.equal(existsSync(`${child.sessionPath}.queue-only-inbox.json`), false);
    const terminal = cli(['pane', 'read', child.paneId, '--source', 'recent', '--lines', '120', '--format', 'text']);
    assert.ok(!terminal.includes('took over'), 'real TUI has no takeover notice');
    const legacySettings = settings.loadSettings({ projectPath: settingsPath, globalPath: join(scratch, 'missing-global.json') });
    assert.equal(legacySettings.issues.length, 0);
    assert.equal(legacySettings.effective.idle_rearm_minutes, 15, 'legacy idle re-arm setting stays inert');
    writeFileSync(join(evidence, 'l1-child.jsonl'), transcript);
    copyFileSync(trace, join(evidence, 'l1-trace.jsonl'));
    writeFileSync(join(evidence, 'l1-terminal.txt'), terminal);
    summaries.push({ scenario: 'registered-legacy-message', registeredToolExecuted: true, queuedBehindBusyTool: true, noTakeoverOrRearm: true, receipt: receipt.details, realHerdrCLI: true, realPiTUI: true });
  }

  // L2 — call the registered followup tool after autonomous pane recycle.
  {
    const child = await launch({ name: 't12-followup', prompt: 'FIRST RUN', interactive: false });
    const trace = `${child.sessionPath}.t12-trace.jsonl`;
    await waitFor(() => existsSync(`${child.sessionPath}.exit`));
    const first = JSON.parse(readFileSync(`${child.sessionPath}.exit`, 'utf8'));
    await until(() => !cli(['pane', 'list']).panes.some(item => item.pane_id === child.paneId), 'autonomous pane gone');
    const result = await followupTool.execute('t12-live-followup', { target: child.name, text: 'SECOND TASK' }, undefined);
    assert.equal(result.isError, undefined, JSON.stringify(result));
    const newRunId = result.details.runId;
    await waitFor(() => existsSync(`${child.sessionPath}.exit`) && JSON.parse(readFileSync(`${child.sessionPath}.exit`, 'utf8')).runId === newRunId);
    const second = JSON.parse(readFileSync(`${child.sessionPath}.exit`, 'utf8'));
    assert.notEqual(second.runId, first.runId, 'followup uses a new run identity');
    assert.notEqual(second.eventId, first.eventId, 'old completion event cannot satisfy the new run');
    assert.ok(readFileSync(child.sessionPath, 'utf8').includes('FIRST RUN'), 'same retained session preserves the first conversation');
    assert.ok(readFileSync(trace, 'utf8').includes('SECOND TASK'), 'new run executes its followup task');
    writeFileSync(join(evidence, 'l2-child.jsonl'), readFileSync(child.sessionPath, 'utf8'));
    copyFileSync(trace, join(evidence, 'l2-trace.jsonl'));
    writeFileSync(join(evidence, 'l2-first.exit.json'), JSON.stringify(first, null, 2));
    writeFileSync(join(evidence, 'l2-second.exit.json'), JSON.stringify(second, null, 2));
    const completion = `${child.sessionPath}.completion-${second.eventId}.json`;
    if (existsSync(completion)) copyFileSync(completion, join(evidence, 'l2-second.completion.json'));
    summaries.push({ scenario: 'gone-pane-followup', sameSession: child.sessionPath, firstRunId: first.runId, secondRunId: second.runId, firstEventId: first.eventId, secondEventId: second.eventId, realHerdrCLI: true, realPiTUI: true });
  }

  // L3 — the registered workflow tool aggregates a real child's answer once as a summary.
  {
    let workflowChildSession;
    let trace;
    const workflowHost = {
      async spawnAgent(request) {
        const child = await launch({ name: request.label, prompt: request.prompt, interactive: false });
        workflowChildSession = child.sessionPath;
        trace = `${child.sessionPath}.t12-trace.jsonl`;
        await waitFor(() => existsSync(trace) && readFileSync(trace, 'utf8').includes('T12_FINAL WORKFLOW CHILD SENTINEL'));
        const final = readFileSync(trace, 'utf8').trim().split('\n').map(JSON.parse).findLast(row => row.state === 'final' && row.text.includes('WORKFLOW CHILD SENTINEL'));
        assert.ok(child.sessionPath && final, 'workflow adapter observed a real pi child final');
        return { ok: true, text: final.text };
      },
      abortAgent() {},
    };
    workflowModule.registerWorkflowTool(mockPi, { load, host: workflowHost, cwd: scratch });
    const workflowTool = tool('herdr_run_workflow');
    assert.ok(workflowTool, 'production workflow tool registered');
    const script = `export const meta = { name: 't12-live-aggregate', description: 'prove aggregate does not republish a child final' }\nconst child = await agent('WORKFLOW CHILD SENTINEL', { label: 't12-wf-child', model: 't12-demo/deterministic' })\nreturn { childCompleted: child.includes('T12_FINAL WORKFLOW CHILD SENTINEL') }`;
    const accepted = await workflowTool.execute('t12-live-workflow', { script }, undefined, undefined, undefined);
    assert.equal(accepted.isError, undefined, JSON.stringify(accepted));
    const runId = accepted.details.runId;
    const aggregate = await until(() => pushes.find(item => (item.msg ?? item).details?.kind === 'workflow' && (item.msg ?? item).details?.runId === runId), 'workflow aggregate push');
    const aggregateMessage = aggregate.msg ?? aggregate;
    const childBody = 'T12_FINAL WORKFLOW CHILD SENTINEL';
    assert.ok(workflowChildSession, 'workflow host retained the real child session path');
    const childTranscript = readFileSync(workflowChildSession, 'utf8');
    assert.ok(childTranscript.includes(childBody), 'real workflow child session contains its unique final body');
    assert.ok(!aggregateMessage.content.includes(childBody), 'aggregate summary does not duplicate child final body');
    writeFileSync(join(evidence, 'l3-child.jsonl'), childTranscript);
    copyFileSync(trace, join(evidence, 'l3-trace.jsonl'));
    writeFileSync(join(evidence, 'l3-aggregate.json'), JSON.stringify({ runId, content: aggregateMessage.content, details: aggregateMessage.details }, null, 2));
    summaries.push({ scenario: 'workflow-aggregate-no-child-body', runId, childFinalPresent: true, aggregateContainsChildFinal: false, aggregateContent: aggregateMessage.content, realHerdrCLI: true, realPiTUI: true });
  }

  writeFileSync(join(evidence, 'summary.json'), JSON.stringify(summaries, null, 2));
  writeFileSync(join(evidence, 'evidence.json'), JSON.stringify({ feature: 'spec43-t12-live-verify', boundary: 'Production registered message/followup/workflow tool handlers; real Herdr CLI workspaces and real child pi TUIs; deterministic model provider only. Workflow host adapter launches a real pi child through the production spawn engine.' }, null, 2));
  console.log(`GREEN spec43-t12 live verify ${evidence}`);
} catch (error) {
  writeFileSync(join(evidence, 'summary.json'), JSON.stringify({ failed: true, error: String(error?.stack ?? error), summaries }, null, 2));
  throw error;
} finally {
  if (workspaceId) {
    const result = spawnSync('herdr', ['workspace', 'close', workspaceId], { env: cleanEnv, encoding: 'utf8', timeout: 30000 });
    appendFileSync(join(evidence, 'cleanup.jsonl'), JSON.stringify({ command: ['herdr', 'workspace', 'close', workspaceId], status: result.status, stdout: result.stdout, stderr: result.stderr }) + '\n');
  }
}
