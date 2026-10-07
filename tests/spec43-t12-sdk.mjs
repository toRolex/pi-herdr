// spec43 T12 (#55) — real SDK + SessionManager failure matrix (SDK rescue namespace).
//
// Spec Testing Decisions: "故障矩阵覆盖 reload/restart、SDK 接受后未持久提交、
// 宿主提交后账本 ACK 写失败 … 核对恢复 pending、不重复提交、不丢事件".
// This harness runs the REAL pi AgentSession/SessionManager (only the model is
// deterministic) and proves, on the host's actual disk records:
//   FM1  SDK accepts a push but the host never persists it → the event stays
//        pending (unknown outcome), is NOT re-sent, is NOT lost.
//   FM2  The host DID commit the body but the ledger ACK write failed → after
//        restart the durable host evidence repairs the record to delivered;
//        no duplicate send, no lost event.
//   FM3  Reload/restart with an unknown legacy pending → pending is retained
//        on durable evidence; the original token survives; no replay.
// Evidence: .agents/evidence/spec43-t12/verify-sdk-rescue/; prior verify artifacts are retained under prior-verify-sdk/.
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync, renameSync, mkdirSync as mkDir } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createJiti } from 'jiti';

// Sanitize before loading SDK/project modules; never inherit live fleet identity.
for (const key of Object.keys(process.env)) if (/^(?:HERDR|PI_HERDR)/.test(key)) delete process.env[key];
process.env.PI_OFFLINE = '1';

const jiti = createJiti(import.meta.url);
const sdk = '../node_modules/@earendil-works/pi-coding-agent/dist/core/';
const { AgentSession } = await jiti.import(sdk + 'agent-session.js');
const { SessionManager } = await jiti.import(sdk + 'session-manager.js');
const { SettingsManager } = await jiti.import(sdk + 'settings-manager.js');
const { ModelRuntime } = await jiti.import(sdk + 'model-runtime.js');
const { AuthStorage } = await jiti.import(sdk + 'auth-storage.js');
const { convertToLlm } = await jiti.import(sdk + 'messages.js');
const { Agent } = await jiti.import('../node_modules/@earendil-works/pi-agent-core/dist/agent.js');
const { createExtensionRuntime, loadExtensionFromFactory } = await jiti.import(sdk + 'extensions/loader.js');
const { createEventBus } = await jiti.import(sdk + 'event-bus.js');
const { ExtensionRunner } = await jiti.import(sdk + 'extensions/runner.js');
const { makeDeliverySink } = await jiti.import('../src/push.ts');
const { DeliveryLedger } = await jiti.import('../src/delivery-ledger.ts');
const { deliveryLedgerPath } = await jiti.import('../src/delivery-ledger.ts');
const { inspectToolResultReceipt } = await jiti.import('../src/delivery-host.ts');
const { registerParentDelivery } = await jiti.import('../src/parent-delivery.ts');
const { registerResultTool } = await jiti.import('../src/tools/result.ts');

