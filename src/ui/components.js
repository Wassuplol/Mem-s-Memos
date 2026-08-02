/**
 * Mem's Memos — DOM factories shared by all seven rooms.
 * Everything is built with createElement + escapeHtml; no innerHTML with
 * unescaped data, ever. Card tilt is deterministic per id.
 */

import { escapeHtml, seededJitter, clamp, formatDate } from '../utils/helpers.js';

export { escapeHtml };

/** element helper: el('div', {class:'x', onclick:fn}, children...) */
export function el(tag, attrs = {}, ...children) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
        if (v == null) continue;
        if (k === 'class') node.className = v;
        else if (k === 'text') node.textContent = v;
        else if (k === 'html') node.innerHTML = v; // caller must pre-escape
        else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
        else if (k === 'style' && typeof v === 'object') Object.assign(node.style, v);
        else if (k === 'dataset') Object.assign(node.dataset, v);
        else node.setAttribute(k, v);
    }
    for (const c of children.flat(9)) {
        if (c == null) continue;
        node.append(c.nodeType ? c : document.createTextNode(String(c)));
    }
    return node;
}

/** Font Awesome icon (bundled by ST). */
export function icon(cls) {
    return el('i', { class: `fa-solid ${cls}`, 'aria-hidden': 'true' });
}

/** Paper index card. importance>=.8 → double rule + larger seal. */
export function card({
    id = '', title = '', text = '', meta = [], importance = 0.5,
    stamps = [], actions = [], secret = false, superseded = false,
    pinned = false, fade = null, justRecalled = false, extraClass = '',
} = {}) {
    const tilt = seededJitter(id || title, 1.5).toFixed(2);
    const sealSize = Math.round(clamp(importance, 0, 1) * 14 + 8);
    const node = el('article', {
        class: `mm-card ${extraClass}`.trim(),
        style: { '--mm-tilt': `${tilt}deg`, '--mm-seal-size': `${sealSize}px` },
        dataset: id ? { memoryId: id } : {},
    });
    if (importance >= 0.8) node.classList.add('mm-important');
    if (superseded) node.classList.add('mm-superseded');
    if (secret) node.classList.add('mm-secret');
    if (pinned) node.classList.add('mm-pinned');
    if (fade != null && fade < 0.4) {
        node.classList.add('mm-fade');
        node.style.setProperty('--mm-fade-level', String(clamp(fade, 0.15, 0.7)));
    }
    if (justRecalled) node.classList.add('mm-just-recalled');

    const head = el('div', { class: 'mm-card-head' },
        el('span', { class: 'mm-seal', 'aria-hidden': 'true' }),
        el('h3', { class: 'mm-card-title', text: title || 'Untitled memo' }),
    );
    node.append(head);
    if (text) node.append(el('p', { class: 'mm-card-text', text }));
    if (meta.length) {
        node.append(el('div', { class: 'mm-card-meta' },
            meta.map((m) => el('span', { text: m }))));
    }
    for (const s of stamps) node.append(stamp(s.text, s.variant, { small: s.small }));
    if (actions.length) {
        node.append(el('div', { class: 'mm-card-actions' }, actions));
    }
    return node;
}

/** Rubber stamp. variant: 'red' | 'verdigris' | 'amber' | 'blue'. */
export function stamp(text, variant = 'red', { small = false, staticPos = true, slam = false } = {}) {
    const node = el('span', {
        class: `mm-stamp mm-${variant}${small ? ' mm-sm' : ''}${staticPos ? ' mm-static' : ''}${slam ? ' mm-slam-in' : ''}`,
        text,
    });
    return node;
}

/** Slam a stamp onto a card with desk shake (state changes). */
export function slamStamp(cardNode, text, variant = 'red') {
    const s = stamp(text, variant, { slam: true });
    s.style.position = 'absolute';
    s.style.top = '8px';
    s.style.right = '10px';
    cardNode.append(s);
    cardNode.classList.remove('mm-shake');
    void cardNode.offsetWidth; // restart animation
    cardNode.classList.add('mm-shake');
    return s;
}

/** Ledger row with dotted leader. state: 'ok'|'bad'|'warn'|'' */
export function ledgerRow(key, value, state = '') {
    return el('div', { class: `mm-ledger-row${state ? ` mm-${state}` : ''}` },
        el('span', { class: 'mm-ledger-key', text: key }),
        el('span', { class: 'mm-ledger-leader' }),
        el('span', { class: 'mm-ledger-val', text: value, title: value }),
    );
}

/** Sticky-note toast. Returns dismiss(); auto-dismisses after `ms`. */
export function toast(dock, message, kind = '', ms = 4200) {
    const note = el('div', { class: `mm-toast${kind ? ` mm-${kind}` : ''}`, role: 'status' },
        el('div', { class: 'mm-toast-msg', text: message }),
        el('button', {
            class: 'mm-toast-x', 'aria-label': 'Dismiss note', text: '✕',
            onclick: () => dismiss(),
        }),
    );
    dock.append(note);
    let gone = false;
    const timer = setTimeout(() => dismiss(), ms);
    function dismiss() {
        if (gone) return;
        gone = true;
        clearTimeout(timer);
        note.classList.add('mm-out');
        setTimeout(() => note.remove(), 280);
    }
    return dismiss;
}

