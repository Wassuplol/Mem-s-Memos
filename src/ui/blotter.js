/**
 * LIVE — "The Blotter": ticker of recent messages under ● REC; five paper
 * trays (ENTITIES/GOALS/ITEMS/MOOD/SCENE) with chips; live injection budget
 * tokenbar; FREEZE / SHRED / CONSOLIDATE NOW.
 */

import { el, btn, tokenbar, stamp, emptyState, ledgerRow } from './components.js';
import { estimateTokens, truncateWords } from '../utils/helpers.js';

export class BlotterRoom {
    /**
     * @param {object} ctx — bureau context (see index.js createBureau)
     */
    constructor(ctx) {
        this.ctx = ctx;
        this.host = null;
        this.tickerTrack = null;
        this.traysEl = null;
        this.tokenbarHost = null;
        this.stmCardsEl = null;
        this._unsub = [];
    }

    render(host) {
        this.host = host;
        host.replaceChildren(
            el('h2', { class: 'mm-room-title', text: 'The Blotter' }),
            el('div', { class: 'mm-room-sub', text: 'LIVE · SHORT-TERM DESK' }),
        );

        // ticker
        const ticker = el('div', { class: 'mm-ticker', role: 'marquee', 'aria-label': 'Recent messages' },
            this.tickerTrack = el('div', { class: 'mm-ticker-track' },
                el('span', { class: 'mm-ticker-item' }, el('b', { text: 'REC' }), 'awaiting first message…'),
            ),
        );
        host.append(ticker);

        // trays
        this.traysEl = el('div', { class: 'mm-trays' });
        host.append(this.traysEl);

        // tokenbar
        this.tokenbarHost = el('div');
        host.append(this.tokenbarHost);

        // actions
        host.append(el('div', { class: 'mm-row mm-mt' },
            btn('FREEZE', { iconCls: 'fa-thumbtack', onClick: () => this._freezeAll() }),
            btn('SHRED', { iconCls: 'fa-scissors', variant: 'danger', onClick: () => this._shredAll() }),
            btn('CONSOLIDATE NOW', { iconCls: 'fa-snowflake', onClick: (e) => this._consolidate(e.currentTarget) }),
        ));

        // STM cards
        this.stmCardsEl = el('div', { class: 'mm-results mm-mt' });
        host.append(this.stmCardsEl);

        this._unsub.push(this.ctx.stm.onChange(() => this.refresh()));
        this._unsub.push(this.ctx.bus.on('memory', () => this.refresh()));
        this.refresh();
    }

    async refresh() {
        if (!this.host) return;
        const scope = this.ctx.getScope();
        if (!scope.chatId) {
            this.stmCardsEl?.replaceChildren(emptyState('NO ACTIVE CHAT — OPEN A CHAT TO START THE DESK.'));
            return;
        }
        await this._refreshTicker(scope);
        await this._refreshTrays(scope);
        await this._refreshTokenbar(scope);
        await this._refreshCards(scope);
    }

    async _refreshTicker(scope) {
        const msgs = this.ctx.host.getRecentMessages?.(8) || [];
        const items = msgs.length ? msgs : [{ name: 'REC', text: 'the desk is listening…' }];
        const nodes = [];
        for (const m of items) {
            nodes.push(el('span', { class: 'mm-ticker-item' },
                el('b', { text: m.name || '—' }),
                truncateWords(m.text || '', 90),
            ));
        }
        // duplicate track for a seamless marquee loop
        this.tickerTrack.replaceChildren(...nodes, ...nodes.map((n) => n.cloneNode(true)));
    }

    async _refreshTrays(scope) {
        const trays = await this.ctx.stm.trays(scope.chatId);
        const world = await this.ctx.states.allWorld(scope.chatId).catch(() => []);
        const scene = world.find((w) => w.key === 'scene' && w.status === 'active')?.value_text
            || world.find((w) => w.key === 'mood' && w.status === 'active')?.value_text || '';
        const defs = [
            ['ENTITIES', trays.entity, 'fa-diagram-project'],
            ['GOALS', trays.goal, 'fa-thumbtack'],
            ['ITEMS', trays.item, 'fa-folder-open'],
            ['MOOD', trays.emotion, 'fa-fire'],
            ['SCENE', scene ? [{ content: scene }] : trays.location, 'fa-timeline'],
        ];
        this.traysEl.replaceChildren(...defs.map(([title, chips, iconCls]) =>
            el('div', { class: 'mm-tray' },
                el('h4', { class: 'mm-tray-title' }, el('i', { class: `fa-solid ${iconCls}` }), title),
                el('div', { class: 'mm-chips' },
                    chips.length
                        ? chips.slice(0, 10).map((c, i) => this._chip(c, i))
                        : [el('span', { class: 'mm-dim', text: '—', style: { fontSize: '10px' } })]),
            ),
        ));
    }

