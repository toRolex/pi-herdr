import assert from 'node:assert/strict';
import { createJiti } from 'jiti';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const jiti = createJiti(import.meta.url);
const { ParentNotifyStore } = await jiti.import('../src/parent-notify-store.ts');
const dir = mkdtempSync(join(tmpdir(), 'spec43-t7-'));
try {
 const host = join(dir, 'host.jsonl');
 const store = new ParentNotifyStore(host);
 const msg = { content: 'result', details: { eventId: 'event', agentId: 'agent', name: 'worker' }, wake: false };
 const fallback = { content: 'untagged', details: { kind: 'message', name: 'peer' }, wake: false };
 const fallbackKey = store.put(fallback);
 assert.equal(store.put({ wake: false, details: { name: 'peer', kind: 'message' }, content: 'untagged' }), fallbackKey);
 assert.equal(store.remove(fallbackKey), true);
 const optional = { content: 'optional', details: { name: 'peer', runId: undefined }, wake: false };
 const optionalKey = store.put(optional);
 assert.equal(new ParentNotifyStore(host).pending()[0].content, 'optional');
 assert.equal(store.remove(optionalKey), true);
 assert.equal(new ParentNotifyStore(join(dir, 'other.jsonl')).pending().length, 0);
 const key = store.put(msg);
 assert.equal(store.put({ ...msg, content: 'duplicate' }), key);
 assert.deepEqual(new ParentNotifyStore(host).pending(), [msg]);
 assert.equal(store.unread({ agentId: 'agent' }), 1);
 assert.equal(store.unread({ name: 'worker' }), 1);
 assert.equal(store.unread({ name: 'other' }), 0);
 assert.equal(store.remove(key), true);
 assert.equal(new ParentNotifyStore(host).pending().length, 0);
 let now = 1000;
 const timed = new ParentNotifyStore(host, { now: () => now });
 for (const scope of [{}, { name: 'worker' }, { agentId: '' }, { eventId: '*' }, { agentId: 42 }]) assert.throws(() => timed.subscribe(scope, 100, 'normal'), /scope/);
 for (const ttl of [0, -1, NaN, Infinity, 3600001]) assert.throws(() => timed.subscribe({ agentId: 'agent' }, ttl, 'normal'), /ttl/i);
 for (const notifications of ['quiet', 'none']) assert.throws(() => timed.subscribe({ eventId: 'event' }, 100, notifications), error => error.code === 'policy-conflict');
 const subscription = timed.subscribe({ agentId: 'agent', runId: 'run' }, 100, 'normal');
 assert.equal(subscription.oneShot, true);
 assert.equal(subscription.expiresAt, 1100);
 assert.equal(timed.matching({ agentId: 'agent', runId: 'other' }, 'normal').length, 0);
 assert.equal(timed.matching({ agentId: 'agent', runId: 'run' }, 'quiet').length, 0);
 assert.equal(timed.matching({ agentId: 'agent', runId: 'run' }, 'normal')[0].id, subscription.id);
 assert.equal(new ParentNotifyStore(host, { now: () => now }).listSubscriptions()[0].id, subscription.id);
 assert.equal(timed.consume(subscription.id), true);
 assert.equal(timed.consume(subscription.id), false);
 const revoked = timed.subscribe({ eventId: 'event' }, 100, 'normal');
 assert.equal(timed.revoke(revoked.id), true);
 assert.equal(timed.revoke(revoked.id), false);
 timed.subscribe({ runId: 'run' }, 100, 'normal');
 now = 1100;
 assert.deepEqual(timed.listSubscriptions(), []);
 assert.deepEqual(timed.matching({ runId: 'run' }, 'normal'), []);
 const { registerWakeTools } = await jiti.import('../src/tools/wake.ts');
 const tools = [];
 registerWakeTools({ registerTool: tool => tools.push(tool) });
 const tool = tools.find(tool => tool.name === 'herdr_wake_subscription');
 assert.ok(tool);
 assert.ok(tool.promptSnippet, 'wake subscription has a concise model-facing summary');
 assert.ok(tool.promptGuidelines?.some(line => line.includes('herdr_wake_subscription')));
 assert.match(tool.description, /TTL|ttl/i);
 assert.match(tool.description, /revoke/i);
 assert.match(tool.description, /quiet and none.*cannot be overridden/i);
 const cwd = join(dir, 'project'); mkdirSync(join(cwd, '.pi'), { recursive: true });
 const ctx = { cwd, sessionManager: { getSessionFile: () => host } };
 writeFileSync(join(cwd, '.pi', 'herdr.json'), JSON.stringify({ notifications: 'normal' }));
 const execute = params => tool.execute('call', params, undefined, undefined, ctx);
 const created = await execute({ action: 'subscribe', scope: { eventId: 'tool-event' }, ttl_ms: 1000 });
 assert.equal(created.isError, undefined);
 const id = created.details.subscription.id;
 assert.equal((await execute({ action: 'list' })).details.subscriptions.some(s => s.id === id), true);
 for (const notifications of ['quiet', 'none']) {
  writeFileSync(join(cwd, '.pi', 'herdr.json'), JSON.stringify({ notifications }));
  const denied = await execute({ action: 'subscribe', scope: { agentId: 'agent' }, ttl_ms: 100 });
  assert.equal(denied.isError, true);
  assert.equal(denied.details.error.code, 'VALIDATION_ERROR');
  assert.equal(denied.details.error.details.reason, 'notification-policy');
  assert.match(denied.details.error.message, new RegExp(`notifications=${notifications}`));
 }
 assert.equal((await execute({ action: 'revoke', id })).details.revoked, true);
 const invalid = await execute({ action: 'revoke' });
 assert.equal(invalid.details.error.code, 'VALIDATION_ERROR');
 assert.equal(invalid.details.error.details.reason, 'invalid-argument');
 const noHost = await tool.execute('call', { action: 'list' }, undefined, undefined, { cwd, sessionManager: { getSessionFile: () => undefined } });
 assert.equal(noHost.isError, true);
 assert.equal(noHost.details.error.code, 'VALIDATION_ERROR');
 assert.equal(noHost.details.error.details.reason, 'invalid-argument');
 const failureHost = join(dir, 'missing', 'session.jsonl');
 const failureStore = new ParentNotifyStore(failureHost);
 assert.throws(() => failureStore.put(msg), /ENOENT/);
 assert.throws(() => failureStore.subscribe({ eventId: 'event' }, 100, 'normal'), /ENOENT/);
 // Use a known project policy so a filesystem error cannot hide behind notifications.
 writeFileSync(join(cwd, '.pi', 'herdr.json'), JSON.stringify({ notifications: 'normal' }));
 const visibleFailure = await tool.execute('call', { action: 'subscribe', scope: { agentId: 'agent' }, ttl_ms: 100 }, undefined, undefined,
  { cwd, sessionManager: { getSessionFile: () => failureHost } });
 assert.equal(visibleFailure.details.error.code, 'VALIDATION_ERROR');
 assert.equal(visibleFailure.details.error.details.reason, 'persistence-error');
 assert.equal(visibleFailure.isError, true);
 for (const subscriptions of [
  [{ id: 'bad', scope: {}, expiresAt: Date.now() + 1000, oneShot: true }],
  [{ id: 'bad', scope: { agentId: 'agent' }, expiresAt: 'forever', oneShot: true }],
  [{ id: 'bad', scope: { agentId: 'agent' }, expiresAt: Date.now() + 1000, oneShot: false }],
 ]) {
  writeFileSync(host + '.herdr-parent-notify.json', JSON.stringify({ version: 1, hostFile: host, messages: [], subscriptions }));
  assert.throws(() => store.matching({ agentId: 'agent' }, 'normal'));
 }
 writeFileSync(host + '.herdr-parent-notify.json', '{broken');
 assert.throws(() => store.pending(), SyntaxError);
 assert.throws(() => store.listSubscriptions(), SyntaxError);
 const corruptStore = await execute({ action: 'list' });
 assert.equal(corruptStore.details.error.code, 'VALIDATION_ERROR');
 assert.equal(corruptStore.details.error.details.reason, 'persistence-error');
 console.log('spec43-t7: persistence, explicit subscriptions, model tool and visible I/O failures passed');
} finally { rmSync(dir, { recursive: true, force: true }); }