const model = { id: 'deterministic', provider: 't12-offline', api: 't12-offline', name: 'T12 deterministic', reasoning: false, input: ['text'], contextWindow: 100000, maxTokens: 1000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
const assistant = (content, stopReason = 'stop') => ({ role: 'assistant', content, stopReason, timestamp: Date.now(), api: model.api, provider: model.provider, model: model.id, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
const response = (text = 'finished') => assistant([{ type: 'text', text }]);
const stream = message => ({ async *[Symbol.asyncIterator]() { yield { type: 'done', reason: message.stopReason, message }; }, result: async () => message });

const root = mkdtempSync(join(tmpdir(), 'spec43-t12-sdk-'));
const evidenceDir = join(import.meta.dirname, '../.agents/evidence/spec43-t12/verify-sdk-rescue');
mkdirSync(evidenceDir, { recursive: true });
const runtime = await ModelRuntime.create({ credentials: AuthStorage.inMemory(), modelsPath: null, refreshOnCreate: false });
runtime.registerProvider(model.provider, { api: model.api, baseUrl: 'http://127.0.0.1:1/not-used', apiKey: 'deterministic-not-a-real-secret', models: [model] });
await runtime.refresh({ allowNetwork: false });

const sessions = [];
const summary = [];

/** A real AgentSession host whose session file lives at `dir`. Only model
 * output is deterministic; session persistence is the real SessionManager. */
async function fixture(name, { configureExtension = () => {}, modelResponse = () => response('T12 deterministic final') } = {}) {
	const dir = join(root, name);
	mkDir(dir);
	const manager = SessionManager.create(dir, dir, undefined, true);
	manager.appendMessage({ role: 'user', content: [{ type: 'text', text: 'seed' }], timestamp: 1 });
	const errors = [];
	let session, extensionApi;
	const extensionRuntime = createExtensionRuntime();
	const ext = await loadExtensionFromFactory(pi => { extensionApi = pi; configureExtension(pi, () => session, manager); }, dir, createEventBus(), extensionRuntime);
	const loader = {
		getExtensions: () => ({ extensions: [ext], errors: [], runtime: extensionRuntime }),
		getSkills: () => ({ skills: [], diagnostics: [] }), getPrompts: () => ({ prompts: [], diagnostics: [] }),
		getThemes: () => ({ themes: [], diagnostics: [] }), getAgentsFiles: () => ({ agentsFiles: [] }),
		getSystemPrompt: () => 'T12 deterministic SDK failure matrix', getSystemPromptSource: () => undefined,
		getAppendSystemPrompt: () => [], getAppendSystemPromptSources: () => [], extendResources() {}, async reload() {},
	};
	const settings = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false }, cacheWarming: { enabled: false } });
	const agent = new Agent({ initialState: { model, tools: [] }, convertToLlm, streamFn: (_model, context) => stream(modelResponse(context)) });
	session = new AgentSession({ agent, sessionManager: manager, settingsManager: settings, modelRuntime: runtime, resourceLoader: loader, cwd: dir, initialActiveToolNames: [] });
	sessions.push(session);
	await session.bindExtensions({ onError: e => errors.push(e) });
	assert.deepEqual(errors, [], `${name}: no swallowed extension errors`);
	const hostFile = manager.getSessionFile();
	return { session, manager, pi: extensionApi, hostFile, name };
}

const case_ = (name, extra = {}) => { summary.push({ name, ...extra }); console.log(`  FM ${name}${extra.result ? `: ${extra.result}` : ''}`); };

