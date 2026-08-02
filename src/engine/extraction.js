/**
 * T3 + T4 + T5-write — Window-based extraction, reflection repair,
 * hierarchical encoding, semantic dedupe at ingest.
 *
 * Evaluates a rolling window of the last W messages (never per-message) and
 * emits VectFox-style event tuples + facts + goals + promises + knowledge
 * attributions + state updates + world deltas. Strict JSON schema is
 * validated; one repair pass; fallback stores the raw text as a chunk.
 */

import {
    uuid, nowIso, estimateTokens, clamp01, dedupeHash, keywordTokens,
    detectLanguage, cosine, truncateWords, parseJsonLoose,
} from '../utils/helpers.js';
import { logger } from '../utils/logger.js';
import { STM_BUFFERS } from './stm.js';

export const EXTRACTION_SCHEMA_HINT = `{
  "window_summary": "",
  "events": [{"event_type":"","importance":0.5,"text":"","datetime":"","cause":"",
              "result":"","characters":[],"locations":[],"items":[],"concepts":[],
              "emotion":"","valence":0,"arousal":0,"knowers":[],"secret_from":[],
              "confidence":0.9}],
  "facts": [{"subject":"","predicate":"","object":"","confidence":0.9,"valid_when":""}],
  "goals": [{"owner":"","goal":"","status":"active","importance":0.8}],
  "promises": [{"speaker":"","listener":"","promise":"","status":"pending"}],
  "emotions": [{"subject":"","emotion":"","valence":0,"arousal":0}],
  "knowledge": [{"knower":"","claim":"","stance":"knows","confidence":0.9}],
  "state_updates": [{"entity":"","entity_type":"character","field":"outfit",
                     "value":"","confidence":0.9}],
  "world": {"scene":"","time_of_day":"","weather":"","mood":"","active_factions":[]},
  "keywords": []
}`;

export function buildExtractionPrompt({ window, characterName, userName }) {
    const transcript = window
        .map((m) => `${m.speaker || (m.isUser ? userName || 'User' : characterName || 'Character')}: ${m.text}`)
        .join('\n');
    return [
        {
            role: 'system',
            content: [
                'You are the extraction engine of a memory bureau. Analyze the conversation window and output STRICT JSON only — no markdown fences, no commentary.',
                'Rules: JSON only. No invented facts. Empty arrays when unknown. Preserve names exactly as written. importance/confidence are 0..1.',
                'Emit events ONLY for concrete happenings, claims, decisions, or state changes — NEVER for banter, greetings, or filler.',
                'knowers lists everyone who plausibly learned the information in this window (use exact speaker names; include "user" when the human knows). secret_from lists characters explicitly excluded from the information.',
                'state_updates describe living snapshot fields: character(outfit,injuries,mood,status,location), place(hazards,occupants,atmosphere,location), object(holder,location,condition), faction(stance,hostility,strength).',
                'Output schema (match exactly):',
                EXTRACTION_SCHEMA_HINT,
            ].join('\n'),
        },
        {
            role: 'user',
            content: `Conversation window (most recent last):\n${transcript}\n\nOutput the JSON object now.`,
        },
    ];
}

export function buildRepairPrompt({ broken, error }) {
    return [
        {
            role: 'system',
            content: 'You repair malformed JSON. Output STRICT JSON only, matching the requested schema exactly. No commentary.',
        },
        {
            role: 'user',
            content: `The following output failed validation (${error}). Repair it into valid JSON matching this schema:\n${EXTRACTION_SCHEMA_HINT}\n\nBroken output:\n${broken}`,
        },
    ];
}

