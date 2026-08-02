/**
 * Mem's Memos — OpenAI-compatible HTTP client.
 * One client instance per lane. Supports /chat/completions, /embeddings and an
 * optional /rerank endpoint (with chat-completion fallback). API keys are only
 * ever used in headers — never logged, never serialized to disk by this module.
 */

import { logger } from '../utils/logger.js';
import { parseJsonLoose, withRetry } from '../utils/helpers.js';

export class OpenAIClient {
    /**
     * @param {{baseUrl:string, apiKey?:string, model?:string, timeoutMs?:number,
     *          retries?:number, name?:string}} cfg
     * @param {{fetchFn?:Function, bridge?:{enabled:boolean, baseUrl:string}}} deps
     */
    constructor(cfg, deps = {}) {
        this.name = cfg.name || 'lane';
        this.baseUrl = String(cfg.baseUrl || '').replace(/\/+$/, '');
        this.apiKey = cfg.apiKey || '';
        this.model = cfg.model || '';
        this.timeoutMs = cfg.timeoutMs ?? 30000;
        this.retries = cfg.retries ?? 2;
        this.fetchFn = deps.fetchFn || globalThis.fetch?.bind(globalThis);
        this.bridge = deps.bridge || { enabled: false, baseUrl: '' };
    }

    get configured() {
        return Boolean(this.baseUrl && this.model);
    }

    headers() {
        const h = { 'Content-Type': 'application/json' };
        if (this.apiKey) h.Authorization = `Bearer ${this.apiKey}`;
        return h;
    }

    /** Route through the localhost bridge when enabled (solves CORS). */
    resolveUrl(path) {
        if (this.bridge.enabled && this.bridge.baseUrl) {
            const kind = path.includes('/embeddings') ? 'embed'
                : path.includes('/chat/completions') ? 'chat'
                    : null;
            if (kind) return `${this.bridge.baseUrl.replace(/\/+$/, '')}/${kind}`;
        }
        return `${this.baseUrl}${path}`;
    }

    async rawPost(path, body, { signal } = {}) {
        if (!this.fetchFn) throw new Error('fetch is unavailable in this environment');
        const url = this.resolveUrl(path);
        const ctl = new AbortController();
        const timer = setTimeout(() => ctl.abort(new Error(`timeout after ${this.timeoutMs}ms`)), this.timeoutMs);
        const onOuterAbort = () => ctl.abort(signal.reason || new Error('aborted'));
        signal?.addEventListener?.('abort', onOuterAbort, { once: true });
        try {
            const res = await this.fetchFn(url, {
                method: 'POST',
                headers: this.headers(),
                body: JSON.stringify(body),
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
                    `${this.name} HTTP ${res.status}: ${json?.error?.message || text.slice(0, 240) || res.statusText}`,
                );
                err.status = res.status;
                throw err;
            }
            return json;
        } catch (err) {
            if (err?.name === 'AbortError') {
                const e = new Error(`${this.name} request aborted/timeout (${this.timeoutMs}ms)`);
                e.status = 408;
                throw e;
            }
            throw err;
        } finally {
            clearTimeout(timer);
            signal?.removeEventListener?.('abort', onOuterAbort);
        }
    }

    /**
     * Chat completion. Returns { content, raw, usage, latencyMs }.
     */
    async chat(messages, { temperature = 0.2, maxTokens, responseFormat, signal, model } = {}) {
        if (!this.configured) throw new Error(`${this.name} lane is not configured (baseUrl/model missing)`);
        const started = Date.now();
        const body = {
            model: model || this.model,
            messages,
            temperature,
            stream: false,
        };
        if (maxTokens) body.max_tokens = maxTokens;
        if (responseFormat === 'json') body.response_format = { type: 'json_object' };
        const json = await withRetry(
            () => this.rawPost('/chat/completions', body, { signal }),
            { retries: this.retries, signal },
        );
        const choice = json?.choices?.[0];
        const content = choice?.message?.content ?? choice?.text ?? '';
        return {
            content: typeof content === 'string' ? content : JSON.stringify(content),
            raw: json,
            usage: json?.usage || null,
            latencyMs: Date.now() - started,
        };
    }

