# MEM'S MEMOS — Architecture

A 12-tier RAG memory pipeline living entirely inside a SillyTavern frontend
extension. Vanilla ES modules, no build step, no runtime dependencies beyond
what ST ships plus one Google Fonts link.

```
message → T1 INGEST ──→ STM buffers ──banter?──→ (immediate only)
              │             │
              │        rolling window (W=6)
              ▼             ▼
         T2 normalize → T3 EXTRACT (fast lane, strict JSON, 1 repair pass)
                              │ events/facts/goals/promises/knowledge/states/world
                              ▼
                     T4 ENCODE (keywords + dense_main/dense_summary, cache)
                              ▼
                     T5 STORE (IndexedDB metadata + Qdrant vectors via WAL)
                              │ semantic dedupe @ cosine ≥ .92
                              ▼
                     T6 CONSOLIDATE (sleep: decay, merge, supersede, forget)
generation ────→ T9 RETRIEVE (expand→HyDE→dense+sparse→graph→EPISTEMIC FILTER)
                              ▼
                     T10 RANK (RRF→weights→rerank→MMR→compress→budget)
                              ▼
                     T11 INJECT (extension-safe slot, depth N, shadow fallback)
T7 EPISTEMIC + T8 STATES + T12 GOVERNANCE are cross-cutting (see below).
```

## Tiers

| Tier | Module | Responsibility |
|---|---|---|
| T1 Ingestion | `src/engine/stm.js` | scope resolution, dedupe hash, redaction, banter pre-filter, async priority queue w/ backpressure, fast lane |
| T2 Normalization | `src/utils/helpers.js` | whitespace/case, UTC timestamps, language sniff, token estimate |
| T3 Extraction | `src/engine/extraction.js` | window-based (not per-message) VectFox tuples + facts/goals/promises/knowledge/state/world; reflection repair ×1; chunk fallback |
| T4 Encoding | `src/engine/extraction.js` | hierarchical parent/child chunks, keywords, dense_main/dense_summary, content-hash embed cache |
| T5 Storage | `src/storage/*` | MetadataStore (IndexedDB) + VectorStore (Qdrant / local brute-force) behind WriteAheadQueue; semantic dedupe; JSONL export/import |
| T6 Consolidation | `src/engine/consolidation.js` | Ebbinghaus reinforcement (S′=S×1.4), fact merge, contradiction supersession, importance boost, archival, forgetting |
| T7 Epistemic | `src/engine/epistemic.js` | mems_knowledge stances; HARD filter per responding character; group isolation; topic-only hints; UI stays omniscient |
| T8 States | `src/engine/states.js` | living entity snapshots + world state; supersession history; observable vs attributed fields |
| T9 Retrieval | `src/engine/retrieval.js` | trigger check, multi-query expansion, HyDE, dense+sparse, 1-hop graph walk, temporal window, scope + epistemic filters |
| T10 Ranking | `src/engine/ranking.js` | RRF → bounded weighted score → rerank (endpoint or chat fallback) → MMR → contextual compression → token budget |
| T11 Injection | `src/engine/injection.js` | preset-safe slot only, Author's-Note depth convention, dry-run, shadow fallback, copyable block |
| T12 Governance | `index.js`, `src/ui/ledger.js` | consent toggles, retention, audit trail, metrics, eval harness, kill switch, model governance + re-embed |

## Model router (`src/ai/router.js`)

Four lanes — `fast` (extraction/expansion/HyDE), `strong`
(rerank/compression/consolidation), `embed`, `rerank` — each with its own
OpenAI-compatible baseUrl/apiKey/model/timeout/retries. Circuit breaker opens
after 3 consecutive failures, half-opens after 60s.

**Degradation ladder:** L0 full → L1 no rerank/compress → L2 no extraction
(keyword+chunk) → L3 Qdrant down (local fallback) → L4 all AI down (STM only).
Chat generation is never touched.

## Storage

- **Metadata:** IndexedDB (`memories`, `stm`, `entity_states`, `world_state`,
  `knowledge`, `cache`, `audit`, `vectors`) — mirrors `docs/SCHEMA.sql`.
- **Vectors:** Qdrant first. Collection fingerprint
  `mems_memos__<model-slug>__<dim>` — one embedding model per collection,
  enforced at startup (MODEL MISMATCH stamp + RE-EMBED / NEW COLLECTION).
  Named vectors `dense_main`/`dense_summary`, sparse `sparse_keywords`,
  scalar quantization default, payload indexes on all scope/time/knower
  fields. Local brute-force fallback behind the same interface; the
  WriteAheadQueue flips stores on outage and replays queued writes.

## Epistemic model

A memory carries `knowers_json` and `secret_from_json`. The injection block
for character X is hard-filtered: denied when X ∈ secret_from, else allowed
when knowers is empty, scope=global, or X (or "user") ∈ knowers. The UI is
omniscient — secrets show as SECRET-stamped cards/envelopes to the *user*,
never to other characters' prompts.

## Scoring (T10, all weights configurable)

```
S_final = clamp01(0.26·sem + 0.13·sparse + 0.13·recency + 0.13·importance
        + 0.08·trust + 0.07·emotion + 0.05·graph + 0.03·novelty
        + 0.02·access + 0.10·composite − P)
P = 0.5 contradicted · 1.0 hidden/rejected · 0.3 confidence < 0.4
recency = exp(−age_h / (half_life_h × strength))
```

## Error → behavior map

| Failure | Behavior |
|---|---|
| extraction fails | raw window stored as chunk, `status=failed_extract` |
| embedding fails | metadata kept, `status=failed_embed`, retry queue |
| Qdrant down | local fallback + STORAGE OFFLINE stamp, WAL replays |
| injection fails | shadow mode + warning toast, copyable block |
| lane timeouts/quota | circuit breaker, degradation ladder, chat unaffected |
| dim mismatch | record stored without vector + MODEL MISMATCH stamp |

## Fail-safety

- No SillyTavern API → dev-mock host keeps the desk fully interactive.
- No indexedDB → clear toast, pipeline idles (never breaks ST load).
- All settings merge over defaults on every read; `saveSettingsDebounced`
  after every mutation; hooks are idempotent (`activated` flag).
