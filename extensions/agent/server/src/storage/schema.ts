import type { DatabaseSync } from 'node:sqlite';

import { canonicalJson, canonicalJsonHash } from './canonical-json.ts';

export const AGENT_JOURNAL_SCHEMA_VERSION = 2;
export const AGENT_JOURNAL_SCHEMA_ID = 'agent-journal-v2';
export const AGENT_JOURNAL_SCHEMA_V1_ID = 'agent-journal-v1';

export const AGENT_JOURNAL_TABLES = [
  'meta',
  'projects',
  'context_spaces',
  'project_primaries',
  'context_bindings',
  'project_relations',
  'conversations',
  'strands',
  'turns',
  'execution_scopes',
  'events',
  'transcript_items',
  'resources',
  'operations',
  'artifacts',
  'epochs',
  'epoch_blocks',
  'inferences',
] as const;

const EXPECTED_COLUMNS: Record<typeof AGENT_JOURNAL_TABLES[number], string[]> = {
  meta: ['key', 'value_json'],
  projects: [
    'project_id', 'root_path', 'title', 'root_space_id', 'revision', 'state',
    'created_sequence', 'updated_sequence', 'created_at', 'updated_at',
  ],
  context_spaces: [
    'space_id', 'project_id', 'parent_space_id', 'key', 'descriptor_json',
    'created_revision', 'created_sequence',
  ],
  project_primaries: [
    'primary_id', 'project_id', 'home_space_id', 'key', 'kind',
    'descriptor_json', 'body_json', 'authority', 'provenance_json', 'lifecycle',
    'superseded_by', 'version', 'created_revision', 'updated_revision',
    'created_sequence', 'updated_sequence',
  ],
  context_bindings: [
    'space_id', 'primary_id', 'project_id', 'mode', 'provenance_json', 'version',
    'created_revision', 'updated_revision', 'created_sequence', 'updated_sequence',
  ],
  project_relations: [
    'relation_id', 'project_id', 'from_type', 'from_id', 'predicate', 'to_type',
    'to_id', 'attributes_json', 'provenance_json', 'version', 'created_revision',
    'created_sequence',
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
    'root_scope_id', 'mode', 'state', 'accepted_sequence', 'terminal_sequence',
    'created_at', 'updated_at',
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
    'redaction_state',
  ],
  epochs: [
    'epoch_id', 'project_id', 'conversation_id', 'strand_id', 'turn_id',
    'scope_id', 'ordinal', 'state', 'policy_version', 'opened_sequence',
    'closed_sequence', 'close_reason', 'bootstrap_artifact_hash', 'basis_sequence',
  ],
  epoch_blocks: [
    'epoch_id', 'ordinal', 'block_hash', 'kind', 'source_json',
    'estimated_tokens', 'artifact_hash',
  ],
  inferences: [
    'inference_id', 'project_id', 'conversation_id', 'strand_id', 'turn_id',
    'scope_id', 'epoch_id', 'ordinal', 'basis_sequence', 'state', 'request_mode',
    'manifest_artifact_hash', 'input_hash', 'estimated_input_tokens',
    'reported_input_tokens', 'reported_output_tokens', 'started_sequence',
    'terminal_sequence',
  ],
};

