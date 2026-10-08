// Independent of the parent: the retained intent is also replayable after restart.
import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { ensureHerdrVersion, runHerdrCommand } from './herdr-transport.mjs';
const [intentPath, bin = 'herdr'] = process.argv.slice(2);
const read = () => { try { return JSON.parse(readFileSync(intentPath, 'utf8')); } catch (error) { throw new Error(`Cannot read recycle intent: ${error}`); } };
const save = value => { writeFileSync(intentPath + '.tmp', JSON.stringify(value), {mode: 0o600}); renameSync(intentPath + '.tmp', intentPath); };
let versionChecked = false;
const command = async args => {
 if (!versionChecked) {
  const version = await ensureHerdrVersion(bin);
  if (!version.ok) throw new Error(`${version.error.code}: ${version.error.message}`);
  versionChecked = true;
 }
 const result = await runHerdrCommand(bin, args, { timeoutMs: 10_000 });
 if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
 return result.data;
};
for (let attempt = 0; attempt < 120; attempt++) {
 await new Promise(resolve => setTimeout(resolve, 1000));
 try {
  const intent = read();
  if (!intent.pending) break;
  const declaration = JSON.parse(readFileSync(intent.sessionPath + '.exit', 'utf8'));
  if (declaration.eventId !== intent.eventId || declaration.runId !== intent.runId || declaration.agentId !== intent.agentId) { save({...intent, pending:false, error:'stale close intent refused'}); break; }
  const fleet = await command(['agent', 'list']);
  if (!fleet || typeof fleet !== 'object' || !Array.isArray(fleet.agents)) throw new Error('Herdr agent list response is missing its agents array');
  const agent = fleet.agents.find(a => a.pane_id === intent.paneId);
  if (agent && agent.name !== intent.name) { save({...intent, pending:false, error:'pane ownership changed'}); break; }
  if (agent) continue; // Only an empty shell may be recycled; never a live TUI.
  if (intent.ownerSession) {
   const registry = JSON.parse(readFileSync(intent.ownerSession + '.registry.json', 'utf8'));
   const owner = registry.find(r => r.agentId === intent.agentId);
   if (!owner || owner.runId !== intent.runId || owner.paneId !== intent.paneId) { save({...intent, pending:false, error:'registry ownership changed'}); break; }
  }
  const panes = await command(['pane','list']);
  if (!panes || typeof panes !== 'object' || !Array.isArray(panes.panes)) throw new Error('Herdr pane list response is missing its panes array');
  if (!panes.panes.some(p => (p.pane_id ?? p.id) === intent.paneId)) { save({...intent, pending:false, error:undefined}); break; }
  await command(['pane','close',intent.paneId]);
  save({...intent, pending:false, error:undefined}); break;
 } catch(error) {
  try { save({...read(), pending:true, error:String(error)}); } catch { break; }
 }
}
