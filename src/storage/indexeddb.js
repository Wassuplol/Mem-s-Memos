/**
 * Mem's Memos — IndexedDB MetadataStore + local brute-force VectorStore.
 *
 * IndexedDbStore is the system of record for ALL metadata (memories, STM,
 * entity states, world state, knowledge, embed cache, audit). LocalVectorStore
 * is the L3 fallback: keeps vectors in IndexedDB and does cosine in JS.
 *
 * A fully in-memory variant (MemoryMetadataStore) lives in tests/mockQdrant.js
 * so the engine is testable under plain Node without indexedDB.
 */

import { MetadataStore, VectorStore } from './adapter.js';
import { cosine, keywordOverlap, modelSlug, nowIso, uuid } from '../utils/helpers.js';
import { logger } from '../utils/logger.js';

const DB_NAME = 'mems-memos';
const DB_VERSION = 1;

export const STORES = {
    memories: 'memories',       // keyPath: id
    stm: 'stm',                 // keyPath: stm_id
    entityStates: 'entity_states', // keyPath: id
    worldState: 'world_state',  // keyPath: id
    knowledge: 'knowledge',     // keyPath: id
    cache: 'cache',             // keyPath: key (embed cache, misc)
    audit: 'audit',             // keyPath: id (auto)
    vectors: 'vectors',         // local fallback vectors: keyPath: pid (`${collection}:${id}`)
};

function hasIndexedDb() {
    try {
        return typeof indexedDB !== 'undefined';
    } catch {
        return false;
    }
}

export class IndexedDbStore extends MetadataStore {
    constructor() {
        super();
        this.db = null;
    }

