import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const tmp = mkdtempSync(join(tmpdir(), 'pi-herdr-turn-release-'));
const childName = `turn-probe-${tmp.split('-').at(-1).toLowerCase()}`;
const provider = join(root, 'tests/fixtures/turn-probe.ts');
const entry = join(root, 'tests/fixtures/turn-probe-entry.ts');
const legacy = process.argv.includes('--legacy-result');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const cli = args => {
  const output = execFileSync('herdr', args, { encoding: 'utf8', timeout: 15000 });
  let value;
  try { value = JSON.parse(output); } catch { return output; }
  if (value.error) throw new Error(JSON.stringify(value.error));
  return value.result;
};
const status = pane => cli(['agent', 'get', pane]).agent.agent_status;
const messages = () => existsSync(join(tmp, 'parent.jsonl')) ? readFileSync(join(tmp, 'parent.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(x => JSON.parse(x)).map(x => x.type === 'custom_message' ? { ...x, message: { customType: x.customType, content: x.content } } : x).filter(x => x.type === 'message' || x.type === 'custom_message') : [];
const textOf = m => typeof m?.content === 'string' ? m.content : (m?.content ?? []).filter(x => x.type === 'text').map(x => x.text).join('\n');
const until = async (predicate, timeout = 2500) => {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (predicate()) return Date.now() - start < timeout;
    await sleep(50);
  }
  return false;
};
mkdirSync(join(tmp, '.pi/agents'), { recursive: true });
writeFileSync(join(tmp, '.pi/herdr.json'), JSON.stringify({ max_spawn_depth: 4, max_parallel_agents: 8, notifications: 'normal', workflows_enabled: true }));
writeFileSync(join(tmp, `.pi/agents/${childName}.md`), `---\nname: ${childName}\nkind: pi\nargs: ["-ne", "-e", "${provider}"]\n---\nDeterministic test fixture.\n`);
const tab = cli(['tab', 'create', '--cwd', tmp, '--label', 'turn-release-test', '--no-focus', '--env', 'PI_HERDR_SPAWN_DEPTH=0', '--env', `TURN_PROBE_EXTENSION=${provider}`, '--env', `TURN_PROBE_CHILD_NAME=${childName}`, '--env', `TURN_PROBE_LOG=${join(tmp, 'settled.jsonl')}`, '--env', `TURN_PROBE_LEGACY_RESULT=${legacy ? '1' : '0'}`]);
const pane = tab.root_pane.pane_id;
try {
  await sleep(400);
  cli(['agent', 'start', `${childName}-parent`, '--kind', 'pi', '--pane', pane, '--timeout', '10000', '--', '-ne', '-ns', '-e', entry, '-e', provider, '--model', 'turn-probe/deterministic', '--thinking', 'off', '--session', join(tmp, 'parent.jsonl')]);
  const start = Date.now();
  cli(['agent', 'prompt', pane, 'probe-dispatch']);
  assert(await until(() => messages().some(x => textOf(x.message) === 'PARENT_READY') && ['done', 'idle'].includes(status(pane)) && existsSync(join(tmp, 'settled.jsonl')) && readFileSync(join(tmp, 'settled.jsonl'), 'utf8').includes('"name":"parent"'), Math.max(0, 2500 - (Date.now() - start))), 'parent must finish within 2.5s while child has 8s of work');
  const spawnResult = messages().find(x => x.message.toolName === 'herdr_spawn_agent');
  assert(spawnResult && !spawnResult.message.isError && !spawnResult.message.details?.error && Date.parse(spawnResult.timestamp) - start < 2500, 'spawn succeeds before child completes');
  const snapshot = messages().find(x => x.message.toolName === 'herdr_get_agent_result')?.message;
  assert(snapshot && !snapshot.isError && !snapshot.details?.error, 'result tool succeeds rather than rejecting extra wait input');
  assert(['queued', 'starting', 'active', 'running'].includes(snapshot.details?.status), 'result is a successful mid-flight snapshot');
  console.log(`GREEN parent settled in ${Date.now() - start}ms; spawn and result did not wait for child`);
  cli(['agent', 'prompt', pane, 'normal-user-conversation']);
  assert(await until(() => messages().filter(x => textOf(x.message) === 'PARENT_READY').length >= 2 && ['done', 'idle'].includes(status(pane))), 'new user turn succeeds before child completes');
  const childWorking = await until(() => cli(['agent', 'list']).agents.some(x => x.name === childName && x.agent_status === 'working'), 15000);
  if (!childWorking) {
    console.log(cli(['pane', 'read', pane, '--source', 'recent', '--lines', '40', '--format', 'text']));
    for (const a of cli(['agent', 'list']).agents.filter(x => x.name === childName)) console.log(cli(['pane', 'read', a.pane_id, '--source', 'recent', '--lines', '25', '--format', 'text']));
  }
  assert(childWorking, 'child continues after parent settled');
  console.log('GREEN ordinary user conversation while child remains working');
  const { createJiti } = await import('jiti');
  const jiti = createJiti(import.meta.url);
  const { messageAgent } = await jiti.import(join(root, 'src/tools/message.ts'));
  const readyBeforeReply = messages().filter(x => textOf(x.message) === 'PARENT_READY').length;
  const receipt = await messageAgent({ target: pane, text: 'CHILD_REPLY_PROBE' }, { env: { PI_HERDR_NAME: childName } });
  assert(receipt.ok && receipt.data.state !== 'working', 'real CLI message delivered to settled parent');
  assert(await until(() => messages().some(x => x.message.role === 'user' && textOf(x.message).includes('CHILD_REPLY_PROBE'))), 'message reached real pi transcript');
  assert(await until(() => messages().filter(x => textOf(x.message) === 'PARENT_READY').length > readyBeforeReply && ['done', 'idle'].includes(status(pane))), 'parent finishes a new turn after child message');
  console.log('GREEN child message reaches idle parent without a Steering backlog');
  assert(await until(() => messages().some(x => x.message.customType === 'herdr-delivery' && textOf(x.message).includes('CHILD_COMPLETE')), 15000), 'child completion report reaches parent asynchronously');
  console.log('GREEN asynchronous child completion report');
  cli(['agent', 'prompt', pane, 'probe-workflow']);
  assert(await until(() => messages().some(x => x.message.toolName === 'herdr_run_workflow')), 'workflow tool returns within 2.5s');
  assert(await until(() => ['done', 'idle'].includes(status(pane))), 'parent settles without awaiting workflow children');
  assert(await until(() => messages().some(x => x.message.customType === 'herdr-delivery' && textOf(x.message).includes('turn-probe-workflow') && textOf(x.message).includes('CHILD_COMPLETE')), 20000), 'workflow result reports asynchronously');
  console.log('GREEN workflow returns and reports asynchronously');
} finally {
  cli(['tab', 'close', tab.tab.tab_id]);
  const ownedTabs = new Set();
  const ownedPanes = new Set();
  const cleanupDeadline = Date.now() + 5000;
  while (Date.now() < cleanupDeadline) {
    for (const agent of cli(['agent', 'list']).agents) {
      if (![childName, `${childName}-workflow`].includes(agent.name) || ![tmp, `/private${tmp}`].includes(agent.cwd)) continue;
      ownedPanes.add(agent.pane_id);
      if (agent.tab_id !== tab.tab.tab_id) ownedTabs.add(agent.tab_id);
    }
    for (const paneId of ownedPanes) {
      try { cli(['pane', 'close', paneId]); } catch {}
      ownedPanes.delete(paneId);
    }
    await sleep(100);
  }
  for (const tabId of ownedTabs) {
    try { cli(['tab', 'close', tabId]); } catch {}
  }
  rmSync(tmp, { recursive: true, force: true });
}