    /**
     * Embeddings. input may be a string or string[].
     * Returns { vectors: number[][], model, dim, latencyMs }.
     * `dimensions` (Matryoshka) is sent only when > 0.
     */
    async embed(input, { dimensions = 0, instruction = '', signal, model } = {}) {
        const baseUrl = this.baseUrl;
        if (!baseUrl) throw new Error(`${this.name} lane is not configured (baseUrl missing)`);
        if (!this.model && !model) throw new Error(`${this.name} lane is not configured (model missing)`);
        const started = Date.now();
        const arr = Array.isArray(input) ? input : [input];
        const body = {
            model: model || this.model,
            input: arr.map((t) => (instruction ? `${instruction}${t}` : t)),
        };
        if (dimensions > 0) body.dimensions = dimensions;
        const json = await withRetry(
            () => this.rawPost('/embeddings', body, { signal }),
            { retries: this.retries, signal },
        );
        const data = Array.isArray(json?.data) ? json.data : [];
        const vectors = data
            .slice()
            .sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
            .map((d) => d.embedding)
            .filter((v) => Array.isArray(v) && v.length > 0);
        if (!vectors.length) throw new Error(`${this.name}: embeddings endpoint returned no vectors`);
        return {
            vectors,
            model: json?.model || model || this.model,
            dim: vectors[0].length,
            latencyMs: Date.now() - started,
        };
    }

    /**
     * Rerank via an OpenAI-compatible /rerank endpoint (Jina/TEI/vLLM style).
     * Falls back to chat-based ranking when useChatFallback is true and the
     * endpoint is missing (404) — the caller supplies `fallbackRank` for that.
     */
    async rerank(query, documents, { topN, signal } = {}) {
        if (!this.baseUrl) throw new Error(`${this.name} lane is not configured`);
        const body = {
            model: this.model,
            query,
            documents,
            ...(topN ? { top_n: topN } : {}),
        };
        const json = await withRetry(
            () => this.rawPost('/rerank', body, { signal }),
            { retries: this.retries, signal, retryOn: (e) => e.status !== 404 && e.status !== 400 },
        );
        const results = Array.isArray(json?.results) ? json.results : [];
        return results.map((r) => ({ index: r.index, score: r.relevance_score ?? r.score ?? 0 }));
    }

    /**
     * Health probe: tries a 1-token chat completion (fast/strong lanes) or a
     * 1-input embedding (embed lane). Returns a stamp-ready result object.
     */
    async test(kind = 'chat', probe = {}) {
        const started = Date.now();
        try {
            if (kind === 'embed') {
                const r = await this.embed(probe.text || 'memory bureau connectivity check', {
                    dimensions: probe.dimensions || 0,
                });
                return {
                    ok: true,
                    kind,
                    latencyMs: Date.now() - started,
                    model: r.model,
                    dim: r.dim,
                    detail: `${r.model} · ${r.dim}d`,
                };
            }
            const r = await this.chat(
                [
                    { role: 'system', content: 'Reply with the single word: OK' },
                    { role: 'user', content: 'ping' },
                ],
                { maxTokens: 8, temperature: 0 },
            );
            return {
                ok: true,
                kind,
                latencyMs: Date.now() - started,
                model: modelOf(r.raw) || this.model,
                detail: `OK · ${Date.now() - started}ms`,
            };
        } catch (err) {
            logger.warn(`${this.name} lane TEST failed`, { err: String(err?.message || err) });
            const msg = String(err?.message || err);
            return {
                ok: false,
                kind,
                latencyMs: Date.now() - started,
                detail: msg.includes('timeout') || err.status === 408 ? 'FAIL · timeout'
                    : err.status ? `FAIL · HTTP ${err.status}`
                        : 'FAIL · unreachable (CORS or offline?)',
                error: msg,
            };
        }
    }
}

function modelOf(raw) {
    return raw?.model || null;
}

/** Extract a JSON object from a chat response, tolerantly. */
export function chatJson(response) {
    return parseJsonLoose(response?.content ?? '');
}