/** Dark bureau button. variant: '' | 'paper' | 'danger'; press = stays pushed. */
export function btn(label, { onClick, variant = '', small = false, iconCls = null, ariaLabel, pressed = false, title } = {}) {
    const b = el('button', {
        class: `mm-btn${variant ? ` mm-${variant}` : ''}${small ? ' mm-sm' : ''}${pressed ? ' mm-press' : ''}`,
        'aria-label': ariaLabel || label,
        onclick: onClick,
        title: title || null,
    });
    if (iconCls) b.append(icon(iconCls));
    b.append(document.createTextNode(label));
    return b;
}

/** Toggle switch. */
export function toggle(label, checked, onChange, { ariaLabel } = {}) {
    const input = el('input', { type: 'checkbox', role: 'switch' });
    input.checked = !!checked;
    input.addEventListener('change', () => onChange(input.checked));
    return el('label', { class: 'mm-toggle', 'aria-label': ariaLabel || label },
        input,
        el('span', { class: 'mm-toggle-track' }),
        el('span', { class: 'mm-toggle-label', text: label }),
    );
}

/** Token budget stacked bar. tiers: {stm,ltm,states,world} token counts + budget. */
export function tokenbar({ stm = 0, ltm = 0, states = 0, world = 0, budget = 800 } = {}) {
    const total = stm + ltm + states + world;
    const pct = (n) => `${clamp((n / Math.max(1, budget)) * 100, 0, 100).toFixed(1)}%`;
    const seg = (tier, n) => el('div', {
        class: 'mm-tokenbar-seg',
        dataset: { tier, tip: `${tier.toUpperCase()} ${n} / ${budget} tokens` },
        style: { width: pct(n) },
    });
    const wrap = el('div', { class: 'mm-tokenbar-wrap' },
        el('div', { class: 'mm-tokenbar-label' },
            el('span', { text: 'Injection budget' }),
            el('span', { text: `${total} / ${budget} tok` }),
        ),
        el('div', { class: 'mm-tokenbar', role: 'img', 'aria-label': `Token usage ${total} of ${budget}` },
            seg('stm', stm), seg('ltm', ltm), seg('states', states), seg('world', world)),
        el('div', { class: 'mm-tokenbar-legend' },
            legendChip('var(--mm-amber)', 'STM'),
            legendChip('var(--mm-verdigris)', 'LTM'),
            legendChip('var(--mm-blue-ink)', 'States'),
            legendChip('var(--mm-stamp-red)', 'World'),
        ),
    );
    return wrap;
}
function legendChip(color, label) {
    return el('span', {}, el('i', { style: { background: color } }), label);
}

/** Empty state: faint desk + stamp. */
export function emptyState(text = 'NO MEMOS YET — THE DESK IS CLEAN.') {
    return el('div', { class: 'mm-empty' },
        stamp(text, 'red', { small: false, staticPos: true }),
    );
}

/** Score ink-stamp for result cards. */
export function scoreStamp(score) {
    return el('span', { class: 'mm-score-stamp', text: `№ score ${Number(score).toFixed(3)}` });
}

/** Memory → fully-stamped card (shared by Reading Room + Card Catalog). */
export function memoryCard(m, { onTrace, onForget, onVerify } = {}) {
    const stamps = [];
    if (m.validity_status === 'superseded') stamps.push({ text: 'SUPERSEDED', variant: 'amber', small: true });
    if (m.validity_status === 'contradicted') stamps.push({ text: 'CONTRADICTED', variant: 'red', small: true });
    if (m.verification_status === 'user_confirmed' || m.verification_status === 'model_verified') {
        stamps.push({ text: 'VERIFIED', variant: 'verdigris', small: true });
    }
    const isSecret = (m.secret_from_json || []).length > 0 || m.epistemic_scope === 'private';
    if (isSecret) stamps.push({ text: 'SECRET', variant: 'blue', small: true });
    if (m.status === 'failed_embed') stamps.push({ text: 'STORAGE OFFLINE', variant: 'red', small: true });
    if (m.status === 'failed_extract') stamps.push({ text: 'ACTIVE', variant: 'amber', small: true });

    const actions = [];
    if (onTrace) actions.push(btn('Trace', { small: true, variant: 'paper', onClick: () => onTrace(m) }));
    if (onVerify) actions.push(btn('Verify', { small: true, variant: 'paper', onClick: () => onVerify(m) }));
    if (onForget) actions.push(btn('Forget', { small: true, variant: 'paper', onClick: () => onForget(m) }));

    const node = card({
        id: m.id,
        title: m.summary || m.subject_name || m.memory_type,
        text: m.summary && m.text !== m.summary ? m.text : (m.text || ''),
        meta: [
            m.memory_type,
            m.event_time ? formatDate(m.event_time) : formatDate(m.created_at),
            `imp ${Number(m.importance ?? 0.5).toFixed(2)}`,
            `str ${Number(m.strength ?? 1).toFixed(2)}`,
            m.embedding_model ? `${m.embedding_model} · ${m.embedding_dim || '?'}d` : 'no vector',
        ].filter(Boolean),
        importance: m.importance ?? 0.5,
        stamps,
        actions,
        secret: isSecret,
        superseded: m.validity_status === 'superseded',
        fade: strengthFade(m),
    });
    return node;
}

/** Memory strength → fade level (< .4 fades). */
export function strengthFade(m, halfLifeHours = 168) {
    const age = (Date.now() - (Date.parse(m.created_at) || Date.now())) / 3_600_000;
    const retention = Math.exp(-age / Math.max(1, (m.half_life_hours || halfLifeHours) * (m.strength || 1)));
    return retention;
}
