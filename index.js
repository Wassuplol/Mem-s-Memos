/**
 * MEM'S MEMOS — entry point.
 *
 * Follows the proven third-party extension pattern (st-qdrant-memory et al):
 *   - window.jQuery(async () => {...}) init
 *   - settings UI appended to #extensions_settings2 + applyInlineDrawerListeners()
 *   - globalThis.mmInterceptor generation interceptor (chat.splice depth slicing)
 *   - window.eventSource for message events
 *   - window.toastr for user feedback
 *
 * Fail-safe: missing SillyTavern → dev-mock keeps everything loadable.
 * Never touches ST core files, presets, or sampler settings.
 */

import { MODULE_NAME, mergeSettings, validateSettings, isEnabledFor } from './src/config/settings.js';
import { logger } from './src/utils/logger.js';
import { createBus, nowIso, truncateWords } from './src/utils/helpers.js';
import { ModelRouter } from './src/ai/router.js';
import { WriteAheadQueue } from './src/storage/adapter.js';
import { QdrantStore } from './src/storage/qdrant.js';
import { createMetadataStore, LocalVectorStore } from './src/storage/indexeddb.js';
import { StmManager } from './src/engine/stm.js';
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
// GLOBALS (resolved at init time, never at import time)
// ---------------------------------------------------------------------------
let bureau = null;
let host = null;

function getCtx() {
    const st = globalThis.SillyTavern;
    if (st && typeof st.getContext === 'function') {
        try { return st.getContext(); } catch { /* fall through */ }
    }
    return null;
}

function toast(msg, type = 'info', title = "Mem's Memos", opts = {}) {
    const t = globalThis.toastr;
    if (t && typeof t[type] === 'function') {
        t[type](msg, title, opts);
    }
}

function saveSt() {
    const ctx = getCtx();
    ctx?.saveSettingsDebounced?.();
}

// ---------------------------------------------------------------------------
// HOST ADAPTER — wraps ST context for the bureau
// ---------------------------------------------------------------------------
class StHost {
    constructor() {
        this.kind = 'sillytavern';
    }
    getSettings() {
        const ctx = getCtx();
        return ctx?.extensionSettings?.[MODULE_NAME] ?? null;
    }
    setSettings(v) {
        const ctx = getCtx();
        if (ctx) ctx.extensionSettings[MODULE_NAME] = v;
    }
    saveSettings() { saveSt(); }

    inject(text, { depth = 1 } = {}) {
        // We don't use setExtensionPrompt — mmInterceptor handles injection.
        // This is a no-op kept for the InjectionEngine contract.
        return true;
    }
    clearInjection() { /* interceptor handles it */ }

    getScope() {
        const ctx = getCtx();
        const chatId = ctx?.chatId != null ? String(ctx.chatId) : null;
        const charIdx = ctx?.characterId != null ? Number(ctx.characterId) : null;
        const character = Number.isInteger(charIdx) ? ctx?.characters?.[charIdx] : null;
        return {
            chatId,
            chatName: chatId,
            characterId: character?.name || null,
            characterName: character?.name || ctx?.name2 || null,
            personaId: ctx?.name1 || null,
            userId: ctx?.name1 || null,
            date: new Date().toLocaleDateString(),
            isGroup: !!ctx?.groups?.length && !!ctx?.groupId,
        };
    }

    getRecentMessages(n = 8) {
        const ctx = getCtx();
        const chat = ctx?.chat || [];
        return chat.slice(-n).map((m) => ({ name: m.name, text: m.mes, isUser: !!m.is_user }));
    }
    getLastUserMessage() {
        const ctx = getCtx();
        const chat = ctx?.chat || [];
        for (let i = chat.length - 1; i >= 0; i--) {
            if (chat[i].is_user) return chat[i].mes;
        }
        return '';
    }
    messageText(index) {
        const ctx = getCtx();
        return ctx?.chat?.[index]?.mes || '';
    }
    messageInfo(index) {
        const ctx = getCtx();
        const m = ctx?.chat?.[index];
        return m ? { name: m.name, isUser: !!m.is_user } : null;
    }

