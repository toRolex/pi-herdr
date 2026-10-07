// Real-host demonstration for T6. Run inside a pi-herdr parent session.
import assert from 'node:assert/strict';
import extension from '../src/index.ts';
const tools=[]; const pi={registerTool:t=>tools.push(t),registerCommand(){},registerProvider(){},on(){},sendMessage(){},appendEntry(){},setModel(){},getCommands(){return[]},registerMessageRenderer(){},registerShortcut(){}};
extension(pi);
const wait=tools.find(t=>t.name==='herdr_wait_agent_event'); const result=tools.find(t=>t.name==='herdr_get_agent_result');
assert.ok(wait); assert.ok(result);
const rows=[]; const before=await wait.execute('live-1',{target:'__missing_t6_event__',timeout:1},new AbortController().signal);
rows.push({scenario:'timeout',details:before.details});
const controller=new AbortController(); const cancelled=wait.execute('live-2',{target:'__missing_t6_event__',timeout:30000},controller.signal); controller.abort(); rows.push({scenario:'cancel',details:(await cancelled).details});
assert.equal(rows[0].details.status,'timeout'); assert.equal(rows[1].details.status,'cancelled');
console.log(JSON.stringify({host:'real-pi-extension-registration',scenarios:rows,remaining:'event-first/wait-first/result-recovery require a spawned live child session'}));
