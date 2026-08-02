/**
 * T6 — Consolidation ("sleep cycle").
 *
 * Runs at session end / manually (/mm sleep) / idle:
 *  - STM decay sweep
 *  - Ebbinghaus spaced reinforcement (S' = S * 1.4 per successful recall;
 *    retention = exp(-t/S) with S scaled by half_life_hours)
 *  - fact merge for drifted duplicates
 *  - contradiction supersession (newer + higher trust wins; history kept)
 *  - importance boost for frequently recalled memories
 *  - archival & forgetting (retention policies + forget_requested)
 */

import { nowIso, hoursBetween, cosine } from '../utils/helpers.js';
import { logger } from '../utils/logger.js';

export class ConsolidationEngine {
    /**
     * @param {object} deps
     * @param {import('../storage/adapter.js').MetadataStore} deps.meta
     * @param {import('../storage/adapter.js').WriteAheadQueue} deps.wal
     * @param {import('./stm.js').StmManager} deps.stm
     * @param {()=>object} deps.getSettings
     * @param {(kind:string, payload:object)=>void} [deps.emit]
     */
    constructor({ meta, wal, stm, getSettings, emit }) {
        this.meta = meta;
        this.wal = wal;
        this.stm = stm;
        this.getSettings = getSettings;
        this.emit = emit || (() => {});
        this.lastReport = null;
        this.running = false;
    }

    /**
     * Full sleep cycle. Returns a receipt rendered by the UI as a ledger.
     * @param {string|null} chatId — null = all chats
     */
    async sleep(chatId = null) {
        if (this.running) return this.lastReport;
        this.running = true;
        const settings = this.getSettings();
        const report = {
            startedAt: nowIso(),
            stmExpired: 0,
            reinforced: 0,
            decayed: 0,
            merged: 0,
            superseded: 0,
            archived: 0,
            forgotten: 0,
            importanceBoosts: 0,
            errors: [],
        };
        try {
            // 1) STM decay
            if (chatId) report.stmExpired = await this.stm.decaySweep(chatId);

            // 2) load candidate memories
            const filter = { status: 'active' };
            if (chatId) filter.chat_id = chatId;
            const memories = await this.meta.queryMemories(filter);
            const now = Date.now();

            // 3) retention & reinforcement bookkeeping
            for (const m of memories) {
                try {
                    const ageH = hoursBetween(Date.parse(m.created_at) || now, now);
                    const S = Math.max(1, (m.half_life_hours || settings.pipeline.halfLifeHours) * (m.strength || 1));
                    const retention = Math.exp(-ageH / S);

                    // importance boost for heavily recalled memories
                    const recalls = (m.recall_count || 0) + (m.access_count || 0);
                    if (recalls >= 5 && (m.importance || 0) < 0.95) {
                        const boosted = Math.min(0.95, (m.importance || 0.5) + 0.05);
                        await this.meta.updateMemory(m.id, { importance: boosted });
                        report.importanceBoosts++;
                        m.importance = boosted;
                    }

                    // forgetting: retention policy + user requests
                    if (m.forget_requested || this._pastRetention(m, settings, now)) {
                        await this._forget(m);
                        report.forgotten++;
                        continue;
                    }

                    // archival: retention below floor and never reinforced
                    if (retention < 0.03 && (m.reinforcement_count || 0) === 0 && (m.access_count || 0) === 0) {
                        await this.meta.updateMemory(m.id, { status: 'archived' });
                        report.archived++;
                    }
                } catch (err) {
                    report.errors.push(`retention ${m.id}: ${String(err?.message || err)}`);
                }
            }

            // 4) fact merge (drifted duplicates) + contradiction supersession
            const facts = memories.filter((m) => m.memory_type === 'fact' && m.validity_status === 'active');
            report.merged += await this._mergeFacts(facts);
            report.superseded += await this._supersedeContradictions(facts);

            // 5) spaced reinforcement: memories recalled since last sleep get S *= 1.4
            for (const m of memories) {
                const recalled = (m.recall_count || 0) > 0 && m.last_accessed && Date.parse(m.last_accessed) > (settings.state.lastConsolidatedAt || 0);
                if (recalled && m.status === 'active') {
                    const S = (m.strength || 1) * 1.4;
                    await this.meta.updateMemory(m.id, {
                        strength: Math.min(10, S),
                        reinforcement_count: (m.reinforcement_count || 0) + 1,
                    });
                    report.reinforced++;
                }
            }

            settings.state.lastConsolidatedAt = now;
            report.finishedAt = nowIso();
            this.lastReport = report;
            this.emit('consolidated', report);
            logger.info('sleep cycle complete', report);
            return report;
        } finally {
            this.running = false;
        }
    }

