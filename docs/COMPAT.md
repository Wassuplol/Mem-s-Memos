# MEM'S MEMOS — Compatibility

## VectFox tuple mapping

Mem's Memos stores window-extracted events as VectFox-style tuples. The
canonical extraction shape (validated in `validateExtraction`) maps onto the
master record as follows:

| VectFox tuple field | mems_memory_master column | Notes |
|---|---|---|
| `event_type` | `event_type` / `memory_subtype` | free-form verb class (revelation, promise, travel…) |
| `importance` | `importance` | 0..1, drives wax-seal size + double rule ≥ .8 |
| `text` | `text` / `raw_text` / `normalized_text` | verbatim event sentence |
| `datetime` | `event_time` / `when_text` | ISO if parseable, else raw |
| `cause` | `cause` / `why_text` | rendered as linked stub on the Timeline |
| `result` | `result` / `outcome` | linked stub |
| `characters[]` | `characters_json` / `who_json` | also `entity_ids_json` as `char:<lower>` |
| `locations[]` | `locations_json` / `where_text` | first → `where_text` |
| `items[]` | `items_json` | STM ITEMS tray |
| `concepts[]` | `concepts_json` / `tags_json` | |
| `emotion` | `emotion` | + `valence`/`arousal` columns |
| `knowers[]` | `knowers_json` | epistemic HARD filter input |
| `secret_from[]` | `secret_from_json` | epistemic exclusion |
| `confidence` | `confidence` | 0..1 |

Companion arrays (`facts`, `goals`, `promises`, `emotions`, `knowledge`,
`state_updates`, `world`) map to their respective tables/engines as documented
in `docs/ARCHITECTURE.md` (T3/T7/T8).

## Import adapter (user-provided exports)

`Ledger → IMPORT JSONL` accepts the native `mems-memos/v1` bundle **or** a
tolerant VectFox-style JSON/JSONL export. For each record, the importer looks
for (in order): `text|content|memory|what`, `event_type|type`,
`characters|who|agents`, `knowers`, `secret_from|secretFrom|hidden_from`,
`importance`, `datetime|time|timestamp`. Missing fields get safe defaults
(scope=chat, status=active, importance=0.5, unattributed/public epistemics).
Records are run through the normal T4/T5 path (keywords + embeddings) so
imported memories participate in retrieval immediately.

## SillyTavern compatibility

| Surface | Requirement |
|---|---|
| `manifest.json` hooks (`install/update/delete/enable/disable/activate`) | ST ≥ 1.17 (falls back to jQuery-ready init on 1.12+) |
| Injection slot | `setExtensionPrompt` via `SillyTavern.getContext()`; missing → shadow mode automatically |
| Slash commands | `SlashCommandParser.addCommandObject(SlashCommand.fromProps(...))`; legacy `registerSlashCommand` not required |
| Message indices | `MESSAGE_SENT/RECEIVED` payloads may be index number or object — both handled |
| Group chats | per-character epistemic slices; retrieval keyed on the responding character's display name |
| Font Awesome | `fa-solid` classes bundled by ST (no icon dependency added) |

## Endpoint compatibility (OpenAI-compatible)

| Service | Chat | Embeddings | Notes |
|---|---|---|---|
| Ollama (`:11434/v1`) | ✓ | ✓ | default prefill |
| LM Studio (`:1234/v1`) | ✓ | ✓ | |
| llama.cpp server | ✓ | ✓ | |
| vLLM | ✓ | ✓ | some builds also serve `/rerank` |
| OpenAI / Azure-style | ✓ | ✓ | apiKey required |
| TEI / Jina-style rerankers | — | — | `/rerank` lane, chat fallback built in |

Matryoshka `dimensions` truncation is sent only when configured (> 0) —
Qwen3-Embedding 32..4096, nomic 64..768. Prefix models (nomic/E5) are
supported via `docPrefix`/`queryPrefix` settings; queries are always embedded
with identical settings to stored documents.

## Qdrant compatibility

REST API v1.x. Collections use named vectors (`dense_main`, `dense_summary`)
+ a sparse vector slot (`sparse_keywords`); payload indexes are created with
`keyword` fallback when `datetime` schema is unavailable (older servers).
Scalar quantization by default; binary offered at dim ≥ 2048. Works keyless
on localhost and keyed over HTTPS; CORS issues are solved by
`bridge/server.js` (127.0.0.1-only proxy).
