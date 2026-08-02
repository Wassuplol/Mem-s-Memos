/**
 * T1 + short-term layer — Ingestion queue, banter pre-filter, STM buffers.
 *
 * - Message hook lands here; scope is resolved (user/persona/character/chat/
 *   session), dedupe hash checked, optional privacy redaction applied.
 * - BANTER PRE-FILTER: greetings/one-liners feed the immediate buffer only
 *   and never reach the extraction queue.
 * - Async priority queue with backpressure; FAST LANE for user-pinned or
 *   importance >= threshold items.
 * - STM entries decay on an Ebbinghaus curve (half-life in minutes).
 */

import {
    uuid, nowIso, estimateTokens, dedupeHash, isBanter, redactPrivate,
    normalizeWhitespace, ebbinghaus, minutesBetween, truncateWords,
} from '../utils/helpers.js';
import { logger } from '../utils/logger.js';

export const STM_BUFFERS = Object.freeze({
    IMMEDIATE: 'immediate',
    SUMMARY: 'summary',
    ENTITY: 'entity',
    GOAL: 'goal',
    EMOTION: 'emotion',
    LOCATION: 'location',
    ITEM: 'item',
    PROMISE: 'promise',
    RETRIEVAL_CACHE: 'retrieval_cache',
});

export class StmManager {
    /**
     * @param {object} deps
     * @param {import('../storage/adapter.js').MetadataStore} deps.meta
     * @param {()=>object} deps.getSettings
     * @param {(entry:object)=>void} [deps.onEnqueueExtraction]
     */
    constructor({ meta, getSettings, onEnqueueExtraction }) {
        this.meta = meta;
        this.getSettings = getSettings;
        this.onEnqueueExtraction = onEnqueueExtraction || (() => {});
        this.queue = [];
        this.fastLane = [];
        this.processing = false;
        this.backpressureAt = 100; // pause accepting when queue exceeds this
        this.seenHashes = new Map(); // dedupeHash -> ts (bounded LRU-ish)
        this.window = []; // rolling message window for extraction
        this.listeners = new Set();
    }

    onChange(fn) {
        this.listeners.add(fn);
        return () => this.listeners.delete(fn);
    }
    _emit(kind, payload) {
        for (const fn of this.listeners) {
            try { fn(kind, payload); } catch { /* listener must not break engine */ }
        }
    }

    get backpressured() {
        return this.queue.length + this.fastLane.length >= this.backpressureAt;
    }

