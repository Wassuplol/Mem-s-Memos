/**
 * Mem's Memos — StorageAdapter interface + write-ahead queue.
 *
 * Metadata (memories, STM, states, knowledge) always lives in the local
 * MetadataStore (IndexedDB). A VectorStore adapter (Qdrant first, local
 * brute-force fallback) carries the vectors + a payload mirror so Qdrant
 * filter queries work without a round-trip to IndexedDB.
 */

import { logger } from '../utils/logger.js';

/**
 * @typedef {Object} MemoryRecord — shape mirrors mems_memory_master columns;
 * arrays/objects are stored as real JS values (JSON columns in SQLite terms).
 */

export class MetadataStore {
    /** Open/initialize the store. */
    async init() { throw new Error('not implemented'); }
    async putMemory(record) { throw new Error('not implemented'); }
    async putMemories(records) { throw new Error('not implemented'); }
    async getMemory(id) { throw new Error('not implemented'); }
    /** @param {object} filter — scoped equality filters, see IndexedDbStore. */
    async queryMemories(filter = {}) { throw new Error('not implemented'); }
    async updateMemory(id, patch) { throw new Error('not implemented'); }
    async deleteMemory(id) { throw new Error('not implemented'); }
    async deleteWhere(filter) { throw new Error('not implemented'); }
    async countMemories(filter = {}) { throw new Error('not implemented'); }

    async putStm(entry) { throw new Error('not implemented'); }
    async getStm(chatId) { throw new Error('not implemented'); }
    async deleteStm(stmId) { throw new Error('not implemented'); }
    async clearStm(chatId) { throw new Error('not implemented'); }

    async putEntityState(state) { throw new Error('not implemented'); }
    async getEntityStates(chatId) { throw new Error('not implemented'); }
    async putWorldState(entry) { throw new Error('not implemented'); }
    async getWorldState(chatId) { throw new Error('not implemented'); }

    async putKnowledge(entry) { throw new Error('not implemented'); }
    async getKnowledge(chatId) { throw new Error('not implemented'); }

    async cacheGet(key) { throw new Error('not implemented'); }
    async cachePut(key, value, ttlMs) { throw new Error('not implemented'); }

    async audit(entry) { throw new Error('not implemented'); }
    async auditFor(memoryId) { throw new Error('not implemented'); }

    async exportAll(onProgress) { throw new Error('not implemented'); }
    async importAll(bundle, onProgress) { throw new Error('not implemented'); }
    async wipe() { throw new Error('not implemented'); }
    async close() { /* optional */ }
}

export class VectorStore {
    get name() { return 'abstract'; }
    /** Ensure collection exists for the fingerprint {modelSlug, dim}. */
    async ensureCollection(fingerprint) { throw new Error('not implemented'); }
    /** fingerprint -> collection name. */
    collectionFor(fingerprint) { throw new Error('not implemented'); }
    async health() { throw new Error('not implemented'); }
    async upsert(collection, points) { throw new Error('not implemented'); }
    async delete(collection, ids) { throw new Error('not implemented'); }
    /** Dense search on a named vector. Returns [{id, score, payload, vector?}] */
    async searchDense(collection, vector, { topK, filter, namedVector, withVectors } = {}) { throw new Error('not implemented'); }
    /** Sparse keyword search over payload keywords (adapter-defined). */
    async searchSparse(collection, tokens, { topK, filter } = {}) { throw new Error('not implemented'); }
    /** Scroll all points (optionally filtered). Yields pages of {id, payload, vector}. */
    async scroll(collection, { filter, withVectors, onPage } = {}) { throw new Error('not implemented'); }
    async dropCollection(collection) { throw new Error('not implemented'); }
}

/**
 * Write-ahead queue: metadata writes always succeed locally first; vector
 * writes go through this queue so a Qdrant outage never loses data — jobs
 * retry with backoff and surface as STORAGE OFFLINE stamps while down.
 */
export class WriteAheadQueue {
    /**
     * @param {VectorStore} primary — Qdrant adapter
     * @param {VectorStore} fallback — local brute-force adapter
     * @param {(down:boolean)=>void} onStateChange
     */
    constructor(primary, fallback, onStateChange = () => {}) {
        this.primary = primary;
        this.fallback = fallback;
        this.onStateChange = onStateChange;
        this.usingFallback = false;
        this.queue = [];
        this.draining = false;
        this.maxQueue = 500;
    }

    get active() {
        return this.usingFallback ? this.fallback : this.primary;
    }

    async _probePrimary() {
        try {
            const ok = await this.primary.health();
            return !!ok;
        } catch {
            return false;
        }
    }

    /** Switch stores; flushes pending ops to the primary when it recovers. */
    async reconcile() {
        const up = await this._probePrimary();
        if (up && this.usingFallback) {
            this.usingFallback = false;
            this.onStateChange(false);
            logger.info('WAL: primary vector store recovered — flushing', { pending: this.queue.length });
            await this.drain();
        } else if (!up && !this.usingFallback) {
            this.usingFallback = true;
            this.onStateChange(true);
            logger.warn('WAL: primary vector store unreachable — fallback engaged', { pending: this.queue.length });
        }
        return this.usingFallback;
    }

    /**
     * Enqueue a vector op. Executes immediately on the active store; failures
     * on the primary flip to fallback and re-queue for later replay.
     * @param {'upsert'|'delete'} op
     */
    async enqueue(op, collection, payload) {
        if (this.queue.length >= this.maxQueue) {
            logger.warn('WAL: queue full, dropping oldest job');
            this.queue.shift();
        }
        const job = { op, collection, payload, attempts: 0, enqueuedAt: Date.now() };
        this.queue.push(job);
        await this.drain();
        return job;
    }

    async drain() {
        if (this.draining) return;
        this.draining = true;
        try {
            while (this.queue.length) {
                const job = this.queue[0];
                const store = this.usingFallback ? this.fallback : this.primary;
                try {
                    if (job.op === 'upsert') await store.upsert(job.collection, job.payload);
                    else if (job.op === 'delete') await store.delete(job.collection, job.payload);
                    else if (job.op === 'ensure') await store.ensureCollection(job.payload);
                    this.queue.shift();
                } catch (err) {
                    job.attempts++;
                    logger.warn('WAL: job failed', { op: job.op, attempts: job.attempts, err: String(err?.message || err) });
                    if (!this.usingFallback) {
                        // flip to fallback and replay on the local store
                        this.usingFallback = true;
                        this.onStateChange(true);
                        continue;
                    }
                    // fallback failing too: back off and stop draining
                    if (job.attempts > 5) this.queue.shift();
                    break;
                }
            }
        } finally {
            this.draining = false;
        }
    }
}
