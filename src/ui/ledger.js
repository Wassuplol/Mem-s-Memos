/**
 * SETTINGS — "The Ledger": ledger-book form. Every endpoint row has TEST →
 * verdigris "OK · 84ms" or red "FAIL · timeout" stamp; embed TEST reports
 * model + returned dimensions and warns on dim mismatch; depth-slicing
 * config; ink-level sliders for scoring weights; lane configuration;
 * governance; export/import/wipe; re-embed controls; MODEL MISMATCH actions.
 */

import { el, btn, toggle, stamp, ledgerRow, emptyState } from './components.js';
import { DEFAULT_WEIGHTS } from '../config/settings.js';
import { logger } from '../utils/logger.js';

export class LedgerRoom {
    constructor(ctx) {
        this.ctx = ctx;
        this.host = null;
        this.sections = null;
    }

    render(host) {
        this.host = host;
        host.replaceChildren(
            el('h2', { class: 'mm-room-title', text: 'The Ledger' }),
            el('div', { class: 'mm-room-sub', text: 'SETTINGS · EVERY ENTRY IN TRIPLICATE' }),
        );
        this.sections = el('div');
        host.append(this.sections);
        this.refresh();
    }

    refresh() {
        if (!this.host) return;
        this.sections.replaceChildren(
            this._modeSection(),
            this._lanesSection(),
            this._embedSection(),
            this._qdrantSection(),
            this._pipelineSection(),
            this._weightsSection(),
            this._governanceSection(),
            this._dataSection(),
            this._auditSection(),
        );
    }

    _section(title, open, ...children) {
        const det = el('details', { class: 'mm-form-section' });
        if (open) det.setAttribute('open', '');
        det.append(el('summary', { text: title }), el('div', { class: 'mm-form-body' }, ...children));
        return det;
    }

    _field(label, input) {
        return el('div', { class: 'mm-field' }, el('label', { text: label }), input);
    }

    _text(value, onChange, { type = 'text', placeholder = '', min, max, step } = {}) {
        const i = el('input', { type, value: value ?? '', placeholder });
        if (min != null) i.min = min;
        if (max != null) i.max = max;
        if (step != null) i.step = step;
        i.addEventListener('change', () => onChange(i.value));
        return i;
    }

    // ---- mode & toggles -----------------------------------------------------
    _modeSection() {
        const s = this.ctx.getSettings();
        const save = () => this.ctx.saveSettings();
        const seg = (label, value) => btn(label, {
            small: true,
            pressed: s.mode === value,
            onClick: () => {
                s.mode = value;
                save();
                this.ctx.desk.setMode(value);
                this.refresh();
            },
        });
        return this._section('Bureau Mode', true,
            el('div', { class: 'mm-row' }, seg('ACTIVE', 'on'), seg('SHADOW', 'shadow'), seg('OFF', 'off')),
            toggle('This chat participates', this.ctx.isChatEnabled(), (v) => {
                this.ctx.setChatEnabled(v);
            }),
            toggle('Consent: store extracted events', s.consent.storeEvents, (v) => { s.consent.storeEvents = v; save(); }),
            toggle('Consent: store secrets', s.consent.storeSecrets, (v) => { s.consent.storeSecrets = v; save(); }),
            toggle('Privacy redaction (emails/phones/keys)', s.consent.redactPrivate, (v) => { s.consent.redactPrivate = v; save(); }),
            toggle('Show provenance dots on chat messages', s.ui.msgDots, (v) => { s.ui.msgDots = v; save(); this.ctx.refreshMsgDots(); }),
            this._field('Redacted real names (comma separated)', this._text(
                (s.consent.redactedNames || []).join(', '),
                (v) => { s.consent.redactedNames = v.split(',').map((x) => x.trim()).filter(Boolean); save(); },
                { placeholder: 'only used when redaction is on' },
            )),
        );
    }

