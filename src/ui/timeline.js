/**
 * EVENTS — "The Timeline Rail": horizontal rail; window-extracted event
 * cards hang by clothespins; mono time ruler; left edge tinted by valence
 * (verdigris → amber → stamp-red); cause→result shown as linked stubs.
 */

import { el, emptyState, stamp } from './components.js';
import { truncateWords, formatDate, seededJitter } from '../utils/helpers.js';

export class TimelineRoom {
    constructor(ctx) {
        this.ctx = ctx;
        this.host = null;
        this.railEl = null;
        this.rulerEl = null;
        this.byId = new Map();
        this._unsub = [];
    }

    render(host) {
        this.host = host;
        host.replaceChildren(
            el('h2', { class: 'mm-room-title', text: 'The Timeline Rail' }),
            el('div', { class: 'mm-room-sub', text: 'EVENTS · CLIPPED IN ORDER' }),
        );
        const wrap = el('div', { class: 'mm-timeline-wrap' },
            el('div', { class: 'mm-timeline-rail' }),
            this.railEl = el('div', { class: 'mm-timeline-cards' }),
        );
        host.append(wrap);
        this.rulerEl = el('div', { class: 'mm-timeline-ruler' });
        host.append(this.rulerEl);
        this._unsub.push(this.ctx.bus.on('memory', () => this.refresh()));
        this.refresh();
    }

    async refresh() {
        if (!this.host) return;
        const scope = this.ctx.getScope();
        if (!scope.chatId) {
            this.railEl?.replaceChildren(emptyState());
            return;
        }
        const events = await this.ctx.meta.queryMemories({
            chat_id: scope.chatId, memory_type: 'event', status_not: ['deleted'],
        }).catch(() => []);
        events.sort((a, b) => String(a.event_time || a.created_at).localeCompare(String(b.event_time || b.created_at)));
        this.byId = new Map(events.map((e) => [e.id, e]));

        if (!events.length) {
            this.railEl.replaceChildren(emptyState('NO EVENTS CLIPPED TO THE RAIL YET.'));
            this.rulerEl.replaceChildren();
            return;
        }

        const shown = events.slice(-30);
        this.railEl.replaceChildren(...shown.map((ev, i) => this._eventCard(ev, i)));

        const first = shown[0];
        const last = shown[shown.length - 1];
        this.rulerEl.replaceChildren(
            el('span', { text: formatDate(first.event_time || first.created_at) }),
            el('span', { text: `${shown.length} clippings` }),
            el('span', { text: formatDate(last.event_time || last.created_at) }),
        );
    }

    _eventCard(ev, i) {
        const v = Number(ev.emotional_valence ?? 0);
        const valence = v >= 0.25 ? 'var(--mm-verdigris)' : v <= -0.25 ? 'var(--mm-stamp-red)' : 'var(--mm-amber)';
        const holder = el('div', { class: 'mm-eventcard' },
            el('span', { class: 'mm-pin', style: { '--mm-pin-tilt': `${seededJitter(ev.id, 4).toFixed(1)}deg` }, 'aria-hidden': 'true' }),
        );
        const card = el('article', {
            class: 'mm-card mm-card-enter',
            style: { '--mm-tilt': `${seededJitter(ev.id + 't', 1.2).toFixed(2)}deg`, '--mm-valence': valence, animationDelay: `${i * 40}ms` },
        },
            el('div', { class: 'mm-card-head' },
                el('span', { class: 'mm-seal' }),
                el('h3', { class: 'mm-card-title', text: ev.event_type || 'event' }),
            ),
            el('p', { class: 'mm-card-text', text: truncateWords(ev.text || '', 200) }),
            el('div', { class: 'mm-card-meta' },
                el('span', { text: formatDate(ev.event_time || ev.created_at) }),
                (ev.characters_json || []).length ? el('span', { text: ev.characters_json.join(', ') }) : null,
                el('span', { text: `imp ${Number(ev.importance ?? 0.5).toFixed(2)}` }),
            ),
        );
        // cause → result linked stubs
        const stubs = el('div', { class: 'mm-row', style: { gap: '6px', marginTop: '6px' } });
        if (ev.cause) {
            stubs.append(stub(`cause: ${truncateWords(ev.cause, 40)}`, () => this._jumpToText(ev.cause)));
        }
        if (ev.result) {
            stubs.append(stub(`result: ${truncateWords(ev.result, 40)}`, () => this._jumpToText(ev.result)));
        }
        if (stubs.childNodes.length) card.append(stubs);
        if (ev.validity_status === 'superseded') card.append(stamp('SUPERSEDED', 'amber', { small: true }));
        if (ev.validity_status === 'contradicted') card.append(stamp('CONTRADICTED', 'red', { small: true }));
        holder.append(card);

        function stub(label, onClick) {
            return el('button', { class: 'mm-linked-stub', text: label, onclick: onClick });
        }
        return holder;
    }

    _jumpToText(fragment) {
        // scroll to the first card whose text includes the fragment (cause/result link)
        const f = String(fragment || '').slice(0, 40).toLowerCase();
        if (!f) return;
        for (const [id, ev] of this.byId) {
            if ((ev.text || '').toLowerCase().includes(f)) {
                const idx = [...this.railEl.children].findIndex((c) =>
                    c.querySelector('.mm-card-text')?.textContent.toLowerCase().includes(f));
                const target = this.railEl.children[Math.max(0, idx)];
                target?.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' });
                target?.querySelector('.mm-card')?.classList.add('mm-just-recalled');
                setTimeout(() => target?.querySelector('.mm-card')?.classList.remove('mm-just-recalled'), 1000);
                return;
            }
        }
        this.ctx.desk.toast('Linked clipping is outside the visible rail.', 'warn');
    }

    destroy() {
        this._unsub.forEach((u) => u?.());
        this._unsub = [];
    }
}
