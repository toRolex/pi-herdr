import assert from 'node:assert/strict';
import { createJiti } from 'jiti';

// Strip inherited Herdr session state so the fixture always registers as the parent path.
for (const key of Object.keys(process.env)) {
 if (key.startsWith('PI_HERDR_')) delete process.env[key];
}

const jiti = createJiti(import.meta.url);
const { default: register } = await jiti.import('./fixtures/circular-exchange.ts');
let provider;
register({ on() {}, registerProvider(_name, value) { provider = value; } });
const model = { ...provider.models[0], api: provider.api, provider: 'circular-exchange' };
const spawn = { role: 'toolResult', toolName: 'herdr_spawn_agent', content: [] };
const delta = { role: 'system', content: '', toolsAdded: [{ name: 'herdr_spawn_agent' }] };
const result = { role: 'toolResult', toolName: 'herdr_get_agent_result', content: [] };
const call = async messages => (await provider.streamSimple(model, { messages }).result()).content;

for (const messages of [[spawn], [spawn, delta], [spawn, delta, delta]]) {
 assert.equal((await call(messages))[0].name, 'herdr_get_agent_result');
}
for (const next of [result, { role: 'assistant', content: [] }, { role: 'user', content: 'ordinary-user-message' }]) {
 assert.equal((await call([spawn, next, delta]))[0].text, 'PARENT_EXCHANGE_PROGRESS');
}
console.log('GREEN circular exchange snapshot tolerates system deltas without replaying stale spawn results');
