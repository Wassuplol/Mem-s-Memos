/**
 * T9 — Retrieval: trigger detection, multi-query expansion, HyDE, hybrid
 * dense+sparse search, entity graph walk (1 hop), temporal windowing, scope
 * filter, EPISTEMIC HARD FILTER.
 *
 * Every stage appends to a `trace` array — the pipeline ledger in the Reading
 * Room renders it (query → HyDE → hits → fusion → rerank → compress → budget).
 */

import { keywordTokens, truncateWords, nowIso } from '../utils/helpers.js';
import { logger } from '../utils/logger.js';
import { EpistemicEngine } from './epistemic.js';

export function buildHydePrompt(query, characterName) {
    return [
        {
            role: 'system',
            content:
                'You write hypothetical memory entries for a memory bureau. Given a query, write ONE short plausible memory passage (2-4 sentences, past tense, specific) that would answer it. Do not answer the query — write the memory itself.',
        },
        { role: 'user', content: `Query: ${query}\nCharacter whose memories these are: ${characterName || 'unknown'}\n\nHypothetical memory passage:` },
    ];
}

export function buildExpansionPrompt(query) {
    return [
        {
            role: 'system',
            content:
                'Rewrite a memory-retrieval query into 3 alternative phrasings (synonyms, entities, time references). Output STRICT JSON: {"queries":["...","...","..."]} and nothing else.',
        },
        { role: 'user', content: `Query: ${query}` },
    ];
}

/** Cheap heuristic: does this generation need memory at all? */
export function shouldRetrieve(text) {
    const s = String(text || '').toLowerCase();
    if (!s.trim()) return false;
    if (s.length > 40) return true; // any substantial turn benefits
    return /remember|recall|last time|earlier|before|yesterday|ago|promise|told you|know about|what did|when did|where did|who (was|is)|\?/.test(s);
}

export class RetrievalEngine {
    /**
     * @param {object} deps
     * @param {import('../ai/router.js').ModelRouter} deps.router
     * @param {import('../storage/adapter.js').MetadataStore} deps.meta
     * @param {import('../storage/adapter.js').WriteAheadQueue} deps.wal
     * @param {import('./ranking.js').RankingEngine} deps.ranking
     * @param {import('./epistemic.js').EpistemicEngine} deps.epistemic
     * @param {import('./stm.js').StmManager} deps.stm
     * @param {import('./states.js').StateEngine} deps.states
     * @param {()=>object} deps.getSettings
     */
    constructor({ router, meta, wal, ranking, epistemic, stm, states, getSettings }) {
        this.router = router;
        this.meta = meta;
        this.wal = wal;
        this.ranking = ranking;
        this.epistemic = epistemic;
        this.stm = stm;
        this.states = states;
        this.getSettings = getSettings;
    }

