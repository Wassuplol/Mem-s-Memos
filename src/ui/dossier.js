/**
 * KNOWS — "The Dossier": pick any entity; two columns — "Knows" (cards) vs
 * "Does not know" (sealed envelopes, topic labels only). SECRET stamps
 * visible. The UI is omniscient for the USER; the epistemic filter only
 * governs what goes into OTHER characters' prompts.
 */

import { el, memoryCard, emptyState, stamp } from './components.js';
import { truncateWords, seededJitter } from '../utils/helpers.js';

export class DossierRoom {
    constructor(ctx) {
        this.ctx = ctx;
        this.host = null;
        this.select = null;
        this.knowsEl = null;
        this.unknownEl = null;
        this._unsub = [];
    }

    render(host) {
        this.host = host;
        host.replaceChildren(
            el('h2', { class: 'mm-room-title', text: 'The Dossier' }),
            el('div', { class: 'mm-room-sub', text: 'EPISTEMIC LEDGER · WHO KNOWS WHAT' }),
        );
        this.select = el('select', {
            'aria-label': 'Choose entity',
            onchange: () => this.refresh(),
        });
        host.append(el('div', { class: 'mm-field' }, el('label', { text: 'Entity' }), this.select));
        const cols = el('div', { class: 'mm-dossier-cols mm-mt' });
        this.knowsEl = el('div', {},
            el('h3', { class: 'mm-dossier-col-title' }, el('i', { class: 'fa-solid fa-folder-open' }), 'Knows'));
        this.unknownEl = el('div', {},
            el('h3', { class: 'mm-dossier-col-title' }, el('i', { class: 'fa-solid fa-snowflake' }), 'Does not know'));
        cols.append(this.knowsEl, this.unknownEl);
        host.append(cols);
        this._unsub.push(this.ctx.bus.on('memory', () => this.refresh()));
        this.refresh();
    }

    async refresh() {
        if (!this.host) return;
        const scope = this.ctx.getScope();
        if (!scope.chatId) return;

        // entity list = characters in memories + current character + 'user'
        const memories = await this.ctx.meta.queryMemories({ chat_id: scope.chatId, status_not: ['deleted'] }).catch(() => []);
        const names = new Set(['user']);
        if (scope.characterName) names.add(scope.characterName);
        for (const m of memories) {
            for (const c of m.characters_json || []) names.add(c);
            if (m.subject_name) names.add(m.subject_name);
            for (const k of m.knowers_json || []) names.add(k);
        }
        const list = [...names].sort((a, b) => a.localeCompare(b));
        const prev = this.select.value || scope.characterName || 'user';
        this.select.replaceChildren(...list.map((n) => el('option', { value: n, text: n, selected: n === prev ? '' : null })));
        const entity = this.select.value || prev;

        // KNOWS column: knowledge rows + allowed memories mentioning the entity
        const knowledge = await this.ctx.epistemic.knows(scope.chatId, entity).catch(() => []);
        const allowed = memories.filter((m) =>
            this.ctx.epistemic.constructor.allows(m, entity) &&
            ((m.characters_json || []).includes(entity) || (m.knowers_json || []).includes(entity) || m.subject_name === entity),
        ).slice(0, 12);

        const knowsCards = [];
        for (const k of knowledge.slice(0, 8)) {
            knowsCards.push(el('article', { class: 'mm-card', style: { '--mm-tilt': `${seededJitter(k.id, 1.2).toFixed(2)}deg` } },
                el('div', { class: 'mm-card-head' },
                    el('span', { class: 'mm-seal' }),
                    el('h3', { class: 'mm-card-title', text: k.stance }),
                ),
                el('p', { class: 'mm-card-text', text: truncateWords(k.claim_text || '', 180) }),
                el('div', { class: 'mm-card-meta' }, el('span', { text: `conf ${Number(k.confidence ?? 0.9).toFixed(2)}` })),
                k.stance === 'knows' ? stamp('ACTIVE', 'verdigris', { small: true }) : stamp(k.stance.toUpperCase(), 'amber', { small: true }),
            ));
        }
        for (const m of allowed) knowsCards.push(memoryCard(m, { onTrace: (r) => this.ctx.showTrace(r.id) }));
        this.knowsEl.replaceChildren(
            el('h3', { class: 'mm-dossier-col-title' }, el('i', { class: 'fa-solid fa-folder-open' }), 'Knows'),
            ...(knowsCards.length ? knowsCards : [emptyState('THE BUREAU HAS NOTHING ON FILE FOR THEM.')]),
        );

        // DOES NOT KNOW column: sealed envelopes, topic labels only
        const hidden = await this.ctx.epistemic.doesNotKnow(scope.chatId, entity).catch(() => []);
        this.unknownEl.replaceChildren(
            el('h3', { class: 'mm-dossier-col-title' }, el('i', { class: 'fa-solid fa-snowflake' }), 'Does not know'),
            ...(hidden.length
                ? hidden.map((h) => el('div', {
                    class: 'mm-envelope',
                    style: { '--mm-tilt': `${seededJitter(h.label, 1.4).toFixed(2)}deg` },
                },
                    el('span', { class: 'mm-envelope-topic', text: h.label }),
                    stamp('SECRET', 'blue', { small: true }),
                ))
                : [emptyState('NOTHING IS SEALED FROM THEM.')]),
        );
    }

    destroy() {
        this._unsub.forEach((u) => u?.());
        this._unsub = [];
    }
}
