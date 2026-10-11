import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai';
import { Type } from 'typebox';
import { appendFileSync } from 'node:fs';
import { registerSelfReport } from '../../src/selfreport.js';

export default function(pi: ExtensionAPI) {
  registerSelfReport(pi);
  const trace = process.env.PI_HERDR_SESSION ? `${process.env.PI_HERDR_SESSION}.t12-trace.jsonl` : process.env.T12_TRACE;
  const record = (state: string, text = '') => {
    if (trace) appendFileSync(trace, JSON.stringify({ state, text, timestamp: Date.now() }) + '\n');
  };
  pi.registerTool({
    name: 'fixture_wait',
    label: 'Fixture wait',
    description: 'Deterministic busy tool for T12 live acceptance.',
    parameters: Type.Object({}),
    async execute() {
      record('tool');
      await new Promise(resolve => setTimeout(resolve, 6000));
      return { content: [{ type: 'text', text: 'T12_BUSY_TOOL_FINISHED' }], details: {} };
    },
  });
  pi.registerProvider('t12-demo', {
    api: 't12-demo-api',
    baseUrl: 'http://localhost.invalid',
    apiKey: 'fixture',
    models: [{ id: 'deterministic', name: 'T12 deterministic', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 1024 }],
    streamSimple(model, context) {
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => {
        const messages = context.messages as any[];
        const text = (message: any) => typeof message.content === 'string' ? message.content : (message.content ?? []).map((block: any) => block.text ?? '').join('');
        const inputIndex = messages.findLastIndex(message => message.role === 'user');
        const input = text(messages[inputIndex] ?? { content: '' });
        const after = messages.slice(inputIndex + 1);
        let content: any[];
        let reason = 'stop';
        if (input.includes('BUSY') && !after.some(message => message.toolName === 'fixture_wait')) {
          content = [{ type: 'toolCall', id: `wait-${messages.length}`, name: 'fixture_wait', arguments: {} }];
          reason = 'toolUse';
        } else if (after.some(message => message.role === 'assistant' && message.stopReason === 'stop') && !after.some(message => message.toolName === 'agent_done')) {
          content = [{ type: 'toolCall', id: `done-${messages.length}`, name: 'agent_done', arguments: {} }];
          reason = 'toolUse';
        } else {
          const final = `T12_FINAL ${input}`;
          record('final', final);
          content = [{ type: 'text', text: final }];
        }
        const message: any = { role: 'assistant', api: model.api, provider: model.provider, model: model.id, content, stopReason: reason, timestamp: Date.now(), usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
        stream.push({ type: 'start', partial: message });
        stream.push({ type: 'done', reason: reason as any, message });
        stream.end();
      });
      return stream;
    },
  });
}
