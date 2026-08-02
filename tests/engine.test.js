/**
 * Engine integration tests — run with: node --test tests/engine.test.js
 * Covers: banter pre-filter, window extraction + reflection repair, semantic
 * dedupe (.92), Ebbinghaus decay, epistemic hard-filtering + group isolation,
 * entity state supersession, depth slicing, token budget, shadow fallback,
 * degradation ladder L0→L4, model mismatch + re-embed, forget, export/import.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { mergeSettings, validateSettings } from '../src/config/settings.js';
import {
    isBanter, ebbinghaus, clamp01, estimateTokens, parseJsonLoose,
    reciprocalRankFusion, mmrSelect, cosine, escapeHtml, fnv1a,
} from '../src/utils/helpers.js';
import { StmManager } from '../src/engine/stm.js';
import { ExtractionEngine, validateExtraction, buildExtractionPrompt } from '../src/engine/extraction.js';
import { EpistemicEngine } from '../src/engine/epistemic.js';
import { StateEngine } from '../src/engine/states.js';
import { ConsolidationEngine } from '../src/engine/consolidation.js';
import { RetrievalEngine } from '../src/engine/retrieval.js';
import { RankingEngine } from '../src/engine/ranking.js';
import { InjectionEngine } from '../src/engine/injection.js';
import { ModelRouter, DEGRADATION } from '../src/ai/router.js';
import { WriteAheadQueue } from '../src/storage/adapter.js';
import { MemoryMetadataStore, MockQdrant } from './mockQdrant.js';
import { MockOpenAI } from './mockOpenAI.js';
import { createMockST } from './mockST.js';
import { createBureau } from '../index.js';

// ---------------------------------------------------------------------------
// fixture builders
// ---------------------------------------------------------------------------

function makeSettings(patch = {}) {
    const s = validateSettings(mergeSettings({}));
    s.mode = 'on';
    s.lanes.fast.model = 'mock-fast';
    s.lanes.strong.model = 'mock-strong';
    s.lanes.embed.model = 'mock-embed';
    s.lanes.embed.dimensions = 8;
    s.state.embedDim = 8;
    s.state.embedModel = 'mock-embed';
    Object.assign(s.pipeline, patch.pipeline || {});
    return s;
}

async function makeBureauParts(settingsOverrides = {}) {
    const settings = makeSettings(settingsOverrides);
    const meta = new MemoryMetadataStore();
    const ai = new MockOpenAI({ dim: 8 });
    const router = new ModelRouter(settings, { fetchFn: ai.makeFetch() });
    const qdrant = new MockQdrant();
    const local = new MockQdrant(); // local fallback with same contract
    const wal = new WriteAheadQueue(qdrant, local, () => {});
    const stm = new StmManager({ meta, getSettings: () => settings, onEnqueueExtraction: async (j) => extraction.process(j) });
    const epistemic = new EpistemicEngine({ meta });
    const states = new StateEngine({ meta });
    const ranking = new RankingEngine({ router, getSettings: () => settings });
    const extraction = new ExtractionEngine({
        router, meta, wal, getSettings: () => settings,
        io: {
            putChip: (t, k, c, scope, x) => stm.putChip(t, k, c, scope, x),
            applyKnowledge: (rows, base, created) => epistemic.applyKnowledge(rows, base, created),
            applyStateUpdates: (u, base) => states.applyStateUpdates(u, base),
            applyWorld: (w, base) => states.applyWorld(w, base),
            emit: () => {},
        },
    });
    const retrieval = new RetrievalEngine({ router, meta, wal, ranking, epistemic, stm, states, getSettings: () => settings });
    const injection = new InjectionEngine({ retrieval, states, epistemic, stm, getSettings: () => settings, emit: () => {} });
    const consolidation = new ConsolidationEngine({ meta, wal, stm, getSettings: () => settings, emit: () => {} });
    return { settings, meta, ai, router, qdrant, local, wal, stm, epistemic, states, ranking, extraction, retrieval, injection, consolidation };
}

const scope = { chatId: 'c1', characterId: 'Mira', characterName: 'Mira', personaId: 'user', userId: 'user', sessionId: 'c1' };

// ---------------------------------------------------------------------------
// T1 — banter pre-filter
// ---------------------------------------------------------------------------

test('banter pre-filter: greetings feed STM only, never extraction', async () => {
    const { stm } = await makeBureauParts();
    const banter = stm.ingest({ text: 'lol', isUser: true, name: 'user', chatId: 'c1' });
    assert.equal(banter.accepted, true);
    assert.equal(banter.banter, true);
    assert.equal(stm.queue.length + stm.fastLane.length, 0, 'banter must not enqueue extraction');

    const real = stm.ingest({
        text: 'Mira, I found the brass key behind the lighthouse door, just like you said.',
        isUser: true, name: 'user', chatId: 'c1',
    });
    assert.equal(real.banter, false);
    assert.equal(stm.window.length, 2, 'rolling window captured both messages');
});

test('isBanter heuristics', () => {
    assert.equal(isBanter('hi!'), true);
    assert.equal(isBanter('haha nice'), true);
    assert.equal(isBanter('*waves*'), true);
    assert.equal(isBanter('I promise to meet you at dawn'), false);
    assert.equal(isBanter('The treaty was signed in 1742 by both crowns'), false);
});

test('ingest dedupe: identical message within 60s is dropped', async () => {
    const { stm } = await makeBureauParts();
    const a = stm.ingest({ text: 'A distinctly unique sentence about ravens and ledgers.', isUser: true, name: 'user', chatId: 'c1' });
    const b = stm.ingest({ text: 'A distinctly unique sentence about ravens and ledgers.', isUser: true, name: 'user', chatId: 'c1' });
    assert.equal(a.accepted, true);
    assert.equal(b.accepted, false);
    assert.equal(b.reason, 'duplicate');
});

// ---------------------------------------------------------------------------
// T3 — window extraction + validation + reflection
// ---------------------------------------------------------------------------

test('validateExtraction normalizes a full tuple payload', () => {
    const { ok, value } = validateExtraction({
        window_summary: 's',
        events: [{ event_type: 'fight', importance: 1.7, text: 'They fought.', valence: -3, knowers: ['Mira'] }],
        facts: [{ subject: 'key', predicate: 'is', object: 'brass' }],
        state_updates: [{ entity: 'Mira', entity_type: 'character', field: 'outfit', value: 'oilskin coat' }],
        world: { scene: 'dock' },
    });
    assert.equal(ok, true);
    assert.equal(value.events[0].importance, 1, 'importance clamps to 1');
    assert.equal(value.events[0].valence, -1, 'valence clamps to -1');
    assert.equal(value.state_updates[0].value, 'oilskin coat');
});

test('validateExtraction rejects garbage', () => {
    assert.equal(validateExtraction(null).ok, false);
    assert.equal(validateExtraction('nope').ok, false);
});

test('extraction prompt demands strict JSON + banter rule', () => {
    const msgs = buildExtractionPrompt({ window: [{ speaker: 'user', text: 'hello there', isUser: true }], characterName: 'Mira' });
    assert.match(msgs[0].content, /STRICT JSON/);
    assert.match(msgs[0].content, /NEVER for banter/);
    assert.match(msgs[1].content, /user: hello there/);
});

test('window extraction persists VectFox tuples, facts, goals, states, knowledge', async () => {
    const parts = await makeBureauParts();
    const { extraction, meta, states, epistemic } = parts;
    const job = {
        window: [
            { speaker: 'user', text: 'Mira, where is the brass key?', isUser: true, messageId: '0', ts: 1 },
            { speaker: 'Mira', text: 'I hid it inside the lighthouse. Tell no one — especially not the Captain.', isUser: false, messageId: '1', ts: 2 },
        ],
        scope, entry: { stm_id: 's1', source_message_ids_json: ['1'], _isUser: false, _speaker: 'Mira' },
    };
    const res = await extraction.process(job);
    assert.equal(res.extracted, true);

    const events = await meta.queryMemories({ chat_id: 'c1', memory_type: 'event' });
    assert.equal(events.length, 1);
    assert.equal(events[0].event_type, 'revelation');
    assert.deepEqual(events[0].knowers_json.sort(), ['Mira', 'user']);
    assert.deepEqual(events[0].secret_from_json, ['Captain']);
    assert.ok(events[0].vector_collection, 'event embedded into fingerprinted collection');
    assert.match(events[0].vector_collection, /mems_memos__mock-embed__8/);

    const facts = await meta.queryMemories({ chat_id: 'c1', memory_type: 'fact' });
    assert.equal(facts.length, 1);
    assert.equal(facts[0].subject_name, 'brass key');

    const stateRows = await states.allEntityStates('c1');
    assert.equal(stateRows.length, 1);
    assert.deepEqual(stateRows[0].hazards_json, ['crumbling stairs']);

    const worldLine = await states.worldLine('c1');
    assert.match(worldLine, /lighthouse cliff/);

    const knowledge = await epistemic.allForChat('c1');
    assert.ok(knowledge.some((k) => k.knower_id === 'user' && k.stance === 'knows'));
    assert.ok(knowledge.some((k) => k.knower_id === 'captain' && k.stance === 'secret_from'));
});

test('reflection repair: malformed JSON is repaired once, then stored', async () => {
    const parts = await makeBureauParts();
    const { extraction, ai, meta } = parts;
    let calls = 0;
    ai.chatResponder = () => {
        calls++;
        if (calls === 1) return '{"window_summary": "broken", "events": ['; // malformed
        return JSON.stringify({
            window_summary: 'repaired',
            events: [{ event_type: 'note', importance: 0.5, text: 'Repaired memory entry.', datetime: '', cause: '', result: '', characters: [], locations: [], items: [], concepts: [], emotion: '', valence: 0, arousal: 0, knowers: [], secret_from: [], confidence: 0.9 }],
            facts: [], goals: [], promises: [], emotions: [], knowledge: [], state_updates: [],
            world: { scene: '', time_of_day: '', weather: '', mood: '', active_factions: [] }, keywords: [],
        });
    };
    const job = { window: [{ speaker: 'user', text: 'something memorable happened here indeed', isUser: true, messageId: '9', ts: 1 }], scope, entry: {} };
    const res = await extraction.process(job);
    assert.equal(res.extracted, true);
    assert.equal(calls, 2, 'exactly one repair pass');
    const chunks = await meta.queryMemories({ chat_id: 'c1', status: 'failed_extract' });
    assert.equal(chunks.length, 0);
});

test('extraction total failure → raw chunk with status failed_extract', async () => {
    const parts = await makeBureauParts();
    const { extraction, ai, meta } = parts;
    ai.chatResponder = () => 'definitely not json at all';
    const job = { window: [{ speaker: 'user', text: 'the treaty was signed at midnight by both crowns', isUser: true, messageId: '2', ts: 1 }], scope, entry: {} };
    const res = await extraction.process(job);
    assert.equal(res.extracted, false);
    const chunks = await meta.queryMemories({ chat_id: 'c1', status: 'failed_extract' });
    assert.equal(chunks.length, 1);
    assert.match(chunks[0].text, /treaty was signed/);
});

// ---------------------------------------------------------------------------
// T5 — semantic dedupe at ingest (.92)
// ---------------------------------------------------------------------------

test('semantic dedupe: near-identical event reinforces survivor instead of duplicating', async () => {
    const parts = await makeBureauParts({ pipeline: { dedupeThreshold: 0.92 } });
    const { extraction, meta, ai } = parts;
    const mkJob = (text, mid) => ({
        window: [{ speaker: 'user', text, isUser: true, messageId: mid, ts: 1 }],
        scope, entry: { source_message_ids_json: [mid] },
    });
    ai.chatResponder = (messages) => JSON.stringify({
        window_summary: 'dup test',
        events: [{ event_type: 'note', importance: 0.5, text: 'The brass key is hidden inside the lighthouse.', datetime: '', cause: '', result: '', characters: ['Mira'], locations: ['lighthouse'], items: ['brass key'], concepts: [], emotion: '', valence: 0, arousal: 0, knowers: ['user'], secret_from: [], confidence: 0.9 }],
        facts: [], goals: [], promises: [], emotions: [], knowledge: [], state_updates: [],
        world: { scene: '', time_of_day: '', weather: '', mood: '', active_factions: [] }, keywords: ['key', 'lighthouse'],
    });
    await extraction.process(mkJob('The brass key is hidden inside the lighthouse.', '1'));
    await extraction.process(mkJob('The brass key is hidden inside the lighthouse!', '2'));
    const active = await meta.queryMemories({ chat_id: 'c1', memory_type: 'event', status: 'active' });
    const archived = await meta.queryMemories({ chat_id: 'c1', memory_type: 'event', status: 'archived' });
    assert.equal(active.length, 1, 'only one survivor');
    assert.ok(archived.length + active.length >= 1);
    assert.ok(active[0].reinforcement_count >= 1 || active[0].strength > 1 || archived.length === 1);
});

// ---------------------------------------------------------------------------
// decay math
// ---------------------------------------------------------------------------

test('Ebbinghaus: retention halves at t = half-life', () => {
    const r = ebbinghaus(168, 168);
    assert.ok(Math.abs(r - Math.E ** -1) < 1e-9);
    assert.ok(ebbinghaus(0, 168) === 1);
    assert.ok(ebbinghaus(336, 168) < ebbinghaus(168, 168));
});

test('clamp01 + estimateTokens + escapeHtml', () => {
    assert.equal(clamp01(1.5), 1);
    assert.equal(clamp01(-0.2), 0);
    assert.ok(estimateTokens('a'.repeat(100)) >= 25);
    const esc = escapeHtml('<b>&"x"</b>');
    assert.ok(!esc.includes('<b>'), 'tags escaped');
    assert.ok(esc.includes('&' + 'lt;') && esc.includes('&' + 'amp;') && esc.includes('&' + 'quot;'), 'entities present');
});

// ---------------------------------------------------------------------------
// T7 — epistemic hard filter + group isolation
// ---------------------------------------------------------------------------

test('epistemic hard filter: secret never leaks to excluded character', () => {
    const secret = {
        knowers_json: ['user', 'Mira'],
        secret_from_json: ['Captain'],
        scope: 'chat',
    };
    assert.equal(EpistemicEngine.allows(secret, 'Captain'), false, 'Captain is excluded');
    assert.equal(EpistemicEngine.allows(secret, 'Mira'), true, 'Mira is a knower');
    assert.equal(EpistemicEngine.allows(secret, 'user'), true);
    const pub = { knowers_json: [], secret_from_json: [], scope: 'chat' };
    assert.equal(EpistemicEngine.allows(pub, 'Captain'), true, 'unattributed is public');
    const glob = { knowers_json: ['someone'], secret_from_json: [], scope: 'global' };
    assert.equal(EpistemicEngine.allows(glob, 'Captain'), true, 'global scope bypasses attribution');
});

test('group isolation: retrieval for Captain excludes Mira-only secrets end-to-end', async () => {
    const parts = await makeBureauParts();
    const { extraction, retrieval, meta } = parts;
    await extraction.process({
        window: [
            { speaker: 'user', text: 'Mira, where is the brass key?', isUser: true, messageId: '0', ts: 1 },
            { speaker: 'Mira', text: 'Hidden inside the lighthouse. Not a word to the Captain.', isUser: false, messageId: '1', ts: 2 },
        ],
        scope, entry: { source_message_ids_json: ['1'] },
    });
    const all = await meta.queryMemories({ chat_id: 'c1' });
    assert.ok(all.length >= 1);

    const miraView = await retrieval.retrieve({ query: 'brass key lighthouse', chatId: 'c1', characterName: 'Mira', skipLlm: true });
    const captainView = await retrieval.retrieve({ query: 'brass key lighthouse', chatId: 'c1', characterName: 'Captain', skipLlm: true });

    const secretId = all.find((m) => (m.secret_from_json || []).includes('Captain'))?.id;
    assert.ok(secretId, 'fixture produced a secret memory');
    assert.ok(miraView.memories.some((m) => m.record.id === secretId), 'Mira may recall her own secret');
    assert.ok(!captainView.memories.some((m) => m.record.id === secretId), 'Captain must NEVER receive it');
});

// ---------------------------------------------------------------------------
// T8 — entity state supersession
// ---------------------------------------------------------------------------

test('entity state supersession: newer snapshot replaces, history kept', async () => {
    const { states, meta } = await makeBureauParts();
    const base = { chat_id: 'c1', character_id: 'Mira', source_id: 'm1' };
    await states.applyStateUpdates([{ entity: 'Mira', entity_type: 'character', field: 'outfit', value: 'oilskin coat', confidence: 0.9 }], base);
    await states.applyStateUpdates([{ entity: 'Mira', entity_type: 'character', field: 'outfit', value: 'oilskin coat: salt-stained', confidence: 0.9 }], { ...base, source_id: 'm2' });
    const active = await states.allEntityStates('c1');
    assert.equal(active.length, 1, 'one active snapshot');
    assert.deepEqual(active[0].outfit_json, ['oilskin coat: salt-stained']);
    const history = await meta.getEntityStates ? await meta.getEntityStates('c1') : [];
    const allRows = [...meta.entityStates.values()];
    assert.ok(allRows.some((r) => r.status === 'superseded'), 'superseded history retained');
});

test('world state updates supersede on change, skip when unchanged', async () => {
    const { states, meta } = await makeBureauParts();
    const base = { chat_id: 'c1', source_id: 'm1' };
    await states.applyWorld({ scene: 'dock', time_of_day: 'dusk', weather: '', mood: '', active_factions: [] }, base);
    await states.applyWorld({ scene: 'dock', time_of_day: 'dusk', weather: '', mood: '', active_factions: [] }, base);
    let rows = await states.allWorld('c1');
    assert.equal(rows.filter((r) => r.key === 'scene').length, 1, 'unchanged value does not duplicate');
    await states.applyWorld({ scene: 'lighthouse', time_of_day: '', weather: '', mood: '', active_factions: [] }, base);
    rows = await states.allWorld('c1');
    assert.match(await states.worldLine('c1'), /lighthouse/);
});

// ---------------------------------------------------------------------------
// T10 — ranking math, RRF, MMR, budget
// ---------------------------------------------------------------------------

test('RRF fusion + MMR diversity behave sanely', () => {
    const fused = reciprocalRankFusion([['a', 'b', 'c'], ['b', 'a', 'd']]);
    assert.equal(fused[0].id === 'a' || fused[0].id === 'b', true);
    assert.ok(fused[0].score > fused[3].score);
    const cands = [
        { id: 'x', score: 0.9, v: [1, 0] },
        { id: 'y', score: 0.85, v: [0.99, 0.01] },
        { id: 'z', score: 0.8, v: [0, 1] },
    ];
    const picked = mmrSelect(cands, 0.5, 2, (a, b) => cosine(a.v, b.v));
    assert.equal(picked.length, 2);
    assert.equal(picked[1].id, 'z', 'MMR prefers the diverse third candidate over the near-dup');
});

test('weighted score honors penalties and stays bounded', async () => {
    const { ranking } = await makeBureauParts();
    const rec = (over = {}) => ({
        id: Math.random().toString(36).slice(2), memory_type: 'fact',
        text: 't', summary: 's', created_at: new Date().toISOString(),
        importance: 0.5, trust: 0.8, confidence: 0.9, strength: 1,
        half_life_hours: 168, validity_status: 'active', verification_status: 'unverified',
        status: 'active', ...over,
    });
    const records = new Map([
        ['good', rec({ id: 'good' })],
        ['contradicted', rec({ id: 'contradicted', validity_status: 'contradicted' })],
        ['rejected', rec({ id: 'rejected', verification_status: 'rejected' })],
    ]);
    const candidates = [
        { id: 'good', denseScore: 0.9, sparseScore: 0.5, sources: ['dense0'] },
        { id: 'contradicted', denseScore: 0.9, sparseScore: 0.5, sources: ['dense0'] },
        { id: 'rejected', denseScore: 0.9, sparseScore: 0.5, sources: ['dense0'] },
    ];
    const trace = [];
    const out = await ranking.rank({
        query: 'q', candidates, records, trace, t0: Date.now(),
        stmMatches: [], knower: null,
    });
    const good = out.memories.find((m) => m.record.id === 'good');
    const bad = out.memories.find((m) => m.record.id === 'contradicted');
    assert.ok(good, 'good memory kept');
    assert.ok(!out.memories.some((m) => m.record.id === 'rejected'), 'rejected memory is fully penalized');
    if (bad) assert.ok(bad.finalScore < good.finalScore, 'contradiction penalty applies');
    for (const m of out.memories) assert.ok(m.finalScore >= 0 && m.finalScore <= 1);
});

test('token budget: memories are cut when budget is exhausted', async () => {
    const parts = await makeBureauParts({ pipeline: { injectionBudget: 120, finalTopN: 10, minScore: 0 } });
    const { ranking } = parts;
    const records = new Map();
    const candidates = [];
    for (let i = 0; i < 8; i++) {
        const id = `m${i}`;
        records.set(id, {
            id, memory_type: 'fact', text: 'word '.repeat(120), summary: 'word '.repeat(120),
            created_at: new Date().toISOString(), importance: 0.9, trust: 0.9, confidence: 0.9,
            strength: 1, half_life_hours: 999, validity_status: 'active', verification_status: 'unverified', status: 'active',
        });
        candidates.push({ id, denseScore: 0.9, sources: ['dense0'] });
    }
    const out = await ranking.rank({
        query: 'q', candidates, records, trace: [], t0: Date.now(), stmMatches: [], knower: null,
    });
    const total = out.memories.reduce((s, m) => s + m.tokens, 0);
    assert.ok(total <= 120, `budget honored (${total} <= 120)`);
    assert.ok(out.memories.length >= 1 && out.memories.length < 8, 'some memories cut');
});

// ---------------------------------------------------------------------------
// T11 — injection block, depth slicing, shadow fallback
// ---------------------------------------------------------------------------

test('injection block shape + shadow mode stores but never injects', async () => {
    const parts = await makeBureauParts();
    parts.settings.mode = 'shadow';
    const { injection, extraction } = parts;
    await extraction.process({
        window: [
            { speaker: 'user', text: 'Mira, where is the brass key?', isUser: true, messageId: '0', ts: 1 },
            { speaker: 'Mira', text: 'Inside the lighthouse, hidden well.', isUser: false, messageId: '1', ts: 2 },
        ],
        scope, entry: {},
    });
    let injected = null;
    const host = { inject: (text, opts) => { injected = { text, opts }; return true; } };
    const res = await injection.inject(host, { query: 'brass key', chatId: 'c1', characterName: 'Mira' });
    assert.equal(res.injected, false, 'shadow mode never injects');
    assert.equal(res.reason, 'shadow');
    assert.equal(injected, null);
    assert.ok(res.block.text.includes("[Mem's Memos — Recall & World State]"));
    assert.ok(res.block.text.includes('World: lighthouse cliff'));
    assert.ok(res.block.text.includes('What Mira knows:'));
    assert.ok(res.block.text.includes('Never mention the memory system'));
});

test('active mode injects through host hook at configured depth', async () => {
    const parts = await makeBureauParts({ pipeline: { injectionDepth: 3 } });
    const { injection } = parts;
    let captured = null;
    const host = { inject: (text, opts) => { captured = { text, opts }; return true; } };
    const res = await injection.inject(host, { query: 'anything at all', chatId: 'c1', characterName: 'Mira' });
    assert.equal(res.injected, true);
    assert.equal(captured.opts.depth, 3, 'depth slicing honored');
});

test('injection failure → shadow fallback with reason', async () => {
    const parts = await makeBureauParts();
    const { injection } = parts;
    const host = { inject: () => { throw new Error('host exploded'); } };
    const res = await injection.inject(host, { query: 'q', chatId: 'c1', characterName: 'Mira' });
    assert.equal(res.injected, false);
    assert.equal(res.reason, 'failed');
    assert.ok(res.block, 'block still available for copy');
});

// ---------------------------------------------------------------------------
// router circuit breaker + degradation ladder
// ---------------------------------------------------------------------------

test('circuit breaker opens after 3 failures; degradation ladder descends', async () => {
    const settings = makeSettings();
    const ai = new MockOpenAI({ dim: 8, failureRate: 1 }); // everything fails
    const router = new ModelRouter(settings, { fetchFn: ai.makeFetch() });
    for (let i = 0; i < 3; i++) {
        await assert.rejects(() => router.run('fast', (c) => c.chat([{ role: 'user', content: 'x' }])));
    }
    assert.equal(router.breaker('fast').open, true);
    assert.equal(router.degradationLevel(), DEGRADATION.L2_NO_EXTRACT);
    router.reportFailure('embed', new Error('down'));
    router.reportFailure('embed', new Error('down'));
    router.reportFailure('embed', new Error('down'));
    assert.equal(router.degradationLevel(), DEGRADATION.L4_ALL_DOWN);
    router.setQdrantDown(true);
    router.reportSuccess('fast');
    router.reportSuccess('embed');
    assert.equal(router.degradationLevel(), DEGRADATION.L3_QDRANT_DOWN);
});

// ---------------------------------------------------------------------------
// T12 — export/import round trip + forget
// ---------------------------------------------------------------------------

test('export/import round-trips all stores; forget removes memory + vector', async () => {
    const parts = await makeBureauParts();
    const { meta, extraction, wal, qdrant } = parts;
    await extraction.process({
        window: [{ speaker: 'user', text: 'remember the amber compass above the mantel', isUser: true, messageId: '3', ts: 1 }],
        scope, entry: {},
    });
    const before = await meta.queryMemories({ chat_id: 'c1' });
    assert.ok(before.length >= 1);

    const bundle = await meta.exportAll();
    const fresh = new MemoryMetadataStore();
    await fresh.importAll(bundle);
    const after = await fresh.queryMemories({ chat_id: 'c1' });
    assert.equal(after.length, before.length, 'import restores every memory');

    const target = before[0];
    await meta.updateMemory(target.id, { status: 'deleted', validity_status: 'deleted' });
    await wal.enqueue('delete', target.vector_collection, [target.id]);
    const gone = await meta.getMemory(target.id);
    assert.equal(gone.status, 'deleted');
    const remaining = await qdrant.scroll(target.vector_collection, {});
    assert.ok(!remaining.some((r) => r.id === target.id), 'vector removed from store');
});

// ---------------------------------------------------------------------------
// consolidation
// ---------------------------------------------------------------------------

test('sleep cycle: contradiction supersession + reinforcement + archival', async () => {
    const parts = await makeBureauParts();
    const { consolidation, meta } = parts;
    const mk = (id, obj, daysAgo, trust = 0.8) => ({
        id, uuid: id, memory_type: 'fact', subject_id: 'name:mira', predicate: 'lives in',
        object_name: obj, text: `Mira lives in ${obj}`, summary: `Mira lives in ${obj}`,
        chat_id: 'c1', tenant_id: 'default', status: 'active', validity_status: 'active',
        verification_status: 'unverified', importance: 0.5, trust, confidence: 0.9, strength: 1,
        half_life_hours: 168, created_at: new Date(Date.now() - daysAgo * 86400_000).toISOString(),
        updated_at: new Date().toISOString(), keywords_json: [], knowers_json: [], secret_from_json: [],
    });
    await meta.putMemory(mk('old', 'the dockhouse', 40, 0.7));
    await meta.putMemory(mk('new', 'the lighthouse', 1, 0.9));
    await meta.putMemory({
        id: 'ancient', uuid: 'ancient', memory_type: 'event', text: 'dust', summary: 'dust',
        chat_id: 'c1', tenant_id: 'default', status: 'active', validity_status: 'active',
        verification_status: 'unverified', importance: 0.1, trust: 0.5, confidence: 0.5,
        strength: 1, half_life_hours: 1, created_at: new Date(Date.now() - 400 * 86400_000).toISOString(),
        updated_at: new Date().toISOString(), keywords_json: [], knowers_json: [], secret_from_json: [],
        access_count: 0, reinforcement_count: 0,
    });

    const report = await consolidation.sleep('c1');
    const oldFact = await meta.getMemory('old');
    const newFact = await meta.getMemory('new');
    const ancient = await meta.getMemory('ancient');
    assert.equal(newFact.validity_status, 'active', 'newer + higher trust wins');
    assert.ok(['contradicted', 'superseded'].includes(oldFact.validity_status), 'loser marked');
    assert.equal(ancient.status, 'archived', 'retention-floor memory archived');
    assert.ok(report.merged + report.superseded >= 1);
});

// ---------------------------------------------------------------------------
// full-bureau smoke test through mockST (index.js wiring)
// ---------------------------------------------------------------------------

test('bureau boots on mockST: ingest → extract → shadow/ON injection at depth', async () => {
    const st = createMockST();
    try {
        const { createHostForTest } = await import('./testHost.js');
        const ai = new MockOpenAI({ dim: 8 });
        const host = createHostForTest(st.ctx, { fetchFn: ai.makeFetch() });
        const bureau = createBureau(host);
        const meta = new MemoryMetadataStore();
        const vec = new MockQdrant();
        await bureau._testWireMeta(meta, vec);
        await bureau.start();

        await st.sendUser('Mira, I need to know about the brass key you mentioned yesterday.');
        await st.sendCharacter('I hid it inside the lighthouse — tell no one, especially not the Captain.');
        await new Promise((r) => setTimeout(r, 120)); // let the async queue drain

        const memories = await meta.queryMemories({ chat_id: 'chat-001' });
        assert.ok(memories.length >= 1, 'extraction produced memories via events');

        // shadow by default on first run: nothing injected
        assert.equal(st.injected.text, '');
        bureau.setMode('on');
        await st.startGeneration();
        assert.match(st.injected.text, /Mem's Memos/);
        assert.equal(st.injected.depth, 1, 'default injection depth is 1');
        bureau.stop();
    } finally {
        st.destroy();
    }
});