    async init() {
        if (!hasIndexedDb()) throw new Error('indexedDB unavailable');
        this.db = await new Promise((resolve, reject) => {
            const req = indexedDB.open(DB_NAME, DB_VERSION);
            req.onupgradeneeded = () => {
                const db = req.result;
                const mk = (name, opts, indexes = []) => {
                    if (db.objectStoreNames.contains(name)) return;
                    const store = db.createObjectStore(name, opts);
                    for (const [idx, keyPath, unique] of indexes) {
                        store.createIndex(idx, keyPath, { unique: !!unique });
                    }
                };
                mk(STORES.memories, { keyPath: 'id' }, [
                    ['chat_id', 'chat_id'],
                    ['character_id', 'character_id'],
                    ['memory_type', 'memory_type'],
                    ['status', 'status'],
                    ['validity_status', 'validity_status'],
                    ['dedupe_hash', 'dedupe_hash'],
                    ['created_at', 'created_at'],
                    ['importance', 'importance'],
                    ['subject_id', 'subject_id'],
                    ['parent_id', 'parent_id'],
                ]);
                mk(STORES.stm, { keyPath: 'stm_id' }, [['chat_id', 'chat_id'], ['buffer_type', 'buffer_type']]);
                mk(STORES.entityStates, { keyPath: 'id' }, [['chat_id', 'chat_id'], ['entity_id', 'entity_id']]);
                mk(STORES.worldState, { keyPath: 'id' }, [['chat_id', 'chat_id'], ['key', 'key']]);
                mk(STORES.knowledge, { keyPath: 'id' }, [['chat_id', 'chat_id'], ['knower_id', 'knower_id'], ['memory_id', 'memory_id']]);
                mk(STORES.cache, { keyPath: 'key' }, []);
                mk(STORES.audit, { keyPath: 'id' }, [['memory_id', 'memory_id'], ['created_at', 'created_at']]);
                mk(STORES.vectors, { keyPath: 'pid' }, [['collection', 'collection']]);
            };
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error || new Error('indexedDB open failed'));
            req.onblocked = () => reject(new Error('indexedDB blocked by another tab'));
        });
        return this;
    }

    _tx(store, mode, fn) {
        return new Promise((resolve, reject) => {
            const tx = this.db.transaction(store, mode);
            const os = tx.objectStore(store);
            let result;
            Promise.resolve()
                .then(() => fn(os))
                .then((r) => { result = r; })
                .catch(reject);
            tx.oncomplete = () => resolve(result);
            tx.onerror = () => reject(tx.error || new Error(`tx error on ${store}`));
            tx.onabort = () => reject(tx.error || new Error(`tx aborted on ${store}`));
        });
    }

    _req(req) {
        return new Promise((resolve, reject) => {
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error || new Error('idb request failed'));
        });
    }

    _all(store) {
        return this._tx(store, 'readonly', (os) => this._req(os.getAll()));
    }

    // ---- memories ----------------------------------------------------------
    putMemory(record) {
        return this._tx(STORES.memories, 'readwrite', (os) => this._req(os.put(record)));
    }
    putMemories(records) {
        return this._tx(STORES.memories, 'readwrite', async (os) => {
            for (const r of records) await this._req(os.put(r));
            return records.length;
        });
    }
    getMemory(id) {
        return this._tx(STORES.memories, 'readonly', (os) => this._req(os.get(id)));
    }
    async queryMemories(filter = {}) {
        const all = await this._all(STORES.memories);
        return all.filter((m) => matchFilter(m, filter));
    }
    async updateMemory(id, patch) {
        return this._tx(STORES.memories, 'readwrite', async (os) => {
            const cur = await this._req(os.get(id));
            if (!cur) return null;
            const next = { ...cur, ...patch, updated_at: patch.updated_at || nowIso() };
            await this._req(os.put(next));
            return next;
        });
    }
    deleteMemory(id) {
        return this._tx(STORES.memories, 'readwrite', (os) => this._req(os.delete(id)));
    }
    async deleteWhere(filter) {
        const rows = await this.queryMemories(filter);
        return this._tx(STORES.memories, 'readwrite', async (os) => {
            for (const r of rows) await this._req(os.delete(r.id));
            return rows.length;
        });
    }
    async countMemories(filter = {}) {
        const rows = await this.queryMemories(filter);
        return rows.length;
    }

    // ---- stm ---------------------------------------------------------------
    putStm(entry) {
        return this._tx(STORES.stm, 'readwrite', (os) => this._req(os.put(entry)));
    }
    async getStm(chatId) {
        const all = await this._all(STORES.stm);
        return all.filter((e) => e.chat_id === chatId && e.status !== 'deleted');
    }
    deleteStm(stmId) {
        return this._tx(STORES.stm, 'readwrite', (os) => this._req(os.delete(stmId)));
    }
    async clearStm(chatId) {
        const rows = await this.getStm(chatId);
        return this._tx(STORES.stm, 'readwrite', async (os) => {
            for (const r of rows) await this._req(os.delete(r.stm_id));
            return rows.length;
        });
    }

    // ---- entity/world state -------------------------------------------------
    putEntityState(state) {
        return this._tx(STORES.entityStates, 'readwrite', (os) => this._req(os.put(state)));
    }
    async getEntityStates(chatId) {
        const all = await this._all(STORES.entityStates);
        return all.filter((s) => s.chat_id === chatId && s.status !== 'superseded');
    }
    async getEntityStateHistory(entityId) {
        const all = await this._all(STORES.entityStates);
        return all.filter((s) => s.entity_id === entityId);
    }
    putWorldState(entry) {
        return this._tx(STORES.worldState, 'readwrite', (os) => this._req(os.put(entry)));
    }
    async getWorldState(chatId) {
        const all = await this._all(STORES.worldState);
        return all.filter((s) => s.chat_id === chatId && s.status !== 'superseded');
    }

    // ---- knowledge -----------------------------------------------------------
    putKnowledge(entry) {
        return this._tx(STORES.knowledge, 'readwrite', (os) => this._req(os.put(entry)));
    }
    async getKnowledge(chatId) {
        const all = await this._all(STORES.knowledge);
        return all.filter((s) => s.chat_id === chatId && s.status !== 'deleted');
    }
    async deleteKnowledgeWhere(filter) {
        const all = await this._all(STORES.knowledge);
        const rows = all.filter((k) => matchFilter(k, filter));
        return this._tx(STORES.knowledge, 'readwrite', async (os) => {
            for (const r of rows) await this._req(os.delete(r.id));
            return rows.length;
        });
    }

    // ---- cache ---------------------------------------------------------------
    async cacheGet(key) {
        const row = await this._tx(STORES.cache, 'readonly', (os) => this._req(os.get(key)));
        if (!row) return null;
        if (row.expires_at && Date.parse(row.expires_at) < Date.now()) return null;
        return row.value;
    }
    cachePut(key, value, ttlMs = 0) {
        const row = {
            key,
            value,
            created_at: nowIso(),
            expires_at: ttlMs ? new Date(Date.now() + ttlMs).toISOString() : null,
        };
        return this._tx(STORES.cache, 'readwrite', (os) => this._req(os.put(row)));
    }

    // ---- audit ---------------------------------------------------------------
    audit(entry) {
        const row = { id: uuid(), created_at: nowIso(), ...entry };
        return this._tx(STORES.audit, 'readwrite', (os) => this._req(os.put(row)));
    }
    async auditFor(memoryId) {
        const all = await this._all(STORES.audit);
        return all
            .filter((a) => a.memory_id === memoryId)
            .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
    }
    async auditTail(n = 100) {
        const all = await this._all(STORES.audit);
        return all.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at))).slice(0, n);
    }

    // ---- vectors (local fallback) ---------------------------------------------
    async vectorUpsert(collection, points) {
        return this._tx(STORES.vectors, 'readwrite', async (os) => {
            for (const p of points) {
                await this._req(os.put({ pid: `${collection}:${p.id}`, collection, id: p.id, vector: p.vector, payload: p.payload || {} }));
            }
            return points.length;
        });
    }
    async vectorDelete(collection, ids) {
        return this._tx(STORES.vectors, 'readwrite', async (os) => {
            for (const id of ids) await this._req(os.delete(`${collection}:${id}`));
        });
    }
    async vectorAll(collection) {
        const all = await this._all(STORES.vectors);
        return all.filter((v) => v.collection === collection);
    }
    async vectorDropCollection(collection) {
        return this._tx(STORES.vectors, 'readwrite', async (os) => {
            const all = await this._req(os.getAll());
            for (const v of all) if (v.collection === collection) await this._req(os.delete(v.pid));
        });
    }

    // ---- bulk ------------------------------------------------------------------
    async exportAll(onProgress) {
        const stores = Object.values(STORES);
        const out = { format: 'mems-memos/v1', exported_at: nowIso(), stores: {} };
        let done = 0;
        for (const s of stores) {
            out.stores[s] = await this._all(s);
            done++;
            onProgress?.(done, stores.length, s);
        }
        return out;
    }
    async importAll(bundle, onProgress) {
        if (bundle?.format !== 'mems-memos/v1' || !bundle.stores) {
            throw new Error('unrecognized export bundle (expected mems-memos/v1)');
        }
        const entries = Object.entries(bundle.stores);
        let done = 0;
        for (const [store, rows] of entries) {
            if (!Object.values(STORES).includes(store) || !Array.isArray(rows)) continue;
            await this._tx(store, 'readwrite', async (os) => {
                for (const row of rows) await this._req(os.put(row));
            });
            done++;
            onProgress?.(done, entries.length, store);
        }
        return done;
    }
    async wipe() {
        for (const s of Object.values(STORES)) {
            await this._tx(s, 'readwrite', (os) => this._req(os.clear()));
        }
    }
    close() {
        this.db?.close?.();
    }
}