const SCHEMA_V1_SQL = `
CREATE TABLE meta (
  key TEXT PRIMARY KEY NOT NULL,
  value_json TEXT NOT NULL CHECK (json_valid(value_json))
) STRICT;

CREATE TABLE projects (
  project_id TEXT PRIMARY KEY NOT NULL,
  root_path TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  root_space_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision >= 0),
  state TEXT NOT NULL,
  created_sequence INTEGER NOT NULL,
  updated_sequence INTEGER NOT NULL,
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  updated_at INTEGER NOT NULL CHECK (updated_at >= created_at),
  UNIQUE (project_id, root_space_id),
  CHECK (updated_sequence >= created_sequence),
  FOREIGN KEY (project_id, root_space_id)
    REFERENCES context_spaces(project_id, space_id)
    DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (created_sequence, project_id)
    REFERENCES events(sequence, project_id)
    DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (updated_sequence, project_id)
    REFERENCES events(sequence, project_id)
    DEFERRABLE INITIALLY DEFERRED
) STRICT;

CREATE TABLE context_spaces (
  space_id TEXT PRIMARY KEY NOT NULL,
  project_id TEXT NOT NULL,
  parent_space_id TEXT,
  key TEXT NOT NULL,
  descriptor_json TEXT NOT NULL CHECK (json_valid(descriptor_json)),
  created_revision INTEGER NOT NULL CHECK (created_revision >= 0),
  created_sequence INTEGER NOT NULL,
  UNIQUE (project_id, space_id),
  UNIQUE (project_id, parent_space_id, key),
  FOREIGN KEY (project_id) REFERENCES projects(project_id)
    DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (project_id, parent_space_id)
    REFERENCES context_spaces(project_id, space_id)
    DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (created_sequence, project_id)
    REFERENCES events(sequence, project_id)
    DEFERRABLE INITIALLY DEFERRED
) STRICT;

CREATE TABLE project_primaries (
  primary_id TEXT PRIMARY KEY NOT NULL,
  project_id TEXT NOT NULL,
  home_space_id TEXT NOT NULL,
  key TEXT NOT NULL,
  kind TEXT NOT NULL,
  descriptor_json TEXT NOT NULL CHECK (json_valid(descriptor_json)),
  body_json TEXT NOT NULL CHECK (json_valid(body_json)),
  authority TEXT NOT NULL,
  provenance_json TEXT NOT NULL CHECK (json_valid(provenance_json)),
  lifecycle TEXT NOT NULL,
  superseded_by TEXT,
  version INTEGER NOT NULL CHECK (version >= 1),
  created_revision INTEGER NOT NULL CHECK (created_revision >= 0),
  updated_revision INTEGER NOT NULL CHECK (updated_revision >= created_revision),
  created_sequence INTEGER NOT NULL,
  updated_sequence INTEGER NOT NULL,
  UNIQUE (project_id, primary_id),
  UNIQUE (project_id, home_space_id, key),
  CHECK (authority IN ('user', 'observed', 'model')),
  CHECK (lifecycle IN ('active', 'superseded', 'tombstoned')),
  CHECK ((lifecycle = 'superseded') = (superseded_by IS NOT NULL)),
  CHECK (updated_sequence >= created_sequence),
  FOREIGN KEY (project_id) REFERENCES projects(project_id)
    DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (project_id, home_space_id)
    REFERENCES context_spaces(project_id, space_id)
    DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (project_id, superseded_by)
    REFERENCES project_primaries(project_id, primary_id)
    DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (created_sequence, project_id)
    REFERENCES events(sequence, project_id)
    DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (updated_sequence, project_id)
    REFERENCES events(sequence, project_id)
    DEFERRABLE INITIALLY DEFERRED
) STRICT;

CREATE TABLE context_bindings (
  space_id TEXT NOT NULL,
  primary_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  mode TEXT NOT NULL,
  provenance_json TEXT NOT NULL CHECK (json_valid(provenance_json)),
  version INTEGER NOT NULL CHECK (version >= 1),
  created_revision INTEGER NOT NULL CHECK (created_revision >= 0),
  updated_revision INTEGER NOT NULL CHECK (updated_revision >= created_revision),
  created_sequence INTEGER NOT NULL,
  updated_sequence INTEGER NOT NULL,
  PRIMARY KEY (space_id, primary_id),
  UNIQUE (project_id, space_id, primary_id),
  CHECK (mode IN ('inline', 'index', 'available', 'masked')),
  CHECK (updated_sequence >= created_sequence),
  FOREIGN KEY (project_id, space_id)
    REFERENCES context_spaces(project_id, space_id)
    DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (project_id, primary_id)
    REFERENCES project_primaries(project_id, primary_id)
    DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (created_sequence, project_id)
    REFERENCES events(sequence, project_id)
    DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (updated_sequence, project_id)
    REFERENCES events(sequence, project_id)
    DEFERRABLE INITIALLY DEFERRED
) STRICT;

CREATE TABLE project_relations (
  relation_id TEXT PRIMARY KEY NOT NULL,
  project_id TEXT NOT NULL,
  from_type TEXT NOT NULL,
  from_id TEXT NOT NULL,
  predicate TEXT NOT NULL,
  to_type TEXT NOT NULL,
  to_id TEXT NOT NULL,
  attributes_json TEXT NOT NULL CHECK (json_valid(attributes_json)),
  provenance_json TEXT NOT NULL CHECK (json_valid(provenance_json)),
  version INTEGER NOT NULL CHECK (version >= 1),
  created_revision INTEGER NOT NULL CHECK (created_revision >= 0),
  created_sequence INTEGER NOT NULL,
  UNIQUE (project_id, relation_id),
  CHECK (from_type IN ('primary', 'space')),
  CHECK (to_type IN ('primary', 'space')),
  FOREIGN KEY (project_id) REFERENCES projects(project_id)
    DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (created_sequence, project_id)
    REFERENCES events(sequence, project_id)
    DEFERRABLE INITIALLY DEFERRED
) STRICT;

CREATE TABLE conversations (
  conversation_id TEXT PRIMARY KEY NOT NULL,
  project_id TEXT NOT NULL,
  title TEXT NOT NULL,
  cwd TEXT NOT NULL,
  model_id TEXT NOT NULL,
  reasoning TEXT NOT NULL,
  head_strand_id TEXT NOT NULL,
  state TEXT NOT NULL,
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  updated_at INTEGER NOT NULL CHECK (updated_at >= created_at),
  UNIQUE (project_id, conversation_id),
  FOREIGN KEY (project_id) REFERENCES projects(project_id)
    DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (conversation_id, head_strand_id)
    REFERENCES strands(conversation_id, strand_id)
    DEFERRABLE INITIALLY DEFERRED
) STRICT;

CREATE TABLE strands (
  strand_id TEXT PRIMARY KEY NOT NULL,
  conversation_id TEXT NOT NULL,
  parent_strand_id TEXT,
  forked_from_sequence INTEGER,
  state TEXT NOT NULL,
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  UNIQUE (conversation_id, strand_id),
  CHECK ((parent_strand_id IS NULL) = (forked_from_sequence IS NULL)),
  FOREIGN KEY (conversation_id) REFERENCES conversations(conversation_id)
    DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (conversation_id, parent_strand_id)
    REFERENCES strands(conversation_id, strand_id)
    DEFERRABLE INITIALLY DEFERRED,
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
  mode TEXT,
  state TEXT NOT NULL,
  accepted_sequence INTEGER NOT NULL UNIQUE,
  terminal_sequence INTEGER UNIQUE,
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  updated_at INTEGER NOT NULL CHECK (updated_at >= created_at),
  UNIQUE (conversation_id, turn_id),
  UNIQUE (conversation_id, client_message_id),
  UNIQUE (conversation_id, strand_id, turn_id),
  UNIQUE (project_id, conversation_id, strand_id, turn_id),
  CHECK (terminal_sequence IS NULL OR terminal_sequence >= accepted_sequence),
  FOREIGN KEY (project_id, conversation_id)
    REFERENCES conversations(project_id, conversation_id)
    DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (conversation_id, strand_id)
    REFERENCES strands(conversation_id, strand_id)
    DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (project_id, conversation_id, strand_id, turn_id, root_scope_id)
    REFERENCES execution_scopes(project_id, conversation_id, strand_id, turn_id, scope_id)
    DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (accepted_sequence, project_id, conversation_id, strand_id)
    REFERENCES events(sequence, project_id, conversation_id, strand_id)
    DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (terminal_sequence, project_id, conversation_id, strand_id)
    REFERENCES events(sequence, project_id, conversation_id, strand_id)
    DEFERRABLE INITIALLY DEFERRED
) STRICT;

CREATE TABLE execution_scopes (
  scope_id TEXT PRIMARY KEY NOT NULL,
  project_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  strand_id TEXT NOT NULL,
  turn_id TEXT NOT NULL,
  parent_scope_id TEXT,
  kind TEXT NOT NULL,
  objective_json TEXT NOT NULL CHECK (json_valid(objective_json)),
  state TEXT NOT NULL,
  created_sequence INTEGER NOT NULL UNIQUE,
  terminal_sequence INTEGER UNIQUE,
  result_artifact_hash TEXT,
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  updated_at INTEGER NOT NULL CHECK (updated_at >= created_at),
  UNIQUE (conversation_id, scope_id),
  UNIQUE (conversation_id, strand_id, turn_id, scope_id),
  UNIQUE (project_id, conversation_id, strand_id, turn_id, scope_id),
  CHECK (kind IN ('turn', 'work_unit')),
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
  visibility TEXT NOT NULL,
  causal_event_id TEXT,
  operation_id TEXT,
  payload_json TEXT,
  artifact_hash TEXT,
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  UNIQUE (sequence, project_id),
  UNIQUE (sequence, conversation_id),
  UNIQUE (sequence, conversation_id, strand_id),
  UNIQUE (sequence, project_id, conversation_id, strand_id),
  UNIQUE (event_id, conversation_id),
  CHECK (scope_id IS NULL OR turn_id IS NOT NULL),
  CHECK (payload_json IS NULL OR json_valid(payload_json)),
  FOREIGN KEY (project_id, conversation_id)
    REFERENCES conversations(project_id, conversation_id)
    DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (conversation_id, strand_id)
    REFERENCES strands(conversation_id, strand_id)
    DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (causal_event_id, conversation_id)
    REFERENCES events(event_id, conversation_id)
    DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (project_id, conversation_id, strand_id, turn_id)
    REFERENCES turns(project_id, conversation_id, strand_id, turn_id)
    DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (project_id, conversation_id, strand_id, turn_id, scope_id)
    REFERENCES execution_scopes(project_id, conversation_id, strand_id, turn_id, scope_id)
    DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (operation_id, project_id, conversation_id, strand_id)
    REFERENCES operations(operation_id, project_id, conversation_id, strand_id)
    DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (artifact_hash) REFERENCES artifacts(hash)
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
    REFERENCES strands(conversation_id, strand_id)
    DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (conversation_id, strand_id, turn_id)
    REFERENCES turns(conversation_id, strand_id, turn_id)
    DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (first_sequence, conversation_id, strand_id)
    REFERENCES events(sequence, conversation_id, strand_id)
    DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (last_sequence, conversation_id, strand_id)
    REFERENCES events(sequence, conversation_id, strand_id)
    DEFERRABLE INITIALLY DEFERRED
) STRICT;

CREATE TABLE resources (
  resource_key TEXT PRIMARY KEY NOT NULL,
  basis_sequence INTEGER NOT NULL,
  value_json TEXT NOT NULL CHECK (json_valid(value_json)),
  updated_at INTEGER NOT NULL CHECK (updated_at >= 0),
  FOREIGN KEY (basis_sequence) REFERENCES events(sequence)
    DEFERRABLE INITIALLY DEFERRED
) STRICT;

CREATE TABLE operations (
  operation_id TEXT PRIMARY KEY NOT NULL,
  project_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  strand_id TEXT NOT NULL,
  turn_id TEXT,
  scope_id TEXT,
  kind TEXT NOT NULL,
  arguments_hash TEXT NOT NULL
    CHECK (length(arguments_hash) = 64 AND arguments_hash NOT GLOB '*[^0-9a-f]*'),
  state TEXT NOT NULL,
  accepted_sequence INTEGER NOT NULL UNIQUE,
  terminal_sequence INTEGER UNIQUE,
  result_artifact_hash TEXT,
  value_json TEXT NOT NULL CHECK (json_valid(value_json)),
  UNIQUE (operation_id, project_id, conversation_id, strand_id),
  CHECK (scope_id IS NULL OR turn_id IS NOT NULL),
  CHECK (terminal_sequence IS NULL OR terminal_sequence > accepted_sequence),
  FOREIGN KEY (project_id, conversation_id)
    REFERENCES conversations(project_id, conversation_id)
    DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (conversation_id, strand_id)
    REFERENCES strands(conversation_id, strand_id)
    DEFERRABLE INITIALLY DEFERRED,
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
  hash TEXT PRIMARY KEY NOT NULL
    CHECK (length(hash) = 64 AND hash NOT GLOB '*[^0-9a-f]*'),
  byte_length INTEGER NOT NULL CHECK (byte_length >= 0),
  media_type TEXT NOT NULL,
  created_sequence INTEGER NOT NULL,
  storage_path TEXT NOT NULL,
  redaction_state TEXT NOT NULL,
  FOREIGN KEY (created_sequence) REFERENCES events(sequence)
    DEFERRABLE INITIALLY DEFERRED
) STRICT;

CREATE TABLE epochs (
  epoch_id TEXT PRIMARY KEY NOT NULL,
  project_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  strand_id TEXT NOT NULL,
  turn_id TEXT NOT NULL,
  scope_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  state TEXT NOT NULL,
  policy_version TEXT NOT NULL,
  opened_sequence INTEGER NOT NULL UNIQUE,
  closed_sequence INTEGER UNIQUE,
  close_reason TEXT,
  bootstrap_artifact_hash TEXT,
  basis_sequence INTEGER NOT NULL,
  UNIQUE (scope_id, ordinal),
  UNIQUE (epoch_id, project_id, conversation_id, strand_id, turn_id, scope_id),
  CHECK (closed_sequence IS NULL OR closed_sequence >= opened_sequence),
  CHECK (basis_sequence <= opened_sequence),
  FOREIGN KEY (project_id, conversation_id, strand_id, turn_id, scope_id)
    REFERENCES execution_scopes(project_id, conversation_id, strand_id, turn_id, scope_id)
    DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (opened_sequence, project_id, conversation_id, strand_id)
    REFERENCES events(sequence, project_id, conversation_id, strand_id)
    DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (closed_sequence, project_id, conversation_id, strand_id)
    REFERENCES events(sequence, project_id, conversation_id, strand_id)
    DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (basis_sequence, project_id, conversation_id, strand_id)
    REFERENCES events(sequence, project_id, conversation_id, strand_id)
    DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (bootstrap_artifact_hash) REFERENCES artifacts(hash)
    DEFERRABLE INITIALLY DEFERRED
) STRICT;

CREATE TABLE epoch_blocks (
  epoch_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  block_hash TEXT NOT NULL
    CHECK (length(block_hash) = 64 AND block_hash NOT GLOB '*[^0-9a-f]*'),
  kind TEXT NOT NULL,
  source_json TEXT NOT NULL CHECK (json_valid(source_json)),
  estimated_tokens INTEGER NOT NULL CHECK (estimated_tokens >= 0),
  artifact_hash TEXT NOT NULL,
  PRIMARY KEY (epoch_id, ordinal),
  FOREIGN KEY (epoch_id) REFERENCES epochs(epoch_id)
    DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (artifact_hash) REFERENCES artifacts(hash)
    DEFERRABLE INITIALLY DEFERRED
) STRICT;

CREATE TABLE inferences (
  inference_id TEXT PRIMARY KEY NOT NULL,
  project_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  strand_id TEXT NOT NULL,
  turn_id TEXT NOT NULL,
  scope_id TEXT NOT NULL,
  epoch_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  basis_sequence INTEGER NOT NULL,
  state TEXT NOT NULL,
  request_mode TEXT NOT NULL,
  manifest_artifact_hash TEXT NOT NULL,
  input_hash TEXT NOT NULL
    CHECK (length(input_hash) = 64 AND input_hash NOT GLOB '*[^0-9a-f]*'),
  estimated_input_tokens INTEGER NOT NULL CHECK (estimated_input_tokens >= 0),
  reported_input_tokens INTEGER CHECK (reported_input_tokens >= 0),
  reported_output_tokens INTEGER CHECK (reported_output_tokens >= 0),
  started_sequence INTEGER NOT NULL UNIQUE,
  terminal_sequence INTEGER UNIQUE,
  CHECK (terminal_sequence IS NULL OR terminal_sequence >= started_sequence),
  UNIQUE (epoch_id, ordinal),
  FOREIGN KEY (epoch_id, project_id, conversation_id, strand_id, turn_id, scope_id)
    REFERENCES epochs(epoch_id, project_id, conversation_id, strand_id, turn_id, scope_id)
    DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (basis_sequence, project_id, conversation_id, strand_id)
    REFERENCES events(sequence, project_id, conversation_id, strand_id)
    DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (manifest_artifact_hash) REFERENCES artifacts(hash)
    DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (started_sequence, project_id, conversation_id, strand_id)
    REFERENCES events(sequence, project_id, conversation_id, strand_id)
    DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (terminal_sequence, project_id, conversation_id, strand_id)
    REFERENCES events(sequence, project_id, conversation_id, strand_id)
    DEFERRABLE INITIALLY DEFERRED
) STRICT;

CREATE INDEX projects_by_recent
  ON projects(updated_at DESC, project_id DESC);
CREATE INDEX context_spaces_by_parent
  ON context_spaces(project_id, parent_space_id, key);
CREATE UNIQUE INDEX context_spaces_one_root
  ON context_spaces(project_id) WHERE parent_space_id IS NULL;
CREATE INDEX project_primaries_by_home
  ON project_primaries(project_id, home_space_id, key);
CREATE INDEX project_relations_by_from
  ON project_relations(project_id, from_type, from_id, predicate);
CREATE INDEX project_relations_by_to
  ON project_relations(project_id, to_type, to_id, predicate);
CREATE INDEX conversations_by_recent
  ON conversations(updated_at DESC, conversation_id DESC);
CREATE INDEX strands_by_parent
  ON strands(conversation_id, parent_strand_id) WHERE parent_strand_id IS NOT NULL;
CREATE INDEX events_by_strand_sequence
  ON events(conversation_id, strand_id, sequence);
CREATE INDEX events_by_turn_sequence
  ON events(conversation_id, turn_id, sequence) WHERE turn_id IS NOT NULL;
CREATE INDEX events_by_scope_sequence
  ON events(scope_id, sequence) WHERE scope_id IS NOT NULL;
CREATE INDEX events_by_operation_sequence
  ON events(operation_id, sequence) WHERE operation_id IS NOT NULL;
CREATE INDEX transcript_items_by_strand_sequence
  ON transcript_items(conversation_id, strand_id, first_sequence);
CREATE INDEX operations_nonterminal
  ON operations(state) WHERE terminal_sequence IS NULL;
CREATE INDEX turns_by_strand_sequence
  ON turns(conversation_id, strand_id, accepted_sequence);
CREATE INDEX execution_scopes_by_parent
  ON execution_scopes(turn_id, parent_scope_id, created_sequence);
CREATE UNIQUE INDEX execution_scopes_one_root
  ON execution_scopes(turn_id) WHERE parent_scope_id IS NULL;
`;