    on(eventName, handler) {
        const es = globalThis.eventSource;
        if (!es?.on) return () => {};
        const types = globalThis.event_types || {};
        const type = types[eventName] || eventName;
        es.on(type, handler);
        return () => es.off?.(type, handler);
    }

    chatContainer() { return document.querySelector('#chat'); }
    messageSelector() { return '.mes'; }
    messageIndexFor(node) {
        const attr = node.getAttribute('mesid') ?? node.dataset?.mesid;
        if (attr != null && attr !== '') return Number(attr);
        const all = [...document.querySelectorAll('#chat .mes')];
        return all.indexOf(node);
    }

    mountLauncher(onClick) {
        const id = 'mm-launcher';
        if (document.getElementById(id)) return document.getElementById(id);
        const $ = globalThis.$;
        const menu = document.querySelector('#extensionsMenu') || document.querySelector('#extensions-menu');
        const btn = document.createElement('div');
        btn.id = id;
        btn.setAttribute('role', 'button');
        btn.setAttribute('tabindex', '0');
        btn.setAttribute('aria-label', "Open Mem's Memos");
        btn.setAttribute('title', "Mem's Memos — open the Archivist's Desk");
        if (menu && $) {
            btn.className = 'list-group-item flex-container flexGap5 interactable';
            btn.innerHTML = '<i class="fa-solid fa-stamp extensionsMenuExtensionButton" aria-hidden="true"></i><span>Mem\'s Memos</span>';
            menu.appendChild(btn);
        } else {
            btn.className = 'mm-launcher-btn';
            btn.innerHTML = '<i class="fa-solid fa-stamp" aria-hidden="true"></i><span>Memos</span>';
            btn.style.cssText = 'position:fixed;right:10px;bottom:46px;z-index:2999;background:#262019;color:#f2e8d3;border:1px solid #3a3125;border-radius:6px;padding:6px 10px;cursor:pointer;font:12px monospace;display:flex;gap:6px;align-items:center;';
            document.body.appendChild(btn);
        }
        btn.addEventListener('click', onClick);
        btn.addEventListener('keydown', (e) => { if (e.key === 'Enter') onClick(); });
        return btn;
    }

    drawerHost() {
        let el = document.getElementById('mm-drawer-host');
        if (el) return el;
        el = document.createElement('div');
        el.id = 'mm-drawer-host';
        el.className = 'mm-drawer-host mm-hidden';
        document.body.appendChild(el);
        return el;
    }
}

class MockHost {
    constructor() {
        this.kind = 'mock';
        this.settings = null;
        this.chat = [];
        this.injected = null;
        this.listeners = new Map();
        console.warn("[Mem's Memos] SillyTavern not found — dev mock active.");
    }
    getSettings() { return this.settings; }
    setSettings(v) { this.settings = v; }
    saveSettings() {
        try { localStorage.setItem('mems-memos-settings', JSON.stringify(this.settings)); } catch { /* no-op */ }
    }
    loadPersisted() {
        try { return JSON.parse(localStorage.getItem('mems-memos-settings') || 'null'); } catch { return null; }
    }
    inject(text, { depth = 1 } = {}) { this.injected = { text, depth }; return true; }
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
    emit(evt, payload) { for (const fn of this.listeners.get(evt) ?? []) fn(payload); }
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
        let el = document.getElementById('mm-drawer-host');
        if (!el) {
            el = document.createElement('div');
            el.id = 'mm-drawer-host';
            el.className = 'mm-drawer-host';
            document.body.appendChild(el);
        }
        return el;
    }
}

