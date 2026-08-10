import type { DatabaseSync } from 'node:sqlite';

import { canonicalJson, canonicalJsonHash } from './canonical-json.ts';

export const AGENT_JOURNAL_SCHEMA_VERSION = 2;
export const AGENT_JOURNAL_SCHEMA_ID = 'agent-thread-runtime-v2';

export const AGENT_JOURNAL_TABLES = [
  'meta',
  'projects',
  'conversations',
  'strands',
  'turns',
  'execution_scopes',
  'events',
  'messages',
  'transcript_items',
  'resources',
  'operations',
  'artifacts',
  'state_documents',
  'document_versions',
  'journal_search_index',
  'context_frames',
  'inferences',
  'provider_items',
] as const;

const EXPECTED_COLUMNS: Record<typeof AGENT_JOURNAL_TABLES[number], string[]> = {
  meta: ['key', 'value_json'],
  projects: [
    'project_id', 'root_path', 'title', 'state', 'created_sequence',
    'updated_sequence', 'created_at', 'updated_at',
  ],
  conversations: [
    'conversation_id', 'project_id', 'title', 'cwd', 'model_id', 'reasoning',
    'head_strand_id', 'state', 'created_at', 'updated_at',
  ],
  strands: [
    'strand_id', 'conversation_id', 'parent_strand_id', 'forked_from_sequence',
    'state', 'created_at',
  ],
  turns: [
    'turn_id', 'project_id', 'conversation_id', 'strand_id', 'client_message_id',
    'root_scope_id', 'state', 'accepted_sequence', 'terminal_sequence',
    'thread_version_before', 'thread_version_after', 'created_at', 'updated_at',
  ],
  execution_scopes: [
    'scope_id', 'project_id', 'conversation_id', 'strand_id', 'turn_id',
    'parent_scope_id', 'kind', 'objective_json', 'state', 'created_sequence',
    'terminal_sequence', 'result_artifact_hash', 'created_at', 'updated_at',
  ],
  events: [
    'sequence', 'event_id', 'project_id', 'conversation_id', 'strand_id',
    'turn_id', 'scope_id', 'type', 'actor', 'visibility', 'causal_event_id',
    'operation_id', 'payload_json', 'artifact_hash', 'created_at',
  ],
  messages: [
    'message_id', 'project_id', 'conversation_id', 'strand_id', 'turn_id',
    'scope_id', 'ordinal', 'role', 'visibility', 'state',
    'content_artifact_hash', 'provider_item_id', 'created_sequence', 'created_at',
  ],
  transcript_items: [
    'item_id', 'conversation_id', 'strand_id', 'turn_id', 'first_sequence',
    'last_sequence', 'kind', 'status', 'value_json',
  ],
  resources: ['resource_key', 'basis_sequence', 'value_json', 'updated_at'],
  operations: [
    'operation_id', 'project_id', 'conversation_id', 'strand_id', 'turn_id',
    'scope_id', 'kind', 'arguments_hash', 'state', 'accepted_sequence',
    'terminal_sequence', 'result_artifact_hash', 'value_json',
  ],
  artifacts: [
    'hash', 'byte_length', 'media_type', 'created_sequence', 'storage_path',
    'sensitivity',
  ],
  state_documents: [
    'document_id', 'project_id', 'conversation_id', 'strand_id', 'scope_kind',
    'key', 'head_version_id', 'created_sequence', 'updated_sequence',
    'created_at', 'updated_at',
  ],
  document_versions: [
    'version_id', 'document_id', 'ordinal', 'parent_version_id',
    'content_artifact_hash', 'based_on_turn_id', 'created_sequence', 'created_at',
  ],
  journal_search_index: [
    'ref', 'project_id', 'conversation_id', 'strand_id', 'turn_id', 'kind',
    'sequence', 'text',
  ],
  context_frames: [
    'frame_id', 'project_id', 'conversation_id', 'strand_id', 'turn_id',
    'scope_id', 'ordinal', 'basis_sequence', 'compiler_version',
    'thread_version_id', 'manifest_artifact_hash', 'bootstrap_artifact_hash',
    'input_hash', 'ordered_item_hashes_json', 'estimated_input_tokens',
    'created_sequence', 'created_at',
  ],
  inferences: [
    'inference_id', 'project_id', 'conversation_id', 'strand_id', 'turn_id',
    'scope_id', 'frame_id', 'ordinal', 'basis_sequence', 'state',
    'request_mode', 'dispatch_artifact_hash', 'input_hash',
    'estimated_input_tokens', 'reported_input_tokens', 'reported_output_tokens',
    'reported_cache_read_tokens', 'started_sequence', 'terminal_sequence',
  ],
  provider_items: [
    'provider_item_id', 'inference_id', 'project_id', 'conversation_id',
    'strand_id', 'turn_id', 'scope_id', 'ordinal', 'item_type',
    'upstream_item_id', 'raw_artifact_hash', 'inspectable_artifact_hash',
    'created_sequence', 'created_at',
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
  head_strand_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('idle', 'running', 'archived')),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  updated_at INTEGER NOT NULL CHECK (updated_at >= created_at),
  UNIQUE (project_id, conversation_id),
  FOREIGN KEY (project_id) REFERENCES projects(project_id)
    DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (conversation_id, head_strand_id)
    REFERENCES strands(conversation_id, strand_id) DEFERRABLE INITIALLY DEFERRED
) STRICT;