export function listAgentDatabaseTables(database: DatabaseSync) {
  const rows = database.prepare(`
    SELECT name
    FROM sqlite_master
    WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
    ORDER BY name
  `).all() as Array<{ name: string }>;
  return rows.map((row) => row.name);
}

export function createAgentSchemaV1(database: DatabaseSync) {
  database.exec(SCHEMA_V1_SQL);
  database.prepare('INSERT INTO meta (key, value_json) VALUES (?, ?)').run(
    'journal_schema',
    canonicalJson(AGENT_JOURNAL_SCHEMA_V1_ID),
  );
  database.exec('PRAGMA user_version = 1');
}

export function createAgentSchemaV2(database: DatabaseSync) {
  database.exec(SCHEMA_V1_SQL);
  database.exec(`
    CREATE INDEX transcript_items_by_turn_sequence
      ON transcript_items(conversation_id, turn_id, first_sequence);
  `);
  database.prepare('INSERT INTO meta (key, value_json) VALUES (?, ?)').run(
    'journal_schema',
    canonicalJson(AGENT_JOURNAL_SCHEMA_ID),
  );
  database.exec(`PRAGMA user_version = ${AGENT_JOURNAL_SCHEMA_VERSION}`);
}

export function migrateAgentSchemaV1ToV2(database: DatabaseSync) {
  database.exec(`
    CREATE INDEX transcript_items_by_turn_sequence
      ON transcript_items(conversation_id, turn_id, first_sequence);
  `);
  database.prepare('UPDATE meta SET value_json = ? WHERE key = ?').run(
    canonicalJson(AGENT_JOURNAL_SCHEMA_ID),
    'journal_schema',
  );
  database.exec(`PRAGMA user_version = ${AGENT_JOURNAL_SCHEMA_VERSION}`);
}

