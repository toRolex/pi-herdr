#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { accessSync, constants, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { dirname, basename, join, resolve, delimiter } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const [action, directory, feature = 'message-ack'] = process.argv.slice(2);
assert(directory && ['launch', 'doctor', 'drive', 'evidence', 'cleanup'].includes(action), 'Usage: verify.mjs launch|doctor|drive|evidence|cleanup ARTIFACT_DIR [message-ack|spawn-result|workflow]');
const artifacts = resolve(directory);
const manifest = join(artifacts, 'run.json');
const json = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2) + '\n');
const command = (binary, args, env = process.env) => {
 const r = spawnSync(binary, args, { cwd: root, env, encoding: 'utf8', timeout: 120000 });
 const record = { command: [binary, ...args], cwd: root, exitCode: r.status, stdout: r.stdout, stderr: r.stderr, error: r.error?.message };
 writeFileSync(join(artifacts, `${action}-commands.jsonl`), JSON.stringify(record) + '\n', { flag: 'a' });
 assert.equal(r.status, 0, JSON.stringify(record));
 return r.stdout;
};
const cli = args => {
 let v;
 try { v = JSON.parse(command('herdr', args)); } catch (error) { throw new Error(`Herdr response invalid: ${error.message}`); }
 assert(!v.error, JSON.stringify(v.error));
 return v.result;
};
const executable = name => {
 for (const dir of process.env.PATH.split(delimiter)) {
  const candidate = join(dir, name);
  try { accessSync(candidate, constants.X_OK); return realpathSync(candidate); } catch {}
 }
 throw new Error(`${name} missing from PATH`);
};
const digest = path => createHash('sha256').update(readFileSync(path)).digest('hex');
assert.equal(process.env.HERDR_ENV, '1', 'Run inside Herdr. Do not drive an unrelated server.');

