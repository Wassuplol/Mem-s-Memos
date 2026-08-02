/**
 * T10 — Ranking & Compression.
 *
 * RRF fusion → weighted score (bounded 0..1, configurable ink-level weights)
 * → optional LLM rerank → MMR diversity → CONTEXTUAL COMPRESSION (LLM trims
 * each kept memory to the sentences relevant to the query) → token budget.
 *
 * S_final = clamp01(0.26 sem + 0.13 sparse + 0.13 rec + 0.13 imp + 0.08 trust
 *         + 0.07 emo + 0.05 graph + 0.03 nov + 0.02 acc + 0.10 comp − P)
 * P = 0.5 contradicted · 1.0 hidden · 1.0 rejected · 0.3 confidence < 0.4
 */

import {
    clamp01, ebbinghaus, hoursBetween, estimateTokens, mmrSelect, cosine,
    truncateWords, parseJsonLoose,
} from '../utils/helpers.js';
import { logger } from '../utils/logger.js';

export function buildRerankPrompt(query, docs) {
    return [
        {
            role: 'system',
            content:
                'You rank memory passages by relevance to a query. Output STRICT JSON: {"ranking":[{"i":0,"score":0.0},...]} with i = passage index and score 0..1. Rank ALL passages. Nothing else.',
        },
        {
            role: 'user',
            content: `Query: ${query}\n\nPassages:\n${docs.map((d, i) => `[${i}] ${truncateWords(d, 400)}`).join('\n')}`,
        },
    ];
}

export function buildCompressionPrompt(query, text) {
    return [
        {
            role: 'system',
            content:
                'Trim a memory passage to ONLY the sentences relevant to the query. Preserve facts verbatim; drop the rest. Output the trimmed passage only, no commentary. If nothing is relevant, output the single most relevant sentence.',
        },
        { role: 'user', content: `Query: ${query}\n\nMemory:\n${text}` },
    ];
}

export class RankingEngine {
    /**
     * @param {object} deps
     * @param {import('../ai/router.js').ModelRouter} deps.router
     * @param {()=>object} deps.getSettings
     */
    constructor({ router, getSettings }) {
        this.router = router;
        this.getSettings = getSettings;
    }

