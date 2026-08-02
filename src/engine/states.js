/**
 * T8 — Entity & World State.
 *
 * mems_entity_states: living snapshots per entity — characters (outfit,
 * injuries, mood, status), places (hazards, occupants, atmosphere), objects
 * (holder, location, condition), factions (stance, hostility, strength).
 * mems_world_state: scene, time_of_day, weather, mood, open conflicts.
 *
 * Updated from extraction state_updates; stale states are superseded (history
 * kept). Injected as compact one-line snapshots. Epistemic rule: observable
 * state (outfit, location) may render; attributed internal state (hostility,
 * secret motives) respects knowers_json / secret_from.
 */

import { uuid, nowIso } from '../utils/helpers.js';
import { logger } from '../utils/logger.js';
import { EpistemicEngine } from './epistemic.js';

/** Fields treated as internal/attributed — epistemic-gated on injection. */
export const INTERNAL_FIELDS = new Set(['hostility', 'stance', 'motive', 'mood']);

export const OBSERVABLE_BY_TYPE = Object.freeze({
    character: ['outfit', 'injuries', 'status', 'location', 'mood'],
    place: ['hazards', 'occupants', 'atmosphere', 'location'],
    object: ['holder', 'location', 'condition'],
    faction: ['stance', 'hostility', 'strength'],
});

export class StateEngine {
    /**
     * @param {{meta: import('../storage/adapter.js').MetadataStore}} deps
     */
    constructor({ meta }) {
        this.meta = meta;
    }

    _entityId(name, type) {
        return `${type}:${String(name).toLowerCase()}`;
    }

    /** Current active state for an entity, or a blank scaffold. */
    async getState(chatId, entityName, entityType) {
        const entityId = this._entityId(entityName, entityType);
        const rows = await this.meta.getEntityStates(chatId);
        const cur = rows.find((r) => r.entity_id === entityId && r.status === 'active');
        return cur || {
            id: uuid(),
            tenant_id: 'default',
            chat_id: chatId,
            entity_id: entityId,
            entity_name: entityName,
            entity_type: entityType,
            outfit_json: [],
            injuries_json: [],
            mood: null,
            status_flags_json: [],
            location: null,
            occupants_json: [],
            hazards_json: [],
            holder: null,
            condition: null,
            hostility: null,
            stance: null,
            confidence: 0.9,
            source_memory_id: null,
            created_at: nowIso(),
            updated_at: nowIso(),
            superseded_by: null,
            status: 'active',
            _extra: {}, // non-schema fields (atmosphere, strength, motive…) live here
        };
    }

    /**
     * Apply extraction state_updates. Each update supersedes the previous
     * active snapshot for that entity (history retained via superseded_by).
     * @param {Array} updates — validated state_updates from extraction
     * @param {object} base — base record (scope + provenance)
     * @param {object} [epistemic] — {knowers:[], secret_from:[]} attribution
     */
    async applyStateUpdates(updates, base, epistemic = {}) {
        const byEntity = new Map();
        for (const u of updates) {
            const id = this._entityId(u.entity, u.entity_type);
            if (!byEntity.has(id)) byEntity.set(id, []);
            byEntity.get(id).push(u);
        }
        const results = [];
        for (const [entityId, ups] of byEntity) {
            const cur = await this.getState(base.chat_id, ups[0].entity, ups[0].entity_type);
            const next = { ...cur, _extra: { ...(cur._extra || {}) } };
            next.id = uuid();
            next.updated_at = nowIso();
            next.confidence = Math.min(...ups.map((u) => u.confidence));
            next.source_memory_id = base.source_id || null;
            next._knowers = epistemic.knowers || cur._knowers || [];
            next._secretFrom = epistemic.secret_from || cur._secretFrom || [];

            for (const u of ups) {
                this._applyField(next, u.field, u.value);
            }

            // supersede previous (keep history) — only when one was persisted
            if (cur.source_memory_id != null) {
                await this.meta.putEntityState({ ...cur, status: 'superseded', superseded_by: next.id });
            }
            const toStore = { ...next };
            await this.meta.putEntityState(toStore);
            results.push(toStore);
        }
        return results;
    }

    _applyField(state, field, value) {
        const listFields = {
            outfit: 'outfit_json',
            injuries: 'injuries_json',
            status: 'status_flags_json',
            occupants: 'occupants_json',
            hazards: 'hazards_json',
        };
        if (listFields[field]) {
            const key = listFields[field];
            const arr = Array.isArray(state[key]) ? [...state[key]] : [];
            const val = String(value);
            // slot-aware replacement: explicit "slot: value" replaces the same
            // slot; a bare value replaces the BASE entry of its own kind
            // ("oilskin coat" supersedes "oilskin coat: salt-stained").
            const valSlot = val.includes(':') ? val.split(':')[0].trim().toLowerCase() : val.trim().toLowerCase();
            const filtered = arr.filter((e) => {
                const eSlot = String(e).includes(':')
                    ? String(e).split(':')[0].trim().toLowerCase()
                    : String(e).trim().toLowerCase();
                return eSlot !== valSlot;
            });
            if (!filtered.includes(val)) filtered.push(val);
            state[key] = filtered.slice(-12);
            return;
        }
        switch (field) {
            case 'mood': state.mood = String(value); break;
            case 'location': state.location = String(value); break;
            case 'holder': state.holder = String(value); break;
            case 'condition': state.condition = String(value); break;
            case 'stance': state.stance = String(value); break;
            case 'hostility': {
                const n = Number(value);
                state.hostility = Number.isNaN(n) ? state.hostility : Math.max(0, Math.min(1, n > 1 ? n / 100 : n));
                break;
            }
            default: {
                // non-schema field (atmosphere, strength, motive, …) → _extra bag
                state._extra = state._extra || {};
                state._extra[field] = String(value);
            }
        }
    }

