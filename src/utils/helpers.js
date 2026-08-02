/**
 * Mem's Memos — pure helper utilities. No DOM, no SillyTavern imports:
 * everything here is unit-testable under plain Node.
 */

/** Escape any user/AI-generated text before it touches innerHTML. */
export function escapeHtml(value) {
    return String(value ?? '')
        .replace(/&/g, '&' + 'amp;')
        .replace(/</g, '&' + 'lt;')
        .replace(/>/g, '&' + 'gt;')
        .replace(/"/g, '&' + 'quot;')
        .replace(/'/g, '&#39;');
}

/** RFC4122 v4 UUID with crypto fallback. */
export function uuid() {
    const c = globalThis.crypto;
    if (c?.randomUUID) return c.randomUUID();
    const bytes = new Uint8Array(16);
    if (c?.getRandomValues) c.getRandomValues(bytes);
    else for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0'));
    return `${hex.slice(0, 4).join('')}-${hex.slice(4, 6).join('')}-${hex
        .slice(6, 8)
        .join('')}-${hex.slice(8, 10).join('')}-${hex.slice(10, 16).join('')}`;
}

/** FNV-1a 32-bit hash — fast content hash for dedupe keys & embed cache. */
export function fnv1a(str) {
    let h = 0x811c9dc5;
    const s = String(str);
    for (let i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i);
        h = Math.imul(h, 0x01000193);
    }
    return ('0000000' + (h >>> 0).toString(16)).slice(-8);
}

/** Stable hash of a scope+text pair, used for ingest dedupe. */
export function dedupeHash(scopeKey, text) {
    return fnv1a(`${scopeKey}::${normalizeWhitespace(text)}`);
}

export function normalizeWhitespace(text) {
    return String(text ?? '').replace(/\s+/g, ' ').trim();
}

/** Rough-but-honest token estimate (~4 chars/token, min 1). */
export function estimateTokens(text) {
    const s = String(text ?? '');
    if (!s) return 0;
    return Math.max(1, Math.ceil(s.length / 4));
}

export function clamp01(x) {
    const n = Number(x);
    if (Number.isNaN(n)) return 0;
    return Math.min(1, Math.max(0, n));
}

export function clamp(x, lo, hi) {
    return Math.min(hi, Math.max(lo, Number(x)));
}

/** Ebbinghaus retention: exp(-t / h). t = age in hours, h = half-life hours. */
export function ebbinghaus(ageHours, halfLifeHours) {
    const h = Math.max(0.01, Number(halfLifeHours) || 168);
    const t = Math.max(0, Number(ageHours) || 0);
    return Math.exp(-t / h);
}

export function hoursBetween(a, b = Date.now()) {
    return Math.max(0, (Number(b) - Number(a)) / 3_600_000);
}

export function minutesBetween(a, b = Date.now()) {
    return Math.max(0, (Number(b) - Number(a)) / 60_000);
}

/** Cosine similarity; returns 0 on empty/degenerate input. */
export function cosine(a, b) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length || a.length === 0) return 0;
    let dot = 0;
    let na = 0;
    let nb = 0;
    for (let i = 0; i < a.length; i++) {
        const x = a[i];
        const y = b[i];
        dot += x * y;
        na += x * x;
        nb += y * y;
    }
    if (na === 0 || nb === 0) return 0;
    return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/** Reciprocal Rank Fusion over multiple ranked id lists. */
export function reciprocalRankFusion(lists, k = 60) {
    const scores = new Map();
    for (const list of lists) {
        list.forEach((id, idx) => {
            scores.set(id, (scores.get(id) || 0) + 1 / (k + idx + 1));
        });
    }
    return [...scores.entries()].sort((a, b) => b[1] - a[1]).map(([id, score]) => ({ id, score }));
}

/** Maximal Marginal Relevance greedy selection for diversity. */
export function mmrSelect(candidates, lambda, topN, simOf) {
    const selected = [];
    const remaining = [...candidates];
    while (selected.length < topN && remaining.length > 0) {
        let bestIdx = 0;
        let bestScore = -Infinity;
        for (let i = 0; i < remaining.length; i++) {
            const cand = remaining[i];
            let maxSim = 0;
            for (const sel of selected) {
                const s = simOf(cand, sel);
                if (s > maxSim) maxSim = s;
            }
            const mmr = lambda * cand.score - (1 - lambda) * maxSim;
            if (mmr > bestScore) {
                bestScore = mmr;
                bestIdx = i;
            }
        }
        selected.push(remaining.splice(bestIdx, 1)[0]);
    }
    return selected;
}