    /**
     * @param {object} args
     * @param {string} args.query
     * @param {Array}  args.candidates — hit entries from retrieval (byId values)
     * @param {Map}    args.records — id → memory record (epistemically allowed)
     * @param {Array}  args.stmMatches — [{row, score}]
     * @param {string} [args.knower]
     * @param {Array}  args.trace — pipeline ledger sink
     * @param {number} args.t0
     */
    async rank({ query, candidates, records, stmMatches = [], knower, trace, t0 }) {
        const settings = this.getSettings();
        const p = settings.pipeline;
        const w = settings.weights;
        const level = this.router.degradationLevel();

        // ---- RRF fusion ------------------------------------------------------
        const lists = [];
        const denseSorted = candidates.filter((c) => c.denseScore).sort((a, b) => b.denseScore - a.denseScore).map((c) => c.id);
        const sparseSorted = candidates.filter((c) => c.sparseScore).sort((a, b) => b.sparseScore - a.sparseScore).map((c) => c.id);
        if (denseSorted.length) lists.push(denseSorted);
        if (sparseSorted.length) lists.push(sparseSorted);
        const rrf = new Map();
        lists.forEach((list) => {
            list.forEach((id, idx) => {
                rrf.set(id, (rrf.get(id) || 0) + 1 / (60 + idx + 1));
            });
        });
        const maxRrf = Math.max(0.0001, ...rrf.values());
        trace.push({ stage: 'fusion', detail: `${rrf.size} fused candidates`, ms: Date.now() - t0 });

        // ---- weighted score ----------------------------------------------------
        const now = Date.now();
        const scored = [];
        for (const [id, rec] of records) {
            const cand = candidates.find((c) => c.id === id) || { id };
            const ageH = hoursBetween(Date.parse(rec.created_at) || now, now);
            const recW = ebbinghaus(ageH, (rec.half_life_hours || 168) * (rec.strength || 1));
            const semW = clamp01(cand.denseScore || 0);
            const sparseW = clamp01(cand.sparseScore || 0);
            const impW = clamp01(rec.importance ?? 0.5);
            const trustW = clamp01(((rec.trust ?? 0.8) + (rec.confidence ?? 0.9)) / 2);
            const emoW = clamp01(Math.abs(rec.emotional_valence ?? 0) * 0.6 + (rec.emotional_arousal ?? 0) * 0.4);
            const graphW = cand.sources?.includes('graph') ? 1 : 0;
            const novW = clamp01(1 - (rec.access_count || 0) / 10);
            const accW = clamp01(Math.min(1, (rec.recall_count || 0) / 5));
            const compW = clamp01((rrf.get(id) || 0) / maxRrf);

            let penalty = 0;
            if (rec.validity_status === 'contradicted') penalty = 0.5;
            if (rec.validity_status === 'false' || rec.status === 'archived') penalty = 1.0;
            if (rec.verification_status === 'rejected' || rec.verification_status === 'contradictory') penalty = 1.0;
            if ((rec.confidence ?? 1) < 0.4) penalty = Math.max(penalty, 0.3);

            const final = clamp01(
                w.sem * semW + w.sparse * sparseW + w.rec * recW + w.imp * impW +
                w.trust * trustW + w.emo * emoW + w.graph * graphW + w.nov * novW +
                w.acc * accW + w.comp * compW - penalty,
            );
            scored.push({
                id, record: rec, finalScore: final, vector: cand.vector,
                breakdown: { sem: semW, sparse: sparseW, rec: recW, imp: impW, trust: trustW, emo: emoW, graph: graphW, nov: novW, acc: accW, comp: compW, penalty },
            });
        }
        scored.sort((a, b) => b.finalScore - a.finalScore);
        let pool = scored.filter((s) => s.finalScore >= p.minScore).slice(0, p.retrievalTopK);
        trace.push({ stage: 'weighted', detail: `${pool.length} above floor ${p.minScore}`, ms: Date.now() - t0 });

        // ---- LLM rerank (L0 only; skipped at L1+) ----------------------------------
        if (level === 0 && p.useRerank && pool.length > 1) {
            pool = await this._rerank(query, pool, trace, t0);
        } else {
            trace.push({ stage: 'rerank', detail: level > 0 ? `skipped (L${level})` : 'off', ms: Date.now() - t0 });
        }

        // ---- MMR diversity -----------------------------------------------------------
        const simOf = (a, b) => {
            if (a.vector && b.vector) return cosine(a.vector, b.vector);
            const ka = new Set(a.record.keywords_json || []);
            const kb = new Set(b.record.keywords_json || []);
            if (!ka.size || !kb.size) return 0;
            let inter = 0;
            for (const k of ka) if (kb.has(k)) inter++;
            return inter / Math.max(ka.size, kb.size);
        };
        const diverse = mmrSelect(
            pool.map((s) => ({ ...s, score: s.finalScore })),
            p.mmrLambda,
            Math.min(p.finalTopN, pool.length),
            simOf,
        );
        trace.push({ stage: 'mmr', detail: `${diverse.length} after diversity`, ms: Date.now() - t0 });

        // ---- contextual compression (L0 only) ------------------------------------------
        if (level === 0 && p.compressMemories && this.router.available('strong')) {
            for (const item of diverse) {
                const full = item.record.text || item.record.summary || '';
                if (estimateTokens(full) < 60) continue; // short enough already
                try {
                    const res = await this.router.run('strong', (c) =>
                        c.chat(buildCompressionPrompt(query, full), { temperature: 0, maxTokens: 220 }),
                    );
                    const trimmed = res.content.trim();
                    if (trimmed && trimmed.length < full.length) item.compressed = trimmed;
                } catch (err) {
                    logger.debug('compression failed for memory', { err: String(err?.message || err) });
                }
            }
            trace.push({ stage: 'compress', detail: `${diverse.filter((d) => d.compressed).length} compressed`, ms: Date.now() - t0 });
        } else {
            trace.push({ stage: 'compress', detail: level > 0 ? `skipped (L${level})` : 'off', ms: Date.now() - t0 });
        }

        // ---- token budget ----------------------------------------------------------------
        let used = 0;
        const kept = [];
        for (const item of diverse) {
            const text = item.compressed || item.record.summary || item.record.text || '';
            const cost = estimateTokens(text) + 8; // + importance tag + bullet overhead
            if (used + cost > p.injectionBudget && kept.length) break;
            used += cost;
            kept.push({ ...item, tokens: cost, displayText: text });
        }
        // STM matches ride along in their own small budget slice (20% of budget)
        const stmBudget = Math.floor(p.injectionBudget * 0.2);
        let stmUsed = 0;
        const stmKept = [];
        for (const m of stmMatches) {
            const cost = estimateTokens(m.row.content) + 4;
            if (stmUsed + cost > stmBudget) break;
            stmUsed += cost;
            stmKept.push(m);
        }
        trace.push({
            stage: 'budget',
            detail: `${used}/${p.injectionBudget} tokens LTM · ${stmUsed}/${stmBudget} STM`,
            ms: Date.now() - t0,
        });

        kept.forEach((item, i) => { item.rank = i + 1; });
        return {
            memories: kept,
            stm: stmKept,
            tokensUsed: used + stmUsed,
            breakdown: kept.map((k) => ({ id: k.id, score: k.finalScore, breakdown: k.breakdown })),
        };
    }

