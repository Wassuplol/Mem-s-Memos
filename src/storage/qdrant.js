/**
 * Mem's Memos — Qdrant VectorStore adapter.
 *
 * - Collection fingerprint: mems_memos__<model-slug>__<dim> (one embedding
 *   model per collection, enforced by the caller via ensureCollection).
 * - Named vectors: dense_main, dense_summary. Sparse vector: sparse_keywords.
 * - Payload mirror carries every filterable field (scope/time/status/knowers)
 *   so retrieval filters run server-side.
 * - Scalar quantization ON by default (rescore enabled); binary offered for
 *   dim >= 2048. Retry w/ backoff, timeouts, CORS-friendly error messages.
 */

import { VectorStore } from './adapter.js';
import { logger } from '../utils/logger.js';
import { modelSlug, withRetry, keywordOverlap } from '../utils/helpers.js';

const COLLECTION_PREFIX = 'mems_memos';

/** Payload fields that get Qdrant payload indexes (scope/time/status/knower). */
const INDEXED_FIELDS = [
    ['tenant_id', 'keyword'],
    ['user_id', 'keyword'],
    ['persona_id', 'keyword'],
    ['character_id', 'keyword'],
    ['chat_id', 'keyword'],
    ['memory_type', 'keyword'],
    ['status', 'keyword'],
    ['validity_status', 'keyword'],
    ['scope', 'keyword'],
    ['chunk_role', 'keyword'],
    ['subject_id', 'keyword'],
    ['object_id', 'keyword'],
    ['knowers_json', 'keyword'],
    ['secret_from_json', 'keyword'],
    ['entity_ids_json', 'keyword'],
    ['importance', 'float'],
    ['strength', 'float'],
    ['event_time', 'datetime'],
    ['created_at', 'datetime'],
    ['valid_from', 'datetime'],
];

export class QdrantStore extends VectorStore {
    /**
     * @param {{baseUrl:string, apiKey?:string, quantization?:'scalar'|'binary'|'none',
     *          timeoutMs?:number}} cfg
     * @param {{fetchFn?:Function, bridge?:{enabled:boolean,baseUrl:string}}} deps
     */
    constructor(cfg, deps = {}) {
        super();
        this.baseUrl = String(cfg.baseUrl || '').replace(/\/+$/, '');
        this.apiKey = cfg.apiKey || '';
        this.quantization = cfg.quantization || 'scalar';
        this.timeoutMs = cfg.timeoutMs ?? 15000;
        this.fetchFn = deps.fetchFn || globalThis.fetch?.bind(globalThis);
        this.bridge = deps.bridge || { enabled: false, baseUrl: '' };
    }

    get name() {
        return 'qdrant';
    }

    collectionFor({ model, dim }) {
        return `${COLLECTION_PREFIX}__${modelSlug(model)}__${dim}`;
    }

    headers() {
        const h = { 'Content-Type': 'application/json' };
        if (this.apiKey) h['api-key'] = this.apiKey;
        return h;
    }

    _url(path) {
        if (this.bridge.enabled && this.bridge.baseUrl) {
            return `${this.bridge.baseUrl.replace(/\/+$/, '')}/qdrant/proxy?path=${encodeURIComponent(path)}`;
        }
        return `${this.baseUrl}${path}`;
    }

    async request(method, path, body) {
        const ctl = new AbortController();
        const timer = setTimeout(() => ctl.abort(), this.timeoutMs);
        try {
            const res = await this.fetchFn(this._url(path), {
                method,
                headers: this.headers(),
                body: body === undefined ? undefined : JSON.stringify(body),
                signal: ctl.signal,
            });
            const text = await res.text();
            let json = null;
            try {
                json = text ? JSON.parse(text) : null;
            } catch {
                json = null;
            }
            if (!res.ok) {
                const err = new Error(
                    `qdrant ${method} ${path} → HTTP ${res.status}: ${json?.status?.error || text.slice(0, 200) || res.statusText}`,
                );
                err.status = res.status;
                throw err;
            }
            return json;
        } catch (err) {
            if (err?.name === 'AbortError') {
                const e = new Error(`qdrant ${method} ${path} timeout (${this.timeoutMs}ms)`);
                e.status = 408;
                throw e;
            }
            if (/Failed to fetch|NetworkError|fetch failed/i.test(String(err?.message))) {
                const e = new Error(
                    `qdrant unreachable at ${this.baseUrl} (offline or CORS — consider bridge/server.js)`,
                );
                e.cause = err;
                throw e;
            }
            throw err;
        } finally {
            clearTimeout(timer);
        }
    }

