-- ============================================================================
-- MEM'S MEMOS — Canonical schema (SQLite-compatible; JSON columns for arrays)
-- All tables use the mems_ prefix. Enums are canonical across SQL, Qdrant
-- payloads, and UI filters. This file is the reference DDL: the extension's
-- runtime metadata store is IndexedDB, and the optional Node bridge can map
-- these tables 1:1 into SQLite.
-- ============================================================================

PRAGMA journal_mode = WAL;

-- ---------------------------------------------------------------------------
-- T1: SHORT-TERM MEMORY buffers
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS mems_stm (
    stm_id               TEXT PRIMARY KEY,
    uuid                 TEXT NOT NULL,
    schema_version       INTEGER NOT NULL DEFAULT 1,
    tenant_id            TEXT NOT NULL DEFAULT 'default',
    user_id              TEXT,
    persona_id           TEXT,
    character_id         TEXT,
    chat_id              TEXT NOT NULL,
    session_id           TEXT,
    buffer_type          TEXT NOT NULL,              -- ENUM buffer_type
    slot                 INTEGER,
    memory_kind          TEXT,
    key                  TEXT,
    content              TEXT NOT NULL,
    summary              TEXT,
    tokens               INTEGER DEFAULT 0,
    priority             REAL DEFAULT 0.5,
    activation           REAL DEFAULT 1.0,
    decay_rate           REAL DEFAULT 1.0,
    half_life_minutes    REAL DEFAULT 60,
    attention            REAL DEFAULT 0,
    emotion              TEXT,
    valence              REAL DEFAULT 0,
    arousal              REAL DEFAULT 0,
    entity_ids_json      TEXT DEFAULT '[]',
    item_ids_json        TEXT DEFAULT '[]',
    location_ids_json    TEXT DEFAULT '[]',
    goal_ids_json        TEXT DEFAULT '[]',
    source_message_ids_json TEXT DEFAULT '[]',
    evidence             TEXT,
    created_at           TEXT NOT NULL,
    updated_at           TEXT NOT NULL,
    last_reinforced_at   TEXT,
    expires_at           TEXT,
    status               TEXT NOT NULL DEFAULT 'active',  -- ENUM stm status
    CHECK (buffer_type IN ('immediate','summary','entity','goal','emotion',
                           'location','item','promise','retrieval_cache')),
    CHECK (status IN ('active','consolidated','archived','expired','deleted'))
);
CREATE INDEX IF NOT EXISTS idx_stm_scope   ON mems_stm (tenant_id, chat_id, character_id);
CREATE INDEX IF NOT EXISTS idx_stm_status  ON mems_stm (status, buffer_type);
CREATE INDEX IF NOT EXISTS idx_stm_created ON mems_stm (created_at);