    // ---- lanes ----------------------------------------------------------------
    _lanesSection() {
        const s = this.ctx.getSettings();
        const save = () => { this.ctx.saveSettings(); this.ctx.router.refresh(); };
        const laneRows = [];
        for (const lane of ['fast', 'strong', 'embed', 'rerank']) {
            const cfg = s.lanes[lane];
            const stampHost = el('span');
            const testBtn = btn('TEST', {
                small: true,
                onClick: async () => {
                    stampHost.replaceChildren(stamp('TESTING…', 'amber', { small: true }));
                    const result = await this.ctx.router.testLane(lane);
                    stampHost.replaceChildren(result.ok
                        ? stamp(result.detail.toUpperCase(), 'verdigris', { small: true })
                        : stamp(result.detail.toUpperCase(), 'red', { small: true }));
                    if (lane === 'embed' && result.ok) {
                        s.state.embedDim = result.dim;
                        s.state.embedModel = result.model;
                        save();
                        this.ctx.checkModelGovernance();
                    }
                },
            });
            laneRows.push(
                el('div', { class: 'mm-lane' },
                    el('span', { class: 'mm-lane-name', text: lane }),
                    el('span', { class: 'mm-lane-detail', text: `${cfg.baseUrl || '—'} · ${cfg.model || 'no model'}` }),
                    el('span', { class: 'mm-row' }, stampHost, testBtn),
                ),
                el('div', { class: 'mm-field-row' },
                    this._field('Base URL', this._text(cfg.baseUrl, (v) => { cfg.baseUrl = v; save(); }, { placeholder: 'http://localhost:11434/v1' })),
                    this._field('Model', this._text(cfg.model, (v) => { cfg.model = v; save(); }, { placeholder: lane === 'embed' ? 'qwen3-embedding:8b' : 'qwen3:8b-instruct' })),
                ),
                el('div', { class: 'mm-field-row' },
                    this._field('API key (stored locally, never logged)', this._text(cfg.apiKey ? '••••••••' : '', (v) => { cfg.apiKey = v === '••••••••' ? cfg.apiKey : v; save(); }, { type: 'password', placeholder: 'leave blank for local' })),
                    this._field('Timeout ms', this._text(cfg.timeoutMs, (v) => { cfg.timeoutMs = Number(v) || 30000; save(); }, { type: 'number', min: 1000, max: 300000 })),
                ),
            );
        }
        // bridge
        laneRows.push(
            el('h3', { class: 'mm-ledger-title mm-mt', text: 'Local bridge (CORS solver)' }),
            toggle('Route AI + Qdrant via 127.0.0.1:8787 bridge', s.bridge.enabled, (v) => { s.bridge.enabled = v; save(); }),
            this._field('Bridge URL', this._text(s.bridge.baseUrl, (v) => { s.bridge.baseUrl = v; save(); })),
        );
        return this._section('Model Lanes', false, ...laneRows);
    }