/** Shared scoped-filter matcher (also used by the in-memory test store). */
export function matchFilter(m, filter = {}) {
    const eq = (a, b) => String(a ?? '') === String(b ?? '');
    if (filter.id != null && !eq(m.id, filter.id)) return false;
    if (filter.tenant_id != null && !eq(m.tenant_id, filter.tenant_id)) return false;
    if (filter.chat_id != null && !eq(m.chat_id, filter.chat_id)) return false;
    if (filter.character_id != null && !eq(m.character_id, filter.character_id)) return false;
    if (filter.memory_type != null && !eq(m.memory_type, filter.memory_type)) return false;
    if (Array.isArray(filter.memory_types) && !filter.memory_types.includes(m.memory_type)) return false;
    if (filter.status != null && !eq(m.status, filter.status)) return false;
    if (Array.isArray(filter.status_not) && filter.status_not.includes(m.status)) return false;
    if (filter.validity_status != null && !eq(m.validity_status, filter.validity_status)) return false;
    if (Array.isArray(filter.validity_not) && filter.validity_not.includes(m.validity_status)) return false;
    if (filter.chunk_role != null && !eq(m.chunk_role, filter.chunk_role)) return false;
    if (filter.subject_id != null && !eq(m.subject_id, filter.subject_id)) return false;
    if (filter.entity_id != null && !eq(m.entity_id, filter.entity_id)) return false;
    if (filter.knower_id != null && !eq(m.knower_id, filter.knower_id)) return false;
    if (filter.memory_id != null && !eq(m.memory_id, filter.memory_id)) return false;
    if (filter.dedupe_hash != null && !eq(m.dedupe_hash, filter.dedupe_hash)) return false;
    if (filter.parent_id != null && !eq(m.parent_id, filter.parent_id)) return false;
    if (Array.isArray(filter.scope_any) && filter.scope_any.length && !filter.scope_any.includes(m.scope)) return false;
    if (filter.min_importance != null && Number(m.importance || 0) < Number(filter.min_importance)) return false;
    if (filter.event_time_gte != null && String(m.event_time || '') < String(filter.event_time_gte)) return false;
    if (filter.event_time_lte != null && String(m.event_time || '') > String(filter.event_time_lte)) return false;
    if (filter.knower != null) {
        const knowers = Array.isArray(m.knowers_json) ? m.knowers_json : [];
        const ok = knowers.length === 0 || knowers.includes(filter.knower) || knowers.includes('user') || m.scope === 'global';
        if (!ok) return false;
    }
    if (filter.secret_from != null) {
        const secretFrom = Array.isArray(m.secret_from_json) ? m.secret_from_json : [];
        if (secretFrom.includes(filter.secret_from)) return false;
    }
    if (Array.isArray(filter.entity_any) && filter.entity_any.length) {
        const ids = Array.isArray(m.entity_ids_json) ? m.entity_ids_json : [];
        if (!filter.entity_any.some((e) => ids.includes(e))) return false;
    }
    return true;
}