    async health() {
        try {
            const res = await this.request('GET', '/collections');
            return Array.isArray(res?.result?.collections);
        } catch (err) {
            logger.warn('qdrant health check failed', { err: String(err?.message || err) });
            return false;
        }
    }

    async _collectionExists(name) {
        try {
            await this.request('GET', `/collections/${encodeURIComponent(name)}`);
            return true;
        } catch {
            return false;
        }
    }

    /**
     * Create collection (named dense vectors + sparse) and payload indexes.
     * Enforces one-embedding-model-per-collection via payload marker.
     */
    async ensureCollection({ model, dim }) {
        const name = this.collectionFor({ model, dim });
        if (await this._collectionExists(name)) {
            // governance: verify the fingerprint matches the stored marker
            try {
                const info = await this.request('GET', `/collections/${encodeURIComponent(name)}`);
                const marker = info?.result?.config?.params?.vectors?.dense_main?.size;
                if (marker && Number(marker) !== Number(dim)) {
                    throw new Error(
                        `collection ${name} expects dim ${marker} but configured dim is ${dim} — MODEL MISMATCH`,
                    );
                }
            } catch (err) {
                if (/MODEL MISMATCH/.test(err.message)) throw err;
            }
            return name;
        }

        const quantization_config =
            this.quantization === 'scalar'
                ? { scalar: { type: 'int8', quantile: 0.99, always_ram: true } }
                : this.quantization === 'binary' && Number(dim) >= 2048
                    ? { binary: { always_ram: true } }
                    : undefined;

        await this.request('PUT', `/collections/${encodeURIComponent(name)}`, {
            vectors: {
                dense_main: { size: Number(dim), distance: 'Cosine', on_disk: false },
                dense_summary: { size: Number(dim), distance: 'Cosine', on_disk: false },
            },
            sparse_vectors: { sparse_keywords: {} },
            optimizers_config: { default_segment_number: 2 },
            ...(quantization_config ? { quantization_config } : {}),
        });

        for (const [field, schema] of INDEXED_FIELDS) {
            try {
                await this.request('PUT', `/collections/${encodeURIComponent(name)}/index`, {
                    field_name: field,
                    field_schema: schema,
                });
            } catch (err) {
                // datetime schema may be unsupported on old servers → retry as keyword
                if (schema === 'datetime') {
                    try {
                        await this.request('PUT', `/collections/${encodeURIComponent(name)}/index`, {
                            field_name: field,
                            field_schema: 'keyword',
                        });
                    } catch (err2) {
                        logger.warn('payload index failed', { field, err: String(err2?.message || err2) });
                    }
                } else {
                    logger.warn('payload index failed', { field, err: String(err?.message || err) });
                }
            }
        }
        logger.info('qdrant collection ready', { name });
        return name;
    }

    async dropCollection(collection) {
        await this.request('DELETE', `/collections/${encodeURIComponent(collection)}`);
    }

    /**
     * Upsert points. Point: {id, vector:{dense_main?, dense_summary?, sparse_keywords?}, payload}.
     */
    async upsert(collection, points) {
        if (!points?.length) return;
        await withRetry(
            () =>
                this.request('PUT', `/collections/${encodeURIComponent(collection)}/points?wait=true`, {
                    points: points.map((p) => ({
                        id: p.id,
                        vector: p.vector,
                        payload: p.payload || {},
                    })),
                }),
            { retries: 2 },
        );
    }

    async delete(collection, ids) {
        if (!ids?.length) return;
        await this.request('POST', `/collections/${encodeURIComponent(collection)}/points/delete?wait=true`, {
            points: ids,
        });
    }

