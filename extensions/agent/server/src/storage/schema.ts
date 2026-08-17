import type { DatabaseSync } from 'node:sqlite';

import { canonicalJson, canonicalJsonHash } from './canonical-json.ts';

export const AGENT_STATE_SCHEMA_VERSION = 6;
export const AGENT_STATE_SCHEMA_ID = 'agent-state-v6';

export const AGENT_STATE_TABLES = [
  'meta',
  'projects',
  'conversations',
  'turns',
  'execution_scopes',
  'events',
  'messages',
  'transcript_items',
  'resources',
  'operations',
  'artifacts',
  'history_search_index',
  'context_frames',
  'inferences',
  'provider_items',
] as const;

const EXPECTED_COLUMNS: Record<typeof AGENT_STATE_TABLES[number], string[]> = {
  meta: ['key', 'value_json'],
  projects: [
    'project_id', 'root_path', 'title', 'state', 'created_sequence',
    'updated_sequence', 'created_at', 'updated_at',
  ],
  conversations: [
    'conversation_id', 'project_id', 'title', 'cwd', 'model_id', 'reasoning',
    'state', 'created_at', 'updated_at',
  ],
  turns: [
    'turn_id', 'project_id', 'conversation_id', 'client_message_id',
    'root_scope_id', 'state', 'accepted_sequence', 'terminal_sequence',
    'context_plan_json', 'created_at', 'updated_at',
  ],
  execution_scopes: [
    'scope_id', 'project_id', 'conversation_id', 'turn_id', 'parent_scope_id',
    'parent_operation_id', 'kind', 'boundary_text', 'state', 'created_sequence',
    'terminal_sequence', 'result_artifact_hash', 'created_at', 'updated_at',
  ],
  events: [
    'sequence', 'event_id', 'project_id', 'conversation_id', 'turn_id',
    'scope_id', 'type', 'actor', 'visibility', 'causal_event_id', 'operation_id',
    'payload_json', 'artifact_hash', 'created_at',
  ],
  messages: [
    'message_id', 'project_id', 'conversation_id', 'turn_id', 'scope_id',
    'ordinal', 'role', 'visibility', 'state', 'content_artifact_hash',
    'provider_item_id', 'created_sequence', 'created_at',
  ],
  transcript_items: [
    'item_id', 'conversation_id', 'turn_id', 'first_sequence', 'last_sequence',
    'kind', 'status', 'value_json',
  ],
  resources: ['resource_key', 'basis_sequence', 'value_json', 'updated_at'],
  operations: [
    'operation_id', 'project_id', 'conversation_id', 'turn_id', 'scope_id',
    'source_inference_id', 'call_id', 'kind', 'arguments_hash', 'state',
    'accepted_sequence', 'terminal_sequence', 'result_artifact_hash', 'value_json',
  ],
  artifacts: [
    'hash', 'byte_length', 'media_type', 'created_sequence', 'storage_path',
    'sensitivity',
  ],
  history_search_index: [
    'ref', 'project_id', 'conversation_id', 'turn_id', 'kind', 'sequence', 'text',
  ],
  context_frames: [
    'frame_id', 'project_id', 'conversation_id', 'turn_id', 'scope_id',
    'ordinal', 'basis_sequence', 'compiler_version',
    'manifest_artifact_hash', 'input_hash',
    'ordered_item_hashes_json', 'estimated_input_tokens', 'created_sequence',
    'created_at',
  ],
  inferences: [
    'inference_id', 'project_id', 'conversation_id', 'turn_id', 'scope_id',
    'frame_id', 'ordinal', 'basis_sequence', 'state', 'request_mode',
    'dispatch_artifact_hash', 'input_hash', 'estimated_input_tokens',
    'reported_input_tokens', 'reported_output_tokens',
    'reported_cache_read_tokens', 'reasoning_summary_artifact_hash',
    'assistant_text_artifact_hash', 'assistant_text_phase', 'started_sequence',
    'terminal_sequence',
  ],
  provider_items: [
    'provider_item_id', 'inference_id', 'project_id', 'conversation_id',
    'turn_id', 'scope_id', 'ordinal', 'item_type', 'upstream_item_id',
    'raw_artifact_hash', 'inspectable_artifact_hash', 'created_sequence',
    'created_at',
  ],
};