/**
 * Local brute-force VectorStore (L3 fallback). Vectors persist in IndexedDB
 * through an IndexedDbStore handle; an in-memory Map mirrors them for speed.
 */
export class LocalVectorStore extends VectorStore {
    constructor(metaStore) {
        super();
        this.meta = metaStore;
        this.cache = new Map(); // collection -> Map(id -> {vector, payload})
    }

    get name() {
        return 'local-bruteforce';
    }

    collectionFor({ model, dim }) {
        return `mems_memos__${modelSlug(model)}__${dim}`;
    }

    async _load(collection) {
        if (this.cache.has(collection)) return this.cache.get(collection);
        const rows = await this.meta.vectorAll(collection);
        const map = new Map();
        for (const r of rows) map.set(r.id, { vector: r.vector, payload: r.payload });
        this.cache.set(collection, map);
        return map;
    }

    async ensureCollection() {
        return true; // local store needs no schema
    }

    async health() {
        return true;
    }

    async upsert(collection, points) {
        const map = await this._load(collection);
        for (const p of points) map.set(p.id, { vector: p.vector, payload: p.payload || {} });
        await this.meta.vectorUpsert(collection, points);
    }

    async delete(collection, ids) {
        const map = await this._load(collection);
        for (const id of ids) map.delete(id);
        await this.meta.vectorDelete(collection, ids);
    }

    _matches(payload, filter = {}) {
        return matchFilter(
            // adapt payload (already an object with array fields) to matchFilter
            {
                ...payload,
                knowers_json: payload.knowers_json || [],
                secret_from_json: payload.secret_from_json || [],
                entity_ids_json: payload.entity_ids_json || [],
            },
            filter,
        );
    }

    async searchDense(collection, vector, { topK = 12, filter, namedVector = 'dense_main' } = {}) {
        const map = await this._load(collection);
        const out = [];
        for (const [id, row] of map) {
            if (!this._matches(row.payload, filter)) continue;
            const v = row.vector?.[namedVector] || row.vector?.dense_main || row.vector;
            const score = cosine(vector, v);
            if (score > 0) out.push({ id, score, payload: row.payload });
        }
        return out.sort((a, b) => b.score - a.score).slice(0, topK);
    }

    async searchSparse(collection, tokens, { topK = 12, filter } = {}) {
        const map = await this._load(collection);
        const out = [];
        for (const [id, row] of map) {
            if (!this._matches(row.payload, filter)) continue;
            const score = keywordOverlap(tokens, row.payload?.keywords_json || []);
            if (score > 0) out.push({ id, score, payload: row.payload });
        }
        return out.sort((a, b) => b.score - a.score).slice(0, topK);
    }

    async scroll(collection, { filter, withVectors = false, onPage } = {}) {
        const map = await this._load(collection);
        const out = [];
        for (const [id, row] of map) {
            if (!this._matches(row.payload, filter)) continue;
            out.push({ id, payload: row.payload, vector: withVectors ? row.vector : undefined });
        }
        if (onPage) await onPage(out);
        return out;
    }

    async dropCollection(collection) {
        this.cache.delete(collection);
        await this.meta.vectorDropCollection(collection);
    }
}

/** Factory: IndexedDB store when available, else null (tests supply a mock). */
export async function createMetadataStore() {
    if (!hasIndexedDb()) {
        logger.warn('indexedDB unavailable — metadata persistence disabled for this session');
        return null;
    }
    const store = new IndexedDbStore();
    await store.init();
    return store;
}