/** Split text into keyword tokens for sparse search / BM25-ish overlap. */
export function keywordTokens(text) {
    const stop = new Set([
        'the', 'a', 'an', 'and', 'or', 'but', 'of', 'to', 'in', 'on', 'at', 'for', 'with',
        'is', 'was', 'are', 'were', 'be', 'been', 'it', 'its', 'this', 'that', 'these',
        'those', 'i', 'you', 'he', 'she', 'they', 'we', 'me', 'him', 'her', 'them', 'us',
        'my', 'your', 'his', 'their', 'our', 'as', 'by', 'from', 'not', 'no', 'so', 'if',
    ]);
    return String(text ?? '')
        .toLowerCase()
        .replace(/[^a-z0-9а-яё\s'-]/giu, ' ')
        .split(/\s+/)
        .filter((w) => w.length > 2 && !stop.has(w));
}

/** Sparse keyword overlap score in 0..1 (weighted Jaccard-ish). */
export function keywordOverlap(queryTokens, docTokens) {
    if (!queryTokens?.length || !docTokens?.length) return 0;
    const doc = new Set(docTokens);
    let hit = 0;
    for (const t of new Set(queryTokens)) if (doc.has(t)) hit++;
    return hit / new Set(queryTokens).size;
}

/** Sleep with optional AbortSignal. Rejects with AbortError on abort. */
export function sleep(ms, signal) {
    return new Promise((resolve, reject) => {
        if (signal?.aborted) return reject(new DOMException('Aborted', 'AbortError'));
        const id = setTimeout(() => {
            cleanup();
            resolve();
        }, ms);
        const onAbort = () => {
            clearTimeout(id);
            cleanup();
            reject(new DOMException('Aborted', 'AbortError'));
        };
        const cleanup = () => signal?.removeEventListener?.('abort', onAbort);
        signal?.addEventListener?.('abort', onAbort, { once: true });
    });
}

/** Retry with exponential backoff + jitter. */
export async function withRetry(fn, { retries = 2, baseMs = 400, maxMs = 8000, signal, retryOn } = {}) {
    let attempt = 0;
    // attempts = retries + 1 total tries
    for (;;) {
        try {
            return await fn(attempt);
        } catch (err) {
            if (signal?.aborted) throw err;
            const retryable = retryOn ? retryOn(err) : isRetryableError(err);
            if (attempt >= retries || !retryable) throw err;
            const delay = Math.min(maxMs, baseMs * 2 ** attempt) * (0.75 + Math.random() * 0.5);
            await sleep(delay, signal);
            attempt++;
        }
    }
}

export function isRetryableError(err) {
    if (!err) return false;
    if (err.name === 'AbortError') return false;
    const status = err.status ?? err.statusCode;
    if (status === 408 || status === 409 || status === 425 || status === 429) return true;
    if (typeof status === 'number' && status >= 500) return true;
    return /timeout|timed out|network|fetch failed|ECONNRESET|ECONNREFUSED|EAI_AGAIN/i.test(
        String(err.message || err),
    );
}

/** Parse JSON tolerantly: strips code fences, grabs the first {...} block. */
export function parseJsonLoose(text) {
    if (text == null) return null;
    let s = String(text).trim();
    s = s.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
    try {
        return JSON.parse(s);
    } catch {
        // find first balanced { ... } block
        const start = s.indexOf('{');
        if (start === -1) return null;
        let depth = 0;
        let inStr = false;
        let esc = false;
        for (let i = start; i < s.length; i++) {
            const ch = s[i];
            if (inStr) {
                if (esc) esc = false;
                else if (ch === '\\') esc = true;
                else if (ch === '"') inStr = false;
                continue;
            }
            if (ch === '"') inStr = true;
            else if (ch === '{') depth++;
            else if (ch === '}') {
                depth--;
                if (depth === 0) {
                    try {
                        return JSON.parse(s.slice(start, i + 1));
                    } catch {
                        return null;
                    }
                }
            }
        }
        return null;
    }
}

export function nowIso() {
    return new Date().toISOString();
}

export function formatDate(iso) {
    if (!iso) return '—';
    try {
        const d = new Date(iso);
        if (Number.isNaN(d.getTime())) return '—';
        return d.toLocaleString(undefined, {
            year: 'numeric', month: 'short', day: '2-digit',
            hour: '2-digit', minute: '2-digit',
        });
    } catch {
        return '—';
    }
}

/** Slugify a model name for Qdrant collection fingerprints. */
export function modelSlug(model) {
    return String(model || 'unconfigured')
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 48) || 'unconfigured';
}

/** Deterministic pseudo-random in [0,1) from a string seed (for card tilts). */
export function seededJitter(seed, magnitude = 1) {
    const h = parseInt(fnv1a(String(seed)), 16);
    return ((h % 1000) / 1000 - 0.5) * 2 * magnitude;
}

/** Simple language sniff: cyrillic / cjk / latin. Good enough for metadata. */
export function detectLanguage(text) {
    const s = String(text ?? '');
    if (/[а-яА-ЯёЁ]/.test(s)) return 'ru';
    if (/[一-鿿]/.test(s)) return 'zh';
    if (/[぀-ヿ]/.test(s)) return 'ja';
    if (/[가-힯]/.test(s)) return 'ko';
    if (/[a-zA-Z]/.test(s)) return 'en';
    return 'und';
}

/** Privacy redaction: emails, phones, API keys. Optional real-name list. */
export function redactPrivate(text, extraNames = []) {
    let s = String(text ?? '');
    s = s.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[email]');
    s = s.replace(/(\+?\d[\d\s().-]{7,}\d)/g, (m) => (m.replace(/\D/g, '').length >= 8 ? '[phone]' : m));
    s = s.replace(/\b(sk-[A-Za-z0-9_-]{8,}|apikey[=:]\s*\S+|api_key[=:]\s*\S+)/gi, '[key]');
    for (const name of extraNames) {
        if (!name) continue;
        const re = new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'gi');
        s = s.replace(re, '[name]');
    }
    return s;
}