    /** Apply world deltas (scene/time_of_day/weather/mood/factions/conflict). */
    async applyWorld(world, base) {
        const keys = ['scene', 'time_of_day', 'weather', 'mood'];
        const results = [];
        const existing = await this.meta.getWorldState(base.chat_id);
        for (const key of keys) {
            const value = world[key];
            if (!value) continue;
            const prev = existing.find((r) => r.key === key && r.status === 'active');
            const next = {
                id: uuid(),
                tenant_id: 'default',
                chat_id: base.chat_id,
                character_id: base.character_id || null,
                key,
                value_text: String(value),
                confidence: 0.85,
                source_memory_id: base.source_id || null,
                created_at: prev?.created_at || nowIso(),
                updated_at: nowIso(),
                status: 'active',
            };
            if (prev && prev.value_text !== next.value_text) {
                await this.meta.putWorldState({ ...prev, status: 'superseded' });
            } else if (prev && prev.value_text === next.value_text) {
                continue; // no change
            }
            await this.meta.putWorldState(next);
            results.push(next);
        }
        if (Array.isArray(world.active_factions)) {
            for (const faction of world.active_factions) {
                const prev = existing.find((r) => r.key === 'faction' && r.value_text === faction && r.status === 'active');
                if (prev) continue;
                await this.meta.putWorldState({
                    id: uuid(),
                    tenant_id: 'default',
                    chat_id: base.chat_id,
                    character_id: base.character_id || null,
                    key: 'faction',
                    value_text: String(faction),
                    confidence: 0.8,
                    source_memory_id: base.source_id || null,
                    created_at: nowIso(),
                    updated_at: nowIso(),
                    status: 'active',
                });
            }
        }
        return results;
    }

    /** Active world snapshot as one compact line for injection. */
    async worldLine(chatId) {
        const rows = await this.meta.getWorldState(chatId);
        const get = (k) => rows.find((r) => r.key === k && r.status === 'active')?.value_text || '';
        const parts = [get('scene'), get('time_of_day'), get('weather'), get('mood')].filter(Boolean);
        return parts.join(' · ');
    }

    /**
     * Compact per-entity snapshot lines for injection, epistemic-filtered for
     * the responding character. Observable fields render for everyone;
     * internal fields require the knower to be allowed.
     */
    async snapshotLines(chatId, knowerName) {
        const rows = await this.meta.getEntityStates(chatId);
        const lines = [];
        for (const st of rows.filter((r) => r.status === 'active')) {
            const proxy = {
                knowers_json: st._knowers || [],
                secret_from_json: st._secretFrom || [],
                scope: 'chat',
            };
            const allowed = EpistemicEngine.allows(proxy, knowerName);
            const parts = [];
            const push = (label, val, internal = false) => {
                if (val == null || val === '' || (Array.isArray(val) && !val.length)) return;
                if (internal && !allowed) return;
                parts.push(`${label}: ${Array.isArray(val) ? val.join(', ') : val}`);
            };
            switch (st.entity_type) {
                case 'character':
                    push('outfit', st.outfit_json);
                    push('injuries', st.injuries_json);
                    push('mood', st.mood, true);
                    push('status', st.status_flags_json);
                    push('at', st.location);
                    break;
                case 'place':
                    push('hazards', st.hazards_json);
                    push('occupants', st.occupants_json);
                    push('atmosphere', st._extra?.atmosphere, true);
                    break;
                case 'object':
                    push('holder', st.holder);
                    push('at', st.location);
                    push('condition', st.condition);
                    break;
                case 'faction':
                    push('stance', st.stance, true);
                    push('hostility', st.hostility != null ? st.hostility.toFixed(2) : null, true);
                    push('strength', st._extra?.strength, true);
                    break;
            }
            if (parts.length) lines.push(`- ${st.entity_name}: ${parts.join(' | ')}`);
        }
        return lines;
    }

    /** All active entity states (Card Catalog UI). */
    async allEntityStates(chatId) {
        const rows = await this.meta.getEntityStates(chatId);
        return rows.filter((r) => r.status === 'active');
    }

    /** All active world rows (Ledger + Blotter UI). */
    async allWorld(chatId) {
        return this.meta.getWorldState(chatId);
    }

    async forgetEntity(chatId, entityName) {
        const rows = await this.meta.getEntityStates(chatId);
        const name = String(entityName).toLowerCase();
        let n = 0;
        for (const r of rows) {
            if (r.entity_name.toLowerCase() === name || r.entity_id.endsWith(`:${name}`)) {
                await this.meta.putEntityState({ ...r, status: 'deleted' });
                n++;
            }
        }
        return n;
    }
}