    /**
     * T1 entry point. Never blocks the caller for long: heavy work is queued.
     * @param {{text:string, isUser:boolean, name:string, messageId?:string|number,
     *          chatId:string, characterId?:string, characterName?:string,
     *          personaId?:string, userId?:string, sessionId?:string,
     *          pinned?:boolean, forceExtract?:boolean}} msg
     * @returns {{accepted:boolean, banter:boolean, reason?:string}}
     */
    ingest(msg) {
        const settings = this.getSettings();
        const text = normalizeWhitespace(msg.text);
        if (!text) return { accepted: false, banter: false, reason: 'empty' };

        // dedupe (T1)
        const scopeKey = `${msg.chatId}|${msg.characterId || ''}`;
        const hash = dedupeHash(scopeKey, text);
        const seenAt = this.seenHashes.get(hash);
        if (seenAt && Date.now() - seenAt < 60_000) {
            return { accepted: false, banter: false, reason: 'duplicate' };
        }
        this.seenHashes.set(hash, Date.now());
        if (this.seenHashes.size > 2000) {
            const cutoff = Date.now() - 120_000;
            for (const [k, ts] of this.seenHashes) if (ts < cutoff) this.seenHashes.delete(k);
        }

        // privacy redaction (T1)
        let content = text;
        if (settings.consent.redactPrivate) {
            content = redactPrivate(text, settings.consent.redactedNames || []);
        }

        // banter pre-filter (T1)
        const banter = isBanter(content) && !msg.forceExtract;

        const entry = {
            stm_id: uuid(),
            uuid: uuid(),
            schema_version: 1,
            tenant_id: 'default',
            user_id: msg.userId || null,
            persona_id: msg.personaId || null,
            character_id: msg.characterId || null,
            chat_id: msg.chatId,
            session_id: msg.sessionId || null,
            buffer_type: STM_BUFFERS.IMMEDIATE,
            slot: null,
            memory_kind: banter ? 'banter' : 'message',
            key: null,
            content,
            summary: null,
            tokens: estimateTokens(content),
            priority: msg.pinned ? 1 : 0.5,
            activation: 1,
            decay_rate: 1,
            half_life_minutes: settings.pipeline.stmHalfLifeMinutes,
            attention: 0,
            emotion: null,
            valence: 0,
            arousal: 0,
            entity_ids_json: [],
            item_ids_json: [],
            location_ids_json: [],
            goal_ids_json: [],
            source_message_ids_json: msg.messageId != null ? [String(msg.messageId)] : [],
            evidence: null,
            created_at: nowIso(),
            updated_at: nowIso(),
            last_reinforced_at: nowIso(),
            expires_at: null,
            status: 'active',
            _speaker: msg.name || (msg.isUser ? 'user' : 'character'),
            _isUser: !!msg.isUser,
        };

        // persist STM (async, fire-and-forget with error capture)
        this.meta.putStm(entry).catch((err) => logger.warn('stm persist failed', { err: String(err?.message || err) }));

        // rolling extraction window (T3 consumes this)
        this.window.push({
            speaker: entry._speaker,
            text: content,
            isUser: entry._isUser,
            messageId: msg.messageId != null ? String(msg.messageId) : null,
            ts: Date.now(),
        });
        const maxWindow = Math.max(settings.pipeline.extractionWindow * 2, 12);
        if (this.window.length > maxWindow) this.window.splice(0, this.window.length - maxWindow);

        if (!banter || msg.pinned) {
            const job = {
                kind: 'window-extract',
                entry,
                window: this.currentWindow(settings.pipeline.extractionWindow),
                scope: {
                    chatId: msg.chatId,
                    characterId: msg.characterId || null,
                    characterName: msg.characterName || null,
                    personaId: msg.personaId || null,
                    userId: msg.userId || null,
                    sessionId: msg.sessionId || null,
                },
                pinned: !!msg.pinned,
                enqueuedAt: Date.now(),
            };
            if (msg.pinned) this.fastLane.push(job);
            else this.queue.push(job);
            this._pump();
        }

        this._emit('stm', entry);
        return { accepted: true, banter };
    }

    /** Last W messages of the rolling window (extraction input). */
    currentWindow(w) {
        return this.window.slice(-Math.max(1, w));
    }

    async _pump() {
        if (this.processing) return;
        this.processing = true;
        try {
            for (;;) {
                const job = this.fastLane.shift() || this.queue.shift();
                if (!job) break;
                try {
                    await this.onEnqueueExtraction(job);
                } catch (err) {
                    logger.warn('extraction job failed', { err: String(err?.message || err) });
                    this._emit('extract-error', { job, err: String(err?.message || err) });
                }
            }
        } finally {
            this.processing = false;
        }
    }

    /** Add a typed chip (entity/goal/item/...) into STM trays. */
    async putChip(bufferType, key, content, scope, extras = {}) {
        const settings = this.getSettings();
        const entry = {
            stm_id: uuid(),
            uuid: uuid(),
            schema_version: 1,
            tenant_id: 'default',
            user_id: scope.userId || null,
            persona_id: scope.personaId || null,
            character_id: scope.characterId || null,
            chat_id: scope.chatId,
            session_id: scope.sessionId || null,
            buffer_type: bufferType,
            slot: null,
            memory_kind: 'chip',
            key: key || null,
            content: truncateWords(content, 400),
            summary: null,
            tokens: estimateTokens(content),
            priority: extras.priority ?? 0.6,
            activation: 1,
            decay_rate: 1,
            half_life_minutes: settings.pipeline.stmHalfLifeMinutes,
            attention: 0,
            emotion: extras.emotion || null,
            valence: extras.valence ?? 0,
            arousal: extras.arousal ?? 0,
            entity_ids_json: extras.entityIds || [],
            item_ids_json: [],
            location_ids_json: [],
            goal_ids_json: [],
            source_message_ids_json: extras.sourceMessageIds || [],
            evidence: null,
            created_at: nowIso(),
            updated_at: nowIso(),
            last_reinforced_at: nowIso(),
            expires_at: null,
            status: 'active',
        };
        await this.meta.putStm(entry);
        this._emit('stm', entry);
        return entry;
    }

