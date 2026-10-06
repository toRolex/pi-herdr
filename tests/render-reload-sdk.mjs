import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
// Optional host SDK path lets the same regression exercise the installed pi runtime.
const sdk = process.env.PI_HERDR_TEST_SDK_ROOT ?? resolve('node_modules/@earendil-works/pi-coding-agent');
const sdkImport = path => import(pathToFileURL(join(sdk, 'dist', path)).href);
const { loadExtensions } = await sdkImport('core/extensions/loader.js');
const { ExtensionRunner } = await sdkImport('core/extensions/runner.js');
const { SessionManager } = await sdkImport('core/session-manager.js');
const { AgentSession } = await sdkImport('core/agent-session.js');
const { CustomMessageComponent } = await sdkImport('modes/interactive/components/custom-message.js');
const { initTheme } = await sdkImport('modes/interactive/theme/theme.js');
initTheme('dark');
const dir = mkdtempSync(join(tmpdir(), 'render-reload-'));
const manager = new SessionManager(dir, dir, undefined, false);
let runner;
const errors = [];
let models = 0;
const host = {
 _isEmittingAgentSettled: false, _compactionAbortController: undefined, isStreaming: false,
 _runInputHandlers: AgentSession.prototype._runInputHandlers,
 prompt: AgentSession.prototype.prompt, sendUserMessage: AgentSession.prototype.sendUserMessage,
 _flushPendingBashMessages() {}, _flushPendingCustomMessages() {},
 sendCustomMessage: async message => { manager.appendCustomMessageEntry(message.customType, message.content, message.display, message.details); },
};
Object.defineProperty(host, 'model', { get() { models++; return undefined; } });
const line = (from, event, body) => `<agent-message from="${from}" to="r"${event ? ` event="${event}"` : ''}>${body}</agent-message>`;
const live = id => ({ role: 'custom', customType: 'herdr-agent-message', content: line('leaf', id, 'final body'), display: true, details: { eventId: id }, timestamp: 1 });
const done = id => ({ role: 'custom', customType: 'herdr-delivery', content: 'final body', display: true, details: { eventId: id, name: 'leaf', kind: 'done' }, timestamp: 2 });
const component = message => new CustomMessageComponent(message, runner.getMessageRenderer(message.customType));
const rendered = c => c.render(100).join('\n').replace(/\x1b\[[0-9;]*m/g, '');
async function load(reason) {
 if (runner) { await new Promise(r => setTimeout(r, 200)); await runner.emit({ type: 'session_shutdown', reason: 'reload' }); runner.invalidate(); }
 const loaded = await loadExtensions([resolve('src/index.ts')], process.cwd());
 assert.deepEqual(loaded.errors, [], 'direct checkout extension loads on every runtime');
 runner = new ExtensionRunner(loaded.extensions, loaded.runtime, process.cwd(), manager, {});
 host._extensionRunner = runner;
 AgentSession.prototype._bindExtensionCore.call(host, runner);
 runner.onError(error => errors.push(error));
 // InteractiveMode rebuilds history via beforeSessionStart, BEFORE emitting session_start.
 const history = manager.getBranch().filter(e => e.type === 'custom_message').map(e => component(e));
 for (const c of history) assert.doesNotMatch(rendered(c), /\[herdr-(?:delivery|agent-message)\]/, 'reload history must capture custom renderers before session_start');
 await runner.emit({ type: 'session_start', reason });
 return history;
}
try {
 await load('startup');
 for (const [id, sequence] of [['live-first', [live, done]], ['done-first', [done, live]]]) {
  const components = [];
  for (const make of sequence) { const message = make(id); manager.appendCustomMessageEntry(message.customType, message.content, true, message.details); components.push(component(message)); }
  for (const expanded of [false, true]) {
   for (const c of components) c.setExpanded(expanded);
   assert.equal(components.map(rendered).join('\n').split('final body').length - 1, expanded ? 1 : 0);
  }
 }
 const history = await load('reload');
 for (const expanded of [false, true]) {
  history.forEach(c => c.setExpanded(expanded));
  assert.equal(history.map(rendered).join('\n').split('final body').length - 1, expanded ? 2 : 0);
 }
 const before = manager.getBranch().length;
 await host.prompt(line('leaf', 'post-reload', 'typed final'), { source: 'interactive' });
 await new Promise(r => setTimeout(r, 30));
 const notices = manager.getBranch().slice(before).filter(e => e.customType === 'herdr-agent-message');
 assert.equal(notices.length, 1, 'post-reload completion becomes one typed notice');
 assert.doesNotMatch(rendered(component(notices[0])), /\[herdr-agent-message\]/);
 await host.prompt(line('leaf', undefined, 'ordinary progress'), { source: 'interactive' });
 await new Promise(r => setTimeout(r, 30));
 assert.equal(models, 1, 'post-reload ordinary progress reaches SDK model validation once');
 assert.equal(errors.length, 1, 'only expected no-model validation, no duplicate input owner');
 console.log('render-reload-sdk: passed (direct src/index, history/new renderers, both orders, ctrl+o, input)');
} finally {
 if (runner) await runner.emit({ type: 'session_shutdown', reason: 'exit' });
 rmSync(dir, { recursive: true, force: true });
}