/** Heuristic banter detector: greetings / one-liners skip extraction. */
export function isBanter(text) {
    const s = normalizeWhitespace(text);
    if (!s) return true;
    if (s.length > 220) return false;
    const words = s.split(' ').length;
    const banterRe =
        /^(hi|hello|hey|yo|hiya|howdy|good (morning|evening|afternoon|night)|gm|gn|ok(ay)?|k|kk|lol|lmao|haha+|hehe+|nice|cool|thanks?|thank you|thx|ty|sure|yep|yeah|yup|nope|nah|yes|no|maybe|hmm+|hm+|oh|ooh|ah+|wow|aww+|bye|goodbye|see (ya|you)|cya|welcome|np|no problem|sorry|my bad|whoops|brb|gtg|wb|\*?(waves|smiles|laughs|grins|nods|shrugs|sighs|chuckles|giggles|blushes|yawns|stretches)\*?)[\s.!~…)*]*$/i;
    if (banterRe.test(s)) return true;
    if (words <= 3 && !/\d|because|remember|promise|secret|plan|decided|agreed|always|never/i.test(s)) return true;
    return false;
}

/** Truncate a string at a word boundary, appending an ellipsis. */
export function truncateWords(text, maxChars) {
    const s = String(text ?? '');
    if (s.length <= maxChars) return s;
    const cut = s.slice(0, Math.max(0, maxChars - 1));
    const sp = cut.lastIndexOf(' ');
    return (sp > 40 ? cut.slice(0, sp) : cut) + '…';
}

/** Deep clone that survives non-structured-cloneable environments. */
export function deepClone(obj) {
    if (typeof structuredClone === 'function') {
        try {
            return structuredClone(obj);
        } catch {
            /* fall through */
        }
    }
    return JSON.parse(JSON.stringify(obj));
}

/** Event-emitter lite for cross-module signals inside the extension. */
export function createBus() {
    const map = new Map();
    return {
        on(evt, fn) {
            if (!map.has(evt)) map.set(evt, new Set());
            map.get(evt).add(fn);
            return () => map.get(evt)?.delete(fn);
        },
        emit(evt, payload) {
            for (const fn of map.get(evt) ?? []) {
                try {
                    fn(payload);
                } catch (err) {
                    // listeners must never break the emitter
                    console.error("[Mem's Memos] bus listener error", err);
                }
            }
        },
        clear() {
            map.clear();
        },
    };
}