export function agentSchemaFingerprint(database: DatabaseSync) {
  const rows = database.prepare(`
    SELECT type, name, tbl_name, sql
    FROM sqlite_schema
    WHERE name NOT LIKE 'sqlite_%'
      AND type IN ('table', 'index', 'trigger', 'view')
    ORDER BY type, name
  `).all() as Array<{
    type: string;
    name: string;
    tbl_name: string;
    sql: string | null;
  }>;
  return canonicalJsonHash(rows.map((row) => ({
    name: row.name,
    sql: row.sql === null ? null : normalizeSchemaSql(row.sql),
    table: row.tbl_name,
    type: row.type,
  })));
}

export function validateAgentSchemaV1(database: DatabaseSync, expectedFingerprint: string) {
  validateAgentSchema(database, expectedFingerprint, 1, AGENT_JOURNAL_SCHEMA_V1_ID);
}

export function validateAgentSchemaV2(database: DatabaseSync, expectedFingerprint: string) {
  validateAgentSchema(
    database,
    expectedFingerprint,
    AGENT_JOURNAL_SCHEMA_VERSION,
    AGENT_JOURNAL_SCHEMA_ID,
  );
}

function validateAgentSchema(
  database: DatabaseSync,
  expectedFingerprint: string,
  version: number,
  schemaId: string,
) {
  const actualTables = listAgentDatabaseTables(database);
  const expectedTables = [...AGENT_JOURNAL_TABLES].sort();
  if (!sameStrings(actualTables, expectedTables)) {
    throw new AgentSchemaError(
      `Agent schema tables do not match version ${version} (expected ${expectedTables.join(', ')}; found ${actualTables.join(', ')}).`,
    );
  }
  for (const table of AGENT_JOURNAL_TABLES) {
    const rows = database.prepare(`PRAGMA table_info("${table}")`).all() as Array<{ name: string }>;
    const actualColumns = rows.map((row) => row.name);
    if (!sameStrings(actualColumns, EXPECTED_COLUMNS[table])) {
      throw new AgentSchemaError(`Agent schema columns do not match version ${version} for ${table}.`);
    }
  }
  const actualFingerprint = agentSchemaFingerprint(database);
  if (actualFingerprint !== expectedFingerprint) {
    throw new AgentSchemaError(`Agent schema structure does not match version ${version}.`);
  }
  const schema = database.prepare('SELECT value_json FROM meta WHERE key = ?').get('journal_schema') as
    | { value_json: string }
    | undefined;
  if (!schema || schema.value_json !== canonicalJson(schemaId)) {
    throw new AgentSchemaError('Agent journal schema identity is missing or invalid.');
  }
  const foreignKeyFailures = database.prepare('PRAGMA foreign_key_check').all();
  if (foreignKeyFailures.length > 0) {
    throw new AgentSchemaError(`Agent journal contains ${foreignKeyFailures.length} foreign-key violation(s).`);
  }
  validateCanonicalData(database);
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

const CANONICAL_JSON_COLUMNS = [
  ['meta', 'value_json'],
  ['context_spaces', 'descriptor_json'],
  ['project_primaries', 'descriptor_json'],
  ['project_primaries', 'body_json'],
  ['project_primaries', 'provenance_json'],
  ['context_bindings', 'provenance_json'],
  ['project_relations', 'attributes_json'],
  ['project_relations', 'provenance_json'],
  ['execution_scopes', 'objective_json'],
  ['events', 'payload_json'],
  ['transcript_items', 'value_json'],
  ['resources', 'value_json'],
  ['operations', 'value_json'],
  ['epoch_blocks', 'source_json'],
] as const;

function validateCanonicalData(database: DatabaseSync) {
  for (const [table, column] of CANONICAL_JSON_COLUMNS) {
    const rows = database.prepare(`
      SELECT rowid AS storage_row_id, "${column}" AS value
      FROM "${table}"
      WHERE "${column}" IS NOT NULL
    `).all() as Array<{ storage_row_id: number; value: unknown }>;
    for (const row of rows) {
      if (typeof row.value !== 'string') {
        throw new AgentSchemaError(`Agent journal ${table}.${column} contains a non-text value.`);
      }
      if (
        table === 'events' &&
        column === 'payload_json' &&
        Buffer.byteLength(row.value, 'utf8') > 32 * 1024
      ) {
        throw new AgentSchemaError(`Agent journal event ${row.storage_row_id} payload exceeds 32 KiB.`);
      }
      try {
        if (canonicalJson(JSON.parse(row.value)) !== row.value) {
          throw new Error('noncanonical JSON');
        }
      } catch (error) {
        throw new AgentSchemaError(
          `Agent journal ${table}.${column} row ${row.storage_row_id} is not canonical JSON.`,
          { cause: error },
        );
      }
    }
  }
}

function normalizeSchemaSql(sql: string) {
  return sql.trim().replace(/\s+/gu, ' ');
}