    // ---- embedding governance ---------------------------------------------------
    _embedSection() {
        const s = this.ctx.getSettings();
        const cfg = s.lanes.embed;
        const save = () => { this.ctx.saveSettings(); this.ctx.router.refresh(); };
        const mismatch = s.state.modelMismatch;
        const children = [];
        if (mismatch) {
            children.push(
                el('div', { class: 'mm-card', style: { '--mm-tilt': '-0.6deg' } },
                    el('div', { class: 'mm-card-head' },
                        el('span', { class: 'mm-seal' }),
                        el('h3', { class: 'mm-card-title', text: 'Embedding model changed' }),
                    ),
                    el('p', { class: 'mm-card-text', text: `Stored vectors: ${s.state.embedModel || '?'} (${s.state.embedDim || '?'}d) · Configured: ${cfg.model || '?'} (${cfg.dimensions || s.state.embedDim || '?'}d). Vectors from different models are never mixed — choose how to proceed.` }),
                    stamp('MODEL MISMATCH', 'red', { small: true }),
                    el('div', { class: 'mm-card-actions' },
                        btn('RE-EMBED', { small: true, variant: 'paper', onClick: () => this.ctx.reembed({ mode: 'in-place' }) }),
                        btn('NEW COLLECTION', { small: true, variant: 'paper', onClick: () => this.ctx.reembed({ mode: 'new-collection' }) }),
                    ),
                ),
            );
        }
        children.push(
            el('div', { class: 'mm-field-row' },
                this._field('Dimensions (0 = auto; Matryoshka truncation)', this._text(cfg.dimensions || 0, (v) => { cfg.dimensions = Number(v) || 0; save(); }, { type: 'number', min: 0, max: 8192 })),
                this._field('Model max (0 = unknown)', this._text(cfg.maxDimensions || 0, (v) => { cfg.maxDimensions = Number(v) || 0; save(); }, { type: 'number', min: 0, max: 8192 })),
            ),
            el('div', { class: 'mm-field-row' },
                this._field('Doc prefix (nomic/E5: "search_document: ")', this._text(cfg.docPrefix, (v) => { cfg.docPrefix = v; save(); })),
                this._field('Query prefix ("search_query: ")', this._text(cfg.queryPrefix, (v) => { cfg.queryPrefix = v; save(); })),
            ),
            this._field('Instruction (instruction-aware models)', this._text(cfg.instruction, (v) => { cfg.instruction = v; save(); })),
            el('div', { class: 'mm-ledger' },
                el('h3', { class: 'mm-ledger-title', text: 'Governance' }),
                ledgerRow('collection', s.state.collection || '—'),
                ledgerRow('stored model', s.state.embedModel || '—', s.state.modelMismatch ? 'bad' : ''),
                ledgerRow('stored dim', String(s.state.embedDim || '—'), s.state.modelMismatch ? 'bad' : ''),
                ledgerRow('re-embed job', s.state.reembedJob ? `${s.state.reembedJob.done}/${s.state.reembedJob.total}` : 'idle'),
            ),
            el('div', { class: 'mm-row' },
                btn('RE-EMBED ALL', { small: true, onClick: () => this.ctx.reembed({ mode: 'in-place' }) }),
                btn('RETRY FAILED EMBEDS', { small: true, onClick: () => this.ctx.retryFailedEmbeds() }),
            ),
        );
        return this._section('Embedding Governance', mismatch, ...children);
    }

    // ---- qdrant -------------------------------------------------------------------
    _qdrantSection() {
        const s = this.ctx.getSettings();
        const q = s.qdrant;
        const save = () => { this.ctx.saveSettings(); this.ctx.rebuildStorage(); };
        const stampHost = el('span');
        return this._section('Vector Store (Qdrant)', false,
            el('div', { class: 'mm-field-row' },
                this._field('Qdrant URL', this._text(q.baseUrl, (v) => { q.baseUrl = v; save(); }, { placeholder: 'http://localhost:6333' })),
                this._field('API key', this._text(q.apiKey ? '••••••••' : '', (v) => { q.apiKey = v === '••••••••' ? q.apiKey : v; save(); }, { type: 'password' })),
            ),
            el('div', { class: 'mm-field-row' },
                this._field('Quantization', (() => {
                    const sel = el('select', { onchange: (e) => { q.quantization = e.target.value; save(); } },
                        ['scalar', 'binary', 'none'].map((o) => el('option', { value: o, text: o, selected: o === q.quantization ? '' : null })));
                    return sel;
                })()),
                el('div', { class: 'mm-field' }, el('label', { text: 'Health' }), el('span', { class: 'mm-row' }, stampHost,
                    btn('TEST', {
                        small: true,
                        onClick: async () => {
                            stampHost.replaceChildren(stamp('TESTING…', 'amber', { small: true }));
                            const ok = await this.ctx.wal.primary.health().catch(() => false);
                            stampHost.replaceChildren(ok
                                ? stamp('OK · COLLECTIONS REACHABLE', 'verdigris', { small: true })
                                : stamp('STORAGE OFFLINE', 'red', { small: true }));
                            this.ctx.router.setQdrantDown(!ok);
                        },
                    }))),
            ),
        );
    }