    /** Live STM with decay applied. Returns entries sorted by buffer/priority. */
    async live(chatId) {
        const settings = this.getSettings();
        const rows = await this.meta.getStm(chatId);
        const hl = settings.pipeline.stmHalfLifeMinutes;
        const out = [];
        for (const row of rows) {
            if (row.status !== 'active') continue;
            const ageMin = minutesBetween(Date.parse(row.last_reinforced_at || row.created_at) || Date.now());
            const retention = ebbinghaus(ageMin / 60, (row.half_life_minutes || hl) / 60);
            if (retention < 0.05) {
                // decayed out of STM — expire it (consolidation decides archival)
                this.meta.deleteStm(row.stm_id).catch(() => {});
                continue;
            }
            out.push({ ...row, _retention: retention });
        }
        out.sort((a, b) => (a.buffer_type < b.buffer_type ? -1 : 1) || b.priority - a.priority);
        // capacity guard
        const cap = settings.pipeline.stmCapacity;
        if (out.length > cap) {
            const excess = out.slice(cap);
            for (const e of excess) this.meta.deleteStm(e.stm_id).catch(() => {});
            return out.slice(0, cap);
        }
        return out;
    }

    /** STM chips grouped by tray for the Blotter UI. */
    async trays(chatId) {
        const rows = await this.live(chatId);
        const trays = { entity: [], goal: [], item: [], emotion: [], location: [], promise: [], immediate: [] };
        for (const r of rows) {
            if (trays[r.buffer_type]) trays[r.buffer_type].push(r);
            else if (r.buffer_type === 'summary' || r.buffer_type === 'retrieval_cache') continue;
            else trays.immediate.push(r);
        }
        return trays;
    }

    /** FREEZE — pin an STM entry so decay stops. */
    async freeze(stmId) {
        const settings = this.getSettings();
        const rows = await this.meta.getStm(null).catch(() => []);
        const row = rows.find((r) => r.stm_id === stmId);
        if (!row) return null;
        row.priority = 1;
        row.half_life_minutes = 999999;
        row.updated_at = nowIso();
        await this.meta.putStm(row);
        this._emit('stm', row);
        return row;
    }

    /** SHRED — remove an STM entry (UI plays the shred animation first). */
    async shred(stmId) {
        await this.meta.deleteStm(stmId);
        this._emit('stm-shredded', { stmId });
    }

    /** Decay pass used by consolidation: expires STM older than 3 half-lives. */
    async decaySweep(chatId) {
        const rows = await this.meta.getStm(chatId);
        const settings = this.getSettings();
        const hl = settings.pipeline.stmHalfLifeMinutes;
        let expired = 0;
        for (const row of rows) {
            const ageMin = minutesBetween(Date.parse(row.last_reinforced_at || row.created_at) || Date.now());
            const retention = ebbinghaus(ageMin / 60, (row.half_life_minutes || hl) / 60);
            if (retention < 0.02 && row.priority < 1) {
                await this.meta.deleteStm(row.stm_id);
                expired++;
            }
        }
        return expired;
    }

    /** Approximate token usage of STM for the token bar. */
    async tokenUsage(chatId) {
        const rows = await this.live(chatId);
        return rows.reduce((sum, r) => sum + (r.tokens || estimateTokens(r.content)), 0);
    }

    clearWindow() {
        this.window = [];
    }
}