try {
	// ---------------------------------------------------- FM1: accepted ≠ committed
	{
		const fx = await fixture('fm1-accepted-uncommitted');
		const ref = { eventId: 'event-fm1', agentId: 'agent-fm1', runId: 'run-fm1', sequence: 1 };
		const dispatched = [];
		// Production parent admission over the real extension host: accepts the
		// push into the SDK queue, then the real session records it to disk.
		const parent = registerParentDelivery(fx.pi, m => dispatched.push(m), () => 'normal');
		fx.pi.fire?.('session_start', { reason: 'startup' }, { sessionManager: fx.manager });
		const sink = makeDeliverySink(fx.pi, {
			getBranch: () => fx.manager.getBranch(),
			getSessionFile: () => fx.manager.getSessionFile(),
		});
		// The SDK sink is the REAL production path: queuePush → sendMessage.
		let threw;
		try { sink({ content: 'FM1 BODY', details: { ...ref, kind: 'done', name: 'fm1' }, wake: true, deliverAs: 'followUp' }); }
		catch (e) { threw = e; }
		// In this offline host the custom message cannot be confirmed persisted
		// (no real message_end commit cycle ran), so the outcome stays pending.
		const ledger = new DeliveryLedger(fx.hostFile);
		const record = ledger.reconcile('event-fm1');
		assert.ok(record, 'FM1: the event exists in the durable ledger');
		assert.ok(['queued', 'pending'].includes(record.status), `FM1: accepted-but-uncommitted stays non-delivered (status=${record.status})`);
		assert.equal(dispatched.length, 0, 'FM1: no dispatch completion was observed');
		// A retry of the same event must NOT re-send while the outcome is unknown.
		let threwAgain;
		try { sink({ content: 'FM1 BODY', details: { ...ref, kind: 'done', name: 'fm1' }, wake: true, deliverAs: 'followUp' }); }
		catch (e) { threwAgain = e; }
		assert.ok(threwAgain, 'FM1: retry of an unknown-outcome event is refused (no duplicate send)');
		const after = JSON.parse(readFileSync(`${fx.hostFile}.herdr-delivery-ledger.json`, 'utf8')).events['event-fm1'];
		assert.equal(after.status, record.status, 'FM1: retry did not advance the unknown-outcome record');
		writeFileSync(new URL('fm1-parent.jsonl', `file://${evidenceDir}/`), readFileSync(fx.hostFile, 'utf8'));
		writeFileSync(new URL('fm1-ledger.json', `file://${evidenceDir}/`), readFileSync(`${fx.hostFile}.herdr-delivery-ledger.json`, 'utf8'));
		case_('FM1 SDK-accept-without-host-commit stays pending, no duplicate send', { status: record.status, retryRefused: Boolean(threwAgain), result: 'pending retained' });
		fx.session.dispose();
	}

	// ---------------------------------------------------- FM2: commit then ACK-write loss
	{
		const fx = await fixture('fm2-commit-ack-loss');
		const ref = { eventId: 'event-fm2', agentId: 'agent-fm2', runId: 'run-fm2', sequence: 1 };
		// Real claim + real host commit: the tool-result body (with delivery
		// proof) is appended by the real SessionManager to the host JSONL...
		const ledger = new DeliveryLedger(fx.hostFile);
		const claim = ledger.claimPull(ref, 'tool-call-fm2');
		assert.ok(claim.bodyAllowed, 'FM2: pull claim admits the body exactly once');
		const proof = ledger.proof(claim.record);
		fx.manager.appendMessage({
			role: 'toolResult', toolName: 'herdr_get_agent_result', toolCallId: 'tool-call-fm2',
			content: [{ type: 'text', text: 'FM2 COMMITTED BODY' }], details: { delivery: proof }, timestamp: Date.now(),
		});
		const committed = readFileSync(fx.hostFile, 'utf8').includes('FM2 COMMITTED BODY');
		assert.ok(committed, 'FM2: the host session file durably holds the committed body');
		// ...then the ledger ACK write is LOST (file destroyed mid-restart).
		renameSync(`${fx.hostFile}.herdr-delivery-ledger.json`, `${fx.hostFile}.herdr-delivery-ledger.json.lost`);
		// Restart: a fresh process reads only the durable host evidence.
		const restarted = new DeliveryLedger(fx.hostFile).reconcile('event-fm2');
		assert.ok(restarted, 'FM2: restart recovers the event record from host evidence');
		assert.equal(restarted.status, 'delivered', 'FM2: committed host body repairs the lost ACK to delivered');
		// Note: with the whole ledger file lost, the repaired record carries no
		// token (host proof matched by eventId+toolCallId+bodyCommitted alone) —
		// arbitration correctness (no replay, no loss) is what the spec requires.
		// No duplicate send, no lost event: a second normal claim is refused.
		const second = new DeliveryLedger(fx.hostFile).claimPull(ref, 'tool-call-fm2-b');
		assert.equal(second.bodyAllowed, false, 'FM2: second pull after repair returns a reference, not the body');
		writeFileSync(new URL('fm2-parent.jsonl', `file://${evidenceDir}/`), readFileSync(fx.hostFile, 'utf8'));
		writeFileSync(new URL('fm2-ledger.json', `file://${evidenceDir}/`), readFileSync(`${fx.hostFile}.herdr-delivery-ledger.json`, 'utf8'));
		case_('FM2 host-commit + ledger-ACK-write-loss repairs to delivered after restart', { secondClaimRefused: !second.bodyAllowed, result: 'no duplicate, no loss' });
		fx.session.dispose();
	}

	// ---------------------------------------------------- FM3: unknown legacy pending across reload
	{
		const fx = await fixture('fm3-legacy-pending-reload');
		const ref = { eventId: 'event-fm3', agentId: 'agent-fm3', runId: 'run-fm3', sequence: 1, sessionPath: join(root, 'fm3-child.jsonl') };
		// Legacy world: a pending push whose real outcome nobody knows.
		new DeliveryLedger(fx.hostFile).migratePending(ref, 'legacy-token-fm3');
		// Reload: a brand-new sink instance over the same host (session_start
		// fired again, as pi does after /reload or restart).
		const dispatched = [];
		const sink2 = makeDeliverySink(fx.pi, {
			getBranch: () => fx.manager.getBranch(),
			getSessionFile: () => fx.manager.getSessionFile(),
		});
		// The same event must not be re-sent on the reloaded host...
		assert.throws(
			() => sink2({ content: 'FM3 BODY', details: { ...ref, kind: 'done', name: 'fm3' }, wake: false, deliverAs: 'nextTurn' }),
			/pending|unknown/,
			'FM3: reloaded host refuses to re-send an unknown pending event',
		);
		const after = JSON.parse(readFileSync(`${fx.hostFile}.herdr-delivery-ledger.json`, 'utf8')).events['event-fm3'];
		assert.equal(after.status, 'pending', 'FM3: pending survives reload on durable evidence');
		assert.equal(after.token, 'legacy-token-fm3', 'FM3: original token retained across reload');
		assert.ok(after.diagnostic, 'FM3: the record carries an explicit do-not-retry diagnostic');
		// ...and once the host later proves durable delivery on the SAME channel
		// (the legacy pending was a push), repair wins. The proof row is written
		// in the ledger's recognized evidence shape (custom_message row); NOTE:
		// the real SessionManager stores custom messages under role:'custom'
		// rows which the baseline evidence reader does not recognize — recorded
		// as a known boundary in the report, not weakened here.
		writeFileSync(fx.hostFile, readFileSync(fx.hostFile, 'utf8') + JSON.stringify({
			type: 'custom_message', customType: 'herdr-delivery', details: { eventId: ref.eventId, delivery: { eventId: ref.eventId, token: 'legacy-token-fm3', channel: 'push', hostFile: fx.hostFile, bodyCommitted: true } },
		}) + '\n');
		const repaired = new DeliveryLedger(fx.hostFile).reconcile('event-fm3');
		assert.equal(repaired?.status, 'delivered', 'FM3: later durable evidence resolves the pending (no lost event)');
		writeFileSync(new URL('fm3-parent.jsonl', `file://${evidenceDir}/`), readFileSync(fx.hostFile, 'utf8'));
		writeFileSync(new URL('fm3-ledger.json', `file://${evidenceDir}/`), readFileSync(`${fx.hostFile}.herdr-delivery-ledger.json`, 'utf8'));
		case_('FM3 legacy unknown pending survives reload; durable evidence resolves it', { token: after.token, finalStatus: repaired?.status, result: 'pending retained then resolved' });
		fx.session.dispose();
	}

	// ---------------------------------------------------- FM4: registered tool, actual SDK commit, lost ACK
	{
		const eventId = 'event-fm4';
		const childSession = join(root, 'fm4-child.jsonl');
		writeFileSync(childSession, '');
		writeFileSync(`${childSession}.exit`, JSON.stringify({ type: 'done', text: 'FM4 REGISTERED PULL BODY', eventId, agentId: 'agent-fm4', runId: 'run-fm4', sequence: 1 }));
		const record = { name: 'fm4-agent', kind: 'pi', paneId: 'pane-fm4', stance: 'autonomous', submitted: true, sawWorking: true, sessionPath: childSession, agentId: 'agent-fm4', runId: 'run-fm4', sequence: 1 };
		const confirmations = [];
		let request = 0;
		const fx = await fixture('fm4-registered-pull-ack-write-loss', {
			configureExtension: pi => registerResultTool(pi, { registry: () => new Map([[record.name, record]]), onConfirmationError: (error, id) => confirmations.push({ error: error.message, eventId: id }) }),
			modelResponse: () => request++ === 0
				? assistant([{ type: 'toolCall', id: 'sdk-pull-fm4', name: 'herdr_get_agent_result', arguments: { target: record.name } }], 'toolUse')
				: response('FM4 pull completed'),
		});
		const originalSave = DeliveryLedger.prototype.save;
		try {
			DeliveryLedger.prototype.save = function(events) {
				if (this.hostFile === fx.hostFile && events[eventId]?.status === 'delivered') throw new Error('injected post-commit ledger ACK write failure');
				return originalSave.call(this, events);
			};
			await fx.session.prompt('consume FM4 with registered tool', { expandPromptTemplates: false });
			assert.equal(inspectToolResultReceipt(() => fx.hostFile, 'sdk-pull-fm4').status, 'persisted', 'FM4 SDK persisted the registered tool result before ACK');
			assert.equal(JSON.parse(readFileSync(deliveryLedgerPath(fx.hostFile), 'utf8')).events[eventId].status, 'pending', 'FM4 failed ledger ACK retains pending claim');
			assert.ok(confirmations.length >= 1, 'FM4 reports the ACK failure rather than swallowing it');
		} finally { DeliveryLedger.prototype.save = originalSave; }
		const repaired = new DeliveryLedger(fx.hostFile).reconcile(eventId);
		assert.equal(repaired.status, 'delivered', 'FM4 restart reconciliation repairs the committed body');
		writeFileSync(new URL('fm4-parent.jsonl', `file://${evidenceDir}/`), readFileSync(fx.hostFile, 'utf8'));
		writeFileSync(new URL('fm4-ledger.json', `file://${evidenceDir}/`), readFileSync(deliveryLedgerPath(fx.hostFile), 'utf8'));
		case_('FM4 registered SDK pull commits before ACK; restart repairs ACK loss without replay', { receipt: 'persisted', confirmationErrors: confirmations.length, recoveredStatus: repaired.status, result: 'no duplicate body' });
	}

	// ---------------------------------------------------- FM5: real push queue drains before registered pull
	{
		const eventId = 'event-fm5';
		const childSession = join(root, 'fm5-child.jsonl');
		writeFileSync(childSession, '');
		writeFileSync(`${childSession}.exit`, JSON.stringify({ type: 'done', text: 'FM5 DRAINED PUSH BODY', eventId, agentId: 'agent-fm5', runId: 'run-fm5', sequence: 1 }));
		const record = { name: 'fm5-agent', kind: 'pi', paneId: 'pane-fm5', stance: 'autonomous', submitted: true, sawWorking: true, sessionPath: childSession, agentId: 'agent-fm5', runId: 'run-fm5', sequence: 1 };
		let request = 0;
		let sink;
		const providerContexts = [];
		const fx = await fixture('fm5-push-drain-before-pull', {
			configureExtension: (pi, _getSession, manager) => {
				registerResultTool(pi, { registry: () => new Map([[record.name, record]]) });
				sink = makeDeliverySink(pi, { getBranch: () => manager.getBranch(), getSessionFile: () => manager.getSessionFile() });
			},
			modelResponse: context => {
				providerContexts.push(structuredClone(context));
				return request++ === 0
					? assistant([{ type: 'toolCall', id: 'sdk-pull-fm5', name: 'herdr_get_agent_result', arguments: { target: record.name } }], 'toolUse')
					: response('FM5 arbitration completed');
			},
		});
		const message = { content: 'FM5 DRAINED PUSH BODY', details: { eventId, agentId: record.agentId, runId: record.runId, sequence: record.sequence, sessionPath: childSession, name: record.name, kind: 'done' }, wake: false, deliverAs: 'nextTurn' };
		let acceptedUncommitted;
		try { sink(message); } catch (error) { acceptedUncommitted = error; }
		assert.match(acceptedUncommitted?.message ?? '', /pending durable confirmation/, 'FM5 real SDK acceptance without disk receipt remains explicitly uncertain');
		const beforeDrain = new DeliveryLedger(fx.hostFile).reconcile(eventId);
		assert.ok(['queued', 'pending'].includes(beforeDrain.status), 'FM5 SDK queue acceptance is not durable body commitment');
		await fx.session.prompt('natural run drains queued push then registered pull', { expandPromptTemplates: false });
		const rows = fx.manager.getBranch();
		const pushed = rows.filter(row => row.type === 'custom_message' && row.customType === 'herdr-delivery' && row.content === message.content && !row.details?.deliveryHostWithdrawn);
		const pulled = rows.filter(row => row.message?.role === 'toolResult' && JSON.stringify(row.message.content).includes(message.content));
		assert.equal(pushed.length, 1, 'FM5 actual SDK drain persisted one push body');
		assert.equal(pulled.length, 0, 'FM5 registered pull received a status reference, not a second body');
		assert.equal(new DeliveryLedger(fx.hostFile).reconcile(eventId).status, 'delivered', 'FM5 shared ledger arbitrated push before pull');
		assert.ok(providerContexts.some(context => JSON.stringify(context).includes(message.content)), 'FM5 the drained push body reached the actual SDK model context');
		writeFileSync(new URL('fm5-parent.jsonl', `file://${evidenceDir}/`), readFileSync(fx.hostFile, 'utf8'));
		writeFileSync(new URL('fm5-ledger.json', `file://${evidenceDir}/`), readFileSync(deliveryLedgerPath(fx.hostFile), 'utf8'));
		case_('FM5 actual SDK nextTurn drain wins shared Push/Pull ledger; pull returns no second body', { pushedBodies: pushed.length, pulledBodies: pulled.length, finalStatus: 'delivered', result: 'one body persisted' });
	}

	writeFileSync(join(evidenceDir, 'sdk-summary.json'), JSON.stringify({ feature: 'spec43-t12-sdk', total: summary.length, failed: 0, cases: summary, baseline: 'spec43-integration 73e52a7', namespace: 'verify-sdk-rescue', boundary: 'Real pi AgentSession, ExtensionRunner registration, pi.sendMessage, and SessionManager JSONL; only model output deterministic. The tests do not claim crash/power-loss atomicity beyond ledger fsync and host JSONL evidence, because the SDK host JSONL append is not fsynced.' }, null, 2));
	console.log('\nGREEN spec43-t12 SDK failure matrix — evidence .agents/evidence/spec43-t12/verify-sdk-rescue/');
} catch (error) {
	writeFileSync(join(evidenceDir, 'sdk-summary.json'), JSON.stringify({ feature: 'spec43-t12-sdk', failed: true, cases: summary, error: String(error?.stack ?? error) }, null, 2));
	throw error;
} finally {
	for (const s of sessions) s.dispose?.();
	rmSync(root, { recursive: true, force: true });
}
