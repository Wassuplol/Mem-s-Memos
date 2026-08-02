/**
 * T11 — Injection.
 *
 * Builds the [Mem's Memos — Recall & World State] block and injects it ONLY
 * through the extension-safe context hook (host adapter inject(), mapped to
 * ST's extension prompt slot) at the configured Author's-Note-style depth.
 * If no hook exists → SHADOW MODE: everything is computed and stored, nothing
 * is injected, and the block is copyable from the Reading Room.
 *
 * The block is epistemically filtered for the RESPONDING character. World +
 * observable entity state render for all; attributed/internal state and
 * attributed memories respect knowers_json / secret_from_json.
 */

import { estimateTokens, nowIso, truncateWords } from '../utils/helpers.js';
import { logger } from '../utils/logger.js';

export class InjectionEngine {
    /**
     * @param {object} deps
     * @param {import('./retrieval.js').RetrievalEngine} deps.retrieval
     * @param {import('./states.js').StateEngine} deps.states
     * @param {import('./epistemic.js').EpistemicEngine} deps.epistemic
     * @param {import('./stm.js').StmManager} deps.stm
     * @param {()=>object} deps.getSettings
     * @param {(kind:string,payload:object)=>void} [deps.emit]
     */
    constructor({ retrieval, states, epistemic, stm, getSettings, emit }) {
        this.retrieval = retrieval;
        this.states = states;
        this.epistemic = epistemic;
        this.stm = stm;
        this.getSettings = getSettings;
        this.emit = emit || (() => {});
        this.lastBlock = null;   // copyable block for shadow mode / DRY RUN
        this.lastTrace = null;
    }

    /**
     * Compose the injection block (no host interaction — pure + testable).
     * @param {object} args
     * @param {string} args.query — last user message text
     * @param {string} args.chatId
     * @param {string} [args.characterName] — responding character
     * @param {string} [args.characterId]
     * @param {boolean} [args.dryRun] — manual DRY RUN (Reading Room)
     */
    async buildBlock({ query, chatId, characterName, characterId, dryRun = false }) {
        const settings = this.getSettings();
        const p = settings.pipeline;
        const charLabel = characterName || 'the character';

        const [retrieval, worldLine, stateLines, topicHints, stmLive] = await Promise.all([
            this.retrieval.retrieve({ query, chatId, characterName, characterId }),
            this.states.worldLine(chatId).catch(() => ''),
            this.states.snapshotLines(chatId, characterName).catch(() => []),
            p.topicHints ? this.epistemic.topicHints(chatId, characterName || '', 5).catch(() => []) : [],
            this.stm.live(chatId).catch(() => []),
        ]);
        this.lastTrace = retrieval.trace;

        const lines = [];
        lines.push("[Mem's Memos — Recall & World State]");
        if (worldLine) lines.push(`World: ${worldLine}`);
        if (stateLines.length) {
            lines.push('Entity States:');
            lines.push(...stateLines);
        }
        const knows = retrieval.memories.map((m) => {
            const imp = (m.record.importance ?? 0.5).toFixed(2);
            return `- ${m.displayText} [Importance: ${imp}]`;
        });
        if (knows.length) {
            lines.push(`What ${charLabel} knows:`);
            lines.push(...knows);
        }
        if (topicHints.length) {
            lines.push(`What ${charLabel} does NOT know (topic hints only):`);
            lines.push(...topicHints.map((t) => `- ${t}`));
        }
        const goals = stmLive.filter((s) => s.buffer_type === 'goal').slice(0, 5);
        if (goals.length) {
            lines.push('Active Goals:');
            lines.push(...goals.map((g) => `- ${g.content}`));
        }
        const promises = stmLive.filter((s) => s.buffer_type === 'promise').slice(0, 5);
        if (promises.length) {
            lines.push('Unresolved:');
            lines.push(...promises.map((pr) => `- ${pr.content}`));
        }
        lines.push('Use these naturally. Never mention the memory system unless the character would plausibly know about it.');

        const block = lines.join('\n');
        this.lastBlock = {
            text: block,
            depth: p.injectionDepth,
            tokens: estimateTokens(block),
            createdAt: nowIso(),
            dryRun,
            memoryCount: retrieval.memories.length,
            trace: retrieval.trace,
        };
        return this.lastBlock;
    }

    /**
     * Inject through the host adapter. Host contract:
     *   host.inject(text, { depth }) -> boolean (true = actually injected)
     * Shadow/off modes never inject. Failures → shadow + warning (error map).
     * @param {object} host — the ST adapter (or dev mock)
     */
    async inject(host, { query, chatId, characterName, characterId }) {
        const settings = this.getSettings();
        if (settings.mode === 'off' || settings.governance.killSwitch) return { injected: false, reason: 'off' };
        const block = await this.buildBlock({ query, chatId, characterName, characterId });
        if (settings.mode === 'shadow') {
            this.emit('shadow-block', block);
            return { injected: false, reason: 'shadow', block };
        }
        if (typeof host?.inject !== 'function') {
            logger.warn('no extension-safe context hook — shadow mode engaged');
            this.emit('shadow-block', block);
            return { injected: false, reason: 'no-hook', block };
        }
        try {
            const ok = host.inject(block.text, { depth: block.depth, role: 'system' });
            if (!ok) throw new Error('host declined injection');
            this.emit('injected', block);
            return { injected: true, block };
        } catch (err) {
            logger.warn('injection failed — shadow fallback', { err: String(err?.message || err) });
            this.emit('injection-failed', { err: String(err?.message || err), block });
            return { injected: false, reason: 'failed', block };
        }
    }

    /** Copyable block for shadow mode + DRY RUN button. */
    getLastBlock() {
        return this.lastBlock;
    }

    getLastTrace() {
        return this.lastTrace;
    }
}