    _chip(c, i) {
        const chip = el('span', {
            class: 'mm-chip',
            style: { '--mm-tilt': `${((i % 3) - 1) * 1.2}deg` },
            text: truncateWords(c.content, 40),
        });
        if (c.stm_id) {
            chip.append(el('button', {
                text: '✕', 'aria-label': `Shred ${truncateWords(c.content, 20)}`,
                onclick: () => this.ctx.stm.shred(c.stm_id),
            }));
        }
        return chip;
    }

    async _refreshTokenbar(scope) {
        const budget = this.ctx.getSettings().pipeline.injectionBudget;
        const stmTokens = await this.ctx.stm.tokenUsage(scope.chatId).catch(() => 0);
        const last = this.ctx.injection.getLastBlock();
        const worldLine = await this.ctx.states.worldLine(scope.chatId).catch(() => '');
        const stateLines = await this.ctx.states.snapshotLines(scope.chatId, scope.characterName).catch(() => []);
        const ltm = last?.memoryCount ? Math.round(last.tokens * 0.6) : 0;
        this.tokenbarHost.replaceChildren(tokenbar({
            stm: stmTokens,
            ltm,
            states: estimateTokens(stateLines.join('\n')),
            world: estimateTokens(worldLine),
            budget,
        }));
    }

    async _refreshCards(scope) {
        const rows = (await this.ctx.stm.live(scope.chatId)).slice(0, 8);
        if (!rows.length) {
            this.stmCardsEl.replaceChildren(emptyState());
            return;
        }
        this.stmCardsEl.replaceChildren(...rows.map((r, i) => {
            const cardEl = el('article', { class: 'mm-card mm-card-enter', style: { '--mm-tilt': `${((i % 3) - 1) * 1.1}deg`, animationDelay: `${i * 40}ms` } },
                el('div', { class: 'mm-card-head' },
                    el('span', { class: 'mm-seal' }),
                    el('h3', { class: 'mm-card-title', text: r._speaker || r.key || r.buffer_type }),
                ),
                el('p', { class: 'mm-card-text', text: truncateWords(r.content, 220) }),
                el('div', { class: 'mm-card-meta' },
                    el('span', { text: r.buffer_type }),
                    el('span', { text: `${r.tokens || estimateTokens(r.content)} tok` }),
                    el('span', { text: `retention ${(r._retention ?? 1).toFixed(2)}` }),
                ),
                el('div', { class: 'mm-card-actions' },
                    btn('Freeze', { small: true, variant: 'paper', onClick: () => this.ctx.stm.freeze(r.stm_id) }),
                    btn('Shred', { small: true, variant: 'paper', onClick: (e) => this._shredCard(e.currentTarget, r.stm_id) }),
                ),
            );
            if (r.priority >= 1) cardEl.append(stamp('PINNED', 'amber', { small: true }));
            return cardEl;
        }));
    }

    _shredCard(btnEl, stmId) {
        const cardEl = btnEl.closest('.mm-card');
        if (cardEl) {
            cardEl.classList.add('mm-shred-anim', 'mm-shredding');
            setTimeout(() => this.ctx.stm.shred(stmId), 480);
        } else {
            this.ctx.stm.shred(stmId);
        }
    }

    async _freezeAll() {
        const scope = this.ctx.getScope();
        const rows = await this.ctx.stm.live(scope.chatId);
        for (const r of rows.slice(0, 10)) await this.ctx.stm.freeze(r.stm_id);
        this.ctx.desk.toast(`Froze ${Math.min(rows.length, 10)} STM entries — decay halted.`, 'ok');
        this.refresh();
    }

    async _shredAll() {
        const scope = this.ctx.getScope();
        const cards = this.stmCardsEl.querySelectorAll('.mm-card');
        cards.forEach((c) => c.classList.add('mm-shred-anim', 'mm-shredding'));
        setTimeout(async () => {
            await this.ctx.stm.meta.clearStm(scope.chatId);
            this.ctx.desk.toast('Blotter shredded. The desk is clean.', 'warn');
            this.refresh();
        }, 500);
    }

    async _consolidate(btnEl) {
        btnEl.classList.add('mm-press');
        this.ctx.desk.toast('Sleep cycle running…', '');
        const report = await this.ctx.consolidation.sleep(this.ctx.getScope().chatId);
        btnEl.classList.remove('mm-press');
        this.ctx.desk.toast(
            `Sleep complete: ${report.merged} merged · ${report.superseded} contradicted · ${report.archived} archived · ${report.forgotten} forgotten.`,
            'ok', 6000,
        );
        this.refresh();
    }

    destroy() {
        this._unsub.forEach((u) => u?.());
        this._unsub = [];
    }
}
