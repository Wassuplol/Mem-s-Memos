# MEM'S MEMOS — "The Archivist's Desk" Design System

Paper index cards on a dark ink desk. Rubber stamps, red string, ticker tape,
brass details. This document is the contract between the design language and
`style.css` — every rule below is enforced there (and regression-tested in
`tests/ui.test.js`).

## Foundations

### Tokens (exact, scoped under `.mm-root`)

```
--mm-desk-900:#14110c  --mm-desk-800:#1c1812  --mm-desk-700:#262019
--mm-desk-line:#3a3125
--mm-paper:#f2e8d3     --mm-paper-2:#e9dcc0   --mm-paper-edge:#cbb98f
--mm-ink:#2b241a       --mm-ink-soft:#5c5140
--mm-stamp-red:#c23b2a --mm-amber:#d99a2b     --mm-verdigris:#4a9c82
--mm-blue-ink:#4a6fa5  --mm-faded:rgba(43,36,26,.45)
```

### Typography

| Role | Family | Usage |
|---|---|---|
| Display | **Fraunces** 600–900 (opsz) | letterhead, room titles, card titles |
| Body | **Spline Sans** 400/500/600 | card text, general UI |
| Mono | **IBM Plex Mono** 400/500 | metadata, ledgers, ticker, stamps-support |
| Stamps | **Special Elite** | rubber stamps ONLY |

One injected Google Fonts link (`preconnect` + `display=swap`) at the top of
`style.css`. Strong contrast: huge Fraunces 900 display vs tiny mono metadata.

### Background (5 layers on the panel container)

1. base `--mm-desk-900`
2. repeating-linear ledger ruling (~3% white)
3. radial warm lamp glow from top-left (amber ~6%)
4. inline SVG `feTurbulence` grain (~4%)
5. oversized ghost `№` watermark, rotated −12°, ~2% opacity

## Components

- **.mm-card** — paper index card; red 3px top rule; resting tilt via
  `--mm-tilt` (±1.5°, deterministic per id); layered shadow; hover
  `translateY(-6px) rotate(0) scale(1.01)` over 220ms `cubic-bezier(.2,.8,.2,1)`.
  `importance ≥ .8` → double red rule + larger wax seal.
- **.mm-seal** — amber wax blob; diameter maps importance → 8–22px.
- **.mm-stamp** — 2px `currentColor` border, Special Elite, `rotate(-8deg)`,
  noise `mask-image`, `mix-blend-mode: multiply` on paper. Variants:
  red / verdigris / amber / blue-ink. Slam: `mm-slam` 260ms + 2px desk shake.
- **.mm-tab** — vertical file-folder spine; active pulled out 6px, colored
  left edge per tab; `role=tablist` + arrow-key navigation.
- **.mm-ticker** — receipt-tape marquee; 40s linear loop; pauses on hover;
  breathing red `mm-rec` dot (1.6s).
- **.mm-string** — SVG red bezier with sag; draw-in via `stroke-dashoffset`
  600ms; hover brightens active path to 2.5px, dims others to 20%.
- **.mm-slot** — card-catalog search with brass pull; focus glint sweep.
- **.mm-ledger-row** — mono row with dotted leader; ok/warn/bad color states.
- **.mm-toast** — sticky note, `rotate(2deg)`, slide-in bottom-right, peel-out.
- **.mm-pin** — clothespin clipping event cards to the timeline rail.
- **.mm-toggle** — dark track, brass radial-gradient thumb, verdigris tint
  when checked.
- **.mm-btn** — dark bureau button, mono uppercase, brass hover border;
  `--paper` (on cards), `--danger`, `--press` (stays pushed).
- **.mm-fade** — opacity/grayscale mapped to memory strength (< .4).
- **.mm-tokenbar** — stacked flex segments (STM amber, LTM verdigris, states
  blue-ink, world stamp-red); widths animate 300ms; hover → mono tooltip with
  exact count/budget.
- **.mm-msgdot** — 6px provenance dot appended as an ADDITIVE-ONLY sibling
  after native ST message nodes (green STM / blue LTM / red recall).
  MutationObserver re-attaches; full teardown on chat switch.

## State → Visual

| State | Visual |
|---|---|
| superseded | SUPERSEDED stamp + grayscale(.6) opacity(.7) |
| contradicted | CONTRADICTED stamp + red string to conflicting card |
| verified | VERIFIED stamp (verdigris) |
| secret | SECRET stamp (blue-ink) + locked corner fold |
| pinned | brass pin, higher z |
| forgotten | `mm-burn` 380ms (fade + scale .96 + rotate 2°) then removed |
| just recalled | amber underline sweep across the card rule |
| model mismatch | red MODEL MISMATCH stamp + RE-EMBED / NEW COLLECTION |
| storage offline | red STORAGE OFFLINE stamp in the ledger |

## Motion

All animation lives inside `@media (prefers-reduced-motion: no-preference)`.
Card enter: rise 14px + settle into tilt, stagger 40ms, 320ms. Stamp slam:
260ms `cubic-bezier(.34,1.56,.64,1)` + desk shake. Tab switch: drawer slide
260ms. String draw: 600ms. Forget: 380ms. Toast: 300ms spring. Under
`reduce`, every animation/transition collapses to ~0ms and the ticker stops.

## Accessibility

`:focus-visible` — 2px solid `--mm-blue-ink`, offset 2px. Every interactive
element carries an `aria-label`. Tabs are a real `tablist` with roving
tabindex and arrow/Home/End keys. Ink-on-paper text contrast ≥ 7:1
(`--mm-ink` on `--mm-paper` ≈ 11.8:1).

## Forbidden (never)

glassmorphism · gradient-filled text · indigo/violet/pink gradients ·
Inter/Geist/Roboto/Arial as primary · uniform rounded-2xl · aurora blobs ·
pure-black + single neon · generic SaaS dashboard look.