    _pastRetention(m, settings, now) {
        const policy = m.retention_policy || settings.governance.retentionPolicy;
        if (policy === 'forever' || policy === 'manual') return false;
        if (policy === 'ttl') {
            const ttlMs = (m.ttl_seconds || settings.governance.ttlDays * 86400) * 1000;
            return now - (Date.parse(m.created_at) || now) > ttlMs;
        }
        if (m.expires_at) return now > Date.parse(m.expires_at);
        return false;
    }

    async _forget(m) {
        await this.meta.updateMemory(m.id, { status: 'deleted', validity_status: 'deleted' });
        if (m.vector_collection) {
            await this.wal.enqueue('delete', m.vector_collection, [m.id]).catch((err) =>
                logger.warn('vector delete failed', { err: String(err?.message || err) }),
            );
        }
    }

    /** Merge same-subject same-predicate facts: newest+confident survives. */
    async _mergeFacts(facts) {
        const byKey = new Map();
        for (const f of facts) {
            if (!f.subject_id || !f.predicate) continue;
            const key = `${f.subject_id}|${f.predicate}`.toLowerCase();
            if (!byKey.has(key)) byKey.set(key, []);
            byKey.get(key).push(f);
        }
        let merged = 0;
        for (const group of byKey.values()) {
            if (group.length < 2) continue;
            group.sort((a, b) =>
                (Date.parse(b.created_at) - Date.parse(a.created_at)) ||
                (b.confidence - a.confidence) || (b.trust - a.trust),
            );
            const winner = group[0];
            for (const loser of group.slice(1)) {
                const sameObject = String(loser.object_name || '') === String(winner.object_name || '');
                await this.meta.updateMemory(loser.id, {
                    validity_status: sameObject ? 'superseded' : 'contradicted',
                    superseded_by: winner.id,
                    merged_from_json: [...(winner.merged_from_json || []), loser.id],
                });
                if (sameObject && loser.vector_collection) {
                    await this.wal.enqueue('delete', loser.vector_collection, [loser.id]).catch(() => {});
                }
                merged++;
            }
        }
        return merged;
    }

    /**
     * Contradiction supersession across facts: same subject+predicate with
     * DIFFERENT objects → newer + higher trust wins, older marked contradicted
     * (history kept, never hard-deleted).
     */
    async _supersedeContradictions(facts) {
        const byKey = new Map();
        for (const f of facts) {
            if (!f.subject_id || !f.predicate) continue;
            const key = `${f.subject_id}|${f.predicate}`.toLowerCase();
            if (!byKey.has(key)) byKey.set(key, []);
            byKey.get(key).push(f);
        }
        let superseded = 0;
        for (const group of byKey.values()) {
            const distinctObjects = new Set(group.map((f) => String(f.object_name || '')));
            if (distinctObjects.size < 2) continue;
            group.sort((a, b) =>
                (b.trust - a.trust) || (Date.parse(b.created_at) - Date.parse(a.created_at)),
            );
            const winner = group[0];
            for (const loser of group.slice(1)) {
                if (loser.validity_status !== 'active') continue;
                await this.meta.updateMemory(loser.id, {
                    validity_status: 'contradicted',
                    contradicts_ids_json: [...new Set([...(loser.contradicts_ids_json || []), winner.id])],
                });
                superseded++;
            }
        }
        return superseded;
    }

    /**
     * Semantic drift merge: vector-similar facts (> 0.95) in the same chat
     * merge into the stronger record. Runs only when embeddings exist.
     */
    async mergeDrifted(chatId) {
        const facts = await this.meta.queryMemories({
            chat_id: chatId, memory_type: 'fact', validity_status: 'active',
        });
        const withVec = facts.filter((f) => f.vector_collection && Array.isArray(f._vec));
        let merged = 0;
        for (let i = 0; i < withVec.length; i++) {
            const a = withVec[i];
            for (let j = i + 1; j < withVec.length; j++) {
                const b = withVec[j];
                if (!a._vec || !b._vec) continue;
                if (cosine(a._vec, b._vec) > 0.95) {
                    const [winner, loser] = (a.strength >= b.strength) ? [a, b] : [b, a];
                    await this.meta.updateMemory(loser.id, {
                        validity_status: 'superseded',
                        superseded_by: winner.id,
                    });
                    merged++;
                }
            }
        }
        return merged;
    }
}
