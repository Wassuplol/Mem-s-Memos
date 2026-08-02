# MEM'S MEMOS

*A bureau of memory, run by a meticulous archivist.*

Mem's Memos is a maximum-capability, 12-tier RAG memory pipeline for
SillyTavern: short-term buffers, long-term episodic/semantic/entity memory,
epistemic tracking (who knows what), living entity & world state cards,
VectFox-style windowed event tuples, HyDE + hybrid retrieval over Qdrant,
OpenAI-compatible endpoints everywhere, model routing with degradation, and
embedding-model governance — all behind a gorgeous "Archivist's Desk" UI of
paper index cards, rubber stamps, red string, and brass.

---

## Install

1. Copy this folder into
   `SillyTavern/public/scripts/extensions/third-party/Mem's Memos/`
   (or **Extensions → Install from URL** pointing at the git repo).
2. Reload SillyTavern. A **Memos** launcher appears (extensions menu / top bar).
3. Click it — the Archivist's Desk slides open on the right.

First run is **SHADOW** mode: the bureau stores everything and injects
nothing. Flip to **ACTIVE** in `Ledger → Bureau Mode` (or `/mm on`) when your
lanes are configured.

## The seven rooms

| Tab | Room | What lives there |
|---|---|---|
| LIVE | The Blotter | ● REC ticker, five STM trays (ENTITIES/GOALS/ITEMS/MOOD/SCENE), token budget bar, FREEZE / SHRED / CONSOLIDATE |
| RECALL | The Reading Room | brass-pull search + filters, fanned result cards with score stamps, full pipeline receipt, COPY BLOCK / DRY RUN |
| FACTS | The Card Catalog | fact drawers + Entity State Cards (character/place/object/faction) |
| EVENTS | The Timeline Rail | windowed event cards on clothespins, valence-tinted, cause→result stubs |
| GRAPH | The String Board | entity co-occurrence graph with red bezier strings |
| KNOWS | The Dossier | per-entity "Knows" cards vs sealed "Does not know" envelopes |
| LEDGER | Settings | lane TEST stamps, depth slicing, ink-level weights, governance, export/import/wipe, re-embed |

## Endpoints (Ledger → Model Lanes)

Four lanes, each OpenAI-compatible — the pipeline LLM is configured
**separately** from your chat LLM and never reuses the chat endpoint.

| Lane | Used for | Default |
|---|---|---|
| fast | window extraction, query expansion, HyDE | `http://localhost:11434/v1` (Ollama) |
| strong | rerank fallback, contextual compression | same |
| embed | all embeddings (+ Matryoshka dims, prefixes) | same |
| rerank | optional `/rerank` endpoint (TEI/Jina/vLLM) | blank = chat fallback on strong |

Every row has a **TEST** button → verdigris `OK · 84ms` or red
`FAIL · timeout` stamp. Embed TEST reports the returned dimensions and warns
on mismatch with the configured dim. Local servers (Ollama, LM Studio,
llama.cpp, vLLM) and keyed web endpoints both work.

## Qdrant

Default vector store: `http://localhost:6333`, no key. One collection per
embedding model fingerprint — `mems_memos__<model>__<dim>` — with named
vectors `dense_main`/`dense_summary`, sparse `sparse_keywords`, scalar
quantization, and payload indexes on all scope/time/knower fields.

Switch the embedding model and you'll get a red **MODEL MISMATCH** stamp with
two honest actions: **RE-EMBED** (background job with a ledger receipt) or
**NEW COLLECTION**. Vectors from different models are never silently mixed.

If Qdrant goes down mid-session, the bureau flips to a local brute-force
fallback, stamps **STORAGE OFFLINE**, and replays the write-ahead queue when
it recovers.

## CORS and the local bridge

Browsers block direct calls to some local servers. Optional zero-dependency
bridge (keeps keys out of the browser entirely):

```bash
node bridge/server.js            # 127.0.0.1:8787
# env: QDRANT_URL QDRANT_API_KEY EMBED_URL EMBED_API_KEY CHAT_URL CHAT_API_KEY
```

Then enable `Ledger → Local bridge`. Endpoints: `/health`, `/qdrant/proxy`,
`/embed`, `/chat`, `/backup/export`, `/backup/import`.

## Slash commands (`/mm`)

```
/mm on | off | shadow | status        bureau mode + status receipt
/mm recall <query>                    hybrid recall with pipeline receipt
/mm forget last | chat | character <name> | entity <name>
/mm export | import | wipe            archive management
/mm sleep | consolidate               run the sleep cycle now
/mm world                             world-state snapshot
/mm knows <entity>                    epistemic slice (knows vs sealed)
/mm trace <id>                        full provenance receipt
/mm eval                              golden-QA: recall@k, MRR, contradiction rate
/mm reembed                           re-embed all memories with current model
```

## How memory behaves

- **Epistemic honesty.** Characters only know what they know. A secret told
  to Mira is hard-filtered out of the Captain's prompt — in group chats every
  character's slice is independent. The *user* sees everything (SECRET-stamped)
  in the Dossier; only prompts are filtered.
- **Forgetting.** Ebbinghaus decay (half-life 168h default, strength-scaled),
  consolidation sleep cycles (fact merge, contradiction supersession — newer +
  higher trust wins, history kept), `/mm forget …`, retention policies, and a
  kill switch. Forgotten cards burn off the desk.
- **Depth slicing.** The injection block is inserted N messages from the end
  (Author's Note convention; default 1). Presets, samplers, and templates are
  never touched.
- **Shadow mode.** Everything computed, nothing injected; the block is
  copyable from RECALL → COPY BLOCK / DRY RUN.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `FAIL · unreachable (CORS or offline?)` on TEST | enable the bridge, or check the server is up; Ollama needs `OLLAMA_ORIGINS=*` for browser-direct |
| `dim mismatch` warnings | Ledger → Embedding Governance: TEST the embed lane, then RE-EMBED or NEW COLLECTION |
| STORAGE OFFLINE stamp | Qdrant down — bureau runs on local fallback; queued writes replay on recovery |
| Nothing injected | you're in SHADOW (first-run default) — `/mm on`; also check `Ledger → This chat participates` |
| Lane circuit breaker OPEN | 3 consecutive failures; it half-opens after 60s, or TEST the lane in the Ledger |

## Development

```bash
node tools/check-syntax.mjs   # syntax-check all 34+ modules
node --test tests/            # engine + UI integration tests (mocks, no deps)
node bridge/server.js         # optional local bridge
```

Tests cover: banter pre-filter, window extraction + reflection repair,
semantic dedupe (.92), Ebbinghaus math, epistemic hard-filtering + group-chat
secret isolation, entity state supersession, depth slicing, token budget,
shadow fallback, degradation ladder L0→L4, forget, export/import round-trip,
msgdot additive-only DOM safety, design tokens, motion gating, and tab
keyboard navigation.

## License

AGPL-3.0-or-later.
