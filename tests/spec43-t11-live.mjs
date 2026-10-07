import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, copyFileSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
const artifacts = resolve(process.argv[2]);
const run = JSON.parse(readFileSync(join(artifacts, 'run.json'), 'utf8'));
const cli = args => {
 const output = execFileSync('herdr', args, { encoding: 'utf8', timeout: 15000 });
 writeFileSync(join(artifacts, 'transport.jsonl'), JSON.stringify({ command: ['herdr', ...args], output }) + '\n', { flag: 'a' });
 let response; try { response = JSON.parse(output); } catch { return output; }
 assert.ok(!response.error, JSON.stringify(response.error)); return response.result;
};
const record = { name: 't11-fixture', kind: 'pi', sessionPath: join(run.scratch, 'child.jsonl'), agentId: 't11-agent', runId: 't11-run', sequence: 1 };
writeFileSync(join(run.scratch, 'record.json'), JSON.stringify(record));
writeFileSync(record.sessionPath, '');
writeFileSync(record.sessionPath + '.exit', JSON.stringify({ type: 'done', ...record, eventId: 't11-event', text: 'T11_REAL_TUI_FINAL\noriginal line' }));
const tab = cli(['tab', 'create', '--workspace', run.workspace, '--cwd', run.scratch, '--label', 't11-result-demo', '--no-focus', '--env', 'PI_HERDR_SPAWN_DEPTH=0']);
const pane = tab.root_pane.pane_id;
cli(['agent', 'start', 't11-result-demo', '--kind', 'pi', '--pane', pane, '--timeout', '10000', '--', '-ne', '-ns', '-e', join(run.root, 'tests/fixtures/spec43-t11.ts'), '--model', 't11-demo/deterministic', '--thinking', 'off', '--session', join(run.scratch, 'parent.jsonl')]);
cli(['agent', 'prompt', pane, 'verify explicit reread and ACK']);
const file = join(run.scratch, 'parent.jsonl');
const deadline = Date.now() + 25000;
let rows = [];
while (Date.now() < deadline) {
 if (existsSync(file)) rows = readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
 if (rows.some(r => r.message?.role === 'assistant' && JSON.stringify(r.message.content).includes('T11_TUI_COMPLETE'))) break;
 await new Promise(r => setTimeout(r, 100));
}
const replies = rows.filter(r => r.message?.role === 'toolResult' && r.message.toolName === 'herdr_get_agent_result').map(r => r.message);
assert.equal(replies.length, 4, JSON.stringify(replies));
assert.equal(replies[0].details.result, 'T11_REAL_TUI_FINAL\noriginal line');
assert.equal(replies[1].details.acknowledged, true); assert.equal(replies[1].details.result, undefined);
assert.equal(replies[2].details.delivery.status, 'acked'); assert.equal(replies[2].details.result, undefined);
assert.equal(replies[3].details.reread, true); assert.equal(replies[3].details.result, replies[0].details.result);
const ledgerPath = file + '.herdr-delivery-ledger.json';
assert.equal(JSON.parse(readFileSync(ledgerPath)).events['t11-event'].status, 'acked');
copyFileSync(ledgerPath, join(artifacts, 'parent.ledger.json'));
copyFileSync(file, join(artifacts, 'parent.jsonl'));
copyFileSync(record.sessionPath + '.exit', join(artifacts, 'child.exit.json'));
const terminal = cli(['pane', 'read', pane, '--source', 'recent', '--lines', '160', '--format', 'text']);
writeFileSync(join(artifacts, 'terminal.json'), JSON.stringify(terminal, null, 2));
assert.match(JSON.stringify(terminal), /caller declared handled/); assert.match(JSON.stringify(terminal), /Explicit reread/);
writeFileSync(join(artifacts, 'result.json'), JSON.stringify({ exitCode: 0, normalBodies: 1, explicitRereads: 1, durableState: 'acked', realHerdrCLI: true, realPiTUI: true, receiptVisible: true, boundary: 'Child durable event seeded fixture; provider deterministic; registered tools, parent TUI, session writes and UI receipts real.' }, null, 2));
writeFileSync(join(artifacts, 'evidence.json'), JSON.stringify({ feature: 'spec43-t11', captured: true, childFixture: 'child.exit.json', parentTranscript: 'parent.jsonl' }, null, 2));
run.feature = 'spec43-t11'; run.phase = 'driven'; writeFileSync(join(artifacts, 'run.json'), JSON.stringify(run, null, 2));
console.log('GREEN real registered result tool / ACK / reread / TUI receipts');