/** Validate + normalize the extraction result. Returns {ok, value, error}. */
export function validateExtraction(value) {
    if (!value || typeof value !== 'object') return { ok: false, error: 'not an object' };
    const arr = (v) => (Array.isArray(v) ? v : []);
    const str = (v) => (typeof v === 'string' ? v : v == null ? '' : String(v));
    const num01 = (v, d = 0.5) => clamp01(typeof v === 'number' ? v : Number(v) || d);
    const strArr = (v) => arr(v).map(str).filter(Boolean);

    try {
        const out = {
            window_summary: str(value.window_summary),
            events: arr(value.events).map((e) => ({
                event_type: str(e?.event_type) || 'event',
                importance: num01(e?.importance, 0.5),
                text: str(e?.text),
                datetime: str(e?.datetime),
                cause: str(e?.cause),
                result: str(e?.result),
                characters: strArr(e?.characters),
                locations: strArr(e?.locations),
                items: strArr(e?.items),
                concepts: strArr(e?.concepts),
                emotion: str(e?.emotion),
                valence: typeof e?.valence === 'number' ? Math.max(-1, Math.min(1, e.valence)) : 0,
                arousal: num01(e?.arousal, 0),
                knowers: strArr(e?.knowers),
                secret_from: strArr(e?.secret_from),
                confidence: num01(e?.confidence, 0.9),
            })).filter((e) => e.text),
            facts: arr(value.facts).map((f) => ({
                subject: str(f?.subject),
                predicate: str(f?.predicate),
                object: typeof f?.object === 'string' ? f.object : str(f?.object),
                confidence: num01(f?.confidence, 0.9),
                valid_when: str(f?.valid_when),
            })).filter((f) => f.subject && f.predicate),
            goals: arr(value.goals).map((g) => ({
                owner: str(g?.owner),
                goal: str(g?.goal),
                status: str(g?.status) || 'active',
                importance: num01(g?.importance, 0.8),
            })).filter((g) => g.goal),
            promises: arr(value.promises).map((p) => ({
                speaker: str(p?.speaker),
                listener: str(p?.listener),
                promise: str(p?.promise),
                status: str(p?.status) || 'pending',
            })).filter((p) => p.promise),
            emotions: arr(value.emotions).map((e) => ({
                subject: str(e?.subject),
                emotion: str(e?.emotion),
                valence: typeof e?.valence === 'number' ? Math.max(-1, Math.min(1, e.valence)) : 0,
                arousal: num01(e?.arousal, 0),
            })).filter((e) => e.emotion),
            knowledge: arr(value.knowledge).map((k) => ({
                knower: str(k?.knower),
                claim: str(k?.claim),
                stance: ['knows', 'believes', 'suspects', 'denies', 'told', 'secret_from'].includes(k?.stance)
                    ? k.stance : 'knows',
                confidence: num01(k?.confidence, 0.9),
            })).filter((k) => k.knower && k.claim),
            state_updates: arr(value.state_updates).map((s) => ({
                entity: str(s?.entity),
                entity_type: ['character', 'place', 'object', 'faction'].includes(s?.entity_type)
                    ? s.entity_type : 'character',
                field: str(s?.field),
                value: typeof s?.value === 'string' ? s.value : str(s?.value),
                confidence: num01(s?.confidence, 0.9),
            })).filter((s) => s.entity && s.field),
            world: value.world && typeof value.world === 'object' ? {
                scene: str(value.world.scene),
                time_of_day: str(value.world.time_of_day),
                weather: str(value.world.weather),
                mood: str(value.world.mood),
                active_factions: strArr(value.world.active_factions),
            } : { scene: '', time_of_day: '', weather: '', mood: '', active_factions: [] },
            keywords: strArr(value.keywords),
        };
        return { ok: true, value: out };
    } catch (err) {
        return { ok: false, error: String(err?.message || err) };
    }
}

export class ExtractionEngine {
    /**
     * @param {object} deps
     * @param {import('../ai/router.js').ModelRouter} deps.router
     * @param {import('../storage/adapter.js').MetadataStore} deps.meta
     * @param {import('../storage/adapter.js').WriteAheadQueue} deps.wal
     * @param {()=>object} deps.getSettings
     * @param {object} [deps.io] — side-effect callbacks (states, epistemic, stm chips)
     */
    constructor({ router, meta, wal, getSettings, io = {} }) {
        this.router = router;
        this.meta = meta;
        this.wal = wal;
        this.getSettings = getSettings;
        this.io = io; // { applyStateUpdates, applyWorld, applyKnowledge, putChip, emit }
    }

    _emit(kind, payload) {
        this.io.emit?.(kind, payload);
    }

