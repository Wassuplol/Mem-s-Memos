/**
 * Mem's Memos — leveled logger. Secrets are never logged: apiKey-like fields
 * are redacted from any object passed through. Log level is configurable.
 */

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 99 };

let currentLevel = LEVELS.info;
const ring = []; // small in-memory ring buffer for the observability ledger
const RING_MAX = 400;

const SECRET_KEYS = /api[-_]?key|token|secret|password|authorization/i;

function redact(value, depth = 0) {
    if (depth > 4) return '[…]';
    if (value == null) return value;
    if (typeof value === 'string') {
        // redact Bearer headers / sk- style keys that appear inside strings
        return value
            .replace(/Bearer\s+[A-Za-z0-9._\-]+/g, 'Bearer [redacted]')
            .replace(/sk-[A-Za-z0-9._\-]{6,}/g, 'sk-[redacted]');
    }
    if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
    if (typeof value === 'object') {
        const out = {};
        for (const [k, v] of Object.entries(value)) {
            out[k] = SECRET_KEYS.test(k) ? '[redacted]' : redact(v, depth + 1);
        }
        return out;
    }
    return value;
}

function write(level, args) {
    if (LEVELS[level] < currentLevel) return;
    const entry = {
        ts: new Date().toISOString(),
        level,
        msg: args
            .map((a) => (typeof a === 'string' ? a : safeStringify(redact(a))))
            .join(' '),
    };
    ring.push(entry);
    if (ring.length > RING_MAX) ring.splice(0, ring.length - RING_MAX);
    const fn = level === 'error' ? 'error' : level === 'warn' ? 'warn' : 'log';
    // eslint-disable-next-line no-console
    console[fn](`[Mem's Memos]`, entry.msg);
}

function safeStringify(obj) {
    try {
        return JSON.stringify(obj);
    } catch {
        return String(obj);
    }
}

export const logger = {
    debug: (...a) => write('debug', a),
    info: (...a) => write('info', a),
    warn: (...a) => write('warn', a),
    error: (...a) => write('error', a),
    setLevel(level) {
        if (level in LEVELS) currentLevel = LEVELS[level];
    },
    /** Last N ring-buffer entries (already redacted) for the audit ledger. */
    tail(n = 50) {
        return ring.slice(-n);
    },
    redact,
};
