/**
 * T7 — Epistemic layer: who knows what.
 *
 * mems_knowledge rows carry stances (knows|believes|suspects|denies|told|
 * secret_from). Retrieval for character X HARD-FILTERS on X's knowledge —
 * secrets known by A never leak into B's context. Group chats: every
 * character's slice is independent.
 *
 * CLARIFICATION (per spec): epistemic filtering applies ONLY to the injection
 * block. The user-facing UI is omniscient — it shows ALL memories with SECRET
 * stamps. Secrets are filtered from OTHER CHARACTERS' prompts, never from the
 * user.
 */

import { uuid, nowIso } from '../utils/helpers.js';
import { logger } from '../utils/logger.js';

export const STANCES = Object.freeze(['knows', 'believes', 'suspects', 'denies', 'told', 'secret_from']);

export class EpistemicEngine {
    /**
     * @param {{meta: import('../storage/adapter.js').MetadataStore}} deps
     */
    constructor({ meta }) {
        this.meta = meta;
    }

    /**
     * Persist knowledge attributions produced by extraction. Also auto-derive
     * "knows" rows from event knowers[] / secret_from[] lists.
     * @param {Array} knowledgeRows — validated extraction knowledge array
     * @param {object} base — base record scope
     * @param {Array} createdMemories — memories created in the same pass
     */
    async applyKnowledge(knowledgeRows, base, createdMemories = []) {
        const rows = [];
        for (const k of knowledgeRows) {
            rows.push({
                id: uuid(),
                tenant_id: 'default',
                chat_id: base.chat_id,
                knower_id: k.knower.toLowerCase(),
                knower_name: k.knower,
                memory_id: null,
                claim_text: k.claim,
                stance: k.stance,
                confidence: k.confidence,
                since: nowIso(),
                updated_at: nowIso(),
                status: 'active',
            });
        }
        // auto-derive from event knowers/secret_from
        for (const mem of createdMemories) {
            for (const knower of mem.knowers_json || []) {
                rows.push({
                    id: uuid(),
                    tenant_id: 'default',
                    chat_id: base.chat_id,
                    knower_id: String(knower).toLowerCase(),
                    knower_name: String(knower),
                    memory_id: mem.id,
                    claim_text: mem.summary || mem.text?.slice(0, 200) || '',
                    stance: 'knows',
                    confidence: mem.confidence ?? 0.9,
                    since: nowIso(),
                    updated_at: nowIso(),
                    status: 'active',
                });
            }
            for (const excluded of mem.secret_from_json || []) {
                rows.push({
                    id: uuid(),
                    tenant_id: 'default',
                    chat_id: base.chat_id,
                    knower_id: String(excluded).toLowerCase(),
                    knower_name: String(excluded),
                    memory_id: mem.id,
                    claim_text: mem.summary || mem.text?.slice(0, 200) || '',
                    stance: 'secret_from',
                    confidence: 1,
                    since: nowIso(),
                    updated_at: nowIso(),
                    status: 'active',
                });
            }
        }
        for (const row of rows) {
            await this.meta.putKnowledge(row).catch((err) =>
                logger.warn('knowledge persist failed', { err: String(err?.message || err) }),
            );
        }
        return rows;
    }

    /**
     * HARD FILTER — may `knower` (character name, lowercase; or 'user')
     * receive `memory` in an injection block?
     *
     * Rule: a memory with non-empty knowers_json is retrievable only if the
     * knower (or 'user') is listed, or the memory is scope=global. A memory
     * listing the knower in secret_from_json is ALWAYS denied.
     */
    static allows(memory, knower) {
        const k = String(knower || '').toLowerCase();
        if (!k) return true; // no responding character context → allow (user-only view)
        const secretFrom = (memory.secret_from_json || []).map((x) => String(x).toLowerCase());
        if (secretFrom.includes(k)) return false;
        const knowers = (memory.knowers_json || []).map((x) => String(x).toLowerCase());
        if (!knowers.length) return true; // unattributed = public
        if (memory.scope === 'global') return true;
        return knowers.includes(k) || knowers.includes('user');
    }

    /**
     * Filter a list of memory records for a responding character.
     * `knower` is the character's display name.
     */
    filterForKnower(memories, knower) {
        return memories.filter((m) => EpistemicEngine.allows(m, knower));
    }

    /** Knowledge slice for one entity (the Dossier "Knows" column). */
    async knows(chatId, entityName) {
        const rows = await this.meta.getKnowledge(chatId);
        const id = String(entityName).toLowerCase();
        return rows.filter((r) => r.knower_id === id && r.stance !== 'secret_from');
    }

    /**
     * What the entity does NOT know (Dossier "sealed envelopes"). Topic labels
     * only — claim_text is withheld by the UI; content never leaks.
     */
    async doesNotKnow(chatId, entityName) {
        const rows = await this.meta.getKnowledge(chatId);
        const id = String(entityName).toLowerCase();
        const explicit = rows.filter((r) => r.knower_id === id && r.stance === 'secret_from');
        // plus: memories in this chat attributed to others but not this knower
        const memories = await this.meta.queryMemories({ chat_id: chatId, status: 'active' });
        const hidden = memories.filter((m) => !EpistemicEngine.allows(m, id));
        const topics = new Map();
        for (const m of hidden) {
            const label = topicLabel(m);
            if (!topics.has(label)) topics.set(label, { label, memoryId: m.id, secret: true });
        }
        for (const r of explicit) {
            const label = topicLabel({ summary: r.claim_text, keywords_json: [] });
            if (!topics.has(label)) topics.set(label, { label, memoryId: r.memory_id, secret: true });
        }
        return [...topics.values()];
    }

    /** Topic-only hint lines for the injection block ("does not know about: X"). */
    async topicHints(chatId, knowerName, max = 5) {
        const hidden = await this.doesNotKnow(chatId, knowerName);
        return hidden.slice(0, max).map((h) => h.label);
    }

    /** All knowledge rows for a chat (Dossier + audits). */
    async allForChat(chatId) {
        return this.meta.getKnowledge(chatId);
    }

    /** Forget support: remove all knowledge rows pointing at a memory/entity. */
    async forgetMemory(memoryId) {
        return this.meta.deleteKnowledgeWhere({ memory_id: memoryId });
    }
    async forgetKnower(chatId, knowerName) {
        return this.meta.deleteKnowledgeWhere({ chat_id: chatId, knower_id: String(knowerName).toLowerCase() });
    }
}

/** Short opaque topic label: first meaningful keyword, never the content. */
export function topicLabel(memory) {
    const kw = memory.keywords_json || [];
    if (kw.length) return `the matter of ${kw[0]}`;
    const summary = String(memory.summary || memory.text || '').trim();
    if (!summary) return 'an unspoken matter';
    const words = summary.split(/\s+/).filter((w) => w.length > 3);
    return words.length ? `the matter of ${words[0].toLowerCase()}` : 'an unspoken matter';
}
