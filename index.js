/**
 * MEM'S MEMOS — entry point.
 *
 * Fail-safe by design: if the SillyTavern API is missing (opened as plain
 * files, old ST, or a broken host), a dev-mock adapter keeps the extension
 * fully loadable and the desk interactive. Nothing here ever touches ST core
 * files, generation presets, or sampler settings. Memory reaches the prompt
 * ONLY through the extension-safe injection slot, with shadow fallback.
 */

import { MODULE_NAME, mergeSettings, validateSettings, isEnabledFor, defaultSettings } from './src/config/settings.js';
import { logger } from './src/utils/logger.js';
import { createBus, nowIso, truncateWords, uuid, estimateTokens } from './src/utils/helpers.js';
import { ModelRouter } from './src/ai/router.js';
import { WriteAheadQueue } from './src/storage/adapter.js';
import { QdrantStore } from './src/storage/qdrant.js';
import { createMetadataStore, LocalVectorStore } from './src/storage/indexeddb.js';
import { StmManager, STM_BUFFERS } from './src/engine/stm.js';
import { ExtractionEngine } from './src/engine/extraction.js';
import { EpistemicEngine } from './src/engine/epistemic.js';
import { StateEngine } from './src/engine/states.js';
import { ConsolidationEngine } from './src/engine/consolidation.js';
import { RetrievalEngine, shouldRetrieve } from './src/engine/retrieval.js';
import { RankingEngine } from './src/engine/ranking.js';
import { InjectionEngine } from './src/engine/injection.js';
import { Desk } from './src/ui/desk.js';
import { BlotterRoom } from './src/ui/blotter.js';
import { ReadingRoom } from './src/ui/readingRoom.js';
import { CardCatalogRoom } from './src/ui/cardCatalog.js';
import { TimelineRoom } from './src/ui/timeline.js';
import { StringBoardRoom } from './src/ui/stringBoard.js';
import { DossierRoom } from './src/ui/dossier.js';
import { LedgerRoom } from './src/ui/ledger.js';
import { registerSlashCommands } from './src/commands/slash.js';

// ---------------------------------------------------------------------------
// HOST ADAPTER — SillyTavern when present, dev mock when not.
// ---------------------------------------------------------------------------

function createHost() {
    const st = globalThis.SillyTavern;
    if (st && typeof st.getContext === 'function') {
        try {
            const ctx = st.getContext();
            if (ctx && ctx.extensionSettings) return new StHost(ctx);
        } catch (err) {
            console.warn("[Mem's Memos] SillyTavern context unavailable, using dev mock", err);
        }
    }
    return new MockHost();
}

class StHost {
    constructor(ctx) {
        this.ctx = ctx;
        this.kind = 'sillytavern';
    }

    getSettings() {
        return this.ctx.extensionSettings[MODULE_NAME];
    }
    setSettings(value) {
        this.ctx.extensionSettings[MODULE_NAME] = value;
    }
    saveSettings() {
        this.ctx.saveSettingsDebounced?.();
    }

    /** Extension-safe context slot only. Depth follows the Author's Note
     *  convention (N messages from the end; 0 = at the very end). */
    inject(text, { depth = 1 } = {}) {
        const ctx = this.ctx;
        if (typeof ctx.setExtensionPrompt !== 'function') return false;
        // position 1 (in-prompt) + depth; never touches Author's Note itself.
        ctx.setExtensionPrompt(MODULE_NAME, text, 1, Math.max(0, depth), false, 0);
        return true;
    }
    clearInjection() {
        const ctx = this.ctx;
        if (typeof ctx.setExtensionPrompt === 'function') {
            try { ctx.setExtensionPrompt(MODULE_NAME, '', 1, 1, false, 0); } catch { /* best effort */ }
        }
    }

    getScope() {
        const ctx = this.ctx;
        const chatId = ctx.chatId != null ? String(ctx.chatId) : null;
        const charIdx = ctx.characterId != null ? Number(ctx.characterId) : null;
        const character = Number.isInteger(charIdx) ? ctx.characters?.[charIdx] : null;
        return {
            chatId,
            chatName: chatId,
            characterId: character?.name || null,
            characterName: character?.name || ctx.name2 || null,
            personaId: ctx.name1 || null,
            userId: ctx.name1 || null,
            date: new Date().toLocaleDateString(),
            isGroup: !!ctx.groups?.length && !!ctx.groupId,
        };
    }

    getRecentMessages(n = 8) {
        const chat = this.ctx.chat || [];
        return chat.slice(-n).map((m) => ({ name: m.name, text: m.mes, isUser: !!m.is_user }));
    }
    getLastUserMessage() {
        const chat = this.ctx.chat || [];
        for (let i = chat.length - 1; i >= 0; i--) {
            if (chat[i].is_user) return chat[i].mes;
        }
        return '';
    }
    messageText(index) {
        return this.ctx.chat?.[index]?.mes || '';
    }
    messageInfo(index) {
        const m = this.ctx.chat?.[index];
        return m ? { name: m.name, isUser: !!m.is_user } : null;
    }

    /** Subscribe to ST events. Handler names resolve via event_types. */
    on(eventName, handler) {
        const { eventSource, event_types } = this.ctx;
        if (!eventSource?.on) return () => {};
        const type = event_types?.[eventName] || eventName;
        eventSource.on(type, handler);
        return () => eventSource.off?.(type, handler);
    }