    // ---- pipeline knobs ---------------------------------------------------------------
    _pipelineSection() {
        const s = this.ctx.getSettings();
        const p = s.pipeline;
        const save = () => { this.ctx.saveSettings(); };
        const num = (label, key, min, max) =>
            this._field(label, this._text(p[key], (v) => { p[key] = Number(v); this.ctx.validateAndSave(); }, { type: 'number', min, max }));
        return this._section('Pipeline & Depth Slicing', false,
            el('div', { class: 'mm-field-row' },
                num('Injection token budget', 'injectionBudget', 100, 8000),
                num('Injection depth (Author\'s Note convention)', 'injectionDepth', 0, 999),
            ),
            el('div', { class: 'mm-field-row' },
                num('Extraction window W', 'extractionWindow', 2, 24),
                num('Retrieval top-k', 'retrievalTopK', 1, 100),
            ),
            el('div', { class: 'mm-field-row' },
                num('Final top-n', 'finalTopN', 1, 30),
                num('Half-life hours', 'halfLifeHours', 1, 8760),
            ),
            el('div', { class: 'mm-field-row' },
                num('STM half-life minutes', 'stmHalfLifeMinutes', 1, 1440),
                num('Dedupe cosine', 'dedupeThreshold', 0.5, 0.999),
            ),
            toggle('HyDE', p.useHyde, (v) => { p.useHyde = v; save(); }),
            toggle('Query expansion', p.useQueryExpansion, (v) => { p.useQueryExpansion = v; save(); }),
            toggle('LLM rerank', p.useRerank, (v) => { p.useRerank = v; save(); }),
            toggle('Contextual compression', p.compressMemories, (v) => { p.compressMemories = v; save(); }),
            toggle('Topic hints ("does not know about: X")', p.topicHints, (v) => { p.topicHints = v; save(); }),
            toggle('Pull parent chunks for child hits', p.pullParentChunks, (v) => { p.pullParentChunks = v; save(); }),
        );
    }

    // ---- ink-level sliders (weights) ------------------------------------------------------
    _weightsSection() {
        const s = this.ctx.getSettings();
        const rows = [];
        const labels = {
            sem: 'Semantic', sparse: 'Sparse keywords', rec: 'Recency (Ebbinghaus)',
            imp: 'Importance', trust: 'Trust', emo: 'Emotion', graph: 'Graph walk',
            nov: 'Novelty', acc: 'Access frequency', comp: 'Composite (RRF)',
        };
        for (const key of Object.keys(DEFAULT_WEIGHTS)) {
            const val = s.weights[key] ?? DEFAULT_WEIGHTS[key];
            const range = el('input', { type: 'range', min: '0', max: '1', step: '0.01', value: String(val) });
            range.style.setProperty('--mm-fill', `${val * 100}%`);
            const out = el('span', { class: 'mm-inkslider-val', text: val.toFixed(2) });
            range.addEventListener('input', () => {
                const v = Number(range.value);
                out.textContent = v.toFixed(2);
                range.style.setProperty('--mm-fill', `${v * 100}%`);
                s.weights[key] = v;
            });
            range.addEventListener('change', () => this.ctx.saveSettings());
            rows.push(el('div', { class: 'mm-field' },
                el('label', { text: `${labels[key] || key}` }),
                el('div', { class: 'mm-inkslider' }, range, out),
            ));
        }
        return this._section('Scoring Ink Levels', false, ...rows);
    }

