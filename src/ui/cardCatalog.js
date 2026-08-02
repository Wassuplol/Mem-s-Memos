/**
 * FACTS & STATES — "The Card Catalog": drawer grid of fact cards PLUS Entity
 * State Cards (Character: outfit/injuries/mood · Place: hazards/occupants ·
 * Object: holder/condition · Faction: stance/hostility); brass-pull filters;
 * hover pulls a card out.
 */

import { el, btn, memoryCard, emptyState, stamp, card as cardFactory } from './components.js';
import { truncateWords, formatDate } from '../utils/helpers.js';

export class CardCatalogRoom {
    constructor(ctx) {
        this.ctx = ctx;
        this.host = null;
        this.gridEl = null;
        this.stateGridEl = null;
        this.filters = { type: '', q: '' };
        this._unsub = [];
    }

    render(host) {
        this.host = host;
        host.replaceChildren(
            el('h2', { class: 'mm-room-title', text: 'The Card Catalog' }),
            el('div', { class: 'mm-room-sub', text: 'FACTS & STATES · EVERY DRAWER ACCOUNTED FOR' }),
        );

        // brass-pull filters
        const row = el('div', { class: 'mm-row' });
        const q = el('input', { type: 'text', placeholder: 'Filter the drawers…', 'aria-label': 'Filter facts' });
        q.addEventListener('input', () => { this.filters.q = q.value.trim().toLowerCase(); this.refresh(); });
        row.append(el('div', { class: 'mm-slot', style: { flex: '1 1 180px' } }, q, el('span', { class: 'mm-slot-glint' })));
        const typeSel = el('select', {
            'aria-label': 'Memory type filter',
            onchange: (e) => { this.filters.type = e.target.value; this.refresh(); },
        }, ['', 'fact', 'event', 'goal', 'promise', 'preference', 'summary'].map((t) =>
            el('option', { value: t, text: t || 'all drawers' })));
        row.append(el('div', { class: 'mm-field' }, el('label', { text: 'Drawer' }), typeSel));
        host.append(row);

        // entity state cards
        host.append(el('h3', { class: 'mm-ledger-title mm-mt', text: 'Entity State Cards' }));
        this.stateGridEl = el('div', { class: 'mm-results' });
        host.append(this.stateGridEl);

        // fact drawers
        host.append(el('h3', { class: 'mm-ledger-title mm-mt', text: 'Fact Drawers' }));
        this.gridEl = el('div', { class: 'mm-results' });
        host.append(this.gridEl);

        this._unsub.push(this.ctx.bus.on('memory', () => this.refresh()));
        this.refresh();
    }

    async refresh() {
        if (!this.host) return;
        const scope = this.ctx.getScope();
        if (!scope.chatId) {
            this.gridEl?.replaceChildren(emptyState());
            return;
        }
        await this._refreshStates(scope);
        await this._refreshFacts(scope);
    }

    async _refreshStates(scope) {
        const states = await this.ctx.states.allEntityStates(scope.chatId).catch(() => []);
        if (!states.length) {
            this.stateGridEl.replaceChildren(emptyState('NO STATE CARDS FILED YET.'));
            return;
        }
        this.stateGridEl.replaceChildren(...states.map((st, i) => {
            const lines = [];
            const add = (label, val) => {
                if (val == null || val === '' || (Array.isArray(val) && !val.length)) return;
                lines.push(`${label}: ${Array.isArray(val) ? val.join(', ') : val}`);
            };
            add('outfit', st.outfit_json);
            add('injuries', st.injuries_json);
            add('mood', st.mood);
            add('status', st.status_flags_json);
            add('at', st.location);
            add('hazards', st.hazards_json);
            add('occupants', st.occupants_json);
            add('holder', st.holder);
            add('condition', st.condition);
            add('stance', st.stance);
            if (st.hostility != null) add('hostility', st.hostility.toFixed(2));
            const c = cardFactory({
                id: st.id,
                title: `${st.entity_name}`,
                text: truncateWords(lines.join(' · '), 260) || 'no state recorded',
                meta: [st.entity_type, formatDate(st.updated_at), `conf ${Number(st.confidence ?? 0.9).toFixed(2)}`],
                importance: 0.6,
                stamps: [{ text: st.entity_type.toUpperCase(), variant: st.entity_type === 'faction' ? 'red' : 'blue', small: true }],
            });
            c.classList.add('mm-card-enter');
            c.style.animationDelay = `${i * 40}ms`;
            return c;
        }));
    }

    async _refreshFacts(scope) {
        const filter = { chat_id: scope.chatId, status_not: ['deleted'] };
        if (this.filters.type) filter.memory_type = this.filters.type;
        else filter.memory_types = ['fact', 'event', 'goal', 'promise', 'preference', 'summary'];
        let rows = await this.ctx.meta.queryMemories(filter).catch(() => []);
        rows.sort((a, b) => (b.importance - a.importance) || String(b.created_at).localeCompare(String(a.created_at)));
        if (this.filters.q) {
            const q = this.filters.q;
            rows = rows.filter((m) =>
                (m.text || '').toLowerCase().includes(q) ||
                (m.summary || '').toLowerCase().includes(q) ||
                (m.subject_name || '').toLowerCase().includes(q) ||
                (m.keywords_json || []).some((k) => k.includes(q)));
        }
        rows = rows.slice(0, 40);
        if (!rows.length) {
            this.gridEl.replaceChildren(emptyState());
            return;
        }
        this.gridEl.replaceChildren(...rows.map((m, i) => {
            const c = memoryCard(m, {
                onTrace: (rec) => this.ctx.showTrace(rec.id),
                onVerify: async (rec) => {
                    await this.ctx.meta.updateMemory(rec.id, { verification_status: 'user_confirmed' });
                    this.ctx.desk.toast('Stamped VERIFIED by the archivist.', 'ok');
                    this.refresh();
                },
                onForget: async (rec) => {
                    await this.ctx.forgetMemory(rec.id);
                    c.classList.add('mm-burn-out');
                    setTimeout(() => c.remove(), 400);
                },
            });
            c.classList.add('mm-card-enter');
            c.style.animationDelay = `${Math.min(i, 10) * 40}ms`;
            return c;
        }));
    }

    destroy() {
        this._unsub.forEach((u) => u?.());
        this._unsub = [];
    }
}