// ---------------------------------------------------------------------------
// BUREAU — wires every subsystem together
// ---------------------------------------------------------------------------
export function createBureau(hostInstance) {
    host = hostInstance;
    const bus = createBus();

    // --- settings
    const persisted = host.kind === 'mock' ? host.loadPersisted() : host.getSettings();
    const settings = validateSettings(mergeSettings(persisted));
    host.setSettings(settings);
    const getSettings = () => settings;
    const saveSettings = () => { validateSettings(settings); host.saveSettings(); };
    logger.setLevel(settings.ui.logLevel);
    const getScope = () => host.getScope();

    // --- test seam
    const testDeps = host._testDeps || {};

    // --- AI + storage
    const router = new ModelRouter(settings, { fetchFn: testDeps.fetchFn });
    const qdrant = new QdrantStore(settings.qdrant, { bridge: settings.bridge, fetchFn: testDeps.fetchFn });
    let meta = null;
    let localVectors = null;
    let wal = null;
    let extraction = null;
    let desk = null;
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
            if (kind === 'injection-failed') toast('Injection failed — shadow mode. Block is copyable in RECALL.', 'warning');
            if (kind === 'injected') refreshMsgDots();
        },
    });

    const consolidation = new ConsolidationEngine({
        meta: null, wal: null, stm, getSettings,
        emit: (kind, payload) => bus.emit(kind, payload),
    });

    // --- bureau context shared by rooms + commands
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
            desk?.refreshLetterhead?.();
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
        showTrace: (id) => traceReport(id),
        showLastTrace: () => showLastTrace(),
        setMode,
        statusReport,
        manualRecall,
        forget,
        sleepReport,
        worldReport,
        knowsReport,
        traceReport: (id) => traceReport(id),
        toggleDrawer: () => toggleDrawer(),
    };

    // --- UI (after ctx exists)
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

    // --- storage bootstrap
    async function rebuildStorage() {
        try {
            meta = meta || (await createMetadataStore());
        } catch (err) {
            logger.error('metadata store init failed', { err: String(err?.message || err) });
            meta = null;
        }
        if (!meta) {
            toast('IndexedDB unavailable — memory will not persist this session.', 'error', "Mem's Memos", { timeOut: 8000 });
            return;
        }
        stm.meta = meta;
        epistemic.meta = meta;
        states.meta = meta;
        extraction.meta = meta;
        retrieval.meta = meta;
        consolidation.meta = meta;

        localVectors = localVectors || new LocalVectorStore(meta);
        if (!wal) {
            wal = new WriteAheadQueue(qdrant, localVectors, (down) => {
                router.setQdrantDown(down);
                desk?.refreshLedger?.(storageLedgerRows());
                if (down) toast('STORAGE OFFLINE — local fallback engaged. Writes are queued.', 'error', "Mem's Memos", { timeOut: 7000 });
                else toast('Qdrant reconnected — queued writes flushed.', 'success', "Mem's Memos");
            });
            extraction.wal = wal;
            retrieval.wal = wal;
            consolidation.wal = wal;
        }
        await wal.reconcile();

        // collection + governance
        const embedCfg = settings.lanes.embed;
        if (embedCfg.model) {
            const dim = embedCfg.dimensions || settings.state.embedDim || 0;
            if (dim > 0) {
                try {
                    const name = qdrant.collectionFor({ model: embedCfg.model, dim });
                    await wal.enqueue('ensure', name, { model: embedCfg.model, dim });
                    settings.state.collection = name;
                } catch (err) {
                    logger.warn('collection ensure failed', { err: String(err?.message || err) });
                }
            }
        }
        checkModelGovernance();
        desk?.refreshLedger?.(storageLedgerRows());
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
            if (mismatch) toast('MODEL MISMATCH — open Ledger → Embedding Governance.', 'error', "Mem's Memos", { timeOut: 8000 });
        }
        if (!storedModel && embedCfg.model) {
            settings.state.embedModel = embedCfg.model;
            saveSettings();
        }
        rooms?.settings?.refresh?.();
    }

    async function reembed({ mode = 'in-place' } = {}) {
        const embedCfg = settings.lanes.embed;
        if (!embedCfg.model) {
            toast('Configure the embed lane first (Ledger → Model Lanes).', 'warning', "Mem's Memos");
            return;
        }
        const job = { total: 0, done: 0, status: 'running', startedAt: nowIso() };
        settings.state.reembedJob = job;
        saveSettings();
        toast('Re-embed job started — progress in the Ledger.', 'info', "Mem's Memos");
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
            toast(`Re-embedded ${job.done} memos into ${newCollection}.`, 'success', "Mem's Memos", { timeOut: 7000 });
        } catch (err) {
            job.status = 'failed';
            job.error = String(err?.message || err);
            saveSettings();
            toast(`Re-embed failed: ${job.error}`, 'error', "Mem's Memos", { timeOut: 7000 });
        }
        rooms?.settings?.refresh?.();
    }

    async function retryFailedEmbeds() {
        const failed = await meta.queryMemories({ status: 'failed_embed' }).catch(() => []);
        if (!failed.length) {
            toast('No failed embeds on file.', 'success', "Mem's Memos");
            return;
        }
        toast(`Retrying ${failed.length} failed embeds…`, 'info', "Mem's Memos");
        for (const m of failed) {
            await extraction._embedAndStore(m, { summaryVector: true });
        }
        toast('Retry pass complete — check the Ledger.', 'success', "Mem's Memos");
    }

    // --- data management
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
        for (const room of Object.values(rooms || {})) room?.refresh?.();
    }

    // --- forgetting
    async function forgetMemory(id) {
        await meta.updateMemory(id, { status: 'deleted', validity_status: 'deleted' });
        const rec = await meta.getMemory(id);
        if (rec?.vector_collection) await wal.enqueue('delete', rec.vector_collection, [id]).catch(() => {});
        await epistemic.forgetMemory(id);
        bus.emit('memory', { forgotten: id });
    }

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

    // --- reports
    function setMode(mode) {
        if (!['on', 'shadow', 'off'].includes(mode)) return `Unknown mode ${mode}`;
        settings.mode = mode;
        saveSettings();
        desk?.setMode?.(mode);
        desk?.refreshLedger?.(storageLedgerRows());
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
        return [
            `TRACE ${rec.id}`,
            `type ${rec.memory_type} · status ${rec.status} · validity ${rec.validity_status}`,
            `importance ${Number(rec.importance ?? 0.5).toFixed(2)} · strength ${Number(rec.strength ?? 1).toFixed(2)} · recalls ${rec.recall_count || 0}`,
            `created ${rec.created_at} by ${rec.extractor_model || 'unknown extractor'}`,
            `vector ${rec.vector_collection || 'none'} · ${rec.embedding_model || 'no model'} ${rec.embedding_dim || ''}d`,
            `knowers [${(rec.knowers_json || []).join(', ')}] secret_from [${(rec.secret_from_json || []).join(', ')}]`,
            ...audit.map((a) => `${a.created_at} ${a.action}: ${truncateWords(JSON.stringify(a.detail || {}), 120)}`),
        ].join('\n');
    }

    function showLastTrace() {
        const trace = injection.getLastTrace();
        if (!trace?.length) {
            toast('No recall has run yet — search in RECALL first.', 'warning', "Mem's Memos");
            return;
        }
        desk?._activate?.('reading');
    }

    // --- eval harness
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
        toast(
            golden.length
                ? `EVAL recall@${k} ${(receipt.recallAtK * 100).toFixed(0)}% · MRR ${receipt.mrr.toFixed(2)} · contradictions ${(receipt.contradictionRate * 100).toFixed(1)}%`
                : 'EVAL: no golden-tagged memos (tag memories with "golden" to build the set).',
            golden.length ? 'success' : 'warning', "Mem's Memos", { timeOut: 7000 },
        );
        return JSON.stringify(receipt, null, 2);
    }

    // --- msgdots
    const stmDots = new Set();
    const ltmDots = new Set();
    const recallDots = new Set();

    function refreshMsgDots() {
        if (!settings.ui.msgDots || !getScope().chatId) {
            desk?.detachMsgDots?.();
            return;
        }
        const container = host.chatContainer?.();
        if (!container) return;
        desk?.attachMsgDots?.({
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

    // --- message + generation wiring
    const unsubscribers = [];

    function wireEvents() {
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

        const onScopeChanged = async () => {
            desk?.detachMsgDots?.();
            stm.clearWindow();
            stmDots.clear();
            ltmDots.clear();
            recallDots.clear();
            desk?.refreshLetterhead?.();
            for (const room of Object.values(rooms || {})) room?.refresh?.();
        };
        unsubscribers.push(host.on('CHAT_CHANGED', async () => {
            await onScopeChanged();
            if (settings.governance.autoConsolidateOnChatChange) {
                consolidation.sleep(getScope().chatId).catch((err) => logger.warn('sleep on chat change failed', { err: String(err?.message || err) }));
            }
        }));
        unsubscribers.push(host.on('CHARACTER_CHANGED', onScopeChanged));
        unsubscribers.push(host.on('CHAT_LOADED', onScopeChanged));
        unsubscribers.push(host.on('PERSONA_CHANGED', onScopeChanged));
    }

    // --- modal desk (centered overlay, megumin-style) -----------------------------
    let drawerOpen = false;
    let modalPanel = null;
    let uiRefreshTimer = null;

    function toggleDrawer(force) {
        const hostEl = host.drawerHost();
        drawerOpen = typeof force === 'boolean' ? force : !drawerOpen;
        if (drawerOpen) {
            hostEl.classList.remove('mm-hidden');
            if (!hostEl.dataset.mounted && hostEl.isConnected !== false) {
                hostEl.dataset.mounted = '1';
                const backdrop = document.createElement('div');
                backdrop.className = 'mm-modal-backdrop';
                backdrop.addEventListener('click', () => toggleDrawer(false));
                hostEl.appendChild(backdrop);

                modalPanel = document.createElement('div');
                modalPanel.className = 'mm-modal-panel';
                applyDrawerWidth(modalPanel, settings.ui.drawerWidth);
                hostEl.appendChild(modalPanel);

                desk.mount(modalPanel);
                makeResizable(modalPanel);
                makeDraggable(modalPanel, modalPanel.querySelector('.mm-letterhead'));
            }
            desk.refreshLetterhead();
            desk.refreshLedger(storageLedgerRows());
            refreshActiveRoom();
            armUiRefresh();
        } else {
            hostEl.classList.add('mm-hidden');
            disarmUiRefresh();
        }
    }

    function refreshActiveRoom() {
        const active = desk?.activeTab;
        if (active && rooms?.[active]?.refresh) rooms[active].refresh();
    }

    function armUiRefresh() {
        clearInterval(uiRefreshTimer);
        uiRefreshTimer = setInterval(() => {
            if (!drawerOpen) return disarmUiRefresh();
            desk?.refreshLetterhead?.();
            refreshActiveRoom();
        }, 4000);
    }
    function disarmUiRefresh() {
        clearInterval(uiRefreshTimer);
        uiRefreshTimer = null;
    }

    function applyDrawerWidth(panel, w) {
        // Old right-side drawer widths (≤ 920) bump to the landscape default.
        const width = !w || w < 920 ? 1240 : w;
        panel.style.width = `${Math.min(1600, Math.max(920, width))}px`;
    }

    function makeResizable(panel) {
        const grip = document.createElement('div');
        grip.className = 'mm-resizer';
        grip.setAttribute('aria-hidden', 'true');
        panel.appendChild(grip);
        let startX = 0;
        let startW = 0;
        const onMove = (e) => {
            const w = startW + (startX - e.clientX);
            applyDrawerWidth(panel, w);
        };
        const onUp = () => {
            document.removeEventListener('mousemove', onMove);
            document.removeEventListener('mouseup', onUp);
            settings.ui.drawerWidth = panel.getBoundingClientRect().width;
            saveSettings();
        };
        grip.addEventListener('mousedown', (e) => {
            startX = e.clientX;
            startW = panel.getBoundingClientRect().width;
            document.addEventListener('mousemove', onMove);
            document.addEventListener('mouseup', onUp);
            e.preventDefault();
        });
    }

    /** Drag the modal by its letterhead. */
    function makeDraggable(panel, handle) {
        if (!handle) return;
        let sx = 0, sy = 0, ox = 0, oy = 0, dragging = false;
        handle.addEventListener('mousedown', (e) => {
            if (e.target.closest('button, a, input, select, textarea')) return;
            dragging = true;
            sx = e.clientX;
            sy = e.clientY;
            const rect = panel.getBoundingClientRect();
            ox = rect.left;
            oy = rect.top;
            panel.style.position = 'fixed';
            panel.style.left = `${ox}px`;
            panel.style.top = `${oy}px`;
            panel.style.margin = '0';
            e.preventDefault();
        });
        document.addEventListener('mousemove', (e) => {
            if (!dragging) return;
            const nx = Math.min(Math.max(-panel.offsetWidth + 120, ox + e.clientX - sx), window.innerWidth - 120);
            const ny = Math.min(Math.max(0, oy + e.clientY - sy), window.innerHeight - 48);
            panel.style.left = `${nx}px`;
            panel.style.top = `${ny}px`;
        });
        document.addEventListener('mouseup', () => { dragging = false; });
    }

    // ESC closes the modal
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && drawerOpen) toggleDrawer(false);
    });

    // --- idle consolidation
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

    /** TEST-ONLY */
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

    // --- boot
    async function start() {
        if (!meta) await rebuildStorage();
        wireEvents();
        host.mountLauncher(() => toggleDrawer());
        registerSlashCommands(ctx, host);
        armIdleConsolidation();
        desk?.refreshLedger?.(storageLedgerRows());
        logger.info('bureau open', { host: host.kind, mode: settings.mode });
        if (host.kind === 'mock') {
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
        desk?.unmount?.();
        document.getElementById('mm-launcher')?.remove();
        document.getElementById('mm-drawer-host')?.remove();
    }

    return Object.assign(ctx, { start, stop, toggleDrawer, storageLedgerRows, _testWireMeta, getScope, settings });
}