const SCHEMA_SQL = `
CREATE TABLE meta (
  key TEXT PRIMARY KEY NOT NULL,
  value_json TEXT NOT NULL CHECK (json_valid(value_json))
) STRICT;

CREATE TABLE projects (
  project_id TEXT PRIMARY KEY NOT NULL,
  root_path TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('active', 'archived')),
  created_sequence INTEGER NOT NULL,
  updated_sequence INTEGER NOT NULL,
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  updated_at INTEGER NOT NULL CHECK (updated_at >= created_at),
  UNIQUE (created_sequence, project_id),
  UNIQUE (updated_sequence, project_id),
  CHECK (updated_sequence >= created_sequence),
  FOREIGN KEY (created_sequence, project_id)
    REFERENCES events(sequence, project_id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (updated_sequence, project_id)
    REFERENCES events(sequence, project_id) DEFERRABLE INITIALLY DEFERRED
) STRICT;

CREATE TABLE conversations (
  conversation_id TEXT PRIMARY KEY NOT NULL,
  project_id TEXT NOT NULL,
  title TEXT NOT NULL,
  cwd TEXT NOT NULL,
  model_id TEXT NOT NULL,
  reasoning TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('idle', 'running', 'archived')),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  updated_at INTEGER NOT NULL CHECK (updated_at >= created_at),
  UNIQUE (project_id, conversation_id),
  FOREIGN KEY (project_id) REFERENCES projects(project_id)
    DEFERRABLE INITIALLY DEFERRED
) STRICT;

CREATE TABLE turns (
  turn_id TEXT PRIMARY KEY NOT NULL,
  project_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  client_message_id TEXT NOT NULL,
  root_scope_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('running', 'completed', 'failed', 'interrupted', 'interrupted_by_restart')),
  accepted_sequence INTEGER NOT NULL UNIQUE,
  terminal_sequence INTEGER UNIQUE,
  context_plan_json TEXT NOT NULL CHECK (json_valid(context_plan_json)),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  updated_at INTEGER NOT NULL CHECK (updated_at >= created_at),
  UNIQUE (conversation_id, turn_id),
  UNIQUE (conversation_id, client_message_id),
  UNIQUE (project_id, conversation_id, turn_id),
  CHECK (terminal_sequence IS NULL OR terminal_sequence >= accepted_sequence),
  FOREIGN KEY (project_id, conversation_id)
    REFERENCES conversations(project_id, conversation_id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (project_id, conversation_id, turn_id, root_scope_id)
    REFERENCES execution_scopes(project_id, conversation_id, turn_id, scope_id)
    DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (accepted_sequence, project_id, conversation_id)
    REFERENCES events(sequence, project_id, conversation_id)
    DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (terminal_sequence, project_id, conversation_id)
    REFERENCES events(sequence, project_id, conversation_id)
    DEFERRABLE INITIALLY DEFERRED
) STRICT;

CREATE TABLE execution_scopes (
  scope_id TEXT PRIMARY KEY NOT NULL,
  project_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  turn_id TEXT NOT NULL,
  parent_scope_id TEXT,
  parent_operation_id TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('turn', 'work_unit')),
  boundary_text TEXT,
  state TEXT NOT NULL CHECK (state IN ('running', 'completed', 'failed', 'abandoned', 'interrupted')),
  created_sequence INTEGER NOT NULL UNIQUE,
  terminal_sequence INTEGER UNIQUE,
  result_artifact_hash TEXT,
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  updated_at INTEGER NOT NULL CHECK (updated_at >= created_at),
  UNIQUE (conversation_id, scope_id),
  UNIQUE (conversation_id, turn_id, scope_id),
  UNIQUE (project_id, conversation_id, turn_id, scope_id),
  UNIQUE (parent_operation_id),
  CHECK ((kind = 'turn' AND parent_scope_id IS NULL AND parent_operation_id IS NULL) OR
         (kind = 'work_unit' AND parent_scope_id IS NOT NULL AND parent_operation_id IS NOT NULL)),
  CHECK ((kind = 'turn' AND boundary_text IS NULL) OR
         (kind = 'work_unit' AND length(trim(boundary_text)) > 0)),
  CHECK (terminal_sequence IS NULL OR terminal_sequence >= created_sequence),
  FOREIGN KEY (project_id, conversation_id, turn_id)
    REFERENCES turns(project_id, conversation_id, turn_id)
    DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (project_id, conversation_id, turn_id, parent_scope_id)
    REFERENCES execution_scopes(project_id, conversation_id, turn_id, scope_id)
    DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (parent_operation_id, project_id, conversation_id)
    REFERENCES operations(operation_id, project_id, conversation_id)
    DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (created_sequence, project_id, conversation_id)
    REFERENCES events(sequence, project_id, conversation_id)
    DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (terminal_sequence, project_id, conversation_id)
    REFERENCES events(sequence, project_id, conversation_id)
    DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (result_artifact_hash) REFERENCES artifacts(hash)
    DEFERRABLE INITIALLY DEFERRED
) STRICT;

CREATE TABLE events (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL UNIQUE,
  project_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  turn_id TEXT,
  scope_id TEXT,
  type TEXT NOT NULL,
  actor TEXT NOT NULL,
  visibility TEXT NOT NULL CHECK (visibility IN ('transcript', 'internal')),
  causal_event_id TEXT,
  operation_id TEXT,
  payload_json TEXT CHECK (payload_json IS NULL OR json_valid(payload_json)),
  artifact_hash TEXT,
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  UNIQUE (sequence, project_id),
  UNIQUE (sequence, conversation_id),
  UNIQUE (sequence, project_id, conversation_id),
  UNIQUE (event_id, conversation_id),
  CHECK (scope_id IS NULL OR turn_id IS NOT NULL),
  FOREIGN KEY (project_id, conversation_id)
    REFERENCES conversations(project_id, conversation_id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (causal_event_id, conversation_id)
    REFERENCES events(event_id, conversation_id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (project_id, conversation_id, turn_id)
    REFERENCES turns(project_id, conversation_id, turn_id)
    DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (project_id, conversation_id, turn_id, scope_id)
    REFERENCES execution_scopes(project_id, conversation_id, turn_id, scope_id)
    DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (operation_id, project_id, conversation_id)
    REFERENCES operations(operation_id, project_id, conversation_id)
    DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (artifact_hash) REFERENCES artifacts(hash) DEFERRABLE INITIALLY DEFERRED
) STRICT;

CREATE TABLE messages (
  message_id TEXT PRIMARY KEY NOT NULL,
  project_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  turn_id TEXT NOT NULL,
  scope_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'internal')),
  visibility TEXT NOT NULL CHECK (visibility IN ('transcript', 'internal')),
  state TEXT NOT NULL CHECK (state IN ('completed', 'failed', 'interrupted')),
  content_artifact_hash TEXT NOT NULL,
  provider_item_id TEXT,
  created_sequence INTEGER NOT NULL UNIQUE,
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  UNIQUE (scope_id, ordinal),
  UNIQUE (conversation_id, message_id),
  FOREIGN KEY (project_id, conversation_id, turn_id, scope_id)
    REFERENCES execution_scopes(project_id, conversation_id, turn_id, scope_id)
    DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (content_artifact_hash) REFERENCES artifacts(hash)
    DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (provider_item_id) REFERENCES provider_items(provider_item_id)
    DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (created_sequence, project_id, conversation_id)
    REFERENCES events(sequence, project_id, conversation_id)
    DEFERRABLE INITIALLY DEFERRED
) STRICT;

CREATE TABLE transcript_items (
  item_id TEXT PRIMARY KEY NOT NULL,
  conversation_id TEXT NOT NULL,
  turn_id TEXT NOT NULL,
  first_sequence INTEGER NOT NULL,
  last_sequence INTEGER NOT NULL,
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  value_json TEXT NOT NULL CHECK (json_valid(value_json)),
  CHECK (last_sequence >= first_sequence),
  FOREIGN KEY (conversation_id, turn_id)
    REFERENCES turns(conversation_id, turn_id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (first_sequence, conversation_id)
    REFERENCES events(sequence, conversation_id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (last_sequence, conversation_id)
    REFERENCES events(sequence, conversation_id) DEFERRABLE INITIALLY DEFERRED
) STRICT;

CREATE TABLE resources (
  resource_key TEXT PRIMARY KEY NOT NULL,
  basis_sequence INTEGER NOT NULL,
  value_json TEXT NOT NULL CHECK (json_valid(value_json)),
  updated_at INTEGER NOT NULL CHECK (updated_at >= 0),
  FOREIGN KEY (basis_sequence) REFERENCES events(sequence) DEFERRABLE INITIALLY DEFERRED
) STRICT;

CREATE TABLE operations (
  operation_id TEXT PRIMARY KEY NOT NULL,
  project_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  turn_id TEXT,
  scope_id TEXT,
  source_inference_id TEXT,
  call_id TEXT,
  kind TEXT NOT NULL,
  arguments_hash TEXT NOT NULL CHECK (length(arguments_hash) = 64 AND arguments_hash NOT GLOB '*[^0-9a-f]*'),
  state TEXT NOT NULL,
  accepted_sequence INTEGER NOT NULL UNIQUE,
  terminal_sequence INTEGER UNIQUE,
  result_artifact_hash TEXT,
  value_json TEXT NOT NULL CHECK (json_valid(value_json)),
  UNIQUE (operation_id, project_id, conversation_id),
  UNIQUE (scope_id, call_id),
  CHECK (scope_id IS NULL OR turn_id IS NOT NULL),
  CHECK (terminal_sequence IS NULL OR terminal_sequence > accepted_sequence),
  FOREIGN KEY (project_id, conversation_id)
    REFERENCES conversations(project_id, conversation_id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (project_id, conversation_id, turn_id)
    REFERENCES turns(project_id, conversation_id, turn_id)
    DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (project_id, conversation_id, turn_id, scope_id)
    REFERENCES execution_scopes(project_id, conversation_id, turn_id, scope_id)
    DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (source_inference_id) REFERENCES inferences(inference_id)
    DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (accepted_sequence, project_id, conversation_id)
    REFERENCES events(sequence, project_id, conversation_id)
    DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (terminal_sequence, project_id, conversation_id)
    REFERENCES events(sequence, project_id, conversation_id)
    DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (result_artifact_hash) REFERENCES artifacts(hash)
    DEFERRABLE INITIALLY DEFERRED
) STRICT;

CREATE TABLE artifacts (
  hash TEXT PRIMARY KEY NOT NULL CHECK (length(hash) = 64 AND hash NOT GLOB '*[^0-9a-f]*'),
  byte_length INTEGER NOT NULL CHECK (byte_length >= 0),
  media_type TEXT NOT NULL,
  created_sequence INTEGER NOT NULL,
  storage_path TEXT NOT NULL,
  sensitivity TEXT NOT NULL CHECK (sensitivity IN ('content', 'inspectable', 'private')),
  FOREIGN KEY (created_sequence) REFERENCES events(sequence) DEFERRABLE INITIALLY DEFERRED
) STRICT;

CREATE TABLE context_frames (
  frame_id TEXT PRIMARY KEY NOT NULL,
  project_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  turn_id TEXT NOT NULL,
  scope_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  basis_sequence INTEGER NOT NULL,
  compiler_version TEXT NOT NULL,
  manifest_artifact_hash TEXT NOT NULL,
  input_hash TEXT NOT NULL CHECK (length(input_hash) = 64 AND input_hash NOT GLOB '*[^0-9a-f]*'),
  ordered_item_hashes_json TEXT NOT NULL CHECK (json_valid(ordered_item_hashes_json)),
  estimated_input_tokens INTEGER NOT NULL CHECK (estimated_input_tokens >= 0),
  created_sequence INTEGER NOT NULL UNIQUE,
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  UNIQUE (scope_id, ordinal),
  UNIQUE (frame_id, project_id, conversation_id, turn_id, scope_id),
  CHECK (basis_sequence <= created_sequence),
  FOREIGN KEY (project_id, conversation_id, turn_id, scope_id)
    REFERENCES execution_scopes(project_id, conversation_id, turn_id, scope_id)
    DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (basis_sequence, project_id, conversation_id)
    REFERENCES events(sequence, project_id, conversation_id)
    DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (manifest_artifact_hash) REFERENCES artifacts(hash)
    DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (created_sequence, project_id, conversation_id)
    REFERENCES events(sequence, project_id, conversation_id)
    DEFERRABLE INITIALLY DEFERRED
) STRICT;

CREATE TABLE inferences (
  inference_id TEXT PRIMARY KEY NOT NULL,
  project_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  turn_id TEXT NOT NULL,
  scope_id TEXT NOT NULL,
  frame_id TEXT NOT NULL UNIQUE,
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  basis_sequence INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('running', 'completed', 'failed', 'interrupted')),
  request_mode TEXT NOT NULL CHECK (request_mode IN ('full', 'continuation')),
  dispatch_artifact_hash TEXT NOT NULL,
  input_hash TEXT NOT NULL CHECK (length(input_hash) = 64 AND input_hash NOT GLOB '*[^0-9a-f]*'),
  estimated_input_tokens INTEGER NOT NULL CHECK (estimated_input_tokens >= 0),
  reported_input_tokens INTEGER CHECK (reported_input_tokens >= 0),
  reported_output_tokens INTEGER CHECK (reported_output_tokens >= 0),
  reported_cache_read_tokens INTEGER CHECK (reported_cache_read_tokens >= 0),
  reasoning_summary_artifact_hash TEXT,
  assistant_text_artifact_hash TEXT,
  assistant_text_phase TEXT CHECK (assistant_text_phase IN ('commentary', 'final_answer')),
  started_sequence INTEGER NOT NULL UNIQUE,
  terminal_sequence INTEGER UNIQUE,
  UNIQUE (scope_id, ordinal),
  CHECK (terminal_sequence IS NULL OR terminal_sequence >= started_sequence),
  FOREIGN KEY (frame_id, project_id, conversation_id, turn_id, scope_id)
    REFERENCES context_frames(frame_id, project_id, conversation_id, turn_id, scope_id)
    DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (basis_sequence, project_id, conversation_id)
    REFERENCES events(sequence, project_id, conversation_id)
    DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (dispatch_artifact_hash) REFERENCES artifacts(hash)
    DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (reasoning_summary_artifact_hash) REFERENCES artifacts(hash)
    DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (assistant_text_artifact_hash) REFERENCES artifacts(hash)
    DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (started_sequence, project_id, conversation_id)
    REFERENCES events(sequence, project_id, conversation_id)
    DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (terminal_sequence, project_id, conversation_id)
    REFERENCES events(sequence, project_id, conversation_id)
    DEFERRABLE INITIALLY DEFERRED
) STRICT;

CREATE TABLE provider_items (
  provider_item_id TEXT PRIMARY KEY NOT NULL,
  inference_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  turn_id TEXT NOT NULL,
  scope_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  item_type TEXT NOT NULL,
  upstream_item_id TEXT,
  raw_artifact_hash TEXT NOT NULL,
  inspectable_artifact_hash TEXT NOT NULL,
  created_sequence INTEGER NOT NULL UNIQUE,
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  UNIQUE (inference_id, ordinal),
  UNIQUE (provider_item_id, conversation_id),
  FOREIGN KEY (inference_id) REFERENCES inferences(inference_id)
    DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (project_id, conversation_id, turn_id, scope_id)
    REFERENCES execution_scopes(project_id, conversation_id, turn_id, scope_id)
    DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (raw_artifact_hash) REFERENCES artifacts(hash)
    DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (inspectable_artifact_hash) REFERENCES artifacts(hash)
    DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (created_sequence, project_id, conversation_id)
    REFERENCES events(sequence, project_id, conversation_id)
    DEFERRABLE INITIALLY DEFERRED
) STRICT;

CREATE VIRTUAL TABLE history_search_index USING fts5(
  ref UNINDEXED,
  project_id UNINDEXED,
  conversation_id UNINDEXED,
  turn_id UNINDEXED,
  kind UNINDEXED,
  sequence UNINDEXED,
  text,
  tokenize = 'unicode61'
);

CREATE INDEX projects_by_recent ON projects(updated_at DESC, project_id DESC);
CREATE INDEX conversations_by_recent ON conversations(updated_at DESC, conversation_id DESC);
CREATE INDEX turns_by_conversation_sequence ON turns(conversation_id, accepted_sequence);
CREATE INDEX execution_scopes_by_parent ON execution_scopes(turn_id, parent_scope_id, created_sequence);
CREATE UNIQUE INDEX execution_scopes_one_root ON execution_scopes(turn_id) WHERE parent_scope_id IS NULL;
CREATE INDEX events_by_conversation_sequence ON events(conversation_id, sequence);
CREATE INDEX events_by_turn_sequence ON events(conversation_id, turn_id, sequence) WHERE turn_id IS NOT NULL;
CREATE INDEX events_by_scope_sequence ON events(scope_id, sequence) WHERE scope_id IS NOT NULL;
CREATE INDEX events_by_operation_sequence ON events(operation_id, sequence) WHERE operation_id IS NOT NULL;
CREATE INDEX messages_by_conversation_sequence ON messages(conversation_id, created_sequence);
CREATE INDEX transcript_items_by_conversation_sequence ON transcript_items(conversation_id, first_sequence);
CREATE INDEX transcript_items_by_turn_sequence ON transcript_items(conversation_id, turn_id, first_sequence);
CREATE INDEX operations_nonterminal ON operations(state) WHERE terminal_sequence IS NULL;
CREATE INDEX operations_by_inference ON operations(source_inference_id, accepted_sequence)
  WHERE source_inference_id IS NOT NULL;
CREATE INDEX frames_by_scope ON context_frames(scope_id, ordinal);
CREATE INDEX provider_items_by_scope ON provider_items(scope_id, created_sequence);
`;