CREATE TABLE strands (
  strand_id TEXT PRIMARY KEY NOT NULL,
  conversation_id TEXT NOT NULL,
  parent_strand_id TEXT,
  forked_from_sequence INTEGER,
  state TEXT NOT NULL CHECK (state IN ('active', 'archived')),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  UNIQUE (conversation_id, strand_id),
  CHECK ((parent_strand_id IS NULL) = (forked_from_sequence IS NULL)),
  FOREIGN KEY (conversation_id) REFERENCES conversations(conversation_id)
    DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (conversation_id, parent_strand_id)
    REFERENCES strands(conversation_id, strand_id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (forked_from_sequence, conversation_id, parent_strand_id)
    REFERENCES events(sequence, conversation_id, strand_id)
    DEFERRABLE INITIALLY DEFERRED
) STRICT;

CREATE TABLE turns (
  turn_id TEXT PRIMARY KEY NOT NULL,
  project_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  strand_id TEXT NOT NULL,
  client_message_id TEXT NOT NULL,
  root_scope_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('running', 'completed', 'failed', 'interrupted', 'interrupted_by_restart')),
  accepted_sequence INTEGER NOT NULL UNIQUE,
  terminal_sequence INTEGER UNIQUE,
  thread_version_before TEXT,
  thread_version_after TEXT,
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  updated_at INTEGER NOT NULL CHECK (updated_at >= created_at),
  UNIQUE (conversation_id, turn_id),
  UNIQUE (conversation_id, client_message_id),
  UNIQUE (conversation_id, strand_id, turn_id),
  UNIQUE (project_id, conversation_id, strand_id, turn_id),
  CHECK (terminal_sequence IS NULL OR terminal_sequence >= accepted_sequence),
  FOREIGN KEY (project_id, conversation_id)
    REFERENCES conversations(project_id, conversation_id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (conversation_id, strand_id)
    REFERENCES strands(conversation_id, strand_id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (project_id, conversation_id, strand_id, turn_id, root_scope_id)
    REFERENCES execution_scopes(project_id, conversation_id, strand_id, turn_id, scope_id)
    DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (accepted_sequence, project_id, conversation_id, strand_id)
    REFERENCES events(sequence, project_id, conversation_id, strand_id)
    DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (terminal_sequence, project_id, conversation_id, strand_id)
    REFERENCES events(sequence, project_id, conversation_id, strand_id)
    DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (thread_version_before) REFERENCES document_versions(version_id)
    DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (thread_version_after) REFERENCES document_versions(version_id)
    DEFERRABLE INITIALLY DEFERRED
) STRICT;

CREATE TABLE execution_scopes (
  scope_id TEXT PRIMARY KEY NOT NULL,
  project_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  strand_id TEXT NOT NULL,
  turn_id TEXT NOT NULL,
  parent_scope_id TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('turn', 'work_unit')),
  objective_json TEXT NOT NULL CHECK (json_valid(objective_json)),
  state TEXT NOT NULL CHECK (state IN ('running', 'completed', 'failed', 'abandoned', 'interrupted')),
  created_sequence INTEGER NOT NULL UNIQUE,
  terminal_sequence INTEGER UNIQUE,
  result_artifact_hash TEXT,
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  updated_at INTEGER NOT NULL CHECK (updated_at >= created_at),
  UNIQUE (conversation_id, scope_id),
  UNIQUE (conversation_id, strand_id, turn_id, scope_id),
  UNIQUE (project_id, conversation_id, strand_id, turn_id, scope_id),
  CHECK ((kind = 'turn' AND parent_scope_id IS NULL) OR
         (kind = 'work_unit' AND parent_scope_id IS NOT NULL)),
  CHECK (terminal_sequence IS NULL OR terminal_sequence >= created_sequence),
  FOREIGN KEY (project_id, conversation_id, strand_id, turn_id)
    REFERENCES turns(project_id, conversation_id, strand_id, turn_id)
    DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (project_id, conversation_id, strand_id, turn_id, parent_scope_id)
    REFERENCES execution_scopes(project_id, conversation_id, strand_id, turn_id, scope_id)
    DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (created_sequence, project_id, conversation_id, strand_id)
    REFERENCES events(sequence, project_id, conversation_id, strand_id)
    DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (terminal_sequence, project_id, conversation_id, strand_id)
    REFERENCES events(sequence, project_id, conversation_id, strand_id)
    DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (result_artifact_hash) REFERENCES artifacts(hash)
    DEFERRABLE INITIALLY DEFERRED
) STRICT;

CREATE TABLE events (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL UNIQUE,
  project_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  strand_id TEXT NOT NULL,
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
  UNIQUE (sequence, conversation_id, strand_id),
  UNIQUE (sequence, project_id, conversation_id, strand_id),
  UNIQUE (event_id, conversation_id),
  CHECK (scope_id IS NULL OR turn_id IS NOT NULL),
  FOREIGN KEY (project_id, conversation_id)
    REFERENCES conversations(project_id, conversation_id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (conversation_id, strand_id)
    REFERENCES strands(conversation_id, strand_id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (causal_event_id, conversation_id)
    REFERENCES events(event_id, conversation_id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (project_id, conversation_id, strand_id, turn_id)
    REFERENCES turns(project_id, conversation_id, strand_id, turn_id)
    DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (project_id, conversation_id, strand_id, turn_id, scope_id)
    REFERENCES execution_scopes(project_id, conversation_id, strand_id, turn_id, scope_id)
    DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (operation_id, project_id, conversation_id, strand_id)
    REFERENCES operations(operation_id, project_id, conversation_id, strand_id)
    DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (artifact_hash) REFERENCES artifacts(hash) DEFERRABLE INITIALLY DEFERRED
) STRICT;

CREATE TABLE messages (
  message_id TEXT PRIMARY KEY NOT NULL,
  project_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  strand_id TEXT NOT NULL,
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
  FOREIGN KEY (project_id, conversation_id, strand_id, turn_id, scope_id)
    REFERENCES execution_scopes(project_id, conversation_id, strand_id, turn_id, scope_id)
    DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (content_artifact_hash) REFERENCES artifacts(hash)
    DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (provider_item_id) REFERENCES provider_items(provider_item_id)
    DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (created_sequence, project_id, conversation_id, strand_id)
    REFERENCES events(sequence, project_id, conversation_id, strand_id)
    DEFERRABLE INITIALLY DEFERRED
) STRICT;

CREATE TABLE transcript_items (
  item_id TEXT PRIMARY KEY NOT NULL,
  conversation_id TEXT NOT NULL,
  strand_id TEXT NOT NULL,
  turn_id TEXT NOT NULL,
  first_sequence INTEGER NOT NULL,
  last_sequence INTEGER NOT NULL,
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  value_json TEXT NOT NULL CHECK (json_valid(value_json)),
  CHECK (last_sequence >= first_sequence),
  FOREIGN KEY (conversation_id, strand_id)
    REFERENCES strands(conversation_id, strand_id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (conversation_id, strand_id, turn_id)
    REFERENCES turns(conversation_id, strand_id, turn_id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (first_sequence, conversation_id, strand_id)
    REFERENCES events(sequence, conversation_id, strand_id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (last_sequence, conversation_id, strand_id)
    REFERENCES events(sequence, conversation_id, strand_id) DEFERRABLE INITIALLY DEFERRED
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
  strand_id TEXT NOT NULL,
  turn_id TEXT,
  scope_id TEXT,
  kind TEXT NOT NULL,
  arguments_hash TEXT NOT NULL CHECK (length(arguments_hash) = 64 AND arguments_hash NOT GLOB '*[^0-9a-f]*'),
  state TEXT NOT NULL,
  accepted_sequence INTEGER NOT NULL UNIQUE,
  terminal_sequence INTEGER UNIQUE,
  result_artifact_hash TEXT,
  value_json TEXT NOT NULL CHECK (json_valid(value_json)),
  UNIQUE (operation_id, project_id, conversation_id, strand_id),
  CHECK (scope_id IS NULL OR turn_id IS NOT NULL),
  CHECK (terminal_sequence IS NULL OR terminal_sequence > accepted_sequence),
  FOREIGN KEY (project_id, conversation_id)
    REFERENCES conversations(project_id, conversation_id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (conversation_id, strand_id)
    REFERENCES strands(conversation_id, strand_id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (project_id, conversation_id, strand_id, turn_id)
    REFERENCES turns(project_id, conversation_id, strand_id, turn_id)
    DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (project_id, conversation_id, strand_id, turn_id, scope_id)
    REFERENCES execution_scopes(project_id, conversation_id, strand_id, turn_id, scope_id)
    DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (accepted_sequence, project_id, conversation_id, strand_id)
    REFERENCES events(sequence, project_id, conversation_id, strand_id)
    DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (terminal_sequence, project_id, conversation_id, strand_id)
    REFERENCES events(sequence, project_id, conversation_id, strand_id)
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

CREATE TABLE state_documents (
  document_id TEXT PRIMARY KEY NOT NULL,
  project_id TEXT NOT NULL,
  conversation_id TEXT,
  strand_id TEXT,
  scope_kind TEXT NOT NULL CHECK (scope_kind IN ('project', 'strand')),
  key TEXT NOT NULL,
  head_version_id TEXT,
  created_sequence INTEGER NOT NULL,
  updated_sequence INTEGER NOT NULL,
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  updated_at INTEGER NOT NULL CHECK (updated_at >= created_at),
  UNIQUE (document_id, head_version_id),
  CHECK ((scope_kind = 'project' AND conversation_id IS NULL AND strand_id IS NULL) OR
         (scope_kind = 'strand' AND conversation_id IS NOT NULL AND strand_id IS NOT NULL)),
  CHECK (updated_sequence >= created_sequence),
  FOREIGN KEY (project_id) REFERENCES projects(project_id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (conversation_id, strand_id)
    REFERENCES strands(conversation_id, strand_id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (document_id, head_version_id)
    REFERENCES document_versions(document_id, version_id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (created_sequence, project_id)
    REFERENCES events(sequence, project_id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (updated_sequence, project_id)
    REFERENCES events(sequence, project_id) DEFERRABLE INITIALLY DEFERRED
) STRICT;

CREATE TABLE document_versions (
  version_id TEXT PRIMARY KEY NOT NULL,
  document_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  parent_version_id TEXT,
  content_artifact_hash TEXT NOT NULL,
  based_on_turn_id TEXT,
  created_sequence INTEGER NOT NULL UNIQUE,
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  UNIQUE (document_id, version_id),
  UNIQUE (document_id, ordinal),
  CHECK ((ordinal = 0 AND parent_version_id IS NULL) OR
         (ordinal > 0 AND parent_version_id IS NOT NULL)),
  FOREIGN KEY (document_id) REFERENCES state_documents(document_id)
    DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (document_id, parent_version_id)
    REFERENCES document_versions(document_id, version_id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (content_artifact_hash) REFERENCES artifacts(hash)
    DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (based_on_turn_id) REFERENCES turns(turn_id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (created_sequence) REFERENCES events(sequence) DEFERRABLE INITIALLY DEFERRED
) STRICT;

CREATE TABLE context_frames (
  frame_id TEXT PRIMARY KEY NOT NULL,
  project_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  strand_id TEXT NOT NULL,
  turn_id TEXT NOT NULL,
  scope_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  basis_sequence INTEGER NOT NULL,
  compiler_version TEXT NOT NULL,
  thread_version_id TEXT,
  manifest_artifact_hash TEXT NOT NULL,
  bootstrap_artifact_hash TEXT NOT NULL,
  input_hash TEXT NOT NULL CHECK (length(input_hash) = 64 AND input_hash NOT GLOB '*[^0-9a-f]*'),
  ordered_item_hashes_json TEXT NOT NULL CHECK (json_valid(ordered_item_hashes_json)),
  estimated_input_tokens INTEGER NOT NULL CHECK (estimated_input_tokens >= 0),
  created_sequence INTEGER NOT NULL UNIQUE,
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  UNIQUE (scope_id, ordinal),
  UNIQUE (frame_id, project_id, conversation_id, strand_id, turn_id, scope_id),
  CHECK (basis_sequence <= created_sequence),
  FOREIGN KEY (project_id, conversation_id, strand_id, turn_id, scope_id)
    REFERENCES execution_scopes(project_id, conversation_id, strand_id, turn_id, scope_id)
    DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (basis_sequence, project_id, conversation_id, strand_id)
    REFERENCES events(sequence, project_id, conversation_id, strand_id)
    DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (thread_version_id) REFERENCES document_versions(version_id)
    DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (manifest_artifact_hash) REFERENCES artifacts(hash)
    DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (bootstrap_artifact_hash) REFERENCES artifacts(hash)
    DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (created_sequence, project_id, conversation_id, strand_id)
    REFERENCES events(sequence, project_id, conversation_id, strand_id)
    DEFERRABLE INITIALLY DEFERRED
) STRICT;

CREATE TABLE inferences (
  inference_id TEXT PRIMARY KEY NOT NULL,
  project_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  strand_id TEXT NOT NULL,
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
  started_sequence INTEGER NOT NULL UNIQUE,
  terminal_sequence INTEGER UNIQUE,
  UNIQUE (scope_id, ordinal),
  CHECK (terminal_sequence IS NULL OR terminal_sequence >= started_sequence),
  FOREIGN KEY (frame_id, project_id, conversation_id, strand_id, turn_id, scope_id)
    REFERENCES context_frames(frame_id, project_id, conversation_id, strand_id, turn_id, scope_id)
    DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (basis_sequence, project_id, conversation_id, strand_id)
    REFERENCES events(sequence, project_id, conversation_id, strand_id)
    DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (dispatch_artifact_hash) REFERENCES artifacts(hash)
    DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (started_sequence, project_id, conversation_id, strand_id)
    REFERENCES events(sequence, project_id, conversation_id, strand_id)
    DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (terminal_sequence, project_id, conversation_id, strand_id)
    REFERENCES events(sequence, project_id, conversation_id, strand_id)
    DEFERRABLE INITIALLY DEFERRED
) STRICT;

CREATE TABLE provider_items (
  provider_item_id TEXT PRIMARY KEY NOT NULL,
  inference_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  strand_id TEXT NOT NULL,
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
  FOREIGN KEY (project_id, conversation_id, strand_id, turn_id, scope_id)
    REFERENCES execution_scopes(project_id, conversation_id, strand_id, turn_id, scope_id)
    DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (raw_artifact_hash) REFERENCES artifacts(hash)
    DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (inspectable_artifact_hash) REFERENCES artifacts(hash)
    DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (created_sequence, project_id, conversation_id, strand_id)
    REFERENCES events(sequence, project_id, conversation_id, strand_id)
    DEFERRABLE INITIALLY DEFERRED
) STRICT;

CREATE VIRTUAL TABLE journal_search_index USING fts5(
  ref UNINDEXED,
  project_id UNINDEXED,
  conversation_id UNINDEXED,
  strand_id UNINDEXED,
  turn_id UNINDEXED,
  kind UNINDEXED,
  sequence UNINDEXED,
  text,
  tokenize = 'unicode61'
);

CREATE INDEX projects_by_recent ON projects(updated_at DESC, project_id DESC);
CREATE INDEX conversations_by_recent ON conversations(updated_at DESC, conversation_id DESC);
CREATE INDEX strands_by_parent ON strands(conversation_id, parent_strand_id) WHERE parent_strand_id IS NOT NULL;
CREATE INDEX turns_by_strand_sequence ON turns(conversation_id, strand_id, accepted_sequence);
CREATE INDEX execution_scopes_by_parent ON execution_scopes(turn_id, parent_scope_id, created_sequence);
CREATE UNIQUE INDEX execution_scopes_one_root ON execution_scopes(turn_id) WHERE parent_scope_id IS NULL;
CREATE INDEX events_by_strand_sequence ON events(conversation_id, strand_id, sequence);
CREATE INDEX events_by_turn_sequence ON events(conversation_id, turn_id, sequence) WHERE turn_id IS NOT NULL;
CREATE INDEX events_by_scope_sequence ON events(scope_id, sequence) WHERE scope_id IS NOT NULL;
CREATE INDEX events_by_operation_sequence ON events(operation_id, sequence) WHERE operation_id IS NOT NULL;
CREATE INDEX messages_by_strand_sequence ON messages(conversation_id, strand_id, created_sequence);
CREATE INDEX transcript_items_by_strand_sequence ON transcript_items(conversation_id, strand_id, first_sequence);
CREATE INDEX transcript_items_by_turn_sequence ON transcript_items(conversation_id, turn_id, first_sequence);
CREATE INDEX operations_nonterminal ON operations(state) WHERE terminal_sequence IS NULL;
CREATE UNIQUE INDEX state_documents_project_key
  ON state_documents(project_id, key) WHERE scope_kind = 'project';
CREATE UNIQUE INDEX state_documents_strand_key
  ON state_documents(conversation_id, strand_id, key) WHERE scope_kind = 'strand';
CREATE INDEX document_versions_by_document ON document_versions(document_id, ordinal);
CREATE INDEX frames_by_scope ON context_frames(scope_id, ordinal);
CREATE INDEX provider_items_by_scope ON provider_items(scope_id, created_sequence);
`;

export function listAgentDatabaseTables(database: DatabaseSync) {
  const rows = database.prepare(`
    SELECT name FROM sqlite_master
    WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
      AND (name = 'journal_search_index' OR name NOT GLOB 'journal_search_index_*')
    ORDER BY name
  `).all() as Array<{ name: string }>;
  return rows.map((row) => row.name);
}

export function createAgentSchema(database: DatabaseSync) {
  database.exec(SCHEMA_SQL);
  database.prepare('INSERT INTO meta (key, value_json) VALUES (?, ?)').run(
    'journal_schema',
    canonicalJson(AGENT_JOURNAL_SCHEMA_ID),
  );
  database.exec(`PRAGMA user_version = ${AGENT_JOURNAL_SCHEMA_VERSION}`);
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
  const expectedTables = [...AGENT_JOURNAL_TABLES].sort();
  if (!sameStrings(actualTables, expectedTables)) {
    throw new AgentSchemaError(
      `Agent schema tables do not match ${AGENT_JOURNAL_SCHEMA_ID} ` +
      `(expected ${expectedTables.join(', ')}; found ${actualTables.join(', ')}).`,
    );
  }
  for (const table of AGENT_JOURNAL_TABLES) {
    const rows = database.prepare(`PRAGMA table_info("${table}")`).all() as Array<{ name: string }>;
    const actualColumns = rows.map((row) => row.name);
    if (!sameStrings(actualColumns, EXPECTED_COLUMNS[table])) {
      throw new AgentSchemaError(`Agent schema columns do not match for ${table}.`);
    }
  }
  if (agentSchemaFingerprint(database) !== expectedFingerprint) {
    throw new AgentSchemaError('Agent schema structure does not match the thread-runtime reference.');
  }
  const schema = database.prepare('SELECT value_json FROM meta WHERE key = ?').get('journal_schema') as
    | { value_json: string }
    | undefined;
  if (!schema || schema.value_json !== canonicalJson(AGENT_JOURNAL_SCHEMA_ID)) {
    throw new AgentSchemaError('Agent journal schema identity is missing or invalid.');
  }
  const foreignKeyFailures = database.prepare('PRAGMA foreign_key_check').all();
  if (foreignKeyFailures.length > 0) {
    throw new AgentSchemaError(`Agent journal contains ${foreignKeyFailures.length} foreign-key violation(s).`);
  }
  validateCanonicalData(database);
}

function validateCanonicalData(database: DatabaseSync) {
  const jsonColumns: Array<[string, string]> = [
    ['meta', 'value_json'],
    ['execution_scopes', 'objective_json'],
    ['events', 'payload_json'],
    ['transcript_items', 'value_json'],
    ['resources', 'value_json'],
    ['operations', 'value_json'],
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
        throw new AgentSchemaError(`Agent journal contains invalid JSON in ${table}.${column}.`, { cause: error });
      }
      if (canonicalJson(parsed) !== row.value) {
        throw new AgentSchemaError(`Agent journal contains non-canonical JSON in ${table}.${column}.`);
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
