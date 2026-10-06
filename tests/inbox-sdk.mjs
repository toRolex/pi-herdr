import assert from 'node:assert/strict';
import { createJiti } from 'jiti';
const jiti = createJiti(import.meta.url);
const { AgentSession } = await jiti.import('../node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js');
const { registerReceiverInbox } = await jiti.import('../src/inbox.ts');
const { parseAgentMessage, handleAgentMessageInput } = await jiti.import('../src/agent-message.ts');
const handlers = new Map();
const errors = []; let inputs = 0, models = 0;
const ctx = { ui: { notify: t => errors.push(t) }, isIdle: () => true };
const session = {
 _isEmittingAgentSettled: false, _compactionAbortController: undefined, isStreaming: false,
 _runInputHandlers: AgentSession.prototype._runInputHandlers,
 prompt: AgentSession.prototype.prompt,
 sendUserMessage: AgentSession.prototype.sendUserMessage,
 _extensionRunner: { hasHandlers: n => handlers.has(n), emitInput: async (text, images, source) => {
  inputs++; return handlers.get('input')({ type: 'input', text, images, source }, ctx);
 } },
 _flushPendingBashMessages() {}, _flushPendingCustomMessages() {},
};
Object.defineProperty(session, 'model', { get() { models++; return undefined; } });
let actions;
AgentSession.prototype._bindExtensionCore.call(session, { bindCore: a => { actions = a; }, emitError: e => errors.push(e) });
const pi = { on: (n,h) => handlers.set(n,h), sendMessage: actions.sendMessage, sendUserMessage: actions.sendUserMessage };
registerReceiverInbox(pi, { parse: parseAgentMessage, deliver: handleAgentMessageInput });
await handlers.get('session_start')({},ctx);
await session.prompt('<agent-message from="a" to="r">ordinary progress</agent-message>', { source: 'interactive' });
await new Promise(r => setTimeout(r, 50));
assert.equal(models, 1, 'ordinary message reaches model exactly once through installed SDK void binding');
assert.equal(inputs, 2, 'one external input and one internal extension input, never recursive admission');
assert.equal(errors.length, 1, 'the accepted prompt reaches SDK model validation once');
await handlers.get('agent_start')({},ctx);
await session.prompt('<agent-message from="b" to="r">busy progress</agent-message>', { source:'interactive' });
assert.equal(models,1,'busy message remains pending');
await handlers.get('agent_settled')({},ctx);await new Promise(r=>setTimeout(r,30));
assert.equal(models,2,'settle drains once through real SDK input path');
assert.equal(inputs,4);
console.log('inbox-sdk: passed');
