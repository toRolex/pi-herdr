import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai';
import { appendFileSync } from 'node:fs';
import herdrExtension from '../../src/index.js';
import { makeDeliverySink } from '../../src/push.js';

/** Deterministic model decisions only; uses this checkout's complete production extension/TUI. */
export default function (pi: ExtensionAPI) {
 herdrExtension(pi);
 const accept = makeDeliverySink(pi);
 pi.registerCommand('t7-late', { description: 'Inject finished automatic fixture event', handler: async () => {
  accept({ content: 'T7_TUI_FINISHED_BODY', details: { eventId: 't7-tui-finished', kind: 'done', name: 't7-fixture' }, wake: true });
 } });
 pi.registerCommand('t7-explicit', { description: 'Inject explicitly subscribed fixture event', handler: async () => {
  accept({ content: 'T7_TUI_EXPLICIT_BODY', details: { eventId: 't7-tui-explicit', kind: 'done', name: 't7-fixture' }, wake: true });
 } });
 pi.registerProvider('t7-tui', {
  api: 't7-tui-api', baseUrl: 'http://localhost.invalid', apiKey: 'fixture',
  models: [{ id: 'deterministic', name: 'T7 TUI deterministic', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 1024 }],
  streamSimple(model, context) {
   const stream = createAssistantMessageEventStream();
   queueMicrotask(() => {
    const messages = context.messages as any[];
    const contentText = (message: any) => typeof message?.content === 'string' ? message.content : (message?.content ?? []).map((block: any) => block.text ?? '').join('');
    const latest = messages.findLast(message => message.role !== 'system');
    const text = contentText(latest);
    let content: any[], stopReason = 'stop';
    if (latest?.role === 'user' && text === 't7-arm') {
     content = [{ type: 'toolCall', id: `t7-arm-${messages.length}`, name: 'herdr_wake_subscription', arguments: { action: 'subscribe', scope: { eventId: 't7-tui-explicit' }, ttl_ms: 60000 } }]; stopReason = 'toolUse';
    } else if (text.includes('T7_TUI_EXPLICIT_BODY')) content = [{ type: 'text', text: 'T7_TUI_EXPLICIT_CONSUMED' }];
    else if (messages.some(message => contentText(message).includes('T7_TUI_FINISHED_BODY'))) content = [{ type: 'text', text: 'T7_TUI_NATURAL_CONSUMED' }];
    else content = [{ type: 'text', text: 'T7_TUI_PARENT_FINISHED' }];
    if (process.env.T7_TUI_REQUEST_LOG) appendFileSync(process.env.T7_TUI_REQUEST_LOG, JSON.stringify({ messages, stopReason, output: content }) + '\n');
    const message: any = { role: 'assistant', api: model.api, provider: model.provider, model: model.id, content, stopReason, timestamp: Date.now(), usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
    stream.push({ type: 'start', partial: message }); stream.push({ type: 'done', reason: stopReason as any, message }); stream.end();
   });
   return stream;
  },
 });
}