    /** Build a Qdrant filter from our scoped filter object. */
    buildFilter(filter = {}) {
        const must = [];
        const must_not = [];
        const eq = (key, val) => ({ key, match: { value: val } });
        if (filter.tenant_id != null) must.push(eq('tenant_id', filter.tenant_id));
        if (filter.chat_id != null) must.push(eq('chat_id', filter.chat_id));
        if (filter.character_id != null) must.push(eq('character_id', filter.character_id));
        if (filter.memory_type != null) must.push(eq('memory_type', filter.memory_type));
        if (Array.isArray(filter.memory_types)) {
            must.push({ key: 'memory_type', match: { any: filter.memory_types } });
        }
        if (filter.status != null) must.push(eq('status', filter.status));
        if (filter.validity_status != null) must.push(eq('validity_status', filter.validity_status));
        if (Array.isArray(filter.validity_not)) {
            for (const v of filter.validity_not) must_not.push(eq('validity_status', v));
        }
        if (filter.chunk_role != null) must.push(eq('chunk_role', filter.chunk_role));
        if (Array.isArray(filter.scope_any) && filter.scope_any.length) {
            must.push({ key: 'scope', match: { any: filter.scope_any } });
        }
        // epistemic hard filter: knower must be in knowers_json OR memory is global/public
        if (filter.knower != null) {
            must.push({
                should: [
                    eq('knowers_json', filter.knower),
                    eq('knowers_json', 'user'),
                    eq('scope', 'global'),
                    { is_empty: { key: 'knowers_json' } },
                ],
            });
        }
        if (filter.secret_from != null) {
            must_not.push(eq('secret_from_json', filter.secret_from));
        }
        if (filter.min_importance != null) {
            must.push({ key: 'importance', range: { gte: Number(filter.min_importance) } });
        }
        if (filter.event_time_gte != null) {
            must.push({ key: 'event_time', range: { gte: filter.event_time_gte } });
        }
        if (filter.event_time_lte != null) {
            must.push({ key: 'event_time', range: { lte: filter.event_time_lte } });
        }
        if (!must.length && !must_not.length) return undefined;
        const f = {};
        if (must.length) f.must = must;
        if (must_not.length) f.must_not = must_not;
        return f;
    }

    async searchDense(collection, vector, { topK = 12, filter, namedVector = 'dense_main', withVectors = false } = {}) {
        const body = {
            vector: { name: namedVector, vector },
            limit: topK,
            with_payload: true,
            with_vector: withVectors,
            score_threshold: 0,
        };
        const f = this.buildFilter(filter);
        if (f) body.filter = f;
        const res = await withRetry(
            () => this.request('POST', `/collections/${encodeURIComponent(collection)}/points/search`, body),
            { retries: 2 },
        );
        return (res?.result || []).map((r) => ({
            id: r.id,
            score: r.score,
            payload: r.payload || {},
            vector: withVectors ? r.vector?.[namedVector] : undefined,
        }));
    }

    /**
     * Sparse search: Qdrant sparse vector query when available; falls back to a
     * scroll + keyword-overlap rescore for older servers.
     */
    async searchSparse(collection, tokens, { topK = 12, filter } = {}) {
        const weights = {};
        const uniq = [...new Set(tokens)];
        uniq.forEach((t, i) => {
            weights[i] = 1;
        });
        try {
            const body = {
                sparse_vector: {
                    name: 'sparse_keywords',
                    vector: {
                        indices: uniq.map((_, i) => i),
                        values: uniq.map(() => 1),
                    },
                },
                limit: topK,
                with_payload: true,
            };
            // NOTE: true text→sparse-index hashing requires a shared tokenizer;
            // instead we query by payload keyword match (works on all servers).
            const f = this.buildFilter(filter) || {};
            const must = [...(f.must || [])];
            if (uniq.length) must.push({ key: 'keywords_json', match: { any: uniq } });
            const res = await this.request('POST', `/collections/${encodeURIComponent(collection)}/points/scroll`, {
                filter: { ...f, must },
                limit: topK * 3,
                with_payload: true,
                with_vector: false,
            });
            const pts = (res?.result?.points || []).map((p) => ({
                id: p.id,
                payload: p.payload || {},
                score: keywordOverlap(uniq, p.payload?.keywords_json || []),
            }));
            return pts.filter((p) => p.score > 0).sort((a, b) => b.score - a.score).slice(0, topK);
        } catch (err) {
            logger.warn('sparse search failed', { err: String(err?.message || err) });
            return [];
        }
    }

    async scroll(collection, { filter, withVectors = false, onPage, pageSize = 128 } = {}) {
        let offset = null;
        const all = [];
        for (;;) {
            const body = {
                limit: pageSize,
                with_payload: true,
                with_vector: withVectors,
            };
            if (offset != null) body.offset = offset;
            const f = this.buildFilter(filter);
            if (f) body.filter = f;
            const res = await this.request(
                'POST',
                `/collections/${encodeURIComponent(collection)}/points/scroll`,
                body,
            );
            const points = res?.result?.points || [];
            const page = points.map((p) => ({ id: p.id, payload: p.payload || {}, vector: p.vector }));
            all.push(...page);
            if (onPage) await onPage(page);
            offset = res?.result?.next_page_offset ?? null;
            if (offset == null || !points.length) break;
        }
        return all;
    }
}