try {
if (action === 'launch') {
 assert(!existsSync(artifacts), 'Use a new artifact directory for each run');
 mkdirSync(artifacts, { recursive: true });
 const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'pi-herdr-verify-')));
 const run = { root, scratch, token: randomUUID(), phase: 'prepared', workspace: null, feature: null };
 json(manifest, run);
 json(join(scratch, '.verify-owner.json'), { token: run.token, artifacts, root, workspace: null });
 mkdirSync(join(scratch, '.pi'), { recursive: true });
 for (const path of ['src/index.ts', 'tests/circular-wait-live.mjs', 'tests/fixtures/circular-exchange.ts', 'node_modules/jiti']) assert(existsSync(join(root, path)), `Missing ${path}. Install checkout dependencies before launch.`);
 const result = cli(['workspace', 'create', '--cwd', scratch, '--label', `verify-${run.token.slice(0, 8)}`, '--no-focus']);
 run.workspace = result.workspace.workspace_id;
 json(join(scratch, '.verify-owner.json'), { token: run.token, artifacts, root, workspace: run.workspace });
 run.phase = 'launched';
 json(manifest, run);
 console.log(`READY workspace=${run.workspace} scratch=${scratch}`);
} else {
 const run = JSON.parse(readFileSync(manifest, 'utf8'));
 assert.equal(run.root, root, 'Manifest belongs to another checkout');
 const env = { ...process.env, HERDR_WORKSPACE_ID: run.workspace };
 const ownedPanes = () => cli(['pane', 'list', '--workspace', run.workspace]).panes;
 if (action === 'doctor') {
  assert.equal(run.phase, 'launched');
  const version = command('herdr', ['--version']).trim();
  const numbers = version.match(/(\d+)\.(\d+)\.(\d+)/)?.slice(1).map(Number);
  assert(numbers && (numbers[0] > 0 || numbers[1] >= 9), 'herdr >=0.9.0 required');
  const panes = ownedPanes();
  assert(panes.length && panes.every(p => realpathSync(p.cwd) === run.scratch), 'Owned workspace cwd mismatch');
  const report = { cwd: root, node: process.version, HERDR_ENV: '1', executables: Object.fromEntries(['herdr', 'pi', 'node'].map(n => [n, executable(n)])), herdrVersion: version, piVersion: command('pi', ['--version']).trim(), runtime: command('herdr', ['status']), packageVersion: JSON.parse(readFileSync(join(root, 'package.json'))).version, localSource: 'src/index.ts loaded through turn-probe-entry.ts with -ne and TURN_PROBE_LEGACY_RESULT=0', sourceSha256: digest(join(root, 'src/index.ts')), harnessSha256: digest(join(root, 'tests/circular-wait-live.mjs')), workspace: run.workspace, panes: panes.map(p => ({ paneId: p.pane_id, tabId: p.tab_id, cwd: p.cwd })) };
  json(join(artifacts, 'doctor.json'), report);
  console.log('HEALTHY local TypeScript loads through jiti. No compiled binary or global extension is being verified.');
 } else if (action === 'drive') {
  assert.equal(run.phase, 'launched');
  assert(existsSync(join(artifacts, 'doctor.json')), 'Run doctor first');
  assert(['message-ack', 'spawn-result', 'workflow'].includes(feature), 'Unknown mapped feature');
  let source = readFileSync(join(root, 'tests/circular-wait-live.mjs'), 'utf8');
  const replace = (before, after) => { assert(source.includes(before), `Harness changed. Review adapter for ${before}`); source = source.replace(before, after); };
  replace("const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');", `const root = ${JSON.stringify(root)};`);
  replace("const tmp = mkdtempSync(join(tmpdir(), 'pi-herdr-circular-'));", `const tmp = ${JSON.stringify(run.scratch)};`);
  replace("cli(['tab', 'create', '--cwd', tmp", `cli(['tab', 'create', '--workspace', ${JSON.stringify(run.workspace)}, '--cwd', tmp`);
  replace('const parentPane = tab.root_pane.pane_id;', `assert.equal(tab.tab.workspace_id, ${JSON.stringify(run.workspace)}, 'Created tab must belong to owned workspace');\nconst parentPane = tab.root_pane.pane_id;`);
  replace("const output = execFileSync('herdr', args, { encoding: 'utf8', timeout: 15000 });", `const output = execFileSync('herdr', args, { encoding: 'utf8', timeout: 15000 });\n writeFileSync(${JSON.stringify(join(artifacts, 'transport.jsonl'))}, JSON.stringify({command: ['herdr', ...args], output}) + '\\n', {flag: 'a'});`);
  const offset = source.indexOf('} finally {');
  assert(offset > 0, 'Harness finally boundary missing');
  source = source.slice(0, offset) + `} finally {\n try { writeFileSync(${JSON.stringify(join(artifacts, 'terminal.json'))}, JSON.stringify(cli(['pane', 'read', parentPane, '--source', 'recent', '--lines', '120', '--format', 'text']), null, 2)); } catch {}\n}\n`;
  const driver = join(run.scratch, 'drive.mjs');
  writeFileSync(driver, source);
  run.feature = feature;
  run.phase = 'driving';
  json(manifest, run);
  try {
   const output = command(process.execPath, [driver, '--snapshot', ...(feature === 'workflow' ? ['--workflow'] : [])], env);
   assert(output.includes('GREEN full circular exchange progressed and child completed after ACK'));
   json(join(artifacts, 'result.json'), { feature, exitCode: 0, output, boundary: 'Deterministic provider replaces model decisions only. Real Herdr CLI, pi TUI, local extension, child process, message transport, ACK, and user turn are exercised. Not an autonomous-model quality evaluation.' });
   run.phase = 'driven';
   console.log(output);
  } finally { json(manifest, run); }
 } else if (action === 'evidence') {
  assert(existsSync(run.scratch), 'Capture before cleanup');
  for (const name of readdirSync(run.scratch)) if (name.endsWith('.jsonl') || name === 'drive.mjs') cpSync(join(run.scratch, name), join(artifacts, name));
  const workflows = join(run.scratch, '.pi/workflows');
  if (existsSync(workflows)) cpSync(workflows, join(artifacts, 'workflows'), { recursive: true });
  const transcript = join(artifacts, 'parent.jsonl');
  assert(existsSync(transcript), 'Parent transcript missing');
  const entries = readFileSync(transcript, 'utf8').trim().split('\n').map(JSON.parse);
  const sessions = new Set(entries.flatMap(e => [e.message?.details?.sessionPath, e.details?.sessionPath]).filter(Boolean));
  const sessionDir = join(process.env.PI_CODING_AGENT_DIR || join(homedir(), '.pi/agent'), 'sessions', `--${run.scratch.replace(/^[/\\]/, '').replace(/[/\\:]/g, '-')}--`);
  if (existsSync(sessionDir)) for (const name of readdirSync(sessionDir)) if (name.endsWith('.jsonl')) sessions.add(join(sessionDir, name));
  mkdirSync(join(artifacts, 'children'), { recursive: true });
  let n = 0;
  for (const path of sessions) if (existsSync(path)) {
   assert.equal(dirname(realpathSync(path)), realpathSync(sessionDir), 'Child transcript must belong to this scratch session directory');
   const child = readFileSync(path, 'utf8').trim().split('\n').map(JSON.parse);
   assert.equal(child[0]?.cwd, run.scratch, 'Child session cwd mismatch');
   cpSync(path, join(artifacts, 'children', `${++n}.jsonl`));
  }
  json(join(artifacts, 'evidence.json'), { feature: run.feature, phase: run.phase, artifacts: readdirSync(artifacts), childCopies: n, parentSha256: digest(transcript) });
  console.log(`CAPTURED ${artifacts}`);
 } else if (action === 'cleanup') {
  assert.equal(dirname(run.scratch), realpathSync(tmpdir()), 'Scratch must be an immediate child of the canonical temp directory');
  assert(/^pi-herdr-verify-[a-zA-Z0-9]+$/.test(basename(run.scratch)), 'Invalid scratch basename');
  if (existsSync(run.scratch)) {
   assert.equal(realpathSync(run.scratch), run.scratch, 'Scratch must not be a symlink or contain path traversal');
   const receipt = JSON.parse(readFileSync(join(run.scratch, '.verify-owner.json'), 'utf8'));
   assert.deepEqual(receipt, { token: run.token, artifacts, root, workspace: run.workspace }, 'Ownership receipt mismatch');
  } else {
   const prior = JSON.parse(readFileSync(join(artifacts, 'cleanup.json'), 'utf8'));
   assert.equal(run.phase, 'cleaned', 'Missing ownership receipt before first cleanup');
   assert.equal(prior.workspace, run.workspace, 'Cleanup receipt workspace mismatch');
   assert.equal(prior.token, run.token, 'Cleanup receipt token mismatch');
   assert.equal(prior.scratch, run.scratch, 'Cleanup receipt scratch mismatch');
   assert(!cli(['workspace', 'list']).workspaces.some(w => w.workspace_id === run.workspace), 'Scratch missing but workspace still exists. Refuse closure.');
  }
  if (run.workspace) {
   const workspaces = cli(['workspace', 'list']).workspaces;
   if (workspaces.some(w => w.workspace_id === run.workspace)) {
    const panes = ownedPanes();
    assert(panes.every(p => existsSync(p.cwd) && realpathSync(p.cwd) === run.scratch), 'Unexpected pane in owned workspace. Refuse closure and inspect IDs.');
    cli(['workspace', 'close', run.workspace]);
   }
   assert(!cli(['workspace', 'list']).workspaces.some(w => w.workspace_id === run.workspace), 'Owned workspace survived cleanup');
  }
  rmSync(run.scratch, { recursive: true, force: true });
  run.phase = 'cleaned';
  json(manifest, run);
  json(join(artifacts, 'cleanup.json'), { workspace: run.workspace, token: run.token, scratch: run.scratch, workspaceGone: true, scratchGone: !existsSync(run.scratch), evidenceRetained: existsSync(join(artifacts, 'evidence.json')), artifacts });
  console.log(`CLEANED workspace=${run.workspace}; evidence retained at ${artifacts}`);
 }
}
} catch (error) {
 console.error(`${action} failed: ${error.message}. Run evidence, then cleanup with this artifact directory.`);
 process.exitCode = 1;
}