    /**
     * Full T9+T10 pipeline.
     * @param {object} q
     * @param {string} q.query — the retrieval query (usually the last user msg)
     * @param {string} q.chatId
     * @param {string} [q.characterName] — responding character (epistemic key)
     * @param {string} [q.characterId]
     * @param {number} [q.topK] — override retrievalTopK
     * @param {boolean} [q.skipLlm] — manual recall may skip HyDE/expansion
     * @returns {{memories:Array, trace:Array, tokensUsed:number}}
     */
    async retrieve({ query, chatId, characterName, characterId, topK, skipLlm = false }) {
        const settings = this.getSettings();
        const p = settings.pipeline;
        const k = topK || p.retrievalTopK;
        const trace = [];
        const t0 = Date.now();
        const knower = characterName || null;
        trace.push({ stage: 'query', detail: truncateWords(query, 120), ms: 0 });

        // --- scope + epistemic pre-filter (applied server-side when Qdrant) --
        const filter = {
            chat_id: chatId,
            status: 'active',
            validity_not: ['deleted', 'false', 'rejected'],
            knower,                    // hard filter inside Qdrant/local store
            secret_from: knower,
        };

        // --- multi-query expansion (fast lane, optional) ----------------------
        let queries = [query];
        if (p.useQueryExpansion && !skipLlm && this.router.available('fast')) {
            try {
                const res = await this.router.run('fast', (c) =>
                    c.chat(buildExpansionPrompt(query), { temperature: 0.3, responseFormat: 'json' }),
                );
                const parsed = JSON.parse(res.content.match(/\{[\s\S]*\}/)?.[0] || '{}');
                if (Array.isArray(parsed.queries)) {
                    queries = [query, ...parsed.queries.filter((q2) => typeof q2 === 'string').slice(0, 3)];
                }
                trace.push({ stage: 'expand', detail: `${queries.length} queries`, ms: Date.now() - t0 });
            } catch (err) {
                trace.push({ stage: 'expand', detail: `skipped (${String(err?.message || err).slice(0, 60)})`, ms: Date.now() - t0 });
            }
        } else {
            trace.push({ stage: 'expand', detail: 'off', ms: 0 });
        }

        // --- HyDE -------------------------------------------------------------
        let hydeVector = null;
        const collection = this.wal.active.collectionFor({
            model: settings.lanes.embed.model || 'unconfigured',
            dim: settings.lanes.embed.dimensions || settings.state.embedDim || 0,
        });
        const embedOk = this.router.available('embed') && settings.lanes.embed.model;
        if (p.useHyde && !skipLlm && embedOk && this.router.available('fast')) {
            try {
                const hyde = await this.router.run('fast', (c) =>
                    c.chat(buildHydePrompt(query, characterName), { temperature: 0.4, maxTokens: 160 }),
                );
                const emb = await this.router.run('embed', (c) =>
                    c.embed((settings.lanes.embed.queryPrefix || '') + hyde.content, {
                        dimensions: settings.lanes.embed.dimensions || 0,
                    }),
                );
                hydeVector = emb.vectors[0];
                trace.push({ stage: 'hyde', detail: truncateWords(hyde.content, 90), ms: Date.now() - t0 });
            } catch (err) {
                trace.push({ stage: 'hyde', detail: `failed (${String(err?.message || err).slice(0, 60)})`, ms: Date.now() - t0 });
            }
        } else {
            trace.push({ stage: 'hyde', detail: 'off', ms: 0 });
        }

        // --- dense search (per query + hyde) -----------------------------------
        const denseLists = [];
        if (embedOk) {
            for (const q2 of queries) {
                try {
                    const emb = await this.router.run('embed', (c) =>
                        c.embed((settings.lanes.embed.queryPrefix || '') + q2, {
                            dimensions: settings.lanes.embed.dimensions || 0,
                        }),
                    );
                    const hits = await this.wal.active.searchDense(collection, emb.vectors[0], {
                        topK: k,
                        filter,
                        namedVector: 'dense_main',
                        withVectors: true,
                    });
                    denseLists.push(hits);
                } catch (err) {
                    logger.warn('dense search failed', { err: String(err?.message || err) });
                }
            }
            if (hydeVector) {
                try {
                    denseLists.push(await this.wal.active.searchDense(collection, hydeVector, {
                        topK: k, filter, namedVector: 'dense_summary', withVectors: true,
                    }));
                } catch (err) {
                    logger.warn('hyde dense search failed', { err: String(err?.message || err) });
                }
            }
        }
        const denseCount = denseLists.reduce((n, l) => n + l.length, 0);
        trace.push({ stage: 'dense', detail: `${denseCount} hits from ${denseLists.length} lists`, ms: Date.now() - t0 });

        // --- sparse keyword search ----------------------------------------------
        let sparseHits = [];
        try {
            sparseHits = await this.wal.active.searchSparse(collection, keywordTokens(query), { topK: k, filter });
        } catch (err) {
            logger.warn('sparse search failed', { err: String(err?.message || err) });
        }
        trace.push({ stage: 'sparse', detail: `${sparseHits.length} hits`, ms: Date.now() - t0 });

        // --- STM retrieval_cache contribution ------------------------------------
        const stmRows = await this.stm.live(chatId);
        const qTokens = keywordTokens(query);
        const stmMatches = stmRows
            .map((r) => ({ row: r, score: overlap(qTokens, keywordTokens(r.content)) }))
            .filter((x) => x.score > 0.15)
            .slice(0, 6);
        trace.push({ stage: 'stm', detail: `${stmMatches.length} live matches`, ms: Date.now() - t0 });

        // --- entity graph walk (1 hop) ---------------------------------------------
        const graphHits = [];
        const seedEntityIds = new Set();
        for (const list of denseLists) {
            for (const h of list.slice(0, 4)) {
                for (const e of h.payload?.entity_ids_json || []) seedEntityIds.add(e);
            }
        }
        if (seedEntityIds.size) {
            const related = await this.meta.queryMemories({
                chat_id: chatId,
                status: 'active',
                entity_any: [...seedEntityIds],
            });
            for (const m of related.slice(0, 10)) {
                graphHits.push({ id: m.id, payload: null, record: m, score: 0.4, viaGraph: true });
            }
        }
        trace.push({ stage: 'graph', detail: `${graphHits.length} 1-hop neighbors`, ms: Date.now() - t0 });

        // --- hydrate records + hard epistemic re-check (defense in depth) -----------
        const byId = new Map();
        const addHit = (id, source, score, payloadVec) => {
            if (!byId.has(id)) byId.set(id, { id, sources: [], rrfLists: {}, vector: payloadVec });
            const e = byId.get(id);
            e.sources.push(source);
            if (!e.rrfLists[source]) e.rrfLists[source] = [];
        };
        denseLists.forEach((list, li) => {
            list.forEach((h) => {
                addHit(h.id, `dense${li}`, h.score, h.vector);
                byId.get(h.id).denseScore = Math.max(byId.get(h.id).denseScore || 0, h.score);
                if (h.vector) byId.get(h.id).vector = h.vector;
            });
        });
        sparseHits.forEach((h) => {
            addHit(h.id, 'sparse', h.score);
            byId.get(h.id).sparseScore = Math.max(byId.get(h.id).sparseScore || 0, h.score);
        });
        graphHits.forEach((h) => addHit(h.id, 'graph', h.score));

        const ids = [...byId.keys()];
        const records = new Map();
        for (const id of ids) {
            const rec = await this.meta.getMemory(id);
            if (rec && EpistemicEngine.allows(rec, knower)) records.set(id, rec);
        }
        for (const h of graphHits) {
            if (h.record && EpistemicEngine.allows(h.record, knower)) records.set(h.id, h.record);
        }
        trace.push({
            stage: 'epistemic',
            detail: `${ids.length - records.size} sealed away from ${knower || 'unknown knower'}`,
            ms: Date.now() - t0,
        });

        // --- ranking (T10): RRF → weighted → rerank → MMR → compress → budget ------
        const ranked = await this.ranking.rank({
            query,
            candidates: [...byId.values()],
            records,
            stmMatches,
            knower,
            trace,
            t0,
        });

        // --- audit trail (T12) ------------------------------------------------------
        if (this.getSettings().governance.auditTrail) {
            for (const r of ranked.memories) {
                this.meta.audit({
                    memory_id: r.record.id,
                    action: 'recalled',
                    detail: {
                        query: truncateWords(query, 160),
                        score: r.finalScore,
                        breakdown: r.breakdown,
                        knower,
                    },
                    created_at: nowIso(),
                }).catch(() => {});
                this.meta.updateMemory(r.record.id, {
                    last_accessed: nowIso(),
                    access_count: (r.record.access_count || 0) + 1,
                    recall_count: (r.record.recall_count || 0) + 1,
                    last_query: truncateWords(query, 160),
                    last_rank: r.rank,
                    retrieval_count: (r.record.retrieval_count || 0) + 1,
                }).catch(() => {});
            }
        }

        trace.push({ stage: 'done', detail: `${ranked.memories.length} memories, ${ranked.tokensUsed} tokens`, ms: Date.now() - t0 });
        return { memories: ranked.memories, trace, tokensUsed: ranked.tokensUsed };
    }
}

function overlap(a, b) {
    if (!a.length || !b.length) return 0;
    const bs = new Set(b);
    let hit = 0;
    for (const t of new Set(a)) if (bs.has(t)) hit++;
    return hit / new Set(a).size;
}