-- ---------------------------------------------------------------------------
-- MASTER MEMORY TABLE (maximum width)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS mems_memory_master (
    -- Identity
    id                   TEXT PRIMARY KEY,
    uuid                 TEXT NOT NULL,
    schema_version       INTEGER NOT NULL DEFAULT 1,
    payload_version      INTEGER NOT NULL DEFAULT 1,
    tenant_id            TEXT NOT NULL DEFAULT 'default',
    user_id              TEXT,
    persona_id           TEXT,
    character_id         TEXT,
    chat_id              TEXT,
    session_id           TEXT,
    message_id           TEXT,
    source_id            TEXT,
    parent_id            TEXT,
    thread_id            TEXT,
    -- Classification
    memory_type          TEXT NOT NULL,              -- ENUM memory_type
    memory_subtype       TEXT,
    event_type           TEXT,
    layer                TEXT,
    tier                 TEXT,
    scope                TEXT NOT NULL DEFAULT 'chat',   -- ENUM scope
    buffer_type          TEXT,
    chunk_role           TEXT,                       -- ENUM chunk_role
    lane                 TEXT,                       -- ENUM lane
    -- Temporal
    event_time           TEXT,
    event_time_end       TEXT,
    created_at           TEXT NOT NULL,
    updated_at           TEXT NOT NULL,
    valid_from           TEXT,
    valid_to             TEXT,
    ingested_at          TEXT,
    last_accessed        TEXT,
    expires_at           TEXT,
    ttl_seconds          INTEGER,
    timezone             TEXT,
    -- Content
    raw_text             TEXT,
    normalized_text      TEXT,
    text                 TEXT,
    summary              TEXT,
    gist                 TEXT,
    cause                TEXT,
    result               TEXT,
    keywords_json        TEXT DEFAULT '[]',
    tags_json            TEXT DEFAULT '[]',
    categories_json      TEXT DEFAULT '[]',
    concepts_json        TEXT DEFAULT '[]',
    language             TEXT,
    content_rating       TEXT,
    privacy_level        TEXT,
    redacted_text        TEXT,
    -- Entity / Relation
    subject_id           TEXT,
    subject_name         TEXT,
    object_id            TEXT,
    object_name          TEXT,
    predicate            TEXT,
    relation             TEXT,
    entity_ids_json      TEXT DEFAULT '[]',
    characters_json      TEXT DEFAULT '[]',
    aliases_json         TEXT DEFAULT '[]',
    persona_ids_json     TEXT DEFAULT '[]',
    character_ids_json   TEXT DEFAULT '[]',
    items_json           TEXT DEFAULT '[]',
    locations_json       TEXT DEFAULT '[]',
    group_ids_json       TEXT DEFAULT '[]',
    -- Event (VectFox-compatible)
    who_json             TEXT DEFAULT '[]',
    what_text            TEXT,
    where_text           TEXT,
    when_text            TEXT,
    why_text             TEXT,
    how_text             TEXT,
    action               TEXT,
    emotion              TEXT,
    emotional_valence    REAL,
    emotional_arousal    REAL,
    sentiment            TEXT,
    intent               TEXT,
    motive               TEXT,
    goal                 TEXT,
    plan                 TEXT,
    obligation           TEXT,
    promise              TEXT,
    conflict             TEXT,
    resolution           TEXT,
    outcome              TEXT,
    consequence          TEXT,
    causal_event_ids_json TEXT DEFAULT '[]',
    temporal_order       INTEGER,
    duration_seconds     INTEGER,
    -- Epistemic
    knowers_json         TEXT DEFAULT '[]',
    secret_from_json     TEXT DEFAULT '[]',
    epistemic_scope      TEXT DEFAULT 'public',      -- ENUM epistemic_scope
    -- Scoring
    importance           REAL DEFAULT 0.5,
    salience             REAL DEFAULT 0.5,
    confidence           REAL DEFAULT 0.9,
    trust                REAL DEFAULT 0.8,
    certainty            REAL DEFAULT 0.5,
    reliability          REAL DEFAULT 0.5,
    novelty              REAL DEFAULT 0.5,
    surprise             REAL DEFAULT 0,
    relevance            REAL DEFAULT 0,
    attention            REAL DEFAULT 0,
    activation           REAL DEFAULT 1.0,
    strength             REAL DEFAULT 1.0,
    decay_rate           REAL DEFAULT 1.0,
    half_life_hours      REAL DEFAULT 168,
    access_count         INTEGER DEFAULT 0,
    recall_count         INTEGER DEFAULT 0,
    reinforcement_count  INTEGER DEFAULT 0,
    -- Provenance
    source_type          TEXT,                       -- ENUM source_type
    source_role          TEXT,
    source_name          TEXT,
    source_model         TEXT,
    extractor_model      TEXT,
    extractor_version    TEXT,
    evidence_ids_json    TEXT DEFAULT '[]',
    citations_json       TEXT DEFAULT '[]',
    quote                TEXT,
    line_start           INTEGER,
    line_end             INTEGER,
    -- Consistency
    canonical_fact_id    TEXT,
    supersedes_id        TEXT,
    superseded_by        TEXT,
    contradicts_ids_json TEXT DEFAULT '[]',
    corroborated_by_json TEXT DEFAULT '[]',
    merged_from_json     TEXT DEFAULT '[]',
    duplicate_of         TEXT,
    validity_status      TEXT DEFAULT 'active',      -- ENUM validity_status
    verification_status  TEXT DEFAULT 'unverified',  -- ENUM verification_status
    -- Vector
    embedding_model      TEXT,
    embedding_dim        INTEGER,
    vector_id            TEXT,
    vector_collection    TEXT,
    sparse_vector_id     TEXT,
    rerank_score         REAL,
    last_query           TEXT,
    last_rank            INTEGER,
    retrieval_count      INTEGER DEFAULT 0,
    -- Governance
    consent              TEXT DEFAULT 'granted',
    retention_policy     TEXT DEFAULT 'forever',     -- ENUM retention_policy
    forget_requested     INTEGER DEFAULT 0,
    forget_at            TEXT,
    anonymized           INTEGER DEFAULT 0,
    encrypted            INTEGER DEFAULT 0,
    acl_read_json        TEXT DEFAULT '[]',
    acl_write_json       TEXT DEFAULT '[]',
    -- Ops
    status               TEXT NOT NULL DEFAULT 'active',  -- ENUM status
    error                TEXT,
    job_id               TEXT,
    checksum             TEXT,
    dedupe_hash          TEXT,
    CHECK (memory_type IN ('event','fact','entity','relation','procedural',
                           'preference','goal','promise','item','location',
                           'summary','chunk')),
    CHECK (status IN ('queued','extracting','embedding','active',
                      'failed_extract','failed_embed','archived','deleted')),
    CHECK (scope IN ('private','chat','character','persona','global')),
    CHECK (chunk_role IS NULL OR chunk_role IN ('atomic','child','parent')),
    CHECK (lane IS NULL OR lane IN ('fast','batch')),
    CHECK (epistemic_scope IN ('public','private','attributed')),
    CHECK (source_type IS NULL OR source_type IN
           ('chat','user','assistant','system','extension','import','manual')),
    CHECK (retention_policy IN ('forever','session','chat','ttl','manual')),
    CHECK (validity_status IN ('active','superseded','contradicted',
                               'uncertain','false','deleted')),
    CHECK (verification_status IN ('unverified','user_confirmed',
                                   'model_verified','contradictory','rejected'))
);
CREATE INDEX IF NOT EXISTS idx_mem_scope     ON mems_memory_master (tenant_id, chat_id, character_id, memory_type, status);
CREATE INDEX IF NOT EXISTS idx_mem_eventtime ON mems_memory_master (event_time);
CREATE INDEX IF NOT EXISTS idx_mem_created   ON mems_memory_master (created_at);
CREATE INDEX IF NOT EXISTS idx_mem_validfrom ON mems_memory_master (valid_from);
CREATE INDEX IF NOT EXISTS idx_mem_import    ON mems_memory_master (importance, strength);
CREATE INDEX IF NOT EXISTS idx_mem_subject   ON mems_memory_master (subject_id, object_id);
CREATE INDEX IF NOT EXISTS idx_mem_validity  ON mems_memory_master (validity_status, verification_status);
CREATE INDEX IF NOT EXISTS idx_mem_dedupe    ON mems_memory_master (dedupe_hash);
CREATE INDEX IF NOT EXISTS idx_mem_parent    ON mems_memory_master (parent_id);