    /**
     * Main entry (called from the STM queue — never from the chat hot path).
     * @param {{window:Array, scope:object, entry:object, pinned:boolean}} job
     */
    async process(job) {
        const settings = this.getSettings();
        const level = this.router.degradationLevel();
        const scope = job.scope;
        const base = this._baseRecord(scope, job);

        if (level >= 2) {
            // L2+: no extraction — store the window as a plain chunk (T-error map)
            await this._storeChunkFallback(base, job, 'degraded');
            return { extracted: false, degraded: true };
        }

        let parsed = null;
        let rawContent = '';
        try {
            const messages = buildExtractionPrompt({
                window: job.window,
                characterName: scope.characterName,
                userName: 'user',
            });
            const res = await this.router.run('fast', (client) =>
                client.chat(messages, { temperature: 0.1, responseFormat: 'json' }),
            );
            rawContent = res.content;
            parsed = parseJsonLoose(rawContent);
            let check = validateExtraction(parsed);
            if (!check.ok) {
                // Reflection loop: exactly one repair pass (T3)
                logger.info('extraction validation failed — repair pass', { error: check.error });
                const repair = await this.router.run('fast', (client) =>
                    client.chat(buildRepairPrompt({ broken: rawContent.slice(0, 6000), error: check.error }), {
                        temperature: 0,
                        responseFormat: 'json',
                    }),
                );
                rawContent = repair.content;
                parsed = parseJsonLoose(rawContent);
                check = validateExtraction(parsed);
            }
            if (!check.ok) throw new Error(`reflection repair failed: ${check.error}`);
            await this._persistExtraction(check.value, base, job, res);
            return { extracted: true, data: check.value };
        } catch (err) {
            logger.warn('extraction failed — chunk fallback', { err: String(err?.message || err) });
            await this._storeChunkFallback(base, job, String(err?.message || err), rawContent);
            return { extracted: false, error: String(err?.message || err) };
        }
    }

    _baseRecord(scope, job) {
        const settings = this.getSettings();
        return {
            uuid: uuid(),
            schema_version: 1,
            payload_version: 1,
            tenant_id: 'default',
            user_id: scope.userId || null,
            persona_id: scope.personaId || null,
            character_id: scope.characterId || null,
            chat_id: scope.chatId,
            session_id: scope.sessionId || null,
            message_id: job?.entry?.source_message_ids_json?.[0] || null,
            source_id: job?.entry?.stm_id || null,
            parent_id: null,
            thread_id: null,
            scope: 'chat',
            buffer_type: null,
            chunk_role: 'atomic',
            lane: job?.pinned ? 'fast' : 'batch',
            created_at: nowIso(),
            updated_at: nowIso(),
            ingested_at: nowIso(),
            last_accessed: nowIso(),
            source_type: 'chat',
            source_role: job?.entry?._isUser ? 'user' : 'assistant',
            source_name: job?.entry?._speaker || null,
            extractor_model: this.router.client('fast')?.model || null,
            extractor_version: '1.0.0',
            evidence_ids_json: job?.window?.map((w) => w.messageId).filter(Boolean) || [],
            consent: 'granted',
            retention_policy: settings.governance.retentionPolicy,
            validity_status: 'active',
            verification_status: 'unverified',
            status: 'active',
            half_life_hours: settings.pipeline.halfLifeHours,
            strength: 1,
            access_count: 0,
            recall_count: 0,
            reinforcement_count: 0,
            retrieval_count: 0,
        };
    }

    /** Extraction failed/degraded → store raw window as chunk (error mapping). */
    async _storeChunkFallback(base, job, errorNote, rawContent = '') {
        const text = job.window.map((m) => `${m.speaker}: ${m.text}`).join('\n');
        const record = {
            ...base,
            id: uuid(),
            memory_type: 'chunk',
            memory_subtype: 'window',
            raw_text: text,
            normalized_text: text,
            text: rawContent ? `${text}\n\n[extractor note]: ${truncateWords(rawContent, 500)}` : text,
            summary: null,
            keywords_json: keywordTokens(text).slice(0, 24),
            status: errorNote === 'degraded' ? 'active' : 'failed_extract',
            error: errorNote === 'degraded' ? null : String(errorNote).slice(0, 500),
            importance: 0.3,
            dedupe_hash: dedupeHash(base.chat_id, text),
        };
        await this.meta.putMemory(record);
        await this._embedAndStore(record, { summaryVector: false });
        this._emit('memory', record);
        return record;
    }