export function listAgentDatabaseTables(database: DatabaseSync) {
  const rows = database.prepare(`
    SELECT name FROM sqlite_master
    WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
      AND (name = 'history_search_index' OR name NOT GLOB 'history_search_index_*')
    ORDER BY name
  `).all() as Array<{ name: string }>;
  return rows.map((row) => row.name);
}

export function createAgentSchema(database: DatabaseSync) {
  database.exec(SCHEMA_SQL);
  database.prepare('INSERT INTO meta (key, value_json) VALUES (?, ?)').run(
    'state_schema',
    canonicalJson(AGENT_STATE_SCHEMA_ID),
  );
  database.exec(`PRAGMA user_version = ${AGENT_STATE_SCHEMA_VERSION}`);
}

export function agentSchemaFingerprint(database: DatabaseSync) {
  const rows = database.prepare(`
    SELECT type, name, tbl_name, sql
    FROM sqlite_master
    WHERE name NOT LIKE 'sqlite_%' AND type IN ('table', 'index', 'trigger', 'view')
    ORDER BY type, name
  `).all() as Array<Record<string, unknown>>;
  return canonicalJsonHash(rows.map((row) => ({
    type: String(row.type),
    name: String(row.name),
    table: String(row.tbl_name),
    sql: String(row.sql ?? ''),
  })));
}