-- ---------------------------------------------------------------------------
-- ENTITY STATE CARDS (living snapshots)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS mems_entity_states (
    id                TEXT PRIMARY KEY,
    tenant_id         TEXT NOT NULL DEFAULT 'default',
    chat_id           TEXT NOT NULL,
    entity_id         TEXT NOT NULL,
    entity_name       TEXT NOT NULL,
    entity_type       TEXT NOT NULL,               -- ENUM entity_type
    outfit_json       TEXT DEFAULT '[]',
    injuries_json     TEXT DEFAULT '[]',
    mood              TEXT,
    status_flags_json TEXT DEFAULT '[]',
    location          TEXT,
    occupants_json    TEXT DEFAULT '[]',
    hazards_json      TEXT DEFAULT '[]',
    holder            TEXT,
    condition         TEXT,
    hostility         REAL,
    stance            TEXT,
    confidence        REAL DEFAULT 0.9,
    source_memory_id  TEXT,
    created_at        TEXT NOT NULL,
    updated_at        TEXT NOT NULL,
    superseded_by     TEXT,
    status            TEXT NOT NULL DEFAULT 'active',
    CHECK (entity_type IN ('character','place','object','faction'))
);
CREATE INDEX IF NOT EXISTS idx_entstate_scope ON mems_entity_states (tenant_id, chat_id, entity_id, status);

-- ---------------------------------------------------------------------------
-- WORLD STATE
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS mems_world_state (
    id               TEXT PRIMARY KEY,
    tenant_id        TEXT NOT NULL DEFAULT 'default',
    chat_id          TEXT NOT NULL,
    character_id     TEXT,
    key              TEXT NOT NULL,                -- ENUM key
    value_text       TEXT,
    confidence       REAL DEFAULT 0.9,
    source_memory_id TEXT,
    created_at       TEXT NOT NULL,
    updated_at       TEXT NOT NULL,
    status           TEXT NOT NULL DEFAULT 'active',
    CHECK (key IN ('scene','time_of_day','weather','mood','faction','conflict'))
);
CREATE INDEX IF NOT EXISTS idx_world_scope ON mems_world_state (tenant_id, chat_id, key, status);

-- ---------------------------------------------------------------------------
-- EPISTEMIC LAYER (who knows what)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS mems_knowledge (
    id          TEXT PRIMARY KEY,
    tenant_id   TEXT NOT NULL DEFAULT 'default',
    chat_id     TEXT NOT NULL,
    knower_id   TEXT NOT NULL,
    knower_name TEXT,
    memory_id   TEXT,
    claim_text  TEXT,
    stance      TEXT NOT NULL,                     -- ENUM stance
    confidence  REAL DEFAULT 0.9,
    since       TEXT,
    updated_at  TEXT NOT NULL,
    status      TEXT NOT NULL DEFAULT 'active',
    CHECK (stance IN ('knows','believes','suspects','denies','told','secret_from'))
);
CREATE INDEX IF NOT EXISTS idx_know_scope  ON mems_knowledge (tenant_id, chat_id, knower_id, status);
CREATE INDEX IF NOT EXISTS idx_know_memory ON mems_knowledge (memory_id);
