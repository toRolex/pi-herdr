#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const helper = join(dirname(fileURLToPath(import.meta.url)), 'verify.mjs');
const root = resolve(dirname(helper), '../../../..');
const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'pi-herdr-verify-')));
const artifacts = realpathSync(mkdtempSync(join(tmpdir(), 'pi-herdr-safety-evidence-')));
const victim = realpathSync(mkdtempSync(join(tmpdir(), 'pi-herdr-safety-victim-')));
const link = scratch + 'link';
const marker = join(victim, 'keep');
writeFileSync(marker, 'unchanged');
const base = { root, scratch, token: 'owned-token', workspace: 'owned-workspace', phase: 'launched' };
writeFileSync(join(scratch, '.verify-owner.json'), JSON.stringify({ token: base.token, artifacts, root, workspace: base.workspace }));
try {
 symlinkSync(victim, link);
 const cases = [
  { ...base, scratch: scratch + '/../' + victim.split('/').at(-1), workspace: null },
  { ...base, workspace: null },
  { ...base, workspace: 'unrelated-workspace' },
  { ...base, token: 'wrong-token' },
  { ...base, scratch: link },
  { ...base, scratch: scratch + 'missing', phase: 'cleaned', workspace: 'unrelated-workspace' },
 ];
 for (const run of cases) {
  writeFileSync(join(artifacts, 'run.json'), JSON.stringify(run));
  const result = spawnSync(process.execPath, [helper, 'cleanup', artifacts], { encoding: 'utf8', env: { ...process.env, HERDR_ENV: '1' } });
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert(!existsSync(join(artifacts, 'cleanup-commands.jsonl')), 'No Herdr command may run before ownership checks pass');
  assert.equal(readFileSync(marker, 'utf8'), 'unchanged');
 }
 console.log('PASS traversal, null workspace, altered workspace ID, token mismatch, symlink, and missing-scratch retry refused before any CLI command');
} finally {
 rmSync(link, { force: true });
 rmSync(scratch, { recursive: true, force: true });
 rmSync(artifacts, { recursive: true, force: true });
 rmSync(victim, { recursive: true, force: true });
}
