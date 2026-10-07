// Independent of the parent: the retained intent is also replayable after restart.
import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
const [intentPath, bin = 'herdr'] = process.argv.slice(2);
const read = () => { try { return JSON.parse(readFileSync(intentPath, 'utf8')); } catch (error) { throw new Error(`Cannot read recycle intent: ${error}`); } };
const save = value => { writeFileSync(intentPath + '.tmp', JSON.stringify(value), {mode: 0o600}); renameSync(intentPath + '.tmp', intentPath); };
const command = args => {
 const output = execFileSync(bin, args, {encoding: 'utf8', timeout: 10000});
 let value;
 try { value = JSON.parse(output.trim().split('\n').at(-1)); } catch (error) { throw new Error(`Cannot observe Herdr: ${error}`); }
 if (value.ok === false || value.error) throw new Error(JSON.stringify(value.error));
 return value.result ?? value.data ?? value;
};
for (let attempt = 0; attempt < 120; attempt++) {
 await new Promise(resolve => setTimeout(resolve, 1000));
 try {
  const intent = read();
  if (!intent.pending) break;
  const declaration = JSON.parse(readFileSync(intent.sessionPath + '.exit', 'utf8'));
  if (declaration.eventId !== intent.eventId || declaration.runId !== intent.runId || declaration.agentId !== intent.agentId) { save({...intent, pending:false, error:'stale close intent refused'}); break; }
  const fleet = command(['agent', 'list']);
  const agent = (fleet.agents ?? []).find(a => a.pane_id === intent.paneId);
  if (agent && agent.name !== intent.name) { save({...intent, pending:false, error:'pane ownership changed'}); break; }
  if (agent) continue; // Only an empty shell may be recycled; never a live TUI.
  if (intent.ownerSession) {
   const registry = JSON.parse(readFileSync(intent.ownerSession + '.registry.json', 'utf8'));
   const owner = registry.find(r => r.agentId === intent.agentId);
   if (!owner || owner.runId !== intent.runId || owner.paneId !== intent.paneId) { save({...intent, pending:false, error:'registry ownership changed'}); break; }
  }
  const panes = command(['pane','list']);
  if (!(panes.panes ?? []).some(p => (p.pane_id ?? p.id) === intent.paneId)) { save({...intent, pending:false}); break; }
  command(['pane','close',intent.paneId]);
  save({...intent, pending:false}); break;
 } catch(error) {
  try { save({...read(), pending:true, error:String(error)}); } catch { break; }
 }
}
