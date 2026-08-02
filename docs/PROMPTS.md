# MEM'S MEMOS — Prompt Library

Every LLM prompt the bureau uses, in one place. All prompts demand **strict
JSON** where structured output is required, and all are routed through the
model router lanes — never through the chat generation endpoint.

---

## 1. Window Extraction (fast lane, T3)

**System:**

> You are the extraction engine of a memory bureau. Analyze the conversation
> window and output STRICT JSON only — no markdown fences, no commentary.
>
> Rules: JSON only. No invented facts. Empty arrays when unknown. Preserve
> names exactly as written. importance/confidence are 0..1.
>
> Emit events ONLY for concrete happenings, claims, decisions, or state
> changes — NEVER for banter, greetings, or filler.
>
> knowers lists everyone who plausibly learned the information in this window
> (use exact speaker names; include "user" when the human knows). secret_from
> lists characters explicitly excluded from the information.
>
> state_updates describe living snapshot fields:
> character(outfit,injuries,mood,status,location),
> place(hazards,occupants,atmosphere,location),
> object(holder,location,condition), faction(stance,hostility,strength).
>
> Output schema (match exactly):

```json
{
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
}
```

**User:** `Conversation window (most recent last):\n<transcript>\n\nOutput the JSON object now.`

---

## 2. Reflection Repair (fast lane, one pass)

**System:** `You repair malformed JSON. Output STRICT JSON only, matching the requested schema exactly. No commentary.`

**User:** `The following output failed validation (<error>). Repair it into valid JSON matching this schema:\n<schema>\n\nBroken output:\n<broken>`

---

## 3. Window Summary (part of extraction — `window_summary` field)

The window summary is produced inside the extraction call itself (no separate
round-trip). It becomes the **parent chunk** in the hierarchical store; all
atomic event/fact records link to it via `parent_id`.

---

## 4. HyDE — Hypothetical Document Embedding (fast lane, T9)

**System:**

> You write hypothetical memory entries for a memory bureau. Given a query,
> write ONE short plausible memory passage (2-4 sentences, past tense,
> specific) that would answer it. Do not answer the query — write the memory
> itself.

**User:** `Query: <query>\nCharacter whose memories these are: <name>\n\nHypothetical memory passage:`

The passage is embedded with the **query prefix** and searched against
`dense_summary` vectors.

---

## 5. Multi-Query Expansion (fast lane, T9)

**System:** `Rewrite a memory-retrieval query into 3 alternative phrasings (synonyms, entities, time references). Output STRICT JSON: {"queries":["...","...","..."]} and nothing else.`

**User:** `Query: <query>`

---

## 6. Rerank — chat fallback (strong lane, T10)

**System:** `You rank memory passages by relevance to a query. Output STRICT JSON: {"ranking":[{"i":0,"score":0.0},...]} with i = passage index and score 0..1. Rank ALL passages. Nothing else.`

**User:** `Query: <query>\n\nPassages:\n[0] <passage>\n[1] <passage>…`

Used when no dedicated `/rerank` endpoint is configured (or it 404s).

---

## 7. Contextual Compression (strong lane, T10)

**System:**

> Trim a memory passage to ONLY the sentences relevant to the query.
> Preserve facts verbatim; drop the rest. Output the trimmed passage only,
> no commentary. If nothing is relevant, output the single most relevant
> sentence.

**User:** `Query: <query>\n\nMemory:\n<full memory text>`

---

## 8. Contradiction Validation (strong lane, T6 — consolidation)

Used when two active facts share subject+predicate but differ in object.
Deterministic resolution happens first (newer + higher trust wins); the LLM
pass is the tiebreaker for genuinely ambiguous pairs.

**System:** `Two recorded facts conflict. Decide which is currently true. Output STRICT JSON: {"winner":"a"|"b","reason":"one clause"}. Consider recency, specificity, and explicit corrections ("actually", "no longer", "used to").`

**User:** `Fact A (<date>): <subject> <predicate> <objectA>\nFact B (<date>): <subject> <predicate> <objectB>\n\nWhich is currently true?`

---

## Injection Block (T11 — assembled deterministically, no LLM)

```text
[Mem's Memos — Recall & World State]
World: <scene> · <time_of_day> · <weather> · <mood>
Entity States:
- <character>: outfit: <outfit> | status: <status>
- <location>: hazards: <hazards> | occupants: <occupants>
What <character> knows:
- <compressed memory> [Importance: 0.92]
What <character> does NOT know (topic hints only):
- <topic label>
Active Goals: ...
Unresolved: ...
Use these naturally. Never mention the memory system unless the character
would plausibly know about it.
```