export function validateAgentSchema(database: DatabaseSync, expectedFingerprint: string) {
  const actualTables = listAgentDatabaseTables(database);
  const expectedTables = [...AGENT_STATE_TABLES].sort();
  if (!sameStrings(actualTables, expectedTables)) {
    throw new AgentSchemaError(
      `Agent schema tables do not match ${AGENT_STATE_SCHEMA_ID} ` +
      `(expected ${expectedTables.join(', ')}; found ${actualTables.join(', ')}).`,
    );
  }
  for (const table of AGENT_STATE_TABLES) {
    const rows = database.prepare(`PRAGMA table_info("${table}")`).all() as Array<{ name: string }>;
    const actualColumns = rows.map((row) => row.name);
    if (!sameStrings(actualColumns, EXPECTED_COLUMNS[table])) {
      throw new AgentSchemaError(`Agent schema columns do not match for ${table}.`);
    }
  }
  if (agentSchemaFingerprint(database) !== expectedFingerprint) {
    throw new AgentSchemaError('Agent schema structure does not match the agent-state reference.');
  }
  const schema = database.prepare('SELECT value_json FROM meta WHERE key = ?').get('state_schema') as
    | { value_json: string }
    | undefined;
  if (!schema || schema.value_json !== canonicalJson(AGENT_STATE_SCHEMA_ID)) {
    throw new AgentSchemaError('Agent state schema identity is missing or invalid.');
  }
  const foreignKeyFailures = database.prepare('PRAGMA foreign_key_check').all();
  if (foreignKeyFailures.length > 0) {
    throw new AgentSchemaError(`Agent state contains ${foreignKeyFailures.length} foreign-key violation(s).`);
  }
  validateCanonicalData(database);
}

function validateCanonicalData(database: DatabaseSync) {
  const jsonColumns: Array<[string, string]> = [
    ['meta', 'value_json'],
    ['events', 'payload_json'],
    ['transcript_items', 'value_json'],
    ['resources', 'value_json'],
    ['operations', 'value_json'],
    ['turns', 'context_plan_json'],
    ['context_frames', 'ordered_item_hashes_json'],
  ];
  for (const [table, column] of jsonColumns) {
    const rows = database.prepare(`SELECT rowid AS row_id, ${column} AS value FROM ${table}`).all() as
      Array<{ row_id: number; value: string | null }>;
    for (const row of rows) {
      if (row.value === null) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(row.value);
      } catch (error) {
        throw new AgentSchemaError(`Agent state contains invalid JSON in ${table}.${column}.`, { cause: error });
      }
      if (canonicalJson(parsed) !== row.value) {
        throw new AgentSchemaError(`Agent state contains non-canonical JSON in ${table}.${column}.`);
      }
    }
  }
}

export class AgentSchemaError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'AgentSchemaError';
  }
}

function sameStrings(left: string[], right: string[]) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