    /** LLM rerank: /rerank endpoint first, chat fallback behind it. */
    async _rerank(query, pool, trace, t0) {
        const settings = this.getSettings();
        const rerankLane = settings.lanes.rerank;
        const docs = pool.map((s) => s.record.summary || s.record.text || '');
        try {
            if (rerankLane.baseUrl && rerankLane.model) {
                try {
                    const results = await this.router.run('rerank', (c) =>
                        c.rerank(query, docs, { topN: pool.length }),
                    );
                    if (results.length) {
                        for (const r of results) {
                            if (pool[r.index]) pool[r.index].rerankScore = clamp01(r.score);
                        }
                        trace.push({ stage: 'rerank', detail: `endpoint · ${results.length} scored`, ms: Date.now() - t0 });
                        return pool.slice().sort((a, b) => (b.rerankScore ?? b.finalScore) - (a.rerankScore ?? a.finalScore));
                    }
                } catch (err) {
                    if (!rerankLane.useChatFallback) throw err;
                    trace.push({ stage: 'rerank', detail: `endpoint missing → chat fallback`, ms: Date.now() - t0 });
                }
            }
            // chat fallback on the strong lane
            const res = await this.router.run('strong', (c) =>
                c.chat(buildRerankPrompt(query, docs), { temperature: 0, responseFormat: 'json' }),
            );
            const parsed = parseJsonLoose(res.content);
            const ranking = Array.isArray(parsed?.ranking) ? parsed.ranking : [];
            for (const r of ranking) {
                const i = Number(r.i);
                if (Number.isInteger(i) && pool[i]) pool[i].rerankScore = clamp01(r.score);
            }
            trace.push({ stage: 'rerank', detail: `chat fallback · ${ranking.length} scored`, ms: Date.now() - t0 });
            return pool.slice().sort((a, b) => (b.rerankScore ?? b.finalScore) - (a.rerankScore ?? a.finalScore));
        } catch (err) {
            logger.warn('rerank failed — weighted order kept', { err: String(err?.message || err) });
            trace.push({ stage: 'rerank', detail: `failed, weighted kept`, ms: Date.now() - t0 });
            return pool;
        }
    }
}
