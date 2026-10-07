import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = "/Users/rolex/Documents/Codes/githubProject/MyProject/pi-herdr.spec43-t7";
const tmp = "/private/var/folders/d9/_0gbv97x6332wsrqhr4fcyj80000gn/T/pi-herdr-verify-Cu8anQ";
const childName = `circular-${tmp.split('-').at(-1).toLowerCase()}`;
const provider = join(root, 'tests/fixtures/circular-exchange.ts');
const legacy = !process.argv.includes('--snapshot');
const workflow = process.argv.includes('--workflow');
const busy = process.argv.includes('--busy');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const cli = args => {
 const output = execFileSync('herdr', args, { encoding: 'utf8', timeout: 15000 });
 writeFileSync("/Users/rolex/Documents/Codes/githubProject/MyProject/pi-herdr.spec43-t7/.agents/evidence/spec43-t7/tui-20261007-093338-43522/transport.jsonl", JSON.stringify({command: ['herdr', ...args], output}) + '\n', {flag: 'a'});
 let value;
 try { value = JSON.parse(output); } catch { return output; }
 if (value.error) throw new Error(JSON.stringify(value.error));
 return value.result;
};
const state = pane => { try { return cli(['agent', 'get', pane]).agent.agent_status; } catch { return 'gone'; } };
const entries = () => existsSync(join(tmp, 'parent.jsonl')) ? readFileSync(join(tmp, 'parent.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
const parentText = () => entries().map(e => JSON.stringify(e)).join('\n');
mkdirSync(join(tmp, '.pi/agents'), { recursive: true });
writeFileSync(join(tmp, `.pi/agents/${childName}.md`), `---\nname: ${childName}\nkind: pi\nargs: ["-ne", "-e", "${provider}"]\n---\nCircular exchange fixture.\n`);
writeFileSync(join(tmp, '.pi/herdr.json'), JSON.stringify({ max_spawn_depth: 4, max_parallel_agents: 8, notifications: 'normal', workflows_enabled: true }));
const inputLog = join(tmp, 'input-events.jsonl');
const tab = cli(['tab', 'create', '--workspace', "w8Q", '--cwd', tmp, '--label', childName, '--no-focus', '--env', 'PI_HERDR_SPAWN_DEPTH=0', '--env', `CIRCULAR_INPUT_LOG=${inputLog}`, '--env', `CIRCULAR_BUSY=${busy ? '1' : '0'}`, '--env', `TURN_PROBE_EXTENSION=${provider}`, '--env', `TURN_PROBE_CHILD_NAME=${childName}`, '--env', `TURN_PROBE_LEGACY_RESULT=${legacy ? '1' : '0'}`]);
assert.equal(tab.tab.workspace_id, "w8Q", 'Created tab must belong to owned workspace');
const parentPane = tab.root_pane.pane_id;
try {
 await sleep(400);
 cli(['agent', 'start', `${childName}-parent`, '--kind', 'pi', '--pane', parentPane, '--timeout', '10000', '--', '-ne', '-ns', '-e', join(root, 'tests/fixtures/turn-probe-entry.ts'), '-e', provider, '--model', 'circular-exchange/deterministic', '--thinking', 'off', '--session', join(tmp, 'parent.jsonl')]);
 cli(['agent', 'prompt', parentPane, workflow ? 'exchange-workflow' : 'exchange-start']);
 let childPane;
 const bootDeadline = Date.now() + 20000;
 while (Date.now() < bootDeadline) {
  childPane = cli(['agent', 'list']).agents.find(a => a.name?.startsWith(childName) && a.name !== `${childName}-parent` && [tmp, `/private${tmp}`].includes(a.cwd))?.pane_id;
  if (entries().some(e => e.message?.toolName === 'herdr_message_agent')) break;
  if (childPane && JSON.stringify(cli(['pane', 'read', parentPane, '--source', 'recent', '--lines', '80', '--format', 'text'])).includes('CHILD_QUESTION_NEEDS_ACK')) break;
  await sleep(100);
 }
 if (!childPane && !parentText().includes('CHILD_COMPLETE_AFTER_ACK')) console.log(cli(['pane', 'read', parentPane, '--source', 'recent', '--lines', '100', '--format', 'text']));
 assert(childPane || parentText().includes('CHILD_COMPLETE_AFTER_ACK'), 'owned child booted or already completed after ACK');
 const evidence = cli(['pane', 'read', parentPane, '--source', 'recent', '--lines', '80', '--format', 'text']);
 assert((JSON.stringify(evidence) + parentText()).includes('CHILD_QUESTION_NEEDS_ACK'), 'child actually sent its question through real message tool');
 console.log(`QUESTION_SENT parent=${state(parentPane)} child=${childPane ? state(childPane) : 'completed'}`);
 const start = Date.now();
 while (Date.now() - start < 2500 && !entries().some(e => e.message?.toolName === 'herdr_message_agent')) await sleep(50);
 const progress = entries().some(e => e.message?.toolName === 'herdr_message_agent' && e.message?.details?.delivered === true);
 console.log('INPUT_EVENTS', existsSync(inputLog) ? readFileSync(inputLog, 'utf8') : 'none');
 console.log(`${progress ? 'GREEN' : 'RED'} parent consumed question and replied=${progress}; elapsed=${Date.now() - start}ms`);
 if (!progress) {
  console.log(JSON.stringify(cli(['pane', 'read', parentPane, '--source', 'recent', '--lines', '80', '--format', 'text'])));
  console.log('CHILD_STATE', JSON.stringify(cli(['agent', 'get', childPane]).agent));
  console.log(cli(['pane', 'read', childPane, '--source', 'recent', '--lines', '50', '--format', 'text']));
 }
 assert(progress, 'parent must consume child question and send ACK within 2.5s while waiting for child');
 const completed = Date.now();
 while (Date.now() - completed < 5000 && !parentText().includes('CHILD_COMPLETE_AFTER_ACK')) await sleep(100);
 assert(parentText().includes('CHILD_COMPLETE_AFTER_ACK'), 'child completed only after consuming parent ACK');
 console.log('GREEN full circular exchange progressed and child completed after ACK');
 if (busy) assert(entries().some(e => e.message?.toolName === 'bash' && JSON.stringify(e.message.content).includes('UNRELATED_TOOL_FINISHED') && !e.message.isError), 'independent foreground tool completed normally and was not aborted');
 const answersBeforeUser = entries().filter(e => e.message?.role === 'assistant').length;
 cli(['agent', 'prompt', parentPane, 'ordinary-user-message']);
 const userDeadline = Date.now() + 2500;
 while (Date.now() < userDeadline && !entries().some(e => e.message?.role === 'user' && JSON.stringify(e.message.content).includes('ordinary-user-message'))) await sleep(50);
 assert(entries().some(e => e.message?.role === 'user' && JSON.stringify(e.message.content).includes('ordinary-user-message')), 'ordinary user input is consumed by the model');
 while (Date.now() < userDeadline && entries().filter(e => e.message?.role === 'assistant').length <= answersBeforeUser) await sleep(50);
 assert(entries().filter(e => e.message?.role === 'assistant').length > answersBeforeUser, 'parent actually answers ordinary user input');
 console.log('GREEN parent consumes and answers ordinary user input');
} finally {
 try { writeFileSync("/Users/rolex/Documents/Codes/githubProject/MyProject/pi-herdr.spec43-t7/.agents/evidence/spec43-t7/tui-20261007-093338-43522/terminal.json", JSON.stringify(cli(['pane', 'read', parentPane, '--source', 'recent', '--lines', '120', '--format', 'text']), null, 2)); } catch {}
}
