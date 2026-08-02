/**
 * Mem's Memos — settings schema, defaults, merge/migration, validation.
 * Persistence happens through the host adapter (ST extensionSettings or the
 * dev mock); this module owns the SHAPE only.
 */

import { deepClone } from '../utils/helpers.js';

export const MODULE_NAME = 'mems-memos';
export const SCHEMA_VERSION = 1;

/** Canonical scoring weights (sum of positives = 1.00 before penalties). */
export const DEFAULT_WEIGHTS = Object.freeze({
    sem: 0.26,
    sparse: 0.13,
    rec: 0.13,
    imp: 0.13,
    trust: 0.08,
    emo: 0.07,
    graph: 0.05,
    nov: 0.03,
    acc: 0.02,
    comp: 0.10,
});

export const defaultSettings = Object.freeze({
    schemaVersion: SCHEMA_VERSION,

    /** mode: 'on' | 'shadow' | 'off' — first run defaults to shadow (safe). */
    mode: 'shadow',
    enabledChats: {},      // chatId -> bool override (default follows mode)
    enabledCharacters: {}, // character name -> bool override
    consent: { storeEvents: true, storeSecrets: true, redactPrivate: false, redactedNames: [] },

    lanes: {
        fast:   { baseUrl: 'http://localhost:11434/v1', apiKey: '', model: '', timeoutMs: 30000, retries: 2 },
        strong: { baseUrl: 'http://localhost:11434/v1', apiKey: '', model: '', timeoutMs: 60000, retries: 2 },
        embed:  {
            baseUrl: 'http://localhost:11434/v1', apiKey: '', model: '',
            dimensions: 0,            // 0 = auto (use whatever the model returns)
            maxDimensions: 0,         // 0 = unknown; validated on TEST
            instruction: '',
            docPrefix: '', queryPrefix: '',
            timeoutMs: 30000, retries: 2,
        },
        rerank: { baseUrl: '', apiKey: '', model: '', timeoutMs: 30000, retries: 1, useChatFallback: true },
    },

    qdrant: {
        baseUrl: 'http://localhost:6333',
        apiKey: '',
        quantization: 'scalar',   // 'scalar' | 'binary' | 'none'
        timeoutMs: 15000,
    },

    bridge: { enabled: false, baseUrl: 'http://127.0.0.1:8787' },

    pipeline: {
        injectionBudget: 800,       // tokens
        extractionWindow: 6,        // W — rolling window size
        retrievalTopK: 12,
        finalTopN: 6,
        injectionDepth: 1,          // Author's Note convention: N from the end
        halfLifeHours: 168,         // LTM Ebbinghaus half-life
        stmHalfLifeMinutes: 60,
        stmCapacity: 40,            // max STM entries per chat
        dedupeThreshold: 0.92,      // cosine — semantic dedupe at ingest
        fastLaneImportance: 0.8,    // >= => priority fast lane
        mmrLambda: 0.7,
        topicHints: true,           // inject "does not know about: X" topic labels
        compressMemories: true,
        useHyde: true,
        useRerank: true,
        useQueryExpansion: true,
        pullParentChunks: true,
        minScore: 0.05,
    },

    weights: { ...DEFAULT_WEIGHTS },

    ui: {
        collapsed: false,
        ledgerCollapsed: false,
        drawerWidth: 480,
        logLevel: 'info',
        msgDots: true,
        fab: { x: null, y: null },   // floating desk button position (px from viewport edges; null = default corner)
        ticker: true,
        reducedData: false,
    },

    governance: {
        retentionPolicy: 'forever',   // forever|session|chat|ttl|manual
        ttlDays: 90,
        auditTrail: true,
        killSwitch: false,
        autoConsolidateOnChatChange: true,
        idleConsolidateMinutes: 30,
    },

    /** Persisted operational state (not user prefs, but small + useful). */
    state: {
        collection: '',            // active qdrant collection fingerprint
        embedModel: '',            // model used for stored vectors
        embedDim: 0,               // dim of stored vectors
        modelMismatch: false,
        degradation: 0,            // current ladder level L0..L4
        lastConsolidatedAt: 0,
        reembedJob: null,          // {total, done, status, startedAt}
        evalHistory: [],           // last N eval runs
    },
});

/** Merge stored settings over defaults (deep, array-replacing). */
export function mergeSettings(stored) {
    const base = deepClone(defaultSettings);
    if (!stored || typeof stored !== 'object') return base;
    return deepMerge(base, stored);
}

function deepMerge(target, source) {
    for (const key of Object.keys(source)) {
        const sv = source[key];
        if (sv && typeof sv === 'object' && !Array.isArray(sv) &&
            target[key] && typeof target[key] === 'object' && !Array.isArray(target[key])) {
            deepMerge(target[key], sv);
        } else if (sv !== undefined) {
            target[key] = deepClone(sv);
        }
    }
    return target;
}

/** Validate + clamp numeric ranges. Mutates and returns the settings object. */
export function validateSettings(s) {
    const p = s.pipeline;
    p.injectionBudget = intIn(p.injectionBudget, 100, 8000, 800);
    p.extractionWindow = intIn(p.extractionWindow, 2, 24, 6);
    p.retrievalTopK = intIn(p.retrievalTopK, 1, 100, 12);
    p.finalTopN = intIn(p.finalTopN, 1, 30, 6);
    p.injectionDepth = intIn(p.injectionDepth, 0, 999, 1);
    p.halfLifeHours = numIn(p.halfLifeHours, 1, 8760, 168);
    p.stmHalfLifeMinutes = numIn(p.stmHalfLifeMinutes, 1, 1440, 60);
    p.stmCapacity = intIn(p.stmCapacity, 5, 500, 40);
    p.dedupeThreshold = numIn(p.dedupeThreshold, 0.5, 0.999, 0.92);
    p.fastLaneImportance = numIn(p.fastLaneImportance, 0, 1, 0.8);
    p.mmrLambda = numIn(p.mmrLambda, 0, 1, 0.7);
    p.minScore = numIn(p.minScore, 0, 1, 0.05);
    for (const k of Object.keys(DEFAULT_WEIGHTS)) {
        if (!(k in s.weights)) s.weights[k] = DEFAULT_WEIGHTS[k];
        s.weights[k] = numIn(s.weights[k], 0, 1, DEFAULT_WEIGHTS[k]);
    }
    if (!['on', 'shadow', 'off'].includes(s.mode)) s.mode = 'shadow';
    if (!['forever', 'session', 'chat', 'ttl', 'manual'].includes(s.governance.retentionPolicy)) {
        s.governance.retentionPolicy = 'forever';
    }
    if (!['scalar', 'binary', 'none'].includes(s.qdrant.quantization)) s.qdrant.quantization = 'scalar';
    return s;
}

function intIn(v, lo, hi, dflt) {
    const n = Math.round(Number(v));
    if (Number.isNaN(n)) return dflt;
    return Math.min(hi, Math.max(lo, n));
}
function numIn(v, lo, hi, dflt) {
    const n = Number(v);
    if (Number.isNaN(n)) return dflt;
    return Math.min(hi, Math.max(lo, n));
}

/** Effective enablement for a given chat/character context. */
export function isEnabledFor(s, { chatId, characterName } = {}) {
    if (s.mode === 'off' || s.governance.killSwitch) return false;
    if (chatId != null && chatId in s.enabledChats) return !!s.enabledChats[chatId];
    if (characterName && characterName in s.enabledCharacters) return !!s.enabledCharacters[characterName];
    return true; // mode on/shadow applies
}