// ---------------------------------------------------------------------------
// GENERATION INTERCEPTOR — depth-sliced memory injection via chat.splice
// ---------------------------------------------------------------------------
globalThis.mmInterceptor = async function (chat, contextSize, abort, type) {
    if (!bureau) return;
    try {
        const scope = bureau.getScope();
        if (!scope.chatId) return;
        if (!bureau.isChatEnabled()) return;
        if (bureau.settings.mode === 'off' || bureau.settings.governance.killSwitch) return;

        const query = bureau.host.getLastUserMessage() || '';
        if (!shouldRetrieve(query)) return;

        // Build the block (retrieval + states + epistemic filter)
        const block = await bureau.injection.buildBlock({
            query,
            chatId: scope.chatId,
            characterName: scope.characterName,
            characterId: scope.characterId,
        });

        if (bureau.settings.mode === 'shadow') {
            bureau.injection.lastBlock = block;
            return; // shadow: store but never inject
        }

        // Depth slicing: insert N messages from the end (Author's Note convention)
        const depth = Math.max(0, block.depth ?? bureau.settings.pipeline.injectionDepth);
        const memoryEntry = {
            name: 'System',
            is_user: false,
            is_system: true,
            mes: block.text,
            send_date: Date.now(),
        };
        const insertIndex = Math.max(0, chat.length - depth);
        chat.splice(insertIndex, 0, memoryEntry);

        bureau.injection.lastBlock = block;
        if (bureau.settings.governance.auditTrail) {
            bureau.meta?.audit?.({
                memory_id: null,
                action: 'injected',
                detail: { depth, tokens: block.tokens, memoryCount: block.memoryCount },
            }).catch(() => {});
        }
    } catch (err) {
        logger.warn('mmInterceptor failed — generation unaffected', { err: String(err?.message || err) });
    }
};