    async _persistExtraction(data, base, job, llmRes) {
        const settings = this.getSettings();
        const created = [];
        const windowHash = dedupeHash(base.chat_id, job.window.map((m) => m.text).join('|'));

        // --- events (VectFox tuples) --------------------------------------
        for (const ev of data.events) {
            const record = {
                ...base,
                id: uuid(),
                memory_type: 'event',
                memory_subtype: ev.event_type,
                event_type: ev.event_type,
                raw_text: ev.text,
                normalized_text: ev.text,
                text: ev.text,
                summary: truncateWords(ev.text, 240),
                gist: null,
                cause: ev.cause || null,
                result: ev.result || null,
                keywords_json: [...new Set([...keywordTokens(ev.text), ...data.keywords])].slice(0, 24),
                tags_json: ev.concepts,
                concepts_json: ev.concepts,
                language: detectLanguage(ev.text),
                event_time: ev.datetime || base.created_at,
                who_json: ev.characters,
                what_text: ev.text,
                where_text: ev.locations[0] || null,
                when_text: ev.datetime || null,
                why_text: ev.cause || null,
                emotion: ev.emotion || null,
                emotional_valence: ev.valence,
                emotional_arousal: ev.arousal,
                importance: ev.importance,
                confidence: ev.confidence,
                characters_json: ev.characters,
                entity_ids_json: ev.characters.map((c) => `char:${c.toLowerCase()}`),
                items_json: ev.items,
                locations_json: ev.locations,
                knowers_json: settings.consent.storeSecrets ? ev.knowers : ev.knowers.filter((k) => !ev.secret_from.length),
                secret_from_json: settings.consent.storeSecrets ? ev.secret_from : [],
                epistemic_scope: ev.secret_from.length ? 'attributed' : ev.knowers.length ? 'attributed' : 'public',
                dedupe_hash: dedupeHash(base.chat_id, ev.text),
            };
            const kept = await this._dedupeAndStore(record, settings);
            if (kept) created.push(kept);
        }

        // --- facts ----------------------------------------------------------
        for (const f of data.facts) {
            const text = `${f.subject} ${f.predicate} ${f.object}`;
            const record = {
                ...base,
                id: uuid(),
                memory_type: 'fact',
                subject_id: `name:${f.subject.toLowerCase()}`,
                subject_name: f.subject,
                predicate: f.predicate,
                object_name: f.object,
                raw_text: text,
                normalized_text: text,
                text,
                summary: text,
                keywords_json: [...new Set([...keywordTokens(text), ...data.keywords])].slice(0, 24),
                importance: 0.55,
                confidence: f.confidence,
                valid_from: base.created_at,
                entity_ids_json: [`name:${f.subject.toLowerCase()}`],
                dedupe_hash: dedupeHash(base.chat_id, text),
            };
            const kept = await this._dedupeAndStore(record, settings);
            if (kept) created.push(kept);
        }

        // --- goals -----------------------------------------------------------
        for (const g of data.goals) {
            const record = {
                ...base,
                id: uuid(),
                memory_type: 'goal',
                subject_name: g.owner,
                goal: g.goal,
                plan: null,
                raw_text: g.goal,
                normalized_text: g.goal,
                text: g.goal,
                summary: truncateWords(g.goal, 200),
                keywords_json: keywordTokens(g.goal).slice(0, 16),
                importance: g.importance,
                entity_ids_json: g.owner ? [`name:${g.owner.toLowerCase()}`] : [],
                dedupe_hash: dedupeHash(base.chat_id, `goal:${g.goal}`),
            };
            const kept = await this._dedupeAndStore(record, settings);
            if (kept) created.push(kept);
            await this.io.putChip?.(STM_BUFFERS.GOAL, g.owner || 'goal', g.goal, base, {
                priority: g.importance,
            });
        }

        // --- promises ---------------------------------------------------------
        for (const p of data.promises) {
            const text = `${p.speaker} promised ${p.listener}: ${p.promise}`;
            const record = {
                ...base,
                id: uuid(),
                memory_type: 'promise',
                subject_name: p.speaker,
                object_name: p.listener,
                promise: p.promise,
                obligation: p.promise,
                raw_text: text,
                normalized_text: text,
                text,
                summary: truncateWords(text, 200),
                keywords_json: keywordTokens(text).slice(0, 16),
                importance: 0.7,
                dedupe_hash: dedupeHash(base.chat_id, text),
            };
            const kept = await this._dedupeAndStore(record, settings);
            if (kept) created.push(kept);
            await this.io.putChip?.(STM_BUFFERS.PROMISE, p.speaker, p.promise, base, { priority: 0.7 });
        }

        // --- emotions → STM tray ----------------------------------------------
        for (const em of data.emotions) {
            await this.io.putChip?.(STM_BUFFERS.EMOTION, em.subject, `${em.subject}: ${em.emotion}`, base, {
                emotion: em.emotion, valence: em.valence, arousal: em.arousal, priority: 0.4,
            });
        }

        // --- entities/items/locations → STM trays ------------------------------
        const allEntities = new Set();
        for (const ev of data.events) {
            ev.characters.forEach((c) => allEntities.add(['entity', c]));
            ev.items.forEach((i) => allEntities.add(['item', i]));
            ev.locations.forEach((l) => allEntities.add(['location', l]));
        }
        for (const [kind, name] of allEntities) {
            const tray = kind === 'item' ? STM_BUFFERS.ITEM : kind === 'location' ? STM_BUFFERS.LOCATION : STM_BUFFERS.ENTITY;
            await this.io.putChip?.(tray, name, name, base, { priority: 0.35 });
        }

        // --- knowledge attributions (T7) ---------------------------------------
        if (data.knowledge.length) {
            await this.io.applyKnowledge?.(data.knowledge, base, created);
        }

        // --- entity/world state updates (T8) ------------------------------------
        if (data.state_updates.length) {
            await this.io.applyStateUpdates?.(data.state_updates, base);
        }
        const w = data.world;
        if (w.scene || w.time_of_day || w.weather || w.mood || w.active_factions.length) {
            await this.io.applyWorld?.(w, base);
        }

        // --- window summary → parent chunk (hierarchical, T4) --------------------
        if (data.window_summary && created.length) {
            const parent = {
                ...base,
                id: uuid(),
                memory_type: 'summary',
                memory_subtype: 'window',
                chunk_role: 'parent',
                raw_text: data.window_summary,
                normalized_text: data.window_summary,
                text: data.window_summary,
                summary: data.window_summary,
                keywords_json: data.keywords.slice(0, 24),
                importance: Math.max(...created.map((c) => c.importance || 0.5)) * 0.9,
                confidence: 0.85,
                dedupe_hash: windowHash,
            };
            await this.meta.putMemory(parent);
            await this._embedAndStore(parent, { summaryVector: true });
            // link children → parent
            for (const child of created) {
                await this.meta.updateMemory(child.id, { parent_id: parent.id });
            }
            created.push(parent);
        }

        for (const rec of created) this._emit('memory', rec);
        return created;
    }