    chatContainer() {
        return document.querySelector('#chat');
    }
    messageSelector() {
        return '.mes';
    }
    /** message DOM node → chat index, via data attributes ST renders. */
    messageIndexFor(node) {
        const attr = node.getAttribute('mesid') ?? node.dataset?.mesid;
        if (attr != null && attr !== '') return Number(attr);
        // fallback: index among .mes nodes
        const all = [...document.querySelectorAll('#chat .mes')];
        return all.indexOf(node);
    }

    /** Mount point for the drawer launcher (ST extensions menu / wand area). */
    mountLauncher(onClick) {
        const id = 'mm-launcher';
        if (document.getElementById(id)) return document.getElementById(id);
        const btn = document.createElement('div');
        btn.id = id;
        btn.className = 'mm-launcher-btn';
        btn.setAttribute('role', 'button');
        btn.setAttribute('tabindex', '0');
        btn.setAttribute('aria-label', "Open Mem's Memos");
        btn.innerHTML = '<i class="fa-solid fa-stamp" aria-hidden="true"></i><span>Memos</span>';
        btn.addEventListener('click', onClick);
        btn.addEventListener('keydown', (e) => { if (e.key === 'Enter') onClick(); });
        const targets = [
            document.querySelector('#extensionsMenu'),
            document.querySelector('#extensions-menu'),
            document.querySelector('#rm_extensions_panel'),
            document.querySelector('#top-settings-holder'),
        ].filter(Boolean);
        if (targets.length) {
            targets[0].appendChild(btn);
        } else {
            // fixed floating fallback — never blocks the loader
            btn.style.cssText = 'position:fixed;right:10px;bottom:46px;z-index:2999;background:#262019;color:#f2e8d3;border:1px solid #3a3125;border-radius:6px;padding:6px 10px;cursor:pointer;font:12px monospace;display:flex;gap:6px;align-items:center;';
            document.body.appendChild(btn);
        }
        return btn;
    }

    drawerHost() {
        let host = document.getElementById('mm-drawer-host');
        if (host) return host;
        host = document.createElement('div');
        host.id = 'mm-drawer-host';
        host.className = 'mm-drawer-host mm-hidden';
        document.body.appendChild(host);
        return host;
    }
}

/** Dev mock — keeps the extension loadable without SillyTavern. */
class MockHost {
    constructor() {
        this.kind = 'mock';
        this.settings = null;
        this.chat = [];
        this.injected = null;
        this.listeners = new Map();
        console.warn("[Mem's Memos] SillyTavern not found — dev mock active (desk fully usable, injection is shadowed).");
    }
    getSettings() { return this.settings; }
    setSettings(v) { this.settings = v; }
    saveSettings() {
        try { localStorage.setItem('mems-memos-settings', JSON.stringify(this.settings)); } catch { /* no-op */ }
    }
    loadPersisted() {
        try { return JSON.parse(localStorage.getItem('mems-memos-settings') || 'null'); } catch { return null; }
    }
    inject(text, { depth = 1 } = {}) {
        this.injected = { text, depth };
        return true; // mock accepts, desk shows what WOULD be injected
    }
    clearInjection() { this.injected = null; }
    getScope() {
        return {
            chatId: 'mock-chat', chatName: 'mock-file', characterId: 'Archivist',
            characterName: 'Archivist', personaId: 'user', userId: 'user',
            date: new Date().toLocaleDateString(), isGroup: false,
        };
    }
    getRecentMessages(n = 8) { return this.chat.slice(-n); }
    getLastUserMessage() { return [...this.chat].reverse().find((m) => m.isUser)?.text || ''; }
    messageText(i) { return this.chat[i]?.text || ''; }
    messageInfo(i) { return this.chat[i] || null; }
    on(evt, fn) {
        if (!this.listeners.has(evt)) this.listeners.set(evt, new Set());
        this.listeners.get(evt).add(fn);
        return () => this.listeners.get(evt)?.delete(fn);
    }
    emit(evt, payload) {
        for (const fn of this.listeners.get(evt) ?? []) fn(payload);
    }
    chatContainer() { return null; }
    messageSelector() { return '.mes'; }
    messageIndexFor() { return -1; }
    mountLauncher(onClick) {
        const btn = document.createElement('button');
        btn.id = 'mm-launcher';
        btn.textContent = "Mem's Memos (mock)";
        btn.style.cssText = 'position:fixed;right:10px;bottom:10px;z-index:2999;padding:8px 12px;';
        btn.addEventListener('click', onClick);
        document.body.appendChild(btn);
        return btn;
    }
    drawerHost() {
        let host = document.getElementById('mm-drawer-host');
        if (!host) {
            host = document.createElement('div');
            host.id = 'mm-drawer-host';
            host.className = 'mm-drawer-host';
            document.body.appendChild(host);
        }
        return host;
    }
}

// ---------------------------------------------------------------------------
// BUREAU — wires every subsystem together.
// ---------------------------------------------------------------------------

let bureau = null;