// ---------------------------------------------------------------------------
// SETTINGS UI — appended to #extensions_settings2
// ---------------------------------------------------------------------------
function createSettingsUI(bureau) {
    const $ = globalThis.$;
    if (!$) return;
    const settings = bureau.getSettings();
    const scope = bureau.getScope();

    const modeBtn = (label, value) => `
        <div class="menu_button menu_button_icon mm-mode-btn ${settings.mode === value ? 'mm-active-mode' : ''}"
             data-mode="${value}" style="${settings.mode === value ? 'outline:1px solid #d99a2b' : ''}">
            ${label}
        </div>`;

    const html = `
        <div class="mems-memos-settings">
            <div class="inline-drawer">
                <div class="inline-drawer-toggle inline-drawer-header">
                    <b>Mem's Memos</b>
                    <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
                </div>
                <div class="inline-drawer-content">
                    <div id="mm-ext-status" class="text_margins" style="font-family:monospace;font-size:11px;opacity:.75;margin:6px 0;">
                        mode ${settings.mode.toUpperCase()} · ${bureau.wal?.usingFallback ? 'local fallback' : 'qdrant'} · L${bureau.router.degradationLevel()}
                    </div>
                    <div id="mm-open-desk" class="menu_button menu_button_icon">
                        Open the Archivist's Desk
                    </div>
                    <div style="display:flex;gap:6px;margin-top:8px;flex-wrap:wrap;">
                        ${modeBtn('ACTIVE', 'on')}
                        ${modeBtn('SHADOW', 'shadow')}
                        ${modeBtn('OFF', 'off')}
                    </div>
                    <div class="text_margins" style="font-size:11px;opacity:.6;margin-top:8px;">
                        Full configuration lives in the Desk → LEDGER tab.
                        First run is SHADOW: memories are stored, nothing is injected.
                        <br>Desk of: ${scope.characterName || '—'} · File №${scope.chatName || scope.chatId || '—'}
                    </div>
                </div>
            </div>
        </div>
    `;

    const hostCol = document.querySelector('#extensions_settings2')
        || document.querySelector('#extensions_settings');
    if (!hostCol) return;
    hostCol.insertAdjacentHTML('beforeend', html);

    if (typeof globalThis.applyInlineDrawerListeners === 'function') {
        globalThis.applyInlineDrawerListeners();
    }

    $('#mm-open-desk').on('click', () => bureau.toggleDrawer(true));

    hostCol.querySelectorAll('.mm-mode-btn').forEach((btn) => {
        btn.addEventListener('click', () => {
            bureau.setMode(btn.dataset.mode);
            hostCol.querySelectorAll('.mm-mode-btn').forEach((b) => {
                b.style.outline = b.dataset.mode === bureau.getSettings().mode ? '1px solid #d99a2b' : '';
            });
            const statusEl = hostCol.querySelector('#mm-ext-status');
            if (statusEl) {
                statusEl.textContent = `mode ${bureau.getSettings().mode.toUpperCase()} · ${bureau.wal?.usingFallback ? 'local fallback' : 'qdrant'} · L${bureau.router.degradationLevel()}`;
            }
        });
    });
}

