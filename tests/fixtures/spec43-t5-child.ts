import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai';
import { Type } from 'typebox';
import { registerSelfReport } from '../../src/selfreport.js';
export default function(pi: ExtensionAPI) {
 registerSelfReport(pi);
 pi.registerTool({ name: 'fixture_wait', label: 'Fixture wait', description: 'Deterministic busy tool.', parameters: Type.Object({}), async execute() { await new Promise(r => setTimeout(r, 15000)); return { content: [{ type: 'text', text: 'BUSY_TOOL_FINISHED' }], details: {} }; } });
 pi.registerProvider('t5-demo', { api: 't5-demo-api', baseUrl: 'http://localhost.invalid', apiKey: 'fixture', models: [{ id: 'deterministic', name: 'T5 demo', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 1024 }], streamSimple(model, context) {
  const stream = createAssistantMessageEventStream();
  queueMicrotask(() => {
   const messages = context.messages as any[];
   const text = (m: any) => typeof m.content === 'string' ? m.content : (m.content ?? []).map((b: any) => b.text ?? '').join('');
   const inputIndex = messages.findLastIndex(m => m.role === 'user');
   const input = text(messages[inputIndex] ?? { content: '' });
   const after = messages.slice(inputIndex + 1);
   let content: any[], reason = 'stop';
   if (input.includes('BUSY') && !after.some(m => m.toolName === 'fixture_wait')) { content = [{ type: 'toolCall', id: `wait-${messages.length}`, name: 'fixture_wait', arguments: {} }]; reason = 'toolUse'; }
   else if (!input.includes('IDLE') && after.some(m => m.role === 'assistant' && m.stopReason === 'stop') && !after.some(m => m.toolName === 'agent_done')) { content = [{ type: 'toolCall', id: `done-${messages.length}`, name: 'agent_done', arguments: {} }]; reason = 'toolUse'; }
   else content = [{ type: 'text', text: `T5_FINAL ${input} CONTEXT_PANDA=${messages.some(m => text(m).includes('PANDA'))}` }];
   const message: any = { role: 'assistant', api: model.api, provider: model.provider, model: model.id, content, stopReason: reason, timestamp: Date.now(), usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
   stream.push({ type: 'start', partial: message }); stream.push({ type: 'done', reason: reason as any, message }); stream.end();
  }); return stream;
 } });
}
