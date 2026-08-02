/**
 * UI/design-system tests — run with: node --test tests/ui.test.js
 * Verifies: design tokens present, forbidden patterns absent, motion gated
 * behind prefers-reduced-motion, stamp/tilt/tokenbar rules, ARIA/tab
 * keyboard support markers in the UI layer, escapeHtml integrity.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { escapeHtml } from '../src/utils/helpers.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const css = readFileSync(join(ROOT, 'style.css'), 'utf8');
const uiFiles = readdirSync(join(ROOT, 'src/ui')).filter((f) => f.endsWith('.js'));
const uiSource = uiFiles.map((f) => readFileSync(join(ROOT, 'src/ui', f), 'utf8')).join('\n');
const indexSource = readFileSync(join(ROOT, 'index.js'), 'utf8');

// ---------------------------------------------------------------------------
// design tokens
// ---------------------------------------------------------------------------

test('all design tokens defined exactly as specified', () => {
    const compact = css.replace(/\s+/g, '');
    const tokens = [
        '--mm-desk-900:#14110c', '--mm-desk-800:#1c1812', '--mm-desk-700:#262019',
        '--mm-desk-line:#3a3125', '--mm-paper:#f2e8d3', '--mm-paper-2:#e9dcc0',
        '--mm-paper-edge:#cbb98f', '--mm-ink:#2b241a', '--mm-ink-soft:#5c5140',
        '--mm-stamp-red:#c23b2a', '--mm-amber:#d99a2b', '--mm-verdigris:#4a9c82',
        '--mm-blue-ink:#4a6fa5', '--mm-faded:rgba(43,36,26,.45)',
    ];
    for (const t of tokens) assert.ok(compact.includes(t), `missing token ${t}`);
});

test('fonts: Fraunces display, Spline Sans body, IBM Plex Mono, Special Elite stamps', () => {
    assert.match(css, /Fraunces/);
    assert.match(css, /Spline\+Sans|Spline Sans/);
    assert.match(css, /IBM\+Plex\+Mono|IBM Plex Mono/);
    assert.match(css, /Special\+Elite|Special Elite/);
    assert.match(css, /display=swap/);
});

// ---------------------------------------------------------------------------
// forbidden patterns
// ---------------------------------------------------------------------------

test('forbidden aesthetics are absent', () => {
    assert.ok(!/backdrop-filter/.test(css), 'no glassmorphism blur');
    assert.ok(!/-webkit-background-clip:\s*text|background-clip:\s*text/.test(css), 'no gradient-filled text');
    assert.ok(!/Inter|Geist|Roboto|Arial/.test(css.replace(/feTurbulence|font-stretch|Inline/g, '')), 'no forbidden primary fonts');
    assert.ok(!/rounded-2xl/.test(css), 'no uniform rounded-2xl');
    assert.ok(!/indigo|violet|fuchsia|pink-500|#8b5cf6|#a855f7/i.test(css), 'no indigo/violet/pink');
});

// ---------------------------------------------------------------------------
// background layers
// ---------------------------------------------------------------------------

test('layered ambient background: desk + ledger ruling + lamp glow + grain + watermark', () => {
    assert.match(css, /repeating-linear-gradient\(0deg, rgba\(255, 255, 255, \.03\)/, 'ledger ruling');
    assert.match(css, /radial-gradient\(ellipse 90% 55% at 12% 0%, rgba\(217, 154, 43, \.06\)/, 'lamp glow');
    assert.match(css, /feTurbulence/, 'grain noise');
    assert.match(css, /\.mm-watermark/, 'ghost watermark');
    assert.match(css, /№/, 'the № glyph appears');
});

// ---------------------------------------------------------------------------
// components
// ---------------------------------------------------------------------------

test('card: red 3px top rule, tilt var, hover lift spec', () => {
    assert.match(css, /border-top: 3px solid var\(--mm-stamp-red\)/);
    assert.match(css, /--mm-tilt/);
    assert.match(css, /translateY\(-6px\) rotate\(0deg\) scale\(1\.01\)/);
    assert.match(css, /cubic-bezier\(\.2,\s*\.8,\s*\.2,\s*1\)/);
});

test('stamp: Special Elite, 2px border, -8deg, noise mask, multiply blend', () => {
    assert.match(css, /font-family: var\(--mm-font-stamp\)/);
    assert.match(css, /border: 2px solid currentColor/);
    assert.match(css, /rotate\(-8deg\)/);
    assert.match(css, /mask-image/);
    assert.match(css, /mix-blend-mode: multiply/);
});

test('all state stamps exist in UI logic', () => {
    for (const s of ['SUPERSEDED', 'CONTRADICTED', 'VERIFIED', 'SECRET', 'STORAGE OFFLINE', 'MODEL MISMATCH', 'ACTIVE', 'PINNED']) {
        assert.ok(uiSource.includes(`'${s}'`) || uiSource.includes(`"${s}"`), `missing stamp ${s}`);
    }
});

test('tokenbar: four tiers with exact tier names + tooltip data-tip', () => {
    for (const tier of ["data-tier='stm'", "data-tier='ltm'", "data-tier='states'", "data-tier='world'"]) {
        assert.ok(css.includes(tier), `missing tier ${tier}`);
    }
    assert.match(css, /attr\(data-tip\)/, 'mono tooltip via data-tip');
    assert.match(css, /transition: width 300ms ease-out/, 'width animation');
});

// ---------------------------------------------------------------------------
// motion gating
// ---------------------------------------------------------------------------

test('all keyframes live inside prefers-reduced-motion: no-preference', () => {
    const blocks = css.split('@media (prefers-reduced-motion: no-preference)');
    assert.ok(blocks.length >= 2, 'no-preference block exists');
    const keyframes = [...css.matchAll(/@keyframes\s+([\w-]+)/g)].map((m) => m[1]);
    assert.ok(keyframes.length >= 8, 'rich motion set');
    for (const name of ['mm-slam', 'mm-burn', 'mm-card-enter', 'mm-ticker-scroll', 'mm-string-draw', 'mm-rec', 'mm-toast-in']) {
        assert.ok(keyframes.includes(name), `missing keyframes ${name}`);
    }
    assert.match(css, /@media \(prefers-reduced-motion: reduce\)/, 'reduce block exists');
});

// ---------------------------------------------------------------------------
// accessibility + interaction markers in JS
// ---------------------------------------------------------------------------

test('tabs are a keyboard-navigable tablist with arrow keys', () => {
    assert.ok(uiSource.includes("role: 'tablist'"), 'tablist role');
    assert.ok(uiSource.includes("'aria-selected'"), 'aria-selected');
    assert.ok(uiSource.includes('ArrowDown') && uiSource.includes('ArrowUp'), 'arrow-key navigation');
    assert.ok(uiSource.includes("role: 'tab'"), 'tab role');
    assert.ok(uiSource.includes('aria-label'), 'aria labels used');
});

test('msgdots are additive-only siblings, never touching ST message DOM', () => {
    const allSource = `${indexSource}\n${uiSource}`;
    assert.ok(allSource.includes('insertAdjacentElement'), 'sibling insertion');
    assert.ok(allSource.includes("'afterend'"), 'inserted AFTER the node');
    assert.ok(allSource.includes('MutationObserver'), 're-attach via observer');
    assert.ok(allSource.includes('detachMsgDots'), 'teardown path exists');
    assert.ok(!/classList\.(add|remove)\([^)]*\.mes/.test(allSource), 'ST message classes never modified');
});

test('escapeHtml escapes all five dangerous characters', () => {
    const out = escapeHtml(`<script>"x"&'y'</script>`);
    assert.ok(!out.includes('<'), 'no raw lt');
    assert.ok(!out.includes('>'), 'no raw gt');
    assert.ok(!out.includes('"'), 'no raw quote');
    assert.ok(out.includes('&#39;'), 'single quote escaped');
    assert.ok(out.includes('&' + 'amp;'), 'ampersand escaped');
});