export function createBureau(host) {
    const bus = createBus();

    // --- settings (merge + validate + persist) --------------------------------
    const persisted = host.kind === 'mock' ? host.loadPersisted() : host.getSettings();
    const settings = validateSettings(mergeSettings(persisted));
    host.setSettings(settings);
    const getSettings = () => settings;
    const saveSettings = () => { validateSettings(settings); host.saveSettings(); };
    logger.setLevel(settings.ui.logLevel);

        const getScope = () => host.getScope();

    // --- test seam: allow injection of fetch + storage doubles under Node ------
    const testDeps = host._testDeps || {};

    // --- AI + storage -----------------------------------------------------------
    const router = new ModelRouter(settings, { fetchFn: testDeps.fetchFn });
    const qdrant = new QdrantStore(settings.qdrant, { bridge: settings.bridge, fetchFn: testDeps.fetchFn });
    let meta = null;
    let localVectors = null;
    let wal = null;
    let extraction = null; // wired below (stm references it in a closure)
    let desk = null;       // wired below (injection emit closure references it)
    let rooms = null;

    const stm = new StmManager({
        meta: null, getSettings,
        onEnqueueExtraction: async (job) => extraction.process(job),
    });

    const epistemic = new EpistemicEngine({ meta: null });
    const states = new StateEngine({ meta: null });
    const ranking = new RankingEngine({ router, getSettings });

    extraction = new ExtractionEngine({
        router, meta: null, wal: null, getSettings,
        io: {
            putChip: (type, key, content, scope, extras) =>
                stm.putChip(type, key, content, scope, extras).catch((err) => logger.warn('chip failed', { err: String(err?.message || err) })),
            applyKnowledge: (rows, base, created) => epistemic.applyKnowledge(rows, base, created),
            applyStateUpdates: (updates, base) => states.applyStateUpdates(updates, base),
            applyWorld: (world, base) => states.applyWorld(world, base),
            emit: (kind, payload) => bus.emit(kind, payload),
        },
    });

    const retrieval = new RetrievalEngine({
        router, meta: null, wal: null, ranking, epistemic, stm, states, getSettings,
    });

    const injection = new InjectionEngine({
        retrieval, states, epistemic, stm, getSettings,
        emit: (kind, payload) => {
            bus.emit(kind, payload);
            if (kind === 'injection-failed') desk?.toast('Injection failed — shadow mode. Block is copyable in RECALL.', 'warn', 6000);
            if (kind === 'injected') refreshMsgDots();
        },
    });

    const consolidation = new ConsolidationEngine({
        meta: null, wal: null, stm, getSettings,
        emit: (kind, payload) => bus.emit(kind, payload),
    });

    // --- bureau context shared by rooms + commands ----------------------------------
    const ctx = {
        host, bus, desk, router, getSettings, saveSettings, getScope,
        get meta() { return meta; },
        get wal() { return wal; },
        stm, epistemic, states, ranking, extraction, retrieval, injection, consolidation,
        isChatEnabled() {
            const scope = getScope();
            return isEnabledFor(settings, { chatId: scope.chatId, characterName: scope.characterName });
        },
        setChatEnabled(v) {
            const scope = getScope();
            if (scope.chatId) settings.enabledChats[scope.chatId] = !!v;
            saveSettings();
            desk.refreshLetterhead();
        },
        validateAndSave: saveSettings,
        rebuildStorage,
        refreshMsgDots,
        forgetMemory,
        checkModelGovernance,
        reembed,
        retryFailedEmbeds,
        exportData,
        importData,
        wipeAll,
        runEval,
        showTrace: (id) => showTrace(id),
        showLastTrace: () => showLastTrace(),
        setMode,
        statusReport,
        manualRecall,
        forget,
        sleepReport,
        worldReport,
        knowsReport,
        traceReport: (id) => traceReport(id),
    };

    // --- UI (after ctx exists — rooms take it by reference) ----------------------
    desk = new Desk({
        getSettings,
        getScope,
        onModeChange: (key) => {
            if (key === 'collapse') toggleDrawer(false);
            else if (key === 'settings-changed') saveSettings();
        },
    });
    rooms = {
        blotter: new BlotterRoom(ctx),
        reading: new ReadingRoom(ctx),
        catalog: new CardCatalogRoom(ctx),
        timeline: new TimelineRoom(ctx),
        strings: new StringBoardRoom(ctx),
        dossier: new DossierRoom(ctx),
        settings: new LedgerRoom(ctx),
    };
    for (const [id, room] of Object.entries(rooms)) desk.registerRoom(id, room);
    ctx.desk = desk;

    // --- storage bootstrap --------------------------------------------------------
    async function rebuildStorage() {
        try {
            meta = meta || (await createMetadataStore());
        } catch (err) {
            logger.error('metadata store init failed', { err: String(err?.message || err) });
            meta = null;
        }
        if (!meta) {
            desk?.toast('IndexedDB unavailable — memory will not persist this session.', 'err', 8000);
            return;
        }
        stm.meta = meta;
        epistemic.meta = meta;
        states.meta = meta;
        extraction.meta = meta;
        retrieval.meta = meta;
        consolidation.meta = meta;
        ctx.meta = meta;

        localVectors = localVectors || new LocalVectorStore(meta);
        if (!wal) {
            wal = new WriteAheadQueue(qdrant, localVectors, (down) => {
                router.setQdrantDown(down);
                desk?.refreshLedger(storageLedgerRows());
                if (down) desk?.toast('STORAGE OFFLINE — local fallback engaged. Writes are queued.', 'err', 7000);
                else desk?.toast('Qdrant reconnected — queued writes flushed.', 'ok');
            });
            extraction.wal = wal;
            retrieval.wal = wal;
            consolidation.wal = wal;
            ctx.wal = wal;
        }
        await wal.reconcile();

        // collection + governance
        const embedCfg = settings.lanes.embed;
        if (embedCfg.model) {
            const dim = embedCfg.dimensions || settings.state.embedDim || 0;
            if (dim > 0) {
                try {
                    const name = await qdrant.collectionFor({ model: embedCfg.model, dim })
                        ? await ensureCollection(embedCfg.model, dim)
                        : null;
                    if (name) settings.state.collection = name;
                } catch (err) {
                    logger.warn('collection ensure failed', { err: String(err?.message || err) });
                }
            }
        }
        checkModelGovernance();
        desk?.refreshLedger(storageLedgerRows());
    }

    async function ensureCollection(model, dim) {
        try {
            const name = qdrant.collectionFor({ model, dim });
            await wal.enqueue('ensure', name, { model, dim });
            return name;
        } catch (err) {
            logger.warn('ensureCollection', { err: String(err?.message || err) });
            return null;
        }
    }

    function storageLedgerRows() {
        const level = router.degradationLevel();
        return [
            { key: 'mode', value: settings.mode.toUpperCase(), state: settings.mode === 'on' ? 'ok' : settings.mode === 'shadow' ? 'warn' : 'bad' },
            { key: 'store', value: wal?.usingFallback ? 'LOCAL FALLBACK' : 'qdrant', state: wal?.usingFallback ? 'bad' : 'ok' },
            { key: 'degradation', value: `L${level}`, state: level === 0 ? 'ok' : level >= 3 ? 'bad' : 'warn' },
            { key: 'collection', value: settings.state.collection || '—', state: '' },
            { key: 'queue', value: `${wal?.queue.length ?? 0} pending`, state: (wal?.queue.length ?? 0) ? 'warn' : '' },
        ];
    }

    // --- governance ------------------------------------------------------------------
    function checkModelGovernance() {
        const embedCfg = settings.lanes.embed;
        const storedModel = settings.state.embedModel;
        const storedDim = settings.state.embedDim;
        const cfgDim = embedCfg.dimensions || storedDim;
        const mismatch = Boolean(
            embedCfg.model && storedModel &&
            (embedCfg.model !== storedModel || (cfgDim && storedDim && cfgDim !== storedDim)),
        );
        if (mismatch !== settings.state.modelMismatch) {
            settings.state.modelMismatch = mismatch;
            saveSettings();
            if (mismatch) desk?.toast('MODEL MISMATCH — open Ledger → Embedding Governance.', 'err', 8000);
        }
        if (!storedModel && embedCfg.model) {
            settings.state.embedModel = embedCfg.model;
            saveSettings();
        }
        rooms.settings?.refresh?.();
    }

    /** /mm reembed — background job: scroll all, re-embed, upsert, swap. */
    async function reembed({ mode = 'in-place' } = {}) {
        const embedCfg = settings.lanes.embed;
        if (!embedCfg.model) {
            desk?.toast('Configure the embed lane first (Ledger → Model Lanes).', 'warn');
            return;
        }
        const job = { total: 0, done: 0, status: 'running', startedAt: nowIso() };
        settings.state.reembedJob = job;
        saveSettings();
        desk?.toast('Re-embed job started — progress in the Ledger.', '');
        try {
            const dim = embedCfg.dimensions || settings.state.embedDim || 0;
            if (!dim) throw new Error('unknown embedding dim — TEST the embed lane first');
            const newCollection = qdrant.collectionFor({ model: embedCfg.model, dim });
            await wal.enqueue('ensure', newCollection, { model: embedCfg.model, dim });
            const all = await meta.queryMemories({ status_not: ['deleted'] });
            const withText = all.filter((m) => m.text);
            job.total = withText.length;
            const batchSize = 16;
            for (let i = 0; i < withText.length; i += batchSize) {
                const batch = withText.slice(i, i + batchSize);
                const res = await router.run('embed', (c) =>
                    c.embed(batch.map((m) => (embedCfg.docPrefix || '') + m.text), {
                        dimensions: embedCfg.dimensions || 0,
                        instruction: embedCfg.instruction || '',
                    }),
                );
                const points = batch.map((m, j) => ({
                    id: m.id,
                    vector: { dense_main: res.vectors[j], dense_summary: res.vectors[j] },
                    payload: { chat_id: m.chat_id, memory_type: m.memory_type, status: m.status, knowers_json: m.knowers_json || [], keywords_json: m.keywords_json || [], importance: m.importance, text: truncateWords(m.text, 800), created_at: m.created_at },
                }));
                await wal.enqueue('upsert', newCollection, points);
                for (const m of batch) {
                    await meta.updateMemory(m.id, {
                        embedding_model: embedCfg.model,
                        embedding_dim: res.dim,
                        vector_collection: newCollection,
                        status: 'active',
                        error: null,
                    });
                }
                job.done = Math.min(withText.length, i + batchSize);
                saveSettings();
                bus.emit('reembed-progress', { ...job });
            }
            if (mode === 'in-place' && settings.state.collection && settings.state.collection !== newCollection) {
                await wal.active.dropCollection(settings.state.collection).catch(() => {});
            }
            settings.state.collection = newCollection;
            settings.state.embedModel = embedCfg.model;
            settings.state.embedDim = dim;
            settings.state.modelMismatch = false;
            job.status = 'done';
            saveSettings();
            desk?.toast(`Re-embedded ${job.done} memos into ${newCollection}.`, 'ok', 7000);
        } catch (err) {
            job.status = 'failed';
            job.error = String(err?.message || err);
            saveSettings();
            desk?.toast(`Re-embed failed: ${job.error}`, 'err', 7000);
        }
        rooms.settings?.refresh?.();
    }

    async function retryFailedEmbeds() {
        const failed = await meta.queryMemories({ status: 'failed_embed' }).catch(() => []);
        if (!failed.length) {
            desk?.toast('No failed embeds on file.', 'ok');
            return;
        }
        desk?.toast(`Retrying ${failed.length} failed embeds…`, '');
        for (const m of failed) {
            await extraction._embedAndStore(m, { summaryVector: true });
        }
        desk?.toast('Retry pass complete — check the Ledger.', 'ok');
    }

    // --- data management ----------------------------------------------------------------
    async function exportData() {
        const bundle = await meta.exportAll();
        const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `mems-memos-export-${new Date().toISOString().slice(0, 10)}.json`;
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 5000);
        return `Exported ${Object.keys(bundle.stores).length} store sections.`;
    }

    async function importData(text) {
        const bundle = JSON.parse(text);
        const n = await meta.importAll(bundle);
        bus.emit('memory', { imported: true });
        return n;
    }

    async function wipeAll() {
        await meta.wipe();
        localVectors?.cache?.clear?.();
        settings.state.collection = '';
        settings.state.embedModel = '';
        settings.state.embedDim = 0;
        settings.state.modelMismatch = false;
        saveSettings();
        bus.emit('memory', { wiped: true });
        for (const room of Object.values(rooms)) room.refresh?.();
    }

    // --- forgetting ----------------------------------------------------------------------
    async function forgetMemory(id) {
        await meta.updateMemory(id, { status: 'deleted', validity_status: 'deleted' });
        const rec = await meta.getMemory(id);
        if (rec?.vector_collection) await wal.enqueue('delete', rec.vector_collection, [id]).catch(() => {});
        await epistemic.forgetMemory(id);
        bus.emit('memory', { forgotten: id });
    }

    /** /mm forget last | chat | character <name> | entity <name> */
    async function forget(target) {
        const scope = getScope();
        const t = String(target || '').trim();
        if (t === 'last') {
            const rows = await meta.queryMemories({ chat_id: scope.chatId, status: 'active' });
            rows.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
            if (!rows.length) return 'Nothing to forget.';
            await forgetMemory(rows[0].id);
            return `Forgot: ${truncateWords(rows[0].summary || rows[0].text || rows[0].id, 80)}`;
        }
        if (t === 'chat') {
            const n = await meta.deleteWhere({ chat_id: scope.chatId });
            await meta.clearStm(scope.chatId);
            bus.emit('memory', { wiped: scope.chatId });
            return `Forgot ${n} memos from this chat.`;
        }
        const charMatch = t.match(/^character\s+(.+)$/i);
        if (charMatch) {
            const name = charMatch[1].trim().toLowerCase();
            const rows = await meta.queryMemories({ chat_id: scope.chatId });
            const mine = rows.filter((m) => (m.characters_json || []).some((c) => c.toLowerCase() === name) || (m.subject_name || '').toLowerCase() === name);
            for (const m of mine) await forgetMemory(m.id);
            await epistemic.forgetKnower(scope.chatId, name);
            return `Forgot ${mine.length} memos about ${charMatch[1].trim()}.`;
        }
        const entMatch = t.match(/^entity\s+(.+)$/i);
        if (entMatch) {
            const name = entMatch[1].trim();
            const n = await states.forgetEntity(scope.chatId, name);
            const rows = await meta.queryMemories({ chat_id: scope.chatId });
            const mine = rows.filter((m) => (m.entity_ids_json || []).some((e) => e.endsWith(`:${name.toLowerCase()}`)));
            for (const m of mine) await forgetMemory(m.id);
            return `Forgot entity ${name}: ${n} state cards, ${mine.length} memos.`;
        }
        return 'Usage: /mm forget last | chat | character <name> | entity <name>';
    }

    // --- reports (slash + desk) ------------------------------------------------------------
    function setMode(mode) {
        if (!['on', 'shadow', 'off'].includes(mode)) return `Unknown mode ${mode}`;
        settings.mode = mode;
        saveSettings();
        desk.setMode(mode);
        desk.refreshLedger(storageLedgerRows());
        if (mode !== 'on') host.clearInjection?.();
        return `Bureau mode: ${mode.toUpperCase()}`;
    }

    async function statusReport() {
        const scope = getScope();
        const counts = meta ? await meta.countMemories({ chat_id: scope.chatId }).catch(() => 0) : 0;
        const stmRows = scope.chatId && meta ? (await stm.live(scope.chatId).catch(() => [])).length : 0;
        const health = router.healthSummary();
        const lanes = Object.entries(health).map(([l, h]) => `${l}:${h.breakerOpen ? 'OPEN' : h.configured ? 'ok' : '—'}`).join(' ');
        return [
            `File №${scope.chatId || '—'} · mode ${settings.mode.toUpperCase()} · L${router.degradationLevel()}`,
            `store ${wal?.usingFallback ? 'LOCAL FALLBACK' : 'qdrant'} · collection ${settings.state.collection || '—'}`,
            `memos ${counts} · stm ${stmRows} · lanes ${lanes}`,
        ].join('\n');
    }

    async function manualRecall(query) {
        if (!query) return 'Usage: /mm recall <query>';
        const scope = getScope();
        const result = await retrieval.retrieve({
            query, chatId: scope.chatId, characterName: scope.characterName, characterId: scope.characterId,
        });
        desk._activate('reading');
        if (!result.memories.length) return 'Nothing filed under that name.';
        return result.memories
            .map((m, i) => `${i + 1}. [${m.finalScore.toFixed(3)}] ${truncateWords(m.displayText, 140)}`)
            .join('\n');
    }

    async function sleepReport() {
        const report = await consolidation.sleep(getScope().chatId);
        return `Sleep cycle: ${report.merged} merged · ${report.superseded} contradicted · ${report.archived} archived · ${report.forgotten} forgotten · ${report.reinforced} reinforced.`;
    }

    async function worldReport() {
        const scope = getScope();
        const line = await states.worldLine(scope.chatId);
        const rows = await states.allWorld(scope.chatId);
        const factions = rows.filter((r) => r.key === 'faction' && r.status === 'active').map((r) => r.value_text);
        return `World: ${line || '—'}${factions.length ? `\nFactions: ${factions.join(', ')}` : ''}`;
    }

    async function knowsReport(entity) {
        if (!entity) return 'Usage: /mm knows <entity>';
        const scope = getScope();
        const knows = await epistemic.knows(scope.chatId, entity);
        const hidden = await epistemic.doesNotKnow(scope.chatId, entity);
        return [
            `${entity} knows:`,
            ...(knows.slice(0, 8).map((k) => `- [${k.stance}] ${truncateWords(k.claim_text || '', 100)}`)),
            `${entity} does NOT know (topics only):`,
            ...(hidden.slice(0, 8).map((h) => `- ${h.label}`)),
        ].join('\n');
    }

    async function traceReport(id) {
        const rec = await meta.getMemory(String(id || '').trim());
        if (!rec) return `No memo filed under id ${id}`;
        const audit = await meta.auditFor(rec.id).catch(() => []);
        const lines = [
            `TRACE ${rec.id}`,
            `type ${rec.memory_type} · status ${rec.status} · validity ${rec.validity_status}`,
            `importance ${Number(rec.importance ?? 0.5).toFixed(2)} · strength ${Number(rec.strength ?? 1).toFixed(2)} · recalls ${rec.recall_count || 0}`,
            `created ${rec.created_at} by ${rec.extractor_model || 'unknown extractor'}`,
            `vector ${rec.vector_collection || 'none'} · ${rec.embedding_model || 'no model'} ${rec.embedding_dim || ''}d`,
            `knowers [${(rec.knowers_json || []).join(', ')}] secret_from [${(rec.secret_from_json || []).join(', ')}]`,
            ...audit.map((a) => `${a.created_at} ${a.action}: ${truncateWords(JSON.stringify(a.detail || {}), 120)}`),
        ];
        showTraceCard(rec, audit);
        return lines.join('\n');
    }

    function showTrace(id) {
        traceReport(id).catch((err) => desk.toast(String(err?.message || err), 'err'));
    }

    function showTraceCard(rec, audit) {
        desk._activate('reading');
        const hostEl = desk.roomEl('reading');
        if (!hostEl) return;
        const room = rooms.reading;
        room.pipelineEl?.replaceChildren(
            ...[
                { stage: 'id', detail: rec.id },
                { stage: 'created', detail: rec.created_at },
                { stage: 'extractor', detail: rec.extractor_model || '—' },
                { stage: 'vector', detail: rec.vector_collection || '—' },
                ...audit.map((a) => ({ stage: a.action, detail: truncateWords(JSON.stringify(a.detail || {}), 90) })),
            ].map((t) => {
                const row = document.createElement('div');
                row.className = 'mm-ledger-row';
                const k = document.createElement('span');
                k.className = 'mm-ledger-key';
                k.textContent = t.stage;
                const lead = document.createElement('span');
                lead.className = 'mm-ledger-leader';
                const v = document.createElement('span');
                v.className = 'mm-ledger-val';
                v.textContent = t.detail;
                row.append(k, lead, v);
                return row;
            }),
        );
    }

    function showLastTrace() {
        const trace = injection.getLastTrace();
        if (!trace?.length) {
            desk.toast('No recall has run yet — search in RECALL first.', 'warn');
            return;
        }
        desk._activate('reading');
    }

    // --- eval harness (T12) -----------------------------------------------------------------
    async function runEval() {
        const scope = getScope();
        const all = await meta.queryMemories({ chat_id: scope.chatId, status: 'active' }).catch(() => []);
        const golden = all.filter((m) => (m.tags_json || []).includes('golden'));
        const k = settings.pipeline.retrievalTopK;
        let hits = 0;
        let rrSum = 0;
        const latencies = [];
        for (const g of golden.slice(0, 10)) {
            const t0 = performance.now();
            const result = await retrieval.retrieve({
                query: g.last_query || g.summary || g.text?.slice(0, 120),
                chatId: scope.chatId,
                characterName: scope.characterName,
                characterId: scope.characterId,
                skipLlm: true,
            });
            latencies.push(performance.now() - t0);
            const rank = result.memories.findIndex((m) => m.record.id === g.id);
            if (rank !== -1 && rank < k) {
                hits++;
                rrSum += 1 / (rank + 1);
            }
        }
        const contradicted = all.filter((m) => m.validity_status === 'contradicted').length;
        const receipt = {
            at: nowIso(),
            golden: golden.length,
            recallAtK: golden.length ? hits / Math.min(golden.length, 10) : null,
            mrr: golden.length ? rrSum / Math.min(golden.length, 10) : null,
            contradictionRate: all.length ? contradicted / all.length : 0,
            p50: percentile(latencies, 0.5),
            p95: percentile(latencies, 0.95),
        };
        settings.state.evalHistory = [...(settings.state.evalHistory || []), receipt].slice(-10);
        saveSettings();
        desk.toast(
            golden.length
                ? `EVAL recall@${k} ${(receipt.recallAtK * 100).toFixed(0)}% · MRR ${receipt.mrr.toFixed(2)} · contradictions ${(receipt.contradictionRate * 100).toFixed(1)}%`
                : 'EVAL: no golden-tagged memos (tag memories with "golden" to build the set).',
            golden.length ? 'ok' : 'warn', 7000,
        );
        return JSON.stringify(receipt, null, 2);
    }

    // --- msgdots -------------------------------------------------------------------------------
    function refreshMsgDots() {
        if (!settings.ui.msgDots || !scopeChatId()) {
            desk.detachMsgDots();
            return;
        }
        const container = host.chatContainer?.();
        if (!container) return;
        const chatId = scopeChatId();
        desk.attachMsgDots({
            container,
            selector: host.messageSelector(),
            dotsFor: (node) => {
                const idx = host.messageIndexFor(node);
                if (idx < 0) return [];
                const kinds = [];
                if (stmDots.has(String(idx))) kinds.push('stm');
                if (ltmDots.has(String(idx))) kinds.push('ltm');
                if (recallDots.has(String(idx))) kinds.push('recall');
                return kinds;
            },
        });
    }
    const stmDots = new Set();
    const ltmDots = new Set();
    const recallDots = new Set();
    function scopeChatId() {
        return getScope().chatId;
    }

    // --- message + generation wiring -----------------------------------------------------------
    const unsubscribers = [];

    function wireEvents() {
        // ingestion (T1) — async, never blocks generation
        const onMessage = (isUser) => (data) => {
            try {
                if (!ctx.isChatEnabled()) return;
                const scope = getScope();
                if (!scope.chatId) return;
                const idx = typeof data === 'number' ? data : data?.messageId ?? data?.index ?? null;
                const info = idx != null ? host.messageInfo(idx) : null;
                const text = (idx != null ? host.messageText(idx) : '') || data?.message || data?.mes || '';
                if (!text) return;
                const res = stm.ingest({
                    text,
                    isUser,
                    name: info?.name || (isUser ? scope.personaId : scope.characterName) || (isUser ? 'user' : 'character'),
                    messageId: idx,
                    chatId: scope.chatId,
                    characterId: scope.characterId,
                    characterName: scope.characterName,
                    personaId: scope.personaId,
                    userId: scope.userId,
                    sessionId: scope.chatId,
                });
                if (res.accepted && idx != null) {
                    stmDots.add(String(idx));
                    if (settings.ui.msgDots) refreshMsgDots();
                }
            } catch (err) {
                logger.warn('ingest failed', { err: String(err?.message || err) });
            }
        };
        unsubscribers.push(host.on('MESSAGE_SENT', onMessage(true)));
        unsubscribers.push(host.on('MESSAGE_RECEIVED', onMessage(false)));

        // retrieval + injection BEFORE generation leaves — awaited but guarded
        // by a hard timeout so chat NEVER stalls on the bureau.
        unsubscribers.push(host.on('GENERATION_STARTED', async () => {
            try {
                if (!ctx.isChatEnabled()) return;
                const scope = getScope();
                if (!scope.chatId) return;
                const query = host.getLastUserMessage() || '';
                if (!shouldRetrieve(query)) return;
                const work = injection.inject(host, {
                    query,
                    chatId: scope.chatId,
                    characterName: scope.characterName,
                    characterId: scope.characterId,
                });
                const timeout = new Promise((resolve) =>
                    setTimeout(() => resolve({ injected: false, reason: 'timeout' }), 3500),
                );
                const result = await Promise.race([work, timeout]);
                if (result?.block) {
                    for (const m of result.block.trace ?? []) {
                        if (m.stage === 'done') break;
                    }
                    recallDots.add(String((host.getRecentMessages(1).length || 0)));
                    bus.emit('recall', result.block);
                }
            } catch (err) {
                logger.warn('generation-time recall failed', { err: String(err?.message || err) });
            }
        }));

        unsubscribers.push(host.on('CHAT_CHANGED', async () => {
            desk.detachMsgDots();
            stm.clearWindow();
            stmDots.clear();
            ltmDots.clear();
            recallDots.clear();
            desk.refreshLetterhead();
            for (const room of Object.values(rooms)) room.refresh?.();
            if (settings.governance.autoConsolidateOnChatChange) {
                consolidation.sleep(getScope().chatId).catch((err) => logger.warn('sleep on chat change failed', { err: String(err?.message || err) }));
            }
        }));
    }

    // --- drawer ------------------------------------------------------------------------
    let drawerOpen = false;
    function toggleDrawer(force) {
        const hostEl = host.drawerHost();
        drawerOpen = typeof force === 'boolean' ? force : !drawerOpen;
        hostEl.classList.toggle('mm-hidden', !drawerOpen);
        if (drawerOpen) {
            if (!hostEl.dataset.mounted && hostEl.isConnected !== false) {

                hostEl.dataset.mounted = '1';
                desk.mount(hostEl);
                applyDrawerWidth(hostEl, settings.ui.drawerWidth);
                makeResizable(hostEl);
            }
            desk.refreshLetterhead();
            desk.refreshLedger(storageLedgerRows());
        }
    }

    function applyDrawerWidth(hostEl, w) {
        hostEl.style.width = `${Math.min(720, Math.max(380, w || 480))}px`;
    }

    function makeResizable(hostEl) {
        const grip = document.createElement('div');
        grip.className = 'mm-resizer';
        hostEl.appendChild(grip);
        let startX = 0;
        let startW = 0;
        const onMove = (e) => {
            const w = startW + (startX - e.clientX);
            applyDrawerWidth(hostEl, w);
        };
        const onUp = (e) => {
            document.removeEventListener('mousemove', onMove);
            document.removeEventListener('mouseup', onUp);
            settings.ui.drawerWidth = hostEl.getBoundingClientRect().width;
            saveSettings();
        };
        grip.addEventListener('mousedown', (e) => {
            startX = e.clientX;
            startW = hostEl.getBoundingClientRect().width;
            document.addEventListener('mousemove', onMove);
            document.addEventListener('mouseup', onUp);
            e.preventDefault();
        });
    }

    // --- idle consolidation -----------------------------------------------------------------
    let idleTimer = null;
    function armIdleConsolidation() {
        const minutes = settings.governance.idleConsolidateMinutes;
        if (!minutes) return;
        clearInterval(idleTimer);
        idleTimer = setInterval(() => {
            const last = settings.state.lastConsolidatedAt || 0;
            if (Date.now() - last > minutes * 60_000) {
                consolidation.sleep(getScope().chatId).catch(() => {});
            }
        }, 60_000);
    }

    /** TEST-ONLY: swap the metadata store + WAL to in-memory doubles so the
     *  full bureau can boot under plain Node (no indexedDB). */
    async function _testWireMeta(metaStore, vectorStore) {
        meta = metaStore;
        stm.meta = meta;
        epistemic.meta = meta;
        states.meta = meta;
        extraction.meta = meta;
        retrieval.meta = meta;
        consolidation.meta = meta;
        localVectors = vectorStore || localVectors || null;
        const fallback = localVectors || {
            name: 'test-vectors',
            collectionFor: ({ model, dim }) => `test__${model}__${dim}`,
            ensureCollection: async () => true,
            health: async () => true,
            upsert: async () => {},
            delete: async () => {},
            searchDense: async () => [],
            searchSparse: async () => [],
            scroll: async () => [],
            dropCollection: async () => {},
        };
        wal = new WriteAheadQueue(fallback, fallback, () => {});
        extraction.wal = wal;
        retrieval.wal = wal;
        consolidation.wal = wal;
    }

    // --- boot -------------------------------------------------------------------------------
    async function start() {
        if (!meta) await rebuildStorage();
        wireEvents();
        host.mountLauncher(() => toggleDrawer());
        registerSlashCommands(ctx, host);
        armIdleConsolidation();
        desk.refreshLedger(storageLedgerRows());
        logger.info('bureau open', { host: host.kind, mode: settings.mode });
        if (host.kind === 'mock') {
            // seed a couple of messages so the desk is visibly alive in dev
            setTimeout(() => {
                host.emit('MESSAGE_SENT', { messageId: 0, message: 'The Archivist opened the bureau ledger.' });
                host.chat.push({ name: 'user', text: 'The Archivist opened the bureau ledger.', isUser: true });
            }, 600);
        }
    }

    function stop() {
        unsubscribers.forEach((u) => { try { u?.(); } catch { /* ignore */ } });
        unsubscribers.length = 0;
        clearInterval(idleTimer);
        desk.unmount();
        document.getElementById('mm-launcher')?.remove();
        document.getElementById('mm-drawer-host')?.remove();
        host.clearInjection?.();
    }

    return Object.assign(ctx, { start, stop, toggleDrawer, storageLedgerRows, _testWireMeta });
}