    /**
     * T5 semantic dedupe at ingest: exact hash first; then cosine vs recent
     * same-scope active events (threshold default .92). On duplicate, the
     * survivor is REINFORCED (strength + access_count) and the new one dropped.
     */
    async _dedupeAndStore(record, settings) {
        const existing = await this.meta.queryMemories({
            chat_id: record.chat_id,
            dedupe_hash: record.dedupe_hash,
            status: 'active',
        });
        if (existing.length) {
            const survivor = existing[0];
            await this.meta.updateMemory(survivor.id, {
                strength: Math.min(3, (survivor.strength || 1) + 0.2),
                access_count: (survivor.access_count || 0) + 1,
                last_reinforced_at: nowIso(),
            });
            this._emit('reinforced', survivor);
            return null;
        }

        await this.meta.putMemory(record);
        const vectorized = await this._embedAndStore(record, { summaryVector: true });
        if (vectorized?.vector?.dense_main) {
            // cosine check against the 50 nearest same-scope memories
            try {
                const near = await this.wal.active.searchDense(
                    vectorized.collection,
                    vectorized.vector.dense_main,
                    {
                        topK: 5,
                        namedVector: 'dense_main',
                        filter: {
                            chat_id: record.chat_id,
                            memory_types: [record.memory_type],
                            validity_not: ['deleted', 'superseded'],
                        },
                    },
                );
                const dup = near.find(
                    (h) => h.id !== record.id && h.score >= settings.pipeline.dedupeThreshold,
                );
                if (dup) {
                    // reinforce survivor, mark the new record as a duplicate
                    await this.meta.updateMemory(record.id, {
                        status: 'archived',
                        duplicate_of: dup.id,
                        validity_status: 'superseded',
                        superseded_by: dup.id,
                    });
                    await this.meta.updateMemory(dup.id, {
                        strength: Math.min(3, (dup.payload?.strength || 1) * 1.2),
                        reinforcement_count: (dup.payload?.reinforcement_count || 0) + 1,
                        last_reinforced_at: nowIso(),
                    });
                    await this.wal.enqueue('delete', vectorized.collection, [record.id]);
                    this._emit('deduped', { dropped: record.id, survivor: dup.id, score: dup.score });
                    return null;
                }
            } catch (err) {
                logger.debug('semantic dedupe skipped', { err: String(err?.message || err) });
            }
        }
        return record;
    }