// ---------------------------------------------------------------------------
// INIT — jQuery-ready pattern (proven by st-qdrant-memory et al)
// ---------------------------------------------------------------------------
function mmInit() {
    if (bureau) return; // idempotent

    const st = getCtx();
    const hostInstance = st ? new StHost() : new MockHost();

    try {
        bureau = createBureau(hostInstance);
    } catch (err) {
        console.error("[Mem's Memos] bureau creation failed", err);
        toast('Bureau creation failed — see console.', 'error', "Mem's Memos", { timeOut: 10000 });
        return;
    }

    bureau.start().then(() => {
        createSettingsUI(bureau);
        toast(
            `Bureau open — mode ${bureau.getSettings().mode.toUpperCase()}. Click the stamp icon to open the Desk.`,
            'success',
            "Mem's Memos",
            { timeOut: 5000 },
        );
    }).catch((err) => {
        console.error("[Mem's Memos] bureau start failed", err);
        toast('Bureau start failed — see console.', 'error', "Mem's Memos", { timeOut: 10000 });
    });
}

// Primary init path: jQuery ready (fires immediately if DOM is already ready)
if (typeof globalThis.jQuery === 'function') {
    globalThis.jQuery(async () => {
        // Small delay to let ST's own init finish
        await new Promise((r) => setTimeout(r, 100));
        mmInit();
    });
} else {
    // No jQuery — try DOMContentLoaded
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => setTimeout(mmInit, 200));
    } else {
        setTimeout(mmInit, 200);
    }
}

function percentile(arr, p) {
    if (!arr.length) return 0;
    const sorted = [...arr].sort((a, b) => a - b);
    const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * p));
    return Math.round(sorted[idx]);
}
