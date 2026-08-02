/**
 * Mem's Memos — Model Router.
 * Four lanes {fast, strong, embed, rerank}; per-lane circuit breaker
 * (opens after 3 consecutive failures, half-opens after 60s) and a
 * degradation ladder L0..L4 that the engine consults before each stage.
 */

import { OpenAIClient } from './openaiClient.js';
import { logger } from '../utils/logger.js';

const BREAKER_THRESHOLD = 3;
const BREAKER_HALFOPEN_MS = 60_000;

export const DEGRADATION = Object.freeze({
    L0_FULL: 0,         // extract + embed + rerank + compress
    L1_NO_RERANK: 1,    // no rerank / no compression
    L2_NO_EXTRACT: 2,   // no extraction — keyword + chunk storage only
    L3_QDRANT_DOWN: 3,  // local fallback storage
    L4_ALL_DOWN: 4,     // STM only + manual recall
});

export class ModelRouter {
    /**
     * @param {object} settings — the live settings object (lanes read by ref)
     * @param {{fetchFn?:Function}} deps
     */
    constructor(settings, deps = {}) {
        this.settings = settings;
        this.deps = deps;
        this.clients = new Map();
        this.breakers = new Map();
        this.health = new Map(); // lane -> last test result
        this.qdrantDown = false;
        this._rebuild();
    }

    /** Rebuild lane clients from current settings (call after settings edits). */
    _rebuild() {
        const bridge = this.settings.bridge;
        for (const lane of ['fast', 'strong', 'embed', 'rerank']) {
            const cfg = { ...this.settings.lanes[lane], name: lane };
            this.clients.set(lane, new OpenAIClient(cfg, { fetchFn: this.deps.fetchFn, bridge }));
            if (!this.breakers.has(lane)) {
                this.breakers.set(lane, { failures: 0, open: false, openedAt: 0, halfOpen: false });
            }
        }
    }

    refresh() {
        this._rebuild();
    }

    client(lane) {
        return this.clients.get(lane);
    }

    breaker(lane) {
        return this.breakers.get(lane);
    }

    /** Is a lane currently allowed to carry traffic? */
    available(lane) {
        const b = this.breakers.get(lane);
        if (!b) return false;
        if (!b.open) return true;
        if (Date.now() - b.openedAt >= BREAKER_HALFOPEN_MS) {
            b.halfOpen = true; // allow a single probe through
            return true;
        }
        return false;
    }

    reportSuccess(lane) {
        const b = this.breakers.get(lane);
        if (b) {
            b.failures = 0;
            b.open = false;
            b.halfOpen = false;
        }
    }

    reportFailure(lane, err) {
        const b = this.breakers.get(lane);
        if (!b) return;
        b.failures++;
        logger.warn(`lane ${lane} failure ${b.failures}/${BREAKER_THRESHOLD}`, { err: String(err?.message || err) });
        if (b.failures >= BREAKER_THRESHOLD && !b.open) {
            b.open = true;
            b.openedAt = Date.now();
            logger.warn(`lane ${lane} circuit breaker OPEN`);
        }
    }

    /**
     * Run an async operation on a lane with breaker accounting.
     * Throws the underlying error when the lane is open or the op fails.
     */
    async run(lane, op) {
        if (!this.available(lane)) {
            throw new Error(`lane ${lane} circuit breaker is open`);
        }
        try {
            const result = await op(this.clients.get(lane));
            this.reportSuccess(lane);
            return result;
        } catch (err) {
            this.reportFailure(lane, err);
            throw err;
        }
    }

    /** Current degradation level, derived from lane + qdrant health. */
    degradationLevel() {
        const fastOk = this.available('fast');
        const embedOk = this.available('embed');
        const rerankOk = this.available('rerank');
        if (!fastOk && !embedOk) return DEGRADATION.L4_ALL_DOWN;
        if (this.qdrantDown) return DEGRADATION.L3_QDRANT_DOWN;
        if (!fastOk) return DEGRADATION.L2_NO_EXTRACT;
        if (!rerankOk) return DEGRADATION.L1_NO_RERANK;
        return DEGRADATION.L0_FULL;
    }

    setQdrantDown(down) {
        if (this.qdrantDown !== down) {
            this.qdrantDown = down;
            logger.info(down ? 'Qdrant marked DOWN — local fallback engaged' : 'Qdrant back online');
        }
    }

    /** Probe every lane (used by the Settings ledger TEST buttons). */
    async testLane(lane) {
        const client = this.clients.get(lane);
        const kind = lane === 'embed' ? 'embed' : 'chat';
        const probe = lane === 'embed' ? { dimensions: this.settings.lanes.embed.dimensions || 0 } : {};
        const result = await client.test(kind, probe);
        if (result.ok) this.reportSuccess(lane);
        else this.reportFailure(lane, new Error(result.detail));
        this.health.set(lane, result);
        return result;
    }

    healthSummary() {
        const out = {};
        for (const lane of ['fast', 'strong', 'embed', 'rerank']) {
            const b = this.breakers.get(lane);
            const h = this.health.get(lane);
            out[lane] = {
                breakerOpen: !!b?.open,
                failures: b?.failures || 0,
                lastTest: h || null,
                configured: this.clients.get(lane)?.configured ?? false,
            };
        }
        return out;
    }
}