    /**
     * T4 encoding: keywords + dense embeddings (dense_main over text,
     * dense_summary over summary) with content-hash cache; upsert via WAL.
     * Embedding failure → metadata-only record with status=failed_embed.
     */
    async _embedAndStore(record, { summaryVector = true } = {}) {
        const settings = this.getSettings();
        const embedLane = settings.lanes.embed;
        const collection = this.wal.active.collectionFor({
            model: embedLane.model || 'unconfigured',
            dim: embedLane.dimensions || settings.state.embedDim || 0,
        });

        if (!this.router.available('embed') || !embedLane.model) {
            await this.meta.updateMemory(record.id, { status: 'failed_embed', error: 'embed lane unavailable' });
            return null;
        }

        try {
            const docPrefix = embedLane.docPrefix || '';
            const cacheKey = `emb:${embedLane.model}:${embedLane.dimensions || 0}:${dedupeHash('', docPrefix + record.text)}`;
            let main = await this.meta.cacheGet(cacheKey);
            let summaryVec = null;
            let dim = 0;
            let modelUsed = embedLane.model;

            if (!main) {
                const inputs = [docPrefix + record.text];
                if (summaryVector && record.summary && record.summary !== record.text) {
                    inputs.push(docPrefix + record.summary);
                }
                const res = await this.router.run('embed', (client) =>
                    client.embed(inputs, {
                        dimensions: embedLane.dimensions || 0,
                        instruction: embedLane.instruction || '',
                    }),
                );
                main = res.vectors[0];
                summaryVec = res.vectors[1] || null;
                dim = res.dim;
                modelUsed = res.model || modelUsed;
                await this.meta.cachePut(cacheKey, main, 7 * 24 * 3600 * 1000);
            } else {
                dim = main.length;
            }

            // dimension guard (governance)
            const want = settings.state.embedDim;
            if (want && dim && want !== dim) {
                logger.warn('embedding dim mismatch — record stored without vector', { want, got: dim });
                await this.meta.updateMemory(record.id, {
                    status: 'failed_embed',
                    error: `dim mismatch: stored ${want}, model returned ${dim}`,
                });
                return null;
            }

            const vector = { dense_main: main };
            if (summaryVec) vector.dense_summary = summaryVec;
            else vector.dense_summary = main;

            const payload = payloadOf(record);
            await this.wal.enqueue('upsert', collection, [{
                id: record.id,
                vector,
                payload,
            }]);
            await this.meta.updateMemory(record.id, {
                embedding_model: modelUsed,
                embedding_dim: dim,
                vector_id: record.id,
                vector_collection: collection,
                status: record.status === 'failed_embed' ? 'active' : record.status,
                error: null,
            });
            return { vector, collection, dim };
        } catch (err) {
            logger.warn('embedding failed', { err: String(err?.message || err) });
            await this.meta.updateMemory(record.id, {
                status: 'failed_embed',
                error: String(err?.message || err).slice(0, 500),
            });
            return null;
        }
    }
}

/** Payload mirror for Qdrant / local store (filterable fields only + text). */
export function payloadOf(record) {
    return {
        tenant_id: record.tenant_id,
        user_id: record.user_id,
        persona_id: record.persona_id,
        character_id: record.character_id,
        chat_id: record.chat_id,
        memory_type: record.memory_type,
        memory_subtype: record.memory_subtype,
        status: record.status,
        scope: record.scope,
        chunk_role: record.chunk_role,
        validity_status: record.validity_status,
        subject_id: record.subject_id,
        object_id: record.object_id,
        entity_ids_json: record.entity_ids_json || [],
        knowers_json: record.knowers_json || [],
        secret_from_json: record.secret_from_json || [],
        keywords_json: record.keywords_json || [],
        importance: record.importance ?? 0.5,
        strength: record.strength ?? 1,
        trust: record.trust ?? 0.8,
        confidence: record.confidence ?? 0.9,
        event_time: record.event_time,
        created_at: record.created_at,
        valid_from: record.valid_from,
        text: truncateWords(record.text || '', 800),
        summary: record.summary ? truncateWords(record.summary, 400) : null,
        parent_id: record.parent_id || null,
        embedding_model: record.embedding_model || null,
        reinforcement_count: record.reinforcement_count || 0,
        emotional_valence: record.emotional_valence ?? 0,
    };
}

/** Cosine helper re-exported for tests. */
export { cosine };
