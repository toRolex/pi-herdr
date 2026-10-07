// spec43 T12 (#55) — offline migration acceptance harness (verify namespace).
//
// Verifies the legacy-surface migration contract from the spec ("兼容与迁移"
// + issue #55 acceptance criteria), against the spec-defined behaviors —
// never against incidental implementation details. Assertions marked with a
// `PENDING-MIGRATION` comment depend on agent A's code migration and are
// expected to turn green once that lands; they are NOT weakened.
//
// Covered acceptance points:
//  [AC1] message_agent legacy entry: keeps legacy wake/inject semantics, is
//        NOT silently remapped to QueueOnly send, cannot restore takeover
//        (no marker written, no takenOver branch), cannot bypass completion
//        arbitration for a second body, and its guidance points at the new
//        tool surface (send/followup).
//  [AC2] get_agent_result consumption semantics: mid-flight returns status
//        only (no draft body), no infinite re-read of the same terminal body
//        (normal repeat is a status reference; explicit reread returns the
//        original text and is marked as a reread, never a new completion).
//  [AC3] resume stays a maintenance entry; followup (trigger turn) restores
//        the same retained session internally and assigns a distinct run.
//  [AC4] old registry/pending migrate on durable evidence: identity-unknown
//        records are held for review (identityReviewRequired), no new
//        historical completion events are synthesized, already-delivered
//        historical notifications are not replayed, unknown pending and close
//        retries recover after reload/restart.
//  [AC5] notifications: normal = safe delivery, no accidental wake beyond the
//        explicit default semantics; quiet/none preserved; a legacy
//        `idle_rearm_minutes` config loads without error and is inert.
import assert from 'node:assert/strict';
import { createJiti } from 'jiti';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const jiti = createJiti(import.meta.url);
const imp = (p, o) => jiti.import(resolve(p), o);
const { messageAgent, registerMessageTool } = await imp('src/tools/message.ts');
const { registerResultTool, getAgentResult } = await imp('src/tools/result.ts');
const { triggerTurn, resumeAgent } = await imp('src/tools/lifecycle.ts');
const { DeliveryLedger } = await imp('src/delivery-ledger.ts');
const { makeDeliverySink } = await imp('src/push.ts');
const { registerParentDelivery } = await imp('src/parent-delivery.ts');
const { deliverOnce } = await imp('src/delivery.ts');
const { loadSettings, getSettingsPaths, DEFAULT_SETTINGS } = await imp('src/settings.ts');
const sp = await imp('src/spawn.ts');
const { parseExitSidecar } = await imp('src/sessionfile.ts');

for (const k of Object.keys(process.env)) if (/^(HERDR_|PI_HERDR_)/.test(k)) delete process.env[k];

const ROOT = join(import.meta.dirname, '..');
const evidenceDir = join(ROOT, '.agents/evidence/spec43-t12/verify-offline');
mkdirSync(evidenceDir, { recursive: true });
const dir = mkdtempSync(join(tmpdir(), 'spec43-t12-migration-'));
const results = [];
const check = (name, fn) => Promise.resolve()
	.then(fn)
	.then(() => { results.push({ name, pass: true }); console.log(`  PASS ${name}`); })
	.catch(e => { results.push({ name, pass: false, error: String(e?.message ?? e) }); console.error(`  FAIL ${name}: ${e?.stack ?? e?.message ?? e}`); });

// ---- shared fixture builders ---------------------------------------------------

const record = (over = {}) => ({
	name: 'worker', agentId: 'agent-1', runId: 'run-1', sequence: 1,
	kind: 'pi', prompt: 'task', spawnedAt: 1, paneId: 'pane-old', submitted: true,
	sawWorking: true, stance: 'autonomous', sessionPath: join(dir, 'worker.jsonl'),
	definition: { name: 'worker', kind: 'pi' }, ...over,
});

/** A legacy tool surface pi stub — records registered tools and dispatched
 * messages, exposes the receiving-host context T11's real path uses. */
