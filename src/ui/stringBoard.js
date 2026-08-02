/**
 * GRAPH — "The String Board": dark board, entity nodes as pinned cards,
 * red bezier strings; node hover brightens its strings, dims the rest.
 * Vanilla JS + SVG layout — no graph library.
 */

import { el, emptyState } from './components.js';
import { truncateWords, seededJitter } from '../utils/helpers.js';

const SVG_NS = 'http://www.w3.org/2000/svg';

export class StringBoardRoom {
    constructor(ctx) {
        this.ctx = ctx;
        this.host = null;
        this.board = null;
        this.svg = null;
        this.nodes = new Map(); // entity -> {el, x, y}
        this.edges = [];        // {a, b, count, pathEl, samples}
        this._unsub = [];
    }

    render(host) {
        this.host = host;
        host.replaceChildren(
            el('h2', { class: 'mm-room-title', text: 'The String Board' }),
            el('div', { class: 'mm-room-sub', text: 'GRAPH · RED STRING SOLD SEPARATELY' }),
        );
        this.svg = document.createElementNS(SVG_NS, 'svg');
        this.svg.classList.add('mm-board-svg');
        this.board = el('div', { class: 'mm-board' }, this.svg);
        host.append(this.board);
        this._unsub.push(this.ctx.bus.on('memory', () => this.refresh()));
        this.refresh();
    }

    async refresh() {
        if (!this.host || !this.board) return;
        const scope = this.ctx.getScope();
        if (!scope.chatId) return;
        const memories = await this.ctx.meta.queryMemories({
            chat_id: scope.chatId, status_not: ['deleted'],
        }).catch(() => []);

        // entity co-occurrence graph
        const entityCount = new Map();
        const edgeCount = new Map();
        for (const m of memories) {
            const names = new Set([
                ...(m.characters_json || []),
                ...(m.locations_json || []),
                ...(m.items_json || []),
                m.subject_name,
            ].filter(Boolean));
            for (const n of names) entityCount.set(n, (entityCount.get(n) || 0) + 1);
            const arr = [...names];
            for (let i = 0; i < arr.length; i++) {
                for (let j = i + 1; j < arr.length; j++) {
                    const key = [arr[i], arr[j]].sort().join('|');
                    edgeCount.set(key, (edgeCount.get(key) || 0) + 1);
                }
            }
        }
        const top = [...entityCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 14);
        if (!top.length) {
            this.board.replaceChildren(emptyState('NO STRINGS PINNED YET.'));
            this.board.append(this.svg);
            this.svg.replaceChildren();
            this.nodes.clear();
            return;
        }

        // layout: radial with deterministic jitter, sized to the board
        const W = Math.max(this.board.clientWidth, 560);
        const H = Math.max(this.board.clientHeight, 420);
        const cx = W / 2;
        const cy = H / 2;
        const radius = Math.min(W, H) / 2 - 90;
        this.nodes.clear();
        top.forEach(([name, count], i) => {
            const angle = (i / top.length) * Math.PI * 2 - Math.PI / 2;
            const jx = seededJitter(name + 'x', 24);
            const jy = seededJitter(name + 'y', 24);
            const x = cx + Math.cos(angle) * radius + jx;
            const y = cy + Math.sin(angle) * radius + jy;
            const node = el('div', {
                class: 'mm-board-node',
                style: { left: `${Math.round(x)}px`, top: `${Math.round(y)}px` },
                dataset: { entity: name },
            },
                el('article', { class: 'mm-card', style: { '--mm-tilt': `${seededJitter(name, 1.5).toFixed(2)}deg` } },
                    el('h3', { class: 'mm-card-title', text: truncateWords(name, 26) }),
                    el('div', { class: 'mm-card-meta' }, el('span', { text: `${count} memos` })),
                ),
            );
            node.addEventListener('mouseenter', () => this._focus(name));
            node.addEventListener('mouseleave', () => this._unfocus());
            this.nodes.set(name, { el: node, x: x + 75, y: y + 30, count });
        });

        // rebuild board
        const oldNodes = this.board.querySelectorAll('.mm-board-node');
        oldNodes.forEach((n) => n.remove());
        this.board.querySelector('.mm-empty')?.remove();
        for (const { el: nodeEl } of this.nodes.values()) this.board.append(nodeEl);

        // strings
        this.svg.replaceChildren();
        this.svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
        this.edges = [];
        for (const [key, count] of edgeCount) {
            const [a, b] = key.split('|');
            const na = this.nodes.get(a);
            const nb = this.nodes.get(b);
            if (!na || !nb) continue;
            const path = document.createElementNS(SVG_NS, 'path');
            const mx = (na.x + nb.x) / 2;
            const sag = Math.min(60, Math.hypot(nb.x - na.x, nb.y - na.y) / 4) + 18;
            const my = (na.y + nb.y) / 2 + sag;
            path.setAttribute('d', `M ${na.x} ${na.y} Q ${mx} ${my} ${nb.x} ${nb.y}`);
            path.setAttribute('class', 'mm-string-path mm-draw');
            path.dataset.a = a;
            path.dataset.b = b;
            this.svg.append(path);
            this.edges.push({ a, b, count, pathEl: path });
        }
    }

    _focus(name) {
        this.board.classList.add('mm-focus');
        for (const e of this.edges) {
            const active = e.a === name || e.b === name;
            e.pathEl.classList.toggle('mm-active', active);
        }
    }

    _unfocus() {
        this.board.classList.remove('mm-focus');
        for (const e of this.edges) e.pathEl.classList.remove('mm-active');
    }

    destroy() {
        this._unsub.forEach((u) => u?.());
        this._unsub = [];
    }
}
