/**
 * The Desk — root shell: letterhead, tab rail, stage, live ledger, toastdock.
 * Hosts the seven rooms and routes refresh() calls. Keyboard-navigable tabs
 * (role=tablist, arrow keys). Additive msgdots are managed from here.
 */

import { el, icon, ledgerRow, toast, stamp, btn } from './components.js';
import { logger } from '../utils/logger.js';

const TABS = [
    { id: 'blotter', label: 'LIVE', icon: 'fa-fire', roomTitle: 'The Blotter' },
    { id: 'reading', label: 'RECALL', icon: 'fa-magnifying-glass', roomTitle: 'The Reading Room' },
    { id: 'catalog', label: 'FACTS', icon: 'fa-folder-open', roomTitle: 'The Card Catalog' },
    { id: 'timeline', label: 'EVENTS', icon: 'fa-timeline', roomTitle: 'The Timeline Rail' },
    { id: 'strings', label: 'GRAPH', icon: 'fa-diagram-project', roomTitle: 'The String Board' },
    { id: 'dossier', label: 'KNOWS', icon: 'fa-snowflake', roomTitle: 'The Dossier' },
    { id: 'settings', label: 'LEDGER', icon: 'fa-gear', roomTitle: 'The Ledger' },
];

export class Desk {
    /**
     * @param {object} deps
     * @param {()=>object} deps.getSettings
     * @param {()=>object} deps.getScope — {chatId, chatName, characterName, date}
     * @param {(key:string,payload?:any)=>void} deps.onModeChange
     */
    constructor({ getSettings, getScope, onModeChange }) {
        this.getSettings = getSettings;
        this.getScope = getScope;
        this.onModeChange = onModeChange || (() => {});
        this.rooms = new Map();   // tab id -> room module {render(), refresh()}
        this.activeTab = 'blotter';
        this.root = null;
        this.ledgerEl = null;
        this.toastdock = null;
        this.statusStamp = null;
        this.fileMeta = null;
        this._msgObserver = null;
        this._dotHosts = new WeakSet();
    }

    registerRoom(tabId, room) {
        this.rooms.set(tabId, room);
    }

    mount(hostEl) {
        const s = this.getSettings();
        this.root = el('div', { class: 'mm-root', role: 'complementary', 'aria-label': "Mem's Memos memory bureau" },
            el('div', { class: 'mm-watermark', text: '№', 'aria-hidden': 'true' }),
            this._letterhead(s),
            this._body(s),
            this.toastdock = el('div', { class: 'mm-toastdock' }),
        );
        if (s.ui.ledgerCollapsed) this.root.classList.add('mm-ledger-collapsed');
        hostEl.append(this.root);
        this._activate(this.activeTab, { focus: false });
        this.refreshLetterhead();
        return this.root;
    }

    _letterhead(s) {
        this.statusStamp = el('span', { class: 'mm-stamp mm-static mm-sm mm-verdigris', text: s.mode.toUpperCase() });
        this.fileMeta = el('span', { class: 'mm-letterhead-meta' });
        return el('header', { class: 'mm-letterhead' },
            el('div', { class: 'mm-letterhead-top' },
                el('h1', { class: 'mm-letterhead-title', text: "MEM'S MEMOS" }),
                el('span', { class: 'mm-letterhead-bureau', text: 'Memory Bureau' }),
                el('span', { class: 'mm-rec', text: 'REC' }),
                this.statusStamp,
                el('div', { class: 'mm-letterhead-actions' },
                    el('button', {
                        class: 'mm-iconbtn', 'aria-label': 'Toggle side ledger',
                        onclick: () => this._toggleLedger(),
                    }, icon('fa-folder-open')),
                    el('button', {
                        class: 'mm-iconbtn', 'aria-label': 'Collapse desk',
                        onclick: () => this.onModeChange('collapse'),
                    }, icon('fa-scissors')),
                ),
            ),
            this.fileMeta,
        );
    }

    refreshLetterhead() {
        const scope = this.getScope();
        const s = this.getSettings();
        this.fileMeta.replaceChildren(
            metaItem('File №', scope.chatName || scope.chatId || '—'),
            metaItem('Date', scope.date || new Date().toLocaleDateString()),
            metaItem('Desk of', scope.characterName || '—'),
        );
        this.statusStamp.textContent = s.mode.toUpperCase();
        this.statusStamp.className = `mm-stamp mm-static mm-sm ${s.mode === 'on' ? 'mm-verdigris' : s.mode === 'shadow' ? 'mm-amber' : 'mm-red'}`;
        function metaItem(k, v) {
            return el('span', {}, `${k} `, el('b', { text: v }));
        }
    }