// ---------------------------------------------------------------------------
// LIFECYCLE HOOKS (manifest maps to these globals)
// ---------------------------------------------------------------------------

let activated = false;

export async function mmOnInstall() {
    console.log("[Mem's Memos] installed — the bureau takes its seat.");
}

export async function mmOnUpdate() {
    console.log("[Mem's Memos] updated — settings merge on next activation.");
}

export async function mmOnDelete() {
    try {
        const host = createHost();
        host.setSettings?.(null);
    } catch { /* best effort */ }
    console.log("[Mem's Memos] removed — the desk is cleared.");
}

export async function mmOnEnable() {
    if (bureau) await mmOnActivate();
}

export async function mmOnDisable() {
    if (bureau) {
        bureau.stop();
        bureau = null;
        activated = false;
    }
}

export async function mmOnActivate() {
    if (activated) return;
    activated = true;
    try {
        const host = createHost();
        bureau = createBureau(host);
        await bureau.start();
    } catch (err) {
        // absolute fail-safe: the extension must never break ST load
        console.error("[Mem's Memos] activation failed — bureau disabled", err);
        activated = false;
    }
}

// ST's loader resolves hook names as globals on window
Object.assign(globalThis, {
    mmOnInstall, mmOnUpdate, mmOnDelete, mmOnEnable, mmOnDisable, mmOnActivate,
});

// legacy (pre-1.17) self-init fallback
if (typeof globalThis.jQuery === 'function' && !('hooks' in (globalThis.__mmManifest || {}))) {
    try {
        globalThis.jQuery(async () => {
            await new Promise((r) => setTimeout(r, 50));
            await mmOnActivate();
        });
    } catch { /* hooks path will handle it on 1.17+ */ }
}

function percentile(arr, p) {
    if (!arr.length) return 0;
    const sorted = [...arr].sort((a, b) => a - b);
    const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * p));
    return Math.round(sorted[idx]);
}
