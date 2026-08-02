/**
 * RECALL — "The Reading Room": brass-pull search slot + filters (type,
 * importance, trust, time, knower); fanned result cards with score
 * ink-stamps; pipeline ledger (query → HyDE → hits → fusion → rerank →
 * compress → budget); COPY BLOCK / DRY RUN.
 */

import { el, btn, memoryCard, scoreStamp, emptyState, ledgerRow, stamp } from './components.js';
import { truncateWords } from '../utils/helpers.js';

const TYPES = ['', 'event', 'fact', 'goal', 'promise', 'summary', 'chunk'];
const TIMES = [['', 'any time'], ['1', 'last hour'], ['24', 'last day'], ['168', 'last week'], ['720', 'last month']];

export class ReadingRoom {
    constructor(ctx) {
        this.ctx = ctx;
        this.host = null;
        this.input = null;
        this.filters = { type: '', minImportance: 0, minTrust: 0, hours: '', knower: '' };
        this.resultsEl = null;
        this.pipelineEl = null;
        this.lastResult = null;
    }

    render(host) {
        this.host = host;
        host.replaceChildren(
            el('h2', { class: 'mm-room-title', text: 'The Reading Room' }),
            el('div', { class: 'mm-room-sub', text: 'RECALL · HYBRID SEARCH DESK' }),
        );

        // brass-pull slot
        this.input = el('input', {
            type: 'text', placeholder: 'Search the bureau… (who promised what?)',
            'aria-label': 'Recall query',
        });
        this.input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') this.search();
        });
        const slot = el('div', { class: 'mm-slot' }, this.input, el('span', { class: 'mm-slot-glint' }));
        host.append(slot);

        // filters
        const filterRow = el('div', { class: 'mm-row mm-mt' });
        filterRow.append(select('Type', TYPES.map((t) => [t, t || 'all types']), (v) => { this.filters.type = v; }));
        filterRow.append(select('Importance', [['0', 'any'], ['0.3', '≥ 0.3'], ['0.6', '≥ 0.6'], ['0.8', '≥ 0.8']], (v) => { this.filters.minImportance = Number(v); }));
        filterRow.append(select('Trust', [['0', 'any'], ['0.5', '≥ 0.5'], ['0.8', '≥ 0.8']], (v) => { this.filters.minTrust = Number(v); }));
        filterRow.append(select('Time', TIMES.map(([v, l]) => [v, l]), (v) => { this.filters.hours = v; }));
        const knowerInput = el('input', {
            type: 'text', placeholder: 'knower…', 'aria-label': 'Knower filter',
            style: { width: '90px' },
        });
        knowerInput.className = '';
        knowerInput.addEventListener('change', () => { this.filters.knower = knowerInput.value.trim(); });
        const knowerField = el('div', { class: 'mm-field' }, el('label', { text: 'Knower' }), knowerInput);
        filterRow.append(knowerField);
        host.append(filterRow);

        // actions
        host.append(el('div', { class: 'mm-row mm-mt' },
            btn('SEARCH', { iconCls: 'fa-magnifying-glass', onClick: () => this.search() }),
            btn('COPY BLOCK', { iconCls: 'fa-file-export', onClick: () => this.copyBlock() }),
            btn('DRY RUN', { iconCls: 'fa-stamp', onClick: () => this.dryRun() }),
        ));

        // pipeline ledger
        this.pipelineEl = el('div', { class: 'mm-pipeline' });
        host.append(this.pipelineEl);

        // results
        this.resultsEl = el('div', { class: 'mm-results' }, emptyState('ASK, AND THE BUREAU SHALL FILE AN ANSWER.'));
        host.append(this.resultsEl);

        function select(label, pairs, onChange) {
            const sel = el('select', { 'aria-label': label, onchange: (e) => onChange(e.target.value) },
                pairs.map(([v, l]) => el('option', { value: v, text: l })));
            return el('div', { class: 'mm-field' }, el('label', { text: label }), sel);
        }
    }

    async search() {
        const query = this.input.value.trim();
        if (!query) return;
        const scope = this.ctx.getScope();
        this.resultsEl.replaceChildren(emptyState('FILING THROUGH THE DRAWERS…'));
        this.pipelineEl.replaceChildren();

        const eventGte = this.filters.hours
            ? new Date(Date.now() - Number(this.filters.hours) * 3600_000).toISOString()
            : null;

        const result = await this.ctx.retrieval.retrieve({
            query,
            chatId: scope.chatId,
            characterName: this.filters.knower || scope.characterName,
            characterId: scope.characterId,
        });
        this.lastResult = result;

        // client-side filter pass (importance/trust/time/type)
        let memories = result.memories;
        if (this.filters.type) memories = memories.filter((m) => m.record.memory_type === this.filters.type);
        if (this.filters.minImportance) memories = memories.filter((m) => (m.record.importance ?? 0) >= this.filters.minImportance);
        if (this.filters.minTrust) memories = memories.filter((m) => (m.record.trust ?? 0) >= this.filters.minTrust);
        if (eventGte) memories = memories.filter((m) => !m.record.event_time || m.record.event_time >= eventGte);

        // pipeline ledger
        this.pipelineEl.replaceChildren(
            el('h3', { class: 'mm-ledger-title', text: 'Pipeline Receipt' }),
            ...result.trace.map((t) => ledgerRow(t.stage, `${t.detail} · ${t.ms}ms`)),
        );

        if (!memories.length) {
            this.resultsEl.replaceChildren(emptyState('NOTHING FILED UNDER THAT NAME.'));
            return;
        }
        this.resultsEl.replaceChildren(...memories.map((m, i) => {
            const card = memoryCard(m.record, {
                onTrace: (rec) => this.ctx.showTrace(rec.id),
                onForget: async (rec) => {
                    await this.ctx.forgetMemory(rec.id);
                    card.classList.add('mm-burn-out');
                    setTimeout(() => card.remove(), 400);
                    this.ctx.desk.toast('Memo forgotten. Ash in the bin.', 'warn');
                },
            });
            card.style.animationDelay = `${i * 40}ms`;
            card.classList.add('mm-card-enter');
            card.append(scoreStamp(m.finalScore));
            return card;
        }));
        this.ctx.desk.refreshLedger([
            { key: 'recall', value: `${memories.length} hits`, state: 'ok' },
            { key: 'tokens', value: `${result.tokensUsed}`, state: '' },
            { key: 'degradation', value: `L${this.ctx.router.degradationLevel()}`, state: this.ctx.router.degradationLevel() ? 'warn' : 'ok' },
        ]);
    }

    async copyBlock() {
        const block = this.ctx.injection.getLastBlock();
        const text = block?.text || this._blockFromResults();
        try {
            await navigator.clipboard.writeText(text);
            this.ctx.desk.toast('Recall block copied — paste it anywhere.', 'ok');
        } catch {
            this.ctx.desk.toast('Clipboard unavailable — select + copy manually.', 'warn');
        }
    }

    _blockFromResults() {
        if (!this.lastResult?.memories?.length) return '[Mem\'s Memos] no memories recalled yet.';
        const lines = this.lastResult.memories.map((m) => `- ${m.displayText} [Importance: ${(m.record.importance ?? 0.5).toFixed(2)}]`);
        return ["[Mem's Memos — Recall]", ...lines].join('\n');
    }

    async dryRun() {
        const scope = this.ctx.getScope();
        const query = this.input.value.trim() || this.ctx.host.getLastUserMessage?.() || 'what do they remember?';
        const block = await this.ctx.injection.buildBlock({
            query, chatId: scope.chatId, characterName: scope.characterName, characterId: scope.characterId, dryRun: true,
        });
        this.pipelineEl.replaceChildren(
            el('h3', { class: 'mm-ledger-title', text: 'Dry Run — injection preview (not sent)' }),
            ...block.trace.map((t) => ledgerRow(t.stage, `${t.detail} · ${t.ms}ms`)),
            ledgerRow('depth', String(block.depth)),
            ledgerRow('tokens', `${block.tokens} / ${this.ctx.getSettings().pipeline.injectionBudget}`),
        );
        const preview = el('article', { class: 'mm-card mm-card-enter' },
            el('div', { class: 'mm-card-head' },
                el('span', { class: 'mm-seal' }),
                el('h3', { class: 'mm-card-title', text: 'Injection Block — DRY RUN' }),
            ),
            el('p', { class: 'mm-card-text mm-mono', text: block.text, style: { whiteSpace: 'pre-wrap', fontSize: '11px' } }),
            stamp('SHADOW', 'amber', { small: true }),
        );
        this.resultsEl.replaceChildren(preview);
    }

    refresh() { /* manual room — refresh happens on search */ }
}
