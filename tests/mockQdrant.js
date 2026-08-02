/**
 * Mock storage: fully in-memory MetadataStore + VectorStore implementing the
 * same contracts as IndexedDbStore / QdrantStore. This is what makes the
 * entire engine testable under plain Node (no IndexedDB, no Qdrant).
 */

import { MetadataStore, VectorStore } from '../src/storage/adapter.js';
import { matchFilter } from '../src/storage/indexeddb.js';
import { cosine, keywordOverlap, modelSlug, nowIso, uuid } from '../src/utils/helpers.js';

export class MemoryMetadataStore extends MetadataStore {
    constructor() {
        super();
        this.memories = new Map();
        this.stm = new Map();
        this.entityStates = new Map();
        this.worldState = new Map();
        this.knowledge = new Map();
        this.cache = new Map();
        this.auditRows = [];
        this.vectors = new Map(); // pid -> row
    }

    async init() { return this; }

    async putMemory(r) { this.memories.set(r.id, structuredClone(r)); }
    async putMemories(rs) { for (const r of rs) await this.putMemory(r); return rs.length; }
    async getMemory(id) { const r = this.memories.get(id); return r ? structuredClone(r) : null; }
    async queryMemories(filter = {}) {
        return [...this.memories.values()].filter((m) => matchFilter(m, filter)).map((m) => structuredClone(m));
    }
    async updateMemory(id, patch) {
        const cur = this.memories.get(id);
        if (!cur) return null;
        const next = { ...cur, ...patch, updated_at: patch.updated_at || nowIso() };
        this.memories.set(id, next);
        return structuredClone(next);
    }
    async deleteMemory(id) { this.memories.delete(id); }
    async deleteWhere(filter) {
        const rows = await this.queryMemories(filter);
        for (const r of rows) this.memories.delete(r.id);
        return rows.length;
    }
    async countMemories(filter = {}) { return (await this.queryMemories(filter)).length; }

    async putStm(e) { this.stm.set(e.stm_id, structuredClone(e)); }
    async getStm(chatId) {
        return [...this.stm.values()]
            .filter((e) => (chatId == null || e.chat_id === chatId) && e.status !== 'deleted')
            .map((e) => structuredClone(e));
    }
    async deleteStm(id) { this.stm.delete(id); }
    async clearStm(chatId) {
        let n = 0;
        for (const [id, e] of this.stm) if (e.chat_id === chatId) { this.stm.delete(id); n++; }
        return n;
    }

    async putEntityState(s) { this.entityStates.set(s.id, structuredClone(s)); }
    async getEntityStates(chatId) {
        return [...this.entityStates.values()]
            .filter((s) => s.chat_id === chatId && s.status !== 'deleted' && s.status !== 'superseded')
            .map((s) => structuredClone(s));
    }
    async putWorldState(s) { this.worldState.set(s.id, structuredClone(s)); }
    async getWorldState(chatId) {
        return [...this.worldState.values()]
            .filter((s) => s.chat_id === chatId && s.status !== 'deleted' && s.status !== 'superseded')
            .map((s) => structuredClone(s));
    }

    async putKnowledge(k) { this.knowledge.set(k.id, structuredClone(k)); }
    async getKnowledge(chatId) {
        return [...this.knowledge.values()].filter((k) => k.chat_id === chatId && k.status !== 'deleted').map((k) => structuredClone(k));
    }
    async deleteKnowledgeWhere(filter) {
        const rows = [...this.knowledge.values()].filter((k) => matchFilter(k, filter));
        for (const r of rows) this.knowledge.delete(r.id);
        return rows.length;
    }

    async cacheGet(key) {
        const row = this.cache.get(key);
        if (!row) return null;
        if (row.expires_at && Date.parse(row.expires_at) < Date.now()) return null;
        return structuredClone(row.value);
    }
    async cachePut(key, value, ttlMs = 0) {
        this.cache.set(key, {
            key, value: structuredClone(value), created_at: nowIso(),
            expires_at: ttlMs ? new Date(Date.now() + ttlMs).toISOString() : null,
        });
    }

    async audit(entry) { this.auditRows.push({ id: uuid(), created_at: nowIso(), ...entry }); }
    async auditFor(memoryId) { return this.auditRows.filter((a) => a.memory_id === memoryId); }
    async auditTail(n = 100) { return this.auditRows.slice(-n); }