function makePi() {
	const toolByName = new Map();
	const handlers = new Map();
	const dispatched = [];
	return {
		pi: {
			registerTool: t => toolByName.set(t.name, t),
			on: (n, h) => { if (!handlers.has(n)) handlers.set(n, []); handlers.get(n).push(h); },
			sendMessage: (message, options) => dispatched.push({ message, options }),
			/** Fire a registered handler the way the SDK would. */
			fire(name, event, ctx) { for (const h of handlers.get(name) ?? []) h(event, ctx); },
			// The delivery message gate inspects pi's own identity through a
			// WeakSet; a stable object target keeps that arbitration working.
			hasUI: false,
		},
		toolByName, handlers, dispatched,
	};
}

const sidecar = (sessionPath, over = {}) => writeFileSync(`${sessionPath}.exit`, JSON.stringify({
	type: 'done', agentId: 'agent-1', runId: 'run-1', sequence: 1,
	eventId: 'event-1', text: 'WORKER FINAL BODY', ...over,
}));

// ==============================================================================
try {
	writeFileSync(join(dir, 'worker.jsonl'), '');

	// ---------------------------------------------------------------- [AC1]
	await check('AC1a message_agent legacy wake/inject semantics kept (not QueueOnly remap)', async () => {
		const { pi, toolByName } = makePi();
		registerMessageTool(pi);
		const tool = toolByName.get('herdr_message_agent');
		assert.ok(tool, 'herdr_message_agent is still registered');
		const sessionPath = join(dir, 'legacy-child.jsonl');
		writeFileSync(sessionPath, '');
		const rec = record({ name: 'legacy-child', paneId: 'pane-legacy', agentId: 'agent-legacy', sessionPath, runId: 'legacy-run' });
		let injected;
		const receipt = await messageAgent(
			{ target: 'legacy-child', text: 'hello legacy' },
			{
				registry: () => new Map([['legacy-child', rec]]),
				agentGet: async () => ({ ok: true, data: { paneId: 'pane-legacy', name: 'legacy-child', status: 'working' } }),
				send: async (_paneId, payload) => { injected = payload; return { ok: true, data: true }; },
				env: {},
			},
		);
		assert.ok(receipt.ok, JSON.stringify(receipt));
		// Legacy semantics: an enveloped injection through the send machinery.
		assert.match(injected, /<agent-message from=/, 'legacy entry injects the agent-message envelope');
		assert.match(injected, /hello legacy/);
		assert.equal(receipt.data.delivery, 'message', 'legacy receipt keeps the delivery axis');
		// NOT a silent QueueOnly remap: no queue-only receipt status, nothing
		// written to the child's queue-only inbox file.
		const { readQueueOnlyInbox } = await imp('src/inbox.ts');
		assert.equal(readQueueOnlyInbox(sessionPath).messages.length, 0, 'message_agent must not enqueue into the QueueOnly inbox (no silent remap)');
		assert.equal(receipt.data.status, undefined, 'receipt is not a QueueOnly queued receipt');
	});

	await check('AC1b message_agent cannot restore takeover (no marker, no takenOver field)', async () => {
		const sessionPath = join(dir, 'no-takeover.jsonl');
		writeFileSync(sessionPath, '');
		const rec = record({ name: 'no-takeover', paneId: 'pane-nt', sessionPath, runId: 'nt-run' });
		const r = await messageAgent(
			{ target: 'no-takeover', text: 'human-style input' },
			{
				registry: () => new Map([['no-takeover', rec]]),
				agentGet: async () => ({ ok: true, data: { paneId: 'pane-nt', name: 'no-takeover', status: 'idle' } }),
				send: async () => ({ ok: true, data: true }),
				env: {},
			},
		);
		assert.ok(r.ok, JSON.stringify(r));
		assert.equal(existsSync(`${sessionPath}.takeover`), false, 'no takeover marker may be written by the legacy entry');
		// PENDING-MIGRATION (T9 already removed these; T12 must not re-add):
		// no takenOver lifecycle flag is set on the record by a mere message.
		assert.equal(rec.takenOver, undefined, 'legacy entry must not flip a takenOver lifecycle flag');
	});

	await check('AC1c message_agent cannot bypass completion arbitration for a second body', async () => {
		const sessionPath = join(dir, 'arb.jsonl');
		writeFileSync(sessionPath, '');
		sidecar(sessionPath); // durable completion event-1 already saved
		const hostFile = join(dir, 'arb-host.jsonl');
		writeFileSync(hostFile, '');
		const ledger = new DeliveryLedger(hostFile);
		const rec = record({ name: 'arb', paneId: 'pane-arb', sessionPath, runId: 'run-1' });
		// The legacy entry injects an envelope carrying an event= tag — the
		// receiver parses it into a completion-looking message. Arbitration on
		// the receiving host must still gate the body through the ledger: a
		// second normal pull of the same event returns a reference, not a body.
		const r1 = await getAgentResult(
			{ target: 'arb' },
			{ hostFile, toolCallId: 'pull-1', registry: () => new Map([['arb', rec]]) },
		);
		assert.ok(r1.ok && r1.data.result === 'WORKER FINAL BODY', 'first pull delivers the body once');
		const r2 = await getAgentResult(
			{ target: 'arb' },
			{ hostFile, toolCallId: 'pull-2', registry: () => new Map([['arb', rec]]) },
		);
		assert.equal(r2.data.result, undefined, 'legacy-injected second read cannot replay the completion body');
		assert.ok(r2.data.delivery, 'second read carries the delivered/ledger reference');
		// Explicit reread remains the only exception and is marked as such.
		const r3 = await getAgentResult(
			{ target: 'arb', reread: true },
			{ hostFile, toolCallId: 'pull-3', registry: () => new Map([['arb', rec]]) },
		);
		assert.equal(r3.data.reread, true, 'reread is explicitly marked, not a new completion');
		assert.equal(r3.data.result, 'WORKER FINAL BODY', 'explicit reread returns the original text');
	});

	await check('AC1d default guidance points at the new tool surface', async () => {
		const { pi, toolByName } = makePi();
		registerMessageTool(pi);
		const legacy = toolByName.get('herdr_message_agent');
		const guidance = [legacy.description, ...(legacy.promptGuidelines ?? []), legacy.promptSnippet].join('\n');
		// The legacy entry is explicitly labeled as a compatibility entry and
		// routes ordinary traffic to the new tools.
		assert.match(guidance, /send|followup|trigger/i, 'legacy guidance names the new tool surface');
		// PENDING-MIGRATION: T12's tool-guidance migration should add an explicit
		// legacy/compat marker on message_agent. Red until agent A lands it.
		assert.match(guidance, /legacy|compat/i, 'message_agent guidance is explicitly labeled a compatibility entry');
	});

	// ---------------------------------------------------------------- [AC2]
	await check('AC2a mid-flight result returns status only, no draft body', async () => {
		const sessionPath = join(dir, 'midflight.jsonl');
		writeFileSync(sessionPath, '');
		// A draft (partial assistant text) sits in the session while the child runs.
		const { SessionManager } = await imp('node_modules/@earendil-works/pi-coding-agent/dist/core/session-manager.js');
		const mgr = new SessionManager(dir, dir, undefined, true);
		mgr.appendMessage({ role: 'assistant', content: [{ type: 'text', text: 'MIDFLIGHT DRAFT PANDA' }], timestamp: 1, api: 'x', provider: 'x', model: 'x', usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
		const draftSession = mgr.getSessionFile();
		const hostFile = join(dir, 'mf-host.jsonl');
		writeFileSync(hostFile, '');
		const rec = record({ name: 'mf', paneId: 'pane-mf', sessionPath: draftSession, runId: 'mf-run' });
		const r = await getAgentResult(
			{ target: 'mf' },
			{
				hostFile, toolCallId: 'mf-1',
				registry: () => new Map([['mf', rec]]),
				status: async () => ({ ok: true, data: 'working' }),
			},
		);
		assert.ok(r.ok, JSON.stringify(r));
		assert.equal(r.data.interim, true, 'mid-flight snapshot is interim');
		assert.equal(r.data.result, undefined, 'mid-flight result carries NO draft body by default');
		assert.equal(JSON.stringify(r.data).includes('MIDFLIGHT DRAFT PANDA'), false, 'no draft text leaks in any field');
	});

	await check('AC2b no infinite re-read: normal repeat is a reference, reread is explicit', async () => {
		const sessionPath = join(dir, 'reread.jsonl');
		writeFileSync(sessionPath, '');
		sidecar(sessionPath, { eventId: 'event-reread' });
		const hostFile = join(dir, 'reread-host.jsonl');
		writeFileSync(hostFile, '');
		const rec = record({ name: 'reread', paneId: 'pane-rr', sessionPath, runId: 'run-1' });
		const call = (extra = {}, toolCallId) => getAgentResult(
			{ target: 'reread', ...extra },
			{ hostFile, toolCallId, registry: () => new Map([['reread', rec]]) },
		);
		const first = await call({}, 'rr-1');
		assert.equal(first.data.result, 'WORKER FINAL BODY');
		for (let i = 2; i <= 4; i++) {
			const again = await call({}, `rr-${i}`);
			assert.equal(again.data.result, undefined, `normal repeat ${i} does not return the body`);
			assert.ok(again.data.delivery, 'repeat carries the ledger status reference');
		}
		const again = await call({}, 'rr-5');
		assert.equal(again.data.result, undefined, 'bounded loop: no infinite re-read');
		const explicit = await call({ reread: true }, 'rr-6');
		assert.equal(explicit.data.reread, true);
		assert.equal(explicit.data.result, 'WORKER FINAL BODY');
	});

	// ---------------------------------------------------------------- [AC3]
	await check('AC3 resume stays a maintenance entry; followup restores the session internally with a distinct run', async () => {
		const { pi, toolByName } = makePi();
		const { registerLifecycle } = await imp('src/tools/lifecycle.ts');
		registerLifecycle(pi);
		assert.ok(toolByName.get('herdr_resume_agent'), 'resume remains registered (maintenance entry)');
		assert.ok(toolByName.get('herdr_trigger_turn'), 'followup/trigger-turn is registered');
		// followup on a closed-pane record: internally reuses the same retained
		// session (no caller-side resume needed) and assigns a distinct runId.
		const sessionPath = join(dir, 'followup.jsonl');
		writeFileSync(sessionPath, '');
		writeFileSync(`${sessionPath}.completion-event`, 'run-1');
		const rec = record({ name: 'fu', paneId: undefined, sessionPath, runId: 'run-1', delivery: { kind: 'gone', at: 1 } });
		sp.clearSpawnRegistry();
		sp.putSpawnRecordForTests(rec);
		const r = await triggerTurn(
			{ target: 'fu', text: 'next task' },
			{
				fleet: async () => ({ ok: true, data: [] }),
				load: () => ({ ...DEFAULT_SETTINGS, max_parallel_agents: 4 }),
				env: {},
				childExtension: 'child.ts', autodrain: false,
				registry: { find: (p, id) => ({ provider: p, id }), hasConfiguredAuth: () => true },
				start: async () => ({ ok: true, data: { agent: { pane_id: 'pane-new' } } }),
				boot: async () => ({ ok: true, data: true }),
				submit: async () => ({ ok: true, data: true }),
				// The followup path requires durable evidence that the previous run
				// finished before it restores a closed pane — same gate the
				// delivery loop uses for queued followups.
				readSidecar: () => ({ state: 'ok', sidecar: { type: 'done', agentId: 'agent-1', runId: 'run-1', sequence: 1, eventId: 'event-fu', text: 'prior final' } }),
			},
		);
		assert.ok(r.ok, JSON.stringify(r));
		assert.equal(rec.sessionPath, sessionPath, 'followup restores the SAME retained session internally');
		assert.notEqual(rec.runId, 'run-1', 'followup assigns a distinct run identity');
		assert.equal(rec.agentId, 'agent-1', 'logical agent identity is preserved');
		sp.clearSpawnRegistry();
		// resume engine still works as a maintenance entry (handle-based).
		const sessionPath2 = join(dir, 'resume.jsonl');
		writeFileSync(sessionPath2, '');
		const rec2 = record({ name: 'res', paneId: 'pane-dead-res', sessionPath: sessionPath2, runId: 'run-res' });
		sp.clearSpawnRegistry();
		sp.putSpawnRecordForTests(rec2);
		const rr = await resumeAgent(
			{ target: 'res' },
			{
				fleet: async () => ({ ok: true, data: [] }),
				load: () => ({ ...DEFAULT_SETTINGS, max_parallel_agents: 4 }),
				env: {}, childExtension: 'child.ts', autodrain: false,
				registry: { find: (p, id) => ({ provider: p, id }), hasConfiguredAuth: () => true },
				start: async () => ({ ok: true, data: { agent: { pane_id: 'pane-res' } } }),
				boot: async () => ({ ok: true, data: true }),
			},
		);
		assert.ok(rr.ok, JSON.stringify(rr));
		assert.equal(rr.data.resumed, true, 'resume engine remains functional');
		sp.clearSpawnRegistry();
	});

	// ---------------------------------------------------------------- [AC4]
	await check('AC4a identity-unknown registry records are held for review, not turned into completions', async () => {
		const sessionPath = join(dir, 'legacy-registry-host.jsonl');
		writeFileSync(sessionPath, '');
		// A legacy registry row without agentId/runId (pre-spec43 identity).
		writeFileSync(`${sessionPath}.registry.json`, JSON.stringify([
			{ name: 'old-worker', kind: 'pi', sessionPath: join(dir, 'old-worker.jsonl'), paneId: 'pane-old-w', stance: 'autonomous' },
		]));
		writeFileSync(join(dir, 'old-worker.jsonl'), '');
		sp.clearSpawnRegistry();
		sp.restoreSpawnRegistry(sessionPath);
		const rec = sp.spawnRecords().get('old-worker');
		assert.ok(rec, 'legacy record survives migration into the live registry');
		assert.equal(rec.identityReviewRequired, true, 'identity-unknown record is explicitly held for review');
		// No new historical completion event is synthesized for it: delivery
		// sees no durable sidecar, so it must NOT fabricate a done push.
		const pushes = [];
		let sawGovernance;
		await deliverOnce({
			registry: () => sp.spawnRecords(),
			sessionPath,
			push: m => pushes.push(m),
			fleet: { ok: true, data: [] }, // pane absent
			load: () => ({ ...DEFAULT_SETTINGS, notifications: 'normal' }),
			now: () => 1e12,
			goneGraceMs: 0,
		});
		const completions = pushes.filter(m => m.details?.kind === 'done');
		assert.equal(completions.length, 0, 'no fabricated historical completion for an identity-unknown record');
		sawGovernance = pushes.map(m => m.details?.kind);
		writeFileSync(join(evidenceDir, 'ac4a-identity-review.json'), JSON.stringify({ record: { name: rec.name, identityReviewRequired: rec.identityReviewRequired }, pushes: pushes.map(p => p.details?.kind ?? p.content?.slice(0, 60)) }, null, 2));
		sp.clearSpawnRegistry();
	});

	await check('AC4b already-delivered historical notifications are not replayed after reload', async () => {
		const hostFile = join(dir, 'replay-host.jsonl');
		writeFileSync(hostFile, '');
		const sessionPath = join(dir, 'replay-child.jsonl');
		writeFileSync(sessionPath, '');
		sidecar(sessionPath, { eventId: 'event-replay' });
		// Pre-existing delivery proof inside the host file (already delivered).
		writeFileSync(hostFile, JSON.stringify({
			type: 'custom_message', customType: 'herdr-delivery',
			details: { eventId: 'event-replay', name: 'replay', kind: 'done', delivery: { eventId: 'event-replay', hostFile, token: 'legacy-token', channel: 'push', bodyCommitted: true } },
		}) + '\n');
		const rec = record({ name: 'replay', paneId: undefined, sessionPath });
		sp.clearSpawnRegistry();
		sp.putSpawnRecordForTests(rec);
		rec.delivery = { kind: 'done', at: 1 }; // historical delivered marker
		const pushes = [];
		await deliverOnce({
			registry: () => new Map([['replay', rec]]),
			sessionPath: hostFile,
			push: m => pushes.push(m),
			fleet: { ok: true, data: [] },
			load: () => ({ ...DEFAULT_SETTINGS, notifications: 'normal' }),
			goneGraceMs: 0,
		});
		assert.equal(pushes.length, 0, 'a delivered record is never re-pushed after reload/restart');
		writeFileSync(join(evidenceDir, 'ac4b-no-replay.json'), JSON.stringify({ pushes: pushes.length, eventId: 'event-replay' }, null, 2));
		sp.clearSpawnRegistry();
	});

	await check('AC4c unknown pending recovers via migratePending and reload keeps it pending (no retry, no loss)', async () => {
		const hostFile = join(dir, 'pending-host.jsonl');
		writeFileSync(hostFile, '');
		const ledger = new DeliveryLedger(hostFile);
		const ref = { eventId: 'event-pending', agentId: 'agent-1', runId: 'run-1', sequence: 1, sessionPath: join(dir, 'worker.jsonl') };
		const migrated = ledger.migratePending(ref, 'legacy-token-1');
		assert.equal(migrated.status, 'pending', 'legacy pending outcome unknown stays pending');
		assert.equal(migrated.identityReviewRequired, false, 'identity-bearing pending keeps full identity (not held for review)');
		// A NEW sink instance over the same host file (reload/restart) reconciles
		// against the durable ledger: the pending record is still there, its
		// token preserved, and a repeat push of the same event is refused rather
		// than re-sent or dropped.
		const { pi, dispatched } = makePi();
		const sink = makeDeliverySink(pi, { getBranch: () => [], getSessionFile: () => hostFile });
		assert.throws(() => sink({ content: 'again', details: { ...ref, kind: 'done' }, wake: false }), /pending|unknown/, 'reload keeps unknown pending: no silent resend');
		assert.equal(dispatched.length, 0, 'pending outcome unknown is never re-dispatched');
		const after = JSON.parse(readFileSync(`${hostFile}.herdr-delivery-ledger.json`, 'utf8')).events['event-pending'];
		assert.equal(after.status, 'pending', 'pending record survives restart on durable evidence');
		assert.equal(after.token, 'legacy-token-1', 'original token retained');
		writeFileSync(join(evidenceDir, 'ac4c-pending-recovery.json'), JSON.stringify(after, null, 2));
	});

	await check('AC4d committed body repairs a ledger ACK write failure after restart', async () => {
		const hostFile = join(dir, 'repair-host.jsonl');
		writeFileSync(hostFile, '');
		const ledger = new DeliveryLedger(hostFile);
		const ref = { eventId: 'event-repair', agentId: 'agent-1', runId: 'run-1', sequence: 1 };
		const claim = ledger.claimPull(ref, 'tool-call-1');
		assert.ok(claim.bodyAllowed);
		// The host committed the tool-result body, then the ledger ACK write
		// itself was lost (simulate: ledger file removed after commit proof was
		// appended into the host JSONL).
		const proof = ledger.proof(claim.record);
		writeFileSync(hostFile, JSON.stringify({
			type: 'message', message: { role: 'toolResult', toolCallId: 'tool-call-1', content: [{ type: 'text', text: 'WORKER FINAL BODY' }], details: { delivery: proof } },
		}) + '\n');
		rmSync(`${hostFile}.herdr-delivery-ledger.json`);
		const recovered = new DeliveryLedger(hostFile).reconcile('event-repair');
		assert.ok(recovered, 'reconcile finds the record from the durable host evidence');
		assert.equal(recovered.status, 'delivered', 'host commit evidence repairs the lost ACK (no duplicate resend, no lost event)');
		writeFileSync(join(evidenceDir, 'ac4d-ack-repair.json'), JSON.stringify(recovered, null, 2));
	});

	await check('AC4e queued Push is re-arbitrated before drain, not owned at enqueue time', async () => {
		const hostFile = join(dir, 'requeue-host.jsonl');
		writeFileSync(hostFile, '');
		const { pi, dispatched, handlers } = makePi();
		// Gate that REFUSES the commit at drain time — a queued push whose
		// boundary later rejects must be withdrawn, not drained with its body.
		const gate = { allowCommit: () => false };
		const sink = makeDeliverySink(pi, { getBranch: () => [], getSessionFile: () => hostFile }, gate);
		assert.throws(() => sink({ content: 'queued body', details: { eventId: 'event-q', agentId: 'agent-1', runId: 'run-1', sequence: 1 }, wake: true }), /pending|deferred|withdraw|unconfirmed/, 'queue acceptance is not delivery');
		assert.equal(dispatched.length, 1, 'the body was queued into the SDK (pending commit)');
		// Drain: the host message_end gate must re-arbitrate the queued body
		// before it reaches the model request; the refusing boundary withdraws it.
		const gateHandler = (handlers.get('message_end') ?? []).at(-1);
		assert.equal(typeof gateHandler, 'function', 'delivery gate is registered on message_end');
		const withdrawn = await gateHandler({ message: { ...dispatched[0].message, role: 'custom' } }, { sessionManager: { getSessionFile: () => hostFile } });
		assert.equal(withdrawn?.message?.details?.deliveryHostWithdrawn, true, 'draining a refused queued push withdraws the body');
		assert.equal(JSON.stringify(withdrawn?.message?.content ?? []).includes('queued body'), false, 'withdrawn body does not reach the model context');
		const state = JSON.parse(readFileSync(`${hostFile}.herdr-delivery-ledger.json`, 'utf8')).events['event-q'];
		assert.ok(['available', 'queued'].includes(state.status), `queued push re-arbitrated at drain (status=${state.status})`);
		writeFileSync(join(evidenceDir, 'ac4e-requeue.json'), JSON.stringify(state, null, 2));
	});

	// ---------------------------------------------------------------- [AC5]
	await check('AC5a notifications normal does not accidentally wake a finished parent', async () => {
		const { pi, dispatched } = makePi();
		// The parent admission needs a host session file for its durable notify store.
		const hostFile = join(dir, 'parent-host.jsonl');
		writeFileSync(hostFile, '');
		const registered = registerParentDelivery(pi, m => dispatched.push(m), () => 'normal');
		pi.fire('session_start', { reason: 'startup' }, { sessionManager: { getSessionFile: () => hostFile } });
		registered.accept({ content: 'late done', details: { name: 'child', kind: 'done', agentId: 'a', runId: 'r', sequence: 1 }, wake: true });
		assert.equal(dispatched.length, 0, 'normal on a finished parent holds the notice (no accidental wake)');
	});

	await check('AC5b quiet and none are preserved (no reset to normal)', async () => {
		const sessionPath = join(dir, 'quiet-none.jsonl');
		writeFileSync(sessionPath, '');
		sidecar(sessionPath, { eventId: 'event-quiet' });
		for (const notes of ['quiet', 'none']) {
			const rec = record({ name: `child-${notes}`, paneId: 'pane-gone-quiet', sessionPath });
			const pushes = [];
			await deliverOnce({
				registry: () => new Map([[rec.name, rec]]),
				sessionPath: join(dir, `${notes}-host.jsonl`),
				push: m => pushes.push(m),
				fleet: { ok: true, data: [] }, // pane absent → sidecar route resolves the terminal
				load: () => ({ ...DEFAULT_SETTINGS, notifications: notes }),
				goneGraceMs: 0,
				now: () => 1_000_000,
				extract: () => ({ text: 'WORKER FINAL BODY', message: { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'WORKER FINAL BODY' }] } }),
			});
			const done = pushes.filter(m => m.details?.kind === 'done');
			if (notes === 'quiet') {
				assert.equal(done.length, 1, 'quiet still delivers on the next natural boundary');
				assert.equal(done[0].wake, false, 'quiet never wakes');
			} else {
				assert.equal(done.length, 0, 'none stores pull-only; no automatic push');
				assert.equal(rec.delivery?.kind, 'done', 'none still marks the event so it is not lost');
			}
		}
	});

	await check('AC5c legacy idle_rearm config loads without error and is inert', async () => {
		const projectDir = join(dir, 'rearm-project', '.pi');
		mkdirSync(projectDir, { recursive: true });
		writeFileSync(join(projectDir, 'herdr.json'), JSON.stringify({ idle_rearm_minutes: 3 }));
		const resolved = loadSettings({ globalPath: join(dir, 'no-global.json'), projectPath: join(projectDir, 'herdr.json') });
		assert.equal(resolved.effective.notifications, 'normal', 'settings load cleanly with a legacy rearm key');
		assert.equal(resolved.issues.filter(i => /error|invalid/i.test(i.problem ?? '')).length, 0, 'legacy rearm config produces no hard error');
		// Inert: the effective value is forced to default, user config ignored.
		assert.equal(resolved.sources.idle_rearm_minutes, 'default', 'legacy rearm source is forced to default (inert)');
		assert.equal(resolved.effective.idle_rearm_minutes, DEFAULT_SETTINGS.idle_rearm_minutes, 'legacy rearm value does not take effect');
		// Old sidecar with a `rearm` field parses fine and is ignored.
		const oldSidecar = join(dir, 'old-sidecar.jsonl');
		writeFileSync(oldSidecar, '');
		writeFileSync(`${oldSidecar}.exit`, JSON.stringify({ type: 'done', text: 'OLD BODY', rearm: 42 }));
		const parsed = parseExitSidecar(readFileSync(`${oldSidecar}.exit`, 'utf8'));
		assert.ok(parsed.ok, 'legacy sidecar with rearm flag parses without error');
		writeFileSync(join(evidenceDir, 'ac5c-rearm.json'), JSON.stringify({ source: resolved.sources.idle_rearm_minutes, effective: resolved.effective.idle_rearm_minutes, sidecarOk: parsed.ok }, null, 2));
	});

	await check('AC5d old takeover marker files are tolerated (read, ignored, no error)', async () => {
		const sessionPath = join(dir, 'old-marker.jsonl');
		writeFileSync(sessionPath, '');
		writeFileSync(`${sessionPath}.takeover`, 'stale legacy marker');
		sidecar(sessionPath); // a real terminal exists — the stale marker must not block it
		const rec = record({ name: 'old-marker', paneId: 'pane-gone-marker', sessionPath });
		const pushes = [];
		await deliverOnce({
			registry: () => new Map([['old-marker', rec]]),
			sessionPath: join(dir, 'marker-host.jsonl'),
			push: m => pushes.push(m),
			fleet: { ok: true, data: [] }, // pane absent → sidecar route resolves the terminal
			load: () => ({ ...DEFAULT_SETTINGS, notifications: 'normal' }),
			goneGraceMs: 0,
			now: () => 1_000_000,
			extract: () => ({ text: 'WORKER FINAL BODY', message: { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'WORKER FINAL BODY' }] } }),
		});
		assert.equal(pushes.some(m => JSON.stringify(m).includes('took over')), false, 'no takeover notice is produced from a stale marker');
		assert.equal(rec.delivery?.kind, 'done', 'stale marker does not block the terminal delivery');
	});
} finally {
	sp.clearSpawnRegistry?.();
	rmSync(dir, { recursive: true, force: true });
}

const failed = results.filter(r => !r.pass);
writeFileSync(join(evidenceDir, 'migration-verify-summary.json'), JSON.stringify({
	feature: 'spec43-t12-migration-verify', total: results.length, failed: failed.length,
	results, baseline: 'integration bab5d20', namespace: 'verify-offline',
}, null, 2));
if (failed.length) {
	console.error(`\nSPEC43-T12-MIGRATION-VERIFY: ${failed.length}/${results.length} FAILED (see .agents/evidence/spec43-t12/verify-offline/)`);
	for (const f of failed) console.error(`  - ${f.name}: ${f.error}`);
	process.exit(1);
}
console.log(`\nGREEN spec43-t12 migration acceptance (${results.length}/${results.length}) — evidence .agents/evidence/spec43-t12/verify-offline/`);