    // ---- governance --------------------------------------------------------------------------
    _governanceSection() {
        const s = this.ctx.getSettings();
        const g = s.governance;
        const save = () => { this.ctx.saveSettings(); };
        return this._section('Governance & Retention', false,
            el('div', { class: 'mm-field-row' },
                this._field('Retention policy', (() => {
                    const sel = el('select', { onchange: (e) => { g.retentionPolicy = e.target.value; save(); } },
                        ['forever', 'session', 'chat', 'ttl', 'manual'].map((o) =>
                            el('option', { value: o, text: o, selected: o === g.retentionPolicy ? '' : null })));
                    return sel;
                })()),
                this._field('TTL days', this._text(g.ttlDays, (v) => { g.ttlDays = Number(v) || 90; save(); }, { type: 'number', min: 1, max: 3650 })),
            ),
            toggle('Audit trail (why created / why recalled / score breakdown)', g.auditTrail, (v) => { g.auditTrail = v; save(); }),
            toggle('Auto-consolidate on chat change', g.autoConsolidateOnChatChange, (v) => { g.autoConsolidateOnChatChange = v; save(); }),
            toggle('KILL SWITCH — halt all memory work', g.killSwitch, (v) => { g.killSwitch = v; save(); this.ctx.desk.toast(v ? 'Kill switch engaged. The desk goes dark.' : 'Kill switch released.', v ? 'err' : 'ok'); }),
        );
    }

    // ---- export / import / wipe ------------------------------------------------------------------
    _dataSection() {
        return this._section('Data — Export / Import / Wipe', false,
            el('div', { class: 'mm-row' },
                btn('EXPORT JSONL', { small: true, iconCls: 'fa-file-export', onClick: () => this.ctx.exportData() }),
                btn('IMPORT JSONL', { small: true, iconCls: 'fa-file-import', onClick: () => this._import() }),
                btn('WIPE EVERYTHING', { small: true, variant: 'danger', onClick: () => this._wipe() }),
            ),
            el('p', { class: 'mm-dim', text: 'Exports include memories, STM, states, knowledge, audit and local vectors. Settings (incl. API keys) are never exported.', style: { fontSize: '10px' } }),
        );
    }

    _import() {
        const input = el('input', { type: 'file', accept: '.json,.jsonl,application/json' });
        input.addEventListener('change', async () => {
            const file = input.files?.[0];
            if (!file) return;
            try {
                const text = await file.text();
                const n = await this.ctx.importData(text);
                this.ctx.desk.toast(`Imported ${n} store sections. The drawers are full again.`, 'ok');
            } catch (err) {
                this.ctx.desk.toast(`Import failed: ${String(err?.message || err)}`, 'err');
            }
        });
        input.click();
    }

    async _wipe() {
        // stamp-confirm pattern: two presses
        if (!this._wipeArmed) {
            this._wipeArmed = true;
            this.ctx.desk.toast('Press WIPE EVERYTHING again to burn the archives.', 'warn', 5000);
            setTimeout(() => { this._wipeArmed = false; }, 5000);
            return;
        }
        this._wipeArmed = false;
        await this.ctx.wipeAll();
        this.ctx.desk.toast('Archives burned. The desk is clean.', 'err');
        this.refresh();
    }

    // ---- audit log ----------------------------------------------------------------------------------
    _auditSection() {
        const rows = logger.tail(30).slice(-15).reverse();
        return this._section('Audit & Observability', false,
            rows.length
                ? el('div', { class: 'mm-ledger' }, ...rows.map((r) => ledgerRow(r.level, `${r.ts.slice(11, 19)} ${r.msg.slice(0, 90)}`, r.level === 'error' ? 'bad' : r.level === 'warn' ? 'warn' : '')))
                : el('p', { class: 'mm-dim', text: 'The audit quill has not moved yet.' }),
            el('div', { class: 'mm-row' },
                btn('RUN EVAL', { small: true, onClick: () => this.ctx.runEval() }),
                btn('TRACE LAST RECALL', { small: true, onClick: () => this.ctx.showLastTrace() }),
            ),
        );
    }
}