    async vectorUpsert(collection, points) {
        for (const p of points) this.vectors.set(`${collection}:${p.id}`, { pid: `${collection}:${p.id}`, collection, id: p.id, vector: p.vector, payload: p.payload || {} });
        return points.length;
    }
    async vectorDelete(collection, ids) { for (const id of ids) this.vectors.delete(`${collection}:${id}`); }
    async vectorAll(collection) { return [...this.vectors.values()].filter((v) => v.collection === collection); }
    async vectorDropCollection(collection) {
        for (const [pid, v] of this.vectors) if (v.collection === collection) this.vectors.delete(pid);
    }

    async exportAll(onProgress) {
        const stores = {
            memories: [...this.memories.values()],
            stm: [...this.stm.values()],
            entity_states: [...this.entityStates.values()],
            world_state: [...this.worldState.values()],
            knowledge: [...this.knowledge.values()],
            cache: [...this.cache.values()],
            audit: this.auditRows,
            vectors: [...this.vectors.values()],
        };
        onProgress?.(8, 8, 'all');
        return { format: 'mems-memos/v1', exported_at: nowIso(), stores };
    }
    async importAll(bundle) {
        const s = bundle.stores;
        let n = 0;
        for (const r of s.memories || []) this.memories.set(r.id, r);
        for (const r of s.stm || []) this.stm.set(r.stm_id, r);
        for (const r of s.entity_states || []) this.entityStates.set(r.id, r);
        for (const r of s.world_state || []) this.worldState.set(r.id, r);
        for (const r of s.knowledge || []) this.knowledge.set(r.id, r);
        for (const r of s.vectors || []) this.vectors.set(r.pid, r);
        return ++n;
    }
    async wipe() {
        this.memories.clear(); this.stm.clear(); this.entityStates.clear();
        this.worldState.clear(); this.knowledge.clear(); this.cache.clear();
        this.auditRows = []; this.vectors.clear();
    }
    async close() {}
}

export class MockQdrant extends VectorStore {
    constructor() {
        super();
        this.collections = new Map(); // name -> Map(id -> {vector, payload})
        this.healthy = true;
        this.requests = [];
    }
    get name() { return 'mock-qdrant'; }
    collectionFor({ model, dim }) { return `mems_memos__${modelSlug(model)}__${dim}`; }
    async ensureCollection({ model, dim }) {
        const name = this.collectionFor({ model, dim });
        if (!this.collections.has(name)) this.collections.set(name, new Map());
        return name;
    }
    async health() { return this.healthy; }
    _must(name) {
        if (!this.collections.has(name)) this.collections.set(name, new Map());
        return this.collections.get(name);
    }
    async upsert(collection, points) {
        this.requests.push(['upsert', collection, points.length]);
        const map = this._must(collection);
        for (const p of points) map.set(p.id, { vector: p.vector, payload: p.payload || {} });
    }
    async delete(collection, ids) {
        const map = this._must(collection);
        for (const id of ids) map.delete(id);
    }
    async searchDense(collection, vector, { topK = 12, filter, namedVector = 'dense_main', withVectors = false } = {}) {
        const map = this._must(collection);
        const out = [];
        for (const [id, row] of map) {
            if (!matchFilter({ ...row.payload }, filter || {})) continue;
            const v = row.vector?.[namedVector] || row.vector?.dense_main;
            const score = Array.isArray(vector) ? cosine(vector, v) : 0;
            if (score > 0) out.push({ id, score, payload: row.payload, vector: withVectors ? v : undefined });
        }
        return out.sort((a, b) => b.score - a.score).slice(0, topK);
    }
    async searchSparse(collection, tokens, { topK = 12, filter } = {}) {
        const map = this._must(collection);
        const out = [];
        for (const [id, row] of map) {
            if (!matchFilter({ ...row.payload }, filter || {})) continue;
            const score = keywordOverlap(tokens, row.payload?.keywords_json || []);
            if (score > 0) out.push({ id, score, payload: row.payload });
        }
        return out.sort((a, b) => b.score - a.score).slice(0, topK);
    }
    async scroll(collection, { filter, withVectors = false, onPage } = {}) {
        const map = this._must(collection);
        const out = [];
        for (const [id, row] of map) {
            if (!matchFilter({ ...row.payload }, filter || {})) continue;
            out.push({ id, payload: row.payload, vector: withVectors ? row.vector : undefined });
        }
        if (onPage) await onPage(out);
        return out;
    }
    async dropCollection(collection) { this.collections.delete(collection); }
}