    _body(s) {
        const rail = el('nav', { class: 'mm-rail', role: 'tablist', 'aria-label': 'Bureau rooms' });
        for (const t of TABS) {
            const tab = el('button', {
                class: 'mm-tab',
                role: 'tab',
                id: `mm-tab-${t.id}`,
                'aria-controls': `mm-room-${t.id}`,
                'aria-selected': t.id === this.activeTab ? 'true' : 'false',
                tabindex: t.id === this.activeTab ? '0' : '-1',
                dataset: { tab: t.id },
                onclick: () => this._activate(t.id),
                onkeydown: (e) => this._tabKeys(e, t.id),
            }, icon(t.icon), el('span', { class: 'mm-tab-label', text: t.label }));
            rail.append(tab);
        }
        const stage = el('main', { class: 'mm-stage' });
        for (const t of TABS) {
            const room = el('section', {
                class: 'mm-room', id: `mm-room-${t.id}`, role: 'tabpanel',
                'aria-labelledby': `mm-tab-${t.id}`, dataset: { room: t.id },
            });
            stage.append(room);
        }
        this.ledgerEl = el('aside', { class: 'mm-ledger', 'aria-label': 'Bureau ledger' });
        return el('div', { class: 'mm-body' }, rail, stage, this.ledgerEl);
    }

    _tabKeys(e, tabId) {
        const idx = TABS.findIndex((t) => t.id === tabId);
        let next = null;
        if (e.key === 'ArrowDown' || e.key === 'ArrowRight') next = TABS[(idx + 1) % TABS.length];
        if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') next = TABS[(idx - 1 + TABS.length) % TABS.length];
        if (e.key === 'Home') next = TABS[0];
        if (e.key === 'End') next = TABS[TABS.length - 1];
        if (next) {
            e.preventDefault();
            this._activate(next.id, { focus: true });
        }
    }

    _activate(tabId, { focus = false } = {}) {
        this.activeTab = tabId;
        for (const t of TABS) {
            const tab = this.root.querySelector(`#mm-tab-${t.id}`);
            const room = this.root.querySelector(`#mm-room-${t.id}`);
            const active = t.id === tabId;
            tab?.setAttribute('aria-selected', String(active));
            tab?.setAttribute('tabindex', active ? '0' : '-1');
            room?.classList.toggle('mm-active', active);
        }
        const room = this.rooms.get(tabId);
        const host = this.root.querySelector(`#mm-room-${tabId}`);
        if (room && host && !host.dataset.mounted) {
            host.dataset.mounted = '1';
            room.render(host);
        }
        room?.refresh?.();
        if (focus) this.root.querySelector(`#mm-tab-${tabId}`)?.focus();
    }

    roomEl(tabId) {
        return this.root?.querySelector(`#mm-room-${tabId}`);
    }

    /** Right-column ledger: pipeline status rows + stamps. */
    refreshLedger(rows = []) {
        if (!this.ledgerEl) return;
        const s = this.getSettings();
        this.ledgerEl.replaceChildren(
            el('h3', { class: 'mm-ledger-title', text: 'Bureau Ledger' }),
            ...rows.map((r) => ledgerRow(r.key, r.value, r.state)),
        );
    }

    /** Sticky-note toast on this desk. */
    toast(message, kind = '', ms = 4200) {
        if (!this.toastdock) return () => {};
        return toast(this.toastdock, message, kind, ms);
    }

    setMode(mode) {
        this.getSettings().mode = mode;
        this.refreshLetterhead();
    }

    _toggleLedger() {
        const s = this.getSettings();
        s.ui.ledgerCollapsed = !s.ui.ledgerCollapsed;
        this.root.classList.toggle('mm-ledger-collapsed', s.ui.ledgerCollapsed);
        this.onModeChange('settings-changed');
    }

    /**
     * MSGDOTS — additive-only provenance dots appended as SIBLINGS after
     * native ST message nodes. Never modifies ST message DOM/classes/content.
     * Re-attached via MutationObserver; torn down on chat switch/unmount.
     * @param {object} opts — {container: Element, selector: string, dotsFor: (node)=>Array<'stm'|'ltm'|'recall'>}
     */
    attachMsgDots({ container, selector, dotsFor }) {
        this.detachMsgDots();
        if (!container) return;
        const apply = () => {
            const nodes = container.querySelectorAll(selector);
            for (const node of nodes) {
                if (this._dotHosts.has(node)) continue;
                this._dotHosts.add(node);
                const kinds = dotsFor(node) || [];
                if (!kinds.length) continue;
                // additive-only: a sibling span inserted AFTER the message node
                const holder = document.createElement('span');
                holder.className = 'mm-msgdot-holder';
                for (const kind of kinds) {
                    const d = document.createElement('span');
                    d.className = 'mm-msgdot';
                    d.dataset.kind = kind;
                    d.title = kind === 'stm' ? 'Held in short-term memory'
                        : kind === 'ltm' ? 'Pinned in long-term memory'
                            : 'Recalled out of context';
                    holder.append(d);
                }
                node.insertAdjacentElement('afterend', holder);
            }
        };
        apply();
        this._msgObserver = new MutationObserver(() => apply());
        this._msgObserver.observe(container, { childList: true, subtree: true });
    }

    detachMsgDots() {
        this._msgObserver?.disconnect();
        this._msgObserver = null;
        this._dotHosts = new WeakSet();
        document.querySelectorAll('.mm-msgdot-holder').forEach((n) => n.remove());
    }

    unmount() {
        this.detachMsgDots();
        this.root?.remove();
        this.root = null;
    }
}
