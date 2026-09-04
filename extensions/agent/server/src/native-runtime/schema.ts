import type { DatabaseSync } from 'node:sqlite';

export const NATIVE_AGENT_SCHEMA_VERSION = 9;
export const NATIVE_AGENT_APPLICATION_ID = 0x524d584e; // RMXN
export const NATIVE_AGENT_SCHEMA_ID = 'remux-agent-native-v1';

export const NATIVE_AGENT_TABLES = [
  'meta',
  'provider_instances',
  'conversations',
  'conversation_strands',
  'conversation_heads',
  'strand_turn_path',
  'native_turn_bindings',
  'branch_operations',
  'native_sessions',
  'turns',
  'executions',
  'events',
  'legacy_events',
  'turn_passes',
  'turn_blocks',
  'conversation_control_events',
  'usage_snapshots',
  'provider_account_usage',
  'composer_preferences',
  'compaction_operations',
  'command_receipts',
  'queued_messages',
  'queued_compactions',
  'artifacts',
  'notification_state',
] as const;

const SCHEMA_SQL = `
CREATE TABLE meta (
  key TEXT PRIMARY KEY NOT NULL,
  value_json TEXT NOT NULL CHECK (json_valid(value_json))
) STRICT;

CREATE TABLE provider_instances (
  provider_instance_id TEXT PRIMARY KEY NOT NULL,
  provider TEXT NOT NULL CHECK (provider IN ('codex', 'claude-code', 'fixture')),
  label TEXT NOT NULL,
  probe_state TEXT NOT NULL CHECK (probe_state IN ('ready', 'signed-out', 'missing', 'incompatible', 'error')),
  probe_json TEXT NOT NULL CHECK (json_valid(probe_json)),
  capability_revision TEXT NOT NULL,
  updated_at INTEGER NOT NULL CHECK (updated_at >= 0)
) STRICT;

CREATE TABLE conversations (
  conversation_id TEXT PRIMARY KEY NOT NULL,
  provider_instance_id TEXT NOT NULL,
  root_execution_id TEXT NOT NULL UNIQUE,
  parent_conversation_id TEXT,
  root_conversation_id TEXT NOT NULL,
  forked_from_path_entry_id TEXT,
  title TEXT NOT NULL,
  title_source TEXT NOT NULL DEFAULT 'generated'
    CHECK (title_source IN ('generated', 'manual', 'legacy')),
  preview TEXT NOT NULL,
  cwd TEXT NOT NULL,
  model TEXT NOT NULL,
  effort TEXT,
  access TEXT NOT NULL CHECK (access IN ('read-only', 'workspace-write', 'full-access')),
  state TEXT NOT NULL CHECK (state IN ('running', 'recovering', 'idle', 'failed', 'interrupted')),
  active_turn_id TEXT,
  latest_turn_id TEXT,
  health_message TEXT,
  history_state TEXT NOT NULL DEFAULT 'ready'
    CHECK (history_state IN ('indexed', 'loading', 'ready', 'failed')),
  history_error TEXT,
  native_history_revision TEXT,
  native_history_updated_at INTEGER CHECK (
    native_history_updated_at IS NULL OR native_history_updated_at >= 0
  ),
  history_synced_revision TEXT,
  history_synced_at INTEGER CHECK (history_synced_at IS NULL OR history_synced_at >= 0),
  resumable INTEGER NOT NULL CHECK (resumable IN (0, 1)),
  archived_at INTEGER,
  metadata_revision INTEGER NOT NULL DEFAULT 1 CHECK (metadata_revision >= 1),
  subtree_updated_at INTEGER NOT NULL CHECK (subtree_updated_at >= 0),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  updated_at INTEGER NOT NULL CHECK (updated_at >= created_at),
  FOREIGN KEY (provider_instance_id) REFERENCES provider_instances(provider_instance_id),
  FOREIGN KEY (parent_conversation_id) REFERENCES conversations(conversation_id)
) STRICT;

CREATE TABLE executions (
  execution_id TEXT PRIMARY KEY NOT NULL,
  conversation_id TEXT NOT NULL,
  strand_id TEXT,
  parent_execution_id TEXT,
  root_turn_id TEXT,
  ownership TEXT NOT NULL CHECK (ownership IN ('root', 'native', 'federated')),
  provider TEXT NOT NULL CHECK (provider IN ('codex', 'claude-code', 'fixture')),
  provider_instance_id TEXT NOT NULL,
  model TEXT,
  effort TEXT,
  access TEXT CHECK (access IS NULL OR access IN ('read-only', 'workspace-write', 'full-access')),
  federation_scheduling TEXT CHECK (
    federation_scheduling IS NULL OR federation_scheduling IN ('background', 'foreground')
  ),
  federation_depth INTEGER NOT NULL DEFAULT 0 CHECK (federation_depth BETWEEN 0 AND 2),
  title TEXT,
  state TEXT NOT NULL CHECK (state IN ('running', 'recovering', 'idle', 'failed', 'interrupted')),
  outcome TEXT CHECK (outcome IS NULL OR outcome IN ('completed', 'failed', 'interrupted', 'recovery_failed')),
  summary TEXT,
  transcript_available INTEGER NOT NULL CHECK (transcript_available IN (0, 1)),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  completed_at INTEGER,
  updated_at INTEGER NOT NULL CHECK (updated_at >= created_at),
  UNIQUE (conversation_id, execution_id),
  FOREIGN KEY (conversation_id) REFERENCES conversations(conversation_id) ON DELETE CASCADE,
  FOREIGN KEY (parent_execution_id) REFERENCES executions(execution_id),
  FOREIGN KEY (provider_instance_id) REFERENCES provider_instances(provider_instance_id),
  FOREIGN KEY (strand_id) REFERENCES conversation_strands(strand_id)
    DEFERRABLE INITIALLY DEFERRED
) STRICT;

CREATE TABLE native_sessions (
  execution_id TEXT PRIMARY KEY NOT NULL,
  provider TEXT NOT NULL CHECK (provider IN ('codex', 'claude-code', 'fixture')),
  provider_instance_id TEXT NOT NULL,
  native_session_id TEXT NOT NULL,
  private_ref_json TEXT NOT NULL CHECK (json_valid(private_ref_json)),
  adapter_version TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('ready', 'recovering', 'lost', 'closed')),
  first_observed_at INTEGER NOT NULL CHECK (first_observed_at >= 0),
  last_observed_at INTEGER NOT NULL CHECK (last_observed_at >= first_observed_at),
  UNIQUE (provider_instance_id, native_session_id),
  FOREIGN KEY (execution_id) REFERENCES executions(execution_id) ON DELETE CASCADE,
  FOREIGN KEY (provider_instance_id) REFERENCES provider_instances(provider_instance_id)
) STRICT;

CREATE TABLE turns (
  turn_id TEXT PRIMARY KEY NOT NULL,
  conversation_id TEXT NOT NULL,
  origin_strand_id TEXT,
  execution_id TEXT NOT NULL,
  client_message_id TEXT NOT NULL,
  command_id TEXT NOT NULL,
  user_content_json TEXT NOT NULL CHECK (json_valid(user_content_json)),
  model TEXT,
  effort TEXT,
  native_turn_id TEXT,
  assistant_artifact_id TEXT,
  ordering TEXT NOT NULL DEFAULT 'native-exact' CHECK (ordering IN ('native-exact', 'live-provisional', 'legacy-grouped')),
  state TEXT NOT NULL CHECK (state IN ('queued', 'running', 'recovering', 'completed', 'failed', 'interrupted')),
  outcome TEXT CHECK (outcome IS NULL OR outcome IN ('completed', 'failed', 'interrupted', 'recovery_failed')),
  error_json TEXT CHECK (error_json IS NULL OR json_valid(error_json)),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  started_at INTEGER,
  completed_at INTEGER,
  updated_at INTEGER NOT NULL CHECK (updated_at >= created_at),
  UNIQUE (conversation_id, client_message_id),
  UNIQUE (command_id),
  UNIQUE (conversation_id, turn_id),
  FOREIGN KEY (conversation_id) REFERENCES conversations(conversation_id) ON DELETE CASCADE,
  FOREIGN KEY (execution_id) REFERENCES executions(execution_id) ON DELETE CASCADE,
  FOREIGN KEY (assistant_artifact_id) REFERENCES artifacts(artifact_id),
  FOREIGN KEY (origin_strand_id) REFERENCES conversation_strands(strand_id)
) STRICT;

CREATE TABLE conversation_strands (
  strand_id TEXT PRIMARY KEY NOT NULL,
  conversation_id TEXT NOT NULL,
  source_strand_id TEXT,
  source_path_entry_id TEXT,
  cutoff_kind TEXT NOT NULL CHECK (cutoff_kind IN ('root', 'before', 'through', 'restore')),
  reason TEXT NOT NULL CHECK (reason IN ('initial', 'edit', 'fork', 'restore', 'legacy')),
  root_execution_id TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL CHECK (state IN ('preparing', 'ready', 'failed', 'orphaned')),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  ready_at INTEGER,
  failed_at INTEGER,
  FOREIGN KEY (conversation_id) REFERENCES conversations(conversation_id) ON DELETE CASCADE,
  FOREIGN KEY (source_strand_id) REFERENCES conversation_strands(strand_id),
  FOREIGN KEY (root_execution_id) REFERENCES executions(execution_id)
    DEFERRABLE INITIALLY DEFERRED
) STRICT;

CREATE INDEX conversation_strands_conversation_created
  ON conversation_strands(conversation_id, created_at, strand_id);

CREATE TABLE conversation_heads (
  conversation_id TEXT PRIMARY KEY NOT NULL,
  strand_id TEXT NOT NULL UNIQUE,
  revision INTEGER NOT NULL CHECK (revision >= 1),
  switched_at INTEGER NOT NULL CHECK (switched_at >= 0),
  FOREIGN KEY (conversation_id) REFERENCES conversations(conversation_id) ON DELETE CASCADE,
  FOREIGN KEY (strand_id) REFERENCES conversation_strands(strand_id)
) STRICT;

CREATE TABLE native_turn_bindings (
  native_binding_id TEXT PRIMARY KEY NOT NULL,
  provider_instance_id TEXT NOT NULL,
  native_session_execution_id TEXT NOT NULL,
  turn_id TEXT NOT NULL,
  native_turn_id TEXT,
  branch_cursor_json TEXT CHECK (branch_cursor_json IS NULL OR json_valid(branch_cursor_json)),
  cursor_version INTEGER,
  binding_state TEXT NOT NULL CHECK (
    binding_state IN ('live', 'authoritative', 'legacy-unbranchable')
  ),
  validated_at INTEGER NOT NULL CHECK (validated_at >= 0),
  UNIQUE(native_session_execution_id, turn_id),
  FOREIGN KEY (provider_instance_id) REFERENCES provider_instances(provider_instance_id),
  FOREIGN KEY (native_session_execution_id) REFERENCES executions(execution_id) ON DELETE CASCADE,
  FOREIGN KEY (turn_id) REFERENCES turns(turn_id) ON DELETE CASCADE
) STRICT;

CREATE TABLE strand_turn_path (
  path_entry_id TEXT PRIMARY KEY NOT NULL,
  strand_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  turn_id TEXT NOT NULL,
  source_path_entry_id TEXT,
  relation TEXT NOT NULL CHECK (relation IN ('local', 'inherited')),
  branch_binding_id TEXT,
  UNIQUE(strand_id, ordinal),
  UNIQUE(strand_id, turn_id),
  FOREIGN KEY (strand_id) REFERENCES conversation_strands(strand_id) ON DELETE CASCADE,
  FOREIGN KEY (turn_id) REFERENCES turns(turn_id),
  FOREIGN KEY (source_path_entry_id) REFERENCES strand_turn_path(path_entry_id),
  FOREIGN KEY (branch_binding_id) REFERENCES native_turn_bindings(native_binding_id)
) STRICT;

CREATE INDEX strand_turn_path_turn ON strand_turn_path(turn_id, strand_id);

CREATE TABLE branch_operations (
  operation_id TEXT PRIMARY KEY NOT NULL,
  command_id TEXT NOT NULL UNIQUE,
  mode TEXT NOT NULL CHECK (mode IN ('edit', 'fork', 'restore')),
  source_conversation_id TEXT NOT NULL,
  source_strand_id TEXT NOT NULL,
  source_path_entry_id TEXT NOT NULL,
  expected_head_revision INTEGER NOT NULL CHECK (expected_head_revision >= 1),
  destination_conversation_id TEXT,
  destination_strand_id TEXT NOT NULL,
  destination_execution_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN (
    'claimed', 'native-forking', 'native-prepared', 'prefix-validated',
    'turn-dispatching', 'accepted', 'activated', 'failed', 'delivery-unknown'
  )),
  native_result_json TEXT CHECK (native_result_json IS NULL OR json_valid(native_result_json)),
  error_json TEXT CHECK (error_json IS NULL OR json_valid(error_json)),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  updated_at INTEGER NOT NULL CHECK (updated_at >= created_at),
  FOREIGN KEY (command_id) REFERENCES command_receipts(command_id) ON DELETE CASCADE,
  FOREIGN KEY (source_conversation_id) REFERENCES conversations(conversation_id),
  FOREIGN KEY (source_strand_id) REFERENCES conversation_strands(strand_id),
  FOREIGN KEY (source_path_entry_id) REFERENCES strand_turn_path(path_entry_id)
) STRICT;

CREATE TABLE events (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL UNIQUE,
  provider_instance_id TEXT NOT NULL,
  scope_kind TEXT NOT NULL CHECK (scope_kind IN ('account', 'conversation', 'turn', 'execution')),
  conversation_id TEXT,
  execution_id TEXT,
  turn_id TEXT,
  event_type TEXT NOT NULL,
  native_kind TEXT NOT NULL,
  envelope_json TEXT NOT NULL CHECK (json_valid(envelope_json)),
  observed_at INTEGER NOT NULL CHECK (observed_at >= 0),
  CHECK (
    (scope_kind = 'account' AND conversation_id IS NULL AND execution_id IS NULL AND turn_id IS NULL) OR
    (scope_kind = 'conversation' AND conversation_id IS NOT NULL AND execution_id IS NOT NULL AND turn_id IS NULL) OR
    (scope_kind = 'turn' AND conversation_id IS NOT NULL AND execution_id IS NOT NULL AND turn_id IS NOT NULL) OR
    (scope_kind = 'execution' AND conversation_id IS NOT NULL AND execution_id IS NOT NULL)
  ),
  FOREIGN KEY (provider_instance_id) REFERENCES provider_instances(provider_instance_id),
  FOREIGN KEY (conversation_id) REFERENCES conversations(conversation_id) ON DELETE CASCADE,
  FOREIGN KEY (execution_id) REFERENCES executions(execution_id) ON DELETE CASCADE,
  FOREIGN KEY (turn_id) REFERENCES turns(turn_id) ON DELETE CASCADE
) STRICT;

CREATE INDEX events_conversation_sequence ON events(conversation_id, sequence);
CREATE INDEX events_execution_sequence ON events(execution_id, sequence);
CREATE INDEX events_turn_sequence ON events(turn_id, sequence);
CREATE INDEX events_provider_sequence ON events(provider_instance_id, sequence);

CREATE TABLE legacy_events (
  sequence INTEGER PRIMARY KEY,
  event_id TEXT NOT NULL UNIQUE,
  conversation_id TEXT NOT NULL,
  execution_id TEXT NOT NULL,
  turn_id TEXT,
  event_type TEXT NOT NULL,
  native_kind TEXT NOT NULL,
  envelope_json TEXT NOT NULL CHECK (json_valid(envelope_json)),
  observed_at INTEGER NOT NULL CHECK (observed_at >= 0)
) STRICT;

CREATE INDEX legacy_events_conversation_sequence ON legacy_events(conversation_id, sequence);
CREATE INDEX legacy_events_execution_sequence ON legacy_events(execution_id, sequence);
CREATE INDEX legacy_events_turn_sequence ON legacy_events(turn_id, sequence);

CREATE TABLE turn_passes (
  pass_id TEXT PRIMARY KEY NOT NULL,
  turn_id TEXT NOT NULL,
  native_message_id TEXT,
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  state TEXT NOT NULL CHECK (state IN ('streaming', 'completed', 'reconciled')),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  updated_at INTEGER NOT NULL CHECK (updated_at >= created_at),
  UNIQUE (turn_id, ordinal),
  FOREIGN KEY (turn_id) REFERENCES turns(turn_id) ON DELETE CASCADE
) STRICT;

CREATE TABLE turn_blocks (
  block_id TEXT PRIMARY KEY NOT NULL,
  turn_id TEXT NOT NULL,
  pass_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN (
    'reasoning-summary', 'commentary', 'tool', 'native-child', 'federated-child',
    'web', 'final-message', 'compatibility-notice'
  )),
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  state TEXT NOT NULL CHECK (state IN ('streaming', 'running', 'completed', 'failed', 'interrupted')),
  revision INTEGER NOT NULL CHECK (revision >= 0),
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  content_hash TEXT NOT NULL CHECK (length(content_hash) = 64 AND content_hash NOT GLOB '*[^0-9a-f]*'),
  started_at INTEGER CHECK (started_at IS NULL OR started_at >= 0),
  completed_at INTEGER CHECK (completed_at IS NULL OR completed_at >= 0),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  updated_at INTEGER NOT NULL CHECK (updated_at >= created_at),
  UNIQUE (pass_id, ordinal),
  FOREIGN KEY (turn_id) REFERENCES turns(turn_id) ON DELETE CASCADE,
  FOREIGN KEY (pass_id) REFERENCES turn_passes(pass_id) ON DELETE CASCADE
) STRICT;

CREATE INDEX turn_passes_turn_ordinal ON turn_passes(turn_id, ordinal);
CREATE INDEX turn_blocks_turn_order ON turn_blocks(turn_id, pass_id, ordinal);

CREATE TABLE conversation_control_events (
  control_event_id TEXT PRIMARY KEY NOT NULL,
  conversation_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('compaction', 'session-recovery', 'session-transition')),
  boundary_json TEXT NOT NULL CHECK (json_valid(boundary_json)),
  state TEXT NOT NULL CHECK (state IN ('started', 'completed', 'failed')),
  operation_id TEXT NOT NULL,
  native_identity TEXT,
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  completed_at INTEGER,
  UNIQUE (conversation_id, operation_id, state),
  FOREIGN KEY (conversation_id) REFERENCES conversations(conversation_id) ON DELETE CASCADE
) STRICT;

CREATE TABLE usage_snapshots (
  event_id TEXT PRIMARY KEY NOT NULL,
  provider_instance_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  turn_id TEXT,
  usage_json TEXT NOT NULL CHECK (json_valid(usage_json)),
  observed_at INTEGER NOT NULL CHECK (observed_at >= 0),
  FOREIGN KEY (provider_instance_id) REFERENCES provider_instances(provider_instance_id),
  FOREIGN KEY (conversation_id) REFERENCES conversations(conversation_id) ON DELETE CASCADE,
  FOREIGN KEY (turn_id) REFERENCES turns(turn_id) ON DELETE CASCADE
) STRICT;

CREATE INDEX usage_snapshots_conversation_observed
  ON usage_snapshots(conversation_id, observed_at, event_id);

CREATE TABLE provider_account_usage (
  provider_instance_id TEXT PRIMARY KEY NOT NULL,
  event_id TEXT NOT NULL UNIQUE,
  usage_json TEXT NOT NULL CHECK (json_valid(usage_json)),
  observed_at INTEGER NOT NULL CHECK (observed_at >= 0),
  FOREIGN KEY (provider_instance_id) REFERENCES provider_instances(provider_instance_id)
) STRICT;

CREATE TABLE composer_preferences (
  scope TEXT NOT NULL CHECK (scope IN ('provider', 'conversation', 'default-provider')),
  scope_id TEXT NOT NULL,
  provider_instance_id TEXT NOT NULL,
  model TEXT,
  effort TEXT,
  revision INTEGER NOT NULL CHECK (revision >= 1),
  updated_at INTEGER NOT NULL CHECK (updated_at >= 0),
  PRIMARY KEY (scope, scope_id),
  CHECK (
    (scope = 'default-provider' AND model IS NULL AND effort IS NULL) OR
    (scope != 'default-provider' AND model IS NOT NULL)
  ),
  FOREIGN KEY (provider_instance_id) REFERENCES provider_instances(provider_instance_id)
) STRICT, WITHOUT ROWID;

CREATE TABLE compaction_operations (
  operation_id TEXT PRIMARY KEY NOT NULL,
  command_id TEXT UNIQUE,
  conversation_id TEXT NOT NULL,
  trigger TEXT NOT NULL CHECK (trigger IN ('manual', 'automatic')),
  state TEXT NOT NULL CHECK (state IN (
    'queued', 'running', 'completed', 'failed', 'delivery_unknown', 'cancelled'
  )),
  disposition TEXT CHECK (disposition IS NULL OR disposition IN ('dispatched', 'satisfied-by-native-auto')),
  generation INTEGER NOT NULL CHECK (generation >= 0),
  before_tokens INTEGER CHECK (before_tokens IS NULL OR before_tokens >= 0),
  after_tokens INTEGER CHECK (after_tokens IS NULL OR after_tokens >= 0),
  native_operation_id TEXT,
  error_json TEXT CHECK (error_json IS NULL OR json_valid(error_json)),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  started_at INTEGER,
  completed_at INTEGER,
  updated_at INTEGER NOT NULL CHECK (updated_at >= created_at),
  FOREIGN KEY (conversation_id) REFERENCES conversations(conversation_id) ON DELETE CASCADE,
  FOREIGN KEY (command_id) REFERENCES command_receipts(command_id) ON DELETE CASCADE
) STRICT;

CREATE TABLE command_receipts (
  command_id TEXT PRIMARY KEY NOT NULL,
  kind TEXT NOT NULL,
  request_hash TEXT NOT NULL CHECK (length(request_hash) = 64 AND request_hash NOT GLOB '*[^0-9a-f]*'),
  state TEXT NOT NULL CHECK (state IN ('received', 'dispatching', 'accepted', 'rejected', 'recovery_failed')),
  result_json TEXT CHECK (result_json IS NULL OR json_valid(result_json)),
  error_message TEXT,
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  updated_at INTEGER NOT NULL CHECK (updated_at >= created_at)
) STRICT;

CREATE TABLE queued_messages (
  command_id TEXT PRIMARY KEY NOT NULL,
  conversation_id TEXT NOT NULL,
  turn_id TEXT NOT NULL UNIQUE,
  client_message_id TEXT NOT NULL,
  content_json TEXT NOT NULL CHECK (json_valid(content_json)),
  model TEXT,
  effort TEXT,
  access TEXT NOT NULL CHECK (access IN ('read-only', 'workspace-write', 'full-access')),
  state TEXT NOT NULL DEFAULT 'queued'
    CHECK (state IN ('queued', 'dispatching', 'blocked', 'delivery_unknown')),
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  UNIQUE (conversation_id, ordinal),
  UNIQUE (conversation_id, client_message_id),
  FOREIGN KEY (conversation_id) REFERENCES conversations(conversation_id) ON DELETE CASCADE,
  FOREIGN KEY (turn_id) REFERENCES turns(turn_id) ON DELETE CASCADE,
  FOREIGN KEY (command_id) REFERENCES command_receipts(command_id) ON DELETE CASCADE
) STRICT;

CREATE TABLE queued_compactions (
  command_id TEXT PRIMARY KEY NOT NULL,
  conversation_id TEXT NOT NULL,
  operation_id TEXT NOT NULL UNIQUE,
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  UNIQUE (conversation_id, ordinal),
  FOREIGN KEY (conversation_id) REFERENCES conversations(conversation_id) ON DELETE CASCADE,
  FOREIGN KEY (operation_id) REFERENCES compaction_operations(operation_id) ON DELETE CASCADE,
  FOREIGN KEY (command_id) REFERENCES command_receipts(command_id) ON DELETE CASCADE
) STRICT;

CREATE TABLE artifacts (
  artifact_id TEXT PRIMARY KEY NOT NULL,
  sha256 TEXT NOT NULL UNIQUE CHECK (length(sha256) = 64 AND sha256 NOT GLOB '*[^0-9a-f]*'),
  byte_length INTEGER NOT NULL CHECK (byte_length >= 0),
  media_type TEXT NOT NULL,
  visibility TEXT NOT NULL CHECK (visibility IN ('viewer', 'diagnostic', 'private')),
  storage_path TEXT NOT NULL,
  created_at INTEGER NOT NULL CHECK (created_at >= 0)
) STRICT;

CREATE TABLE notification_state (
  conversation_id TEXT PRIMARY KEY NOT NULL,
  last_terminal_turn_id TEXT,
  updated_at INTEGER NOT NULL CHECK (updated_at >= 0),
  FOREIGN KEY (conversation_id) REFERENCES conversations(conversation_id) ON DELETE CASCADE
) STRICT;
`;

export function createNativeAgentSchema(database: DatabaseSync) {
  database.exec(SCHEMA_SQL);
  database.prepare('INSERT INTO meta(key, value_json) VALUES (?, ?)').run(
    'schema_id',
    JSON.stringify(NATIVE_AGENT_SCHEMA_ID),
  );
  database.exec(`PRAGMA application_id = ${NATIVE_AGENT_APPLICATION_ID}`);
  database.exec(`PRAGMA user_version = ${NATIVE_AGENT_SCHEMA_VERSION}`);
}

export function migrateNativeAgentSchema(database: DatabaseSync, fromVersion: number) {
  if (fromVersion < 1 || fromVersion > 8) {
    throw new NativeAgentSchemaError(`No Native Agent migration exists from schema ${fromVersion}.`);
  }
  if (fromVersion === 1) {
    database.exec(`
      ALTER TABLE turns ADD COLUMN model TEXT;
      ALTER TABLE turns ADD COLUMN effort TEXT;
      ALTER TABLE queued_messages ADD COLUMN model TEXT;
      ALTER TABLE queued_messages ADD COLUMN effort TEXT;
      ALTER TABLE executions ADD COLUMN effort TEXT;
      ALTER TABLE executions ADD COLUMN access TEXT;
      UPDATE turns
        SET model = (SELECT model FROM conversations WHERE conversations.conversation_id = turns.conversation_id),
            effort = (SELECT effort FROM conversations WHERE conversations.conversation_id = turns.conversation_id);
      UPDATE queued_messages
        SET model = (SELECT model FROM conversations WHERE conversations.conversation_id = queued_messages.conversation_id),
            effort = (SELECT effort FROM conversations WHERE conversations.conversation_id = queued_messages.conversation_id);
      UPDATE executions
        SET effort = (SELECT effort FROM conversations WHERE conversations.conversation_id = executions.conversation_id),
            access = (SELECT access FROM conversations WHERE conversations.conversation_id = executions.conversation_id);
    `);
  }
  if (fromVersion <= 2) {
    database.exec(`
      ALTER TABLE executions ADD COLUMN federation_scheduling TEXT;
      ALTER TABLE executions ADD COLUMN federation_depth INTEGER NOT NULL DEFAULT 0;
    `);
  }
  if (fromVersion <= 3) {
    database.exec('ALTER TABLE turns ADD COLUMN assistant_artifact_id TEXT;');
  }
  if (fromVersion <= 4) {
    database.exec(`
      ALTER TABLE turns ADD COLUMN ordering TEXT NOT NULL DEFAULT 'legacy-grouped'
        CHECK (ordering IN ('native-exact', 'live-provisional', 'legacy-grouped'));
    `);
    if (schemaObjectExists(database, 'table', 'events')) {
      database.exec(`
        DROP INDEX IF EXISTS events_conversation_sequence;
        DROP INDEX IF EXISTS events_execution_sequence;
        DROP INDEX IF EXISTS events_turn_sequence;
        ALTER TABLE events RENAME TO legacy_events;
      `);
    }
    createVersionFiveObjects(database);
    database.exec(`
      DELETE FROM sqlite_sequence WHERE name = 'events';
      INSERT INTO sqlite_sequence(name, seq)
        SELECT 'events', COALESCE(MAX(sequence), 0) FROM legacy_events;
    `);
  }
  if (fromVersion <= 5 && schemaObjectExists(database, 'table', 'conversations')) {
    database.exec(`
      ALTER TABLE conversations ADD COLUMN history_state TEXT NOT NULL DEFAULT 'ready'
        CHECK (history_state IN ('indexed', 'loading', 'ready', 'failed'));
      ALTER TABLE conversations ADD COLUMN history_error TEXT;
      UPDATE conversations
      SET history_state = 'indexed'
      WHERE NOT EXISTS (
        SELECT 1 FROM turns WHERE turns.conversation_id = conversations.conversation_id
      ) AND EXISTS (
        SELECT 1 FROM native_sessions
        WHERE native_sessions.execution_id = conversations.root_execution_id
      );
    `);
  }
  if (fromVersion <= 6 && ['conversations', 'executions', 'turns', 'provider_instances']
    .every((name) => schemaObjectExists(database, 'table', name))) {
    migrateVersionSeven(database);
  }
  if (fromVersion <= 7 && schemaObjectExists(database, 'table', 'conversations')) {
    database.exec(`
      ALTER TABLE conversations ADD COLUMN native_history_revision TEXT;
      ALTER TABLE conversations ADD COLUMN native_history_updated_at INTEGER
        CHECK (native_history_updated_at IS NULL OR native_history_updated_at >= 0);
      ALTER TABLE conversations ADD COLUMN history_synced_revision TEXT;
      ALTER TABLE conversations ADD COLUMN history_synced_at INTEGER
        CHECK (history_synced_at IS NULL OR history_synced_at >= 0);
    `);
  }
  if (fromVersion <= 8 && schemaObjectExists(database, 'table', 'queued_messages')) {
    if (!schemaColumnExists(database, 'queued_messages', 'access')) {
      database.exec('ALTER TABLE queued_messages ADD COLUMN access TEXT;');
    }
    if (!schemaColumnExists(database, 'queued_messages', 'state')) {
      database.exec(`
        ALTER TABLE queued_messages ADD COLUMN state TEXT NOT NULL DEFAULT 'queued'
          CHECK (state IN ('queued', 'dispatching', 'blocked', 'delivery_unknown'));
      `);
    }
    database.exec(`
      UPDATE queued_messages
      SET access = (
        SELECT access FROM conversations
        WHERE conversations.conversation_id = queued_messages.conversation_id
      );
    `);
  }
  database.exec(`PRAGMA user_version = ${NATIVE_AGENT_SCHEMA_VERSION}`);
}

const VERSION_SEVEN_OBJECTS = [
  'conversation_strands',
  'conversation_strands_conversation_created',
  'conversation_heads',
  'native_turn_bindings',
  'strand_turn_path',
  'strand_turn_path_turn',
  'branch_operations',
] as const;

function migrateVersionSeven(database: DatabaseSync) {
  database.exec(`
    ALTER TABLE conversations ADD COLUMN parent_conversation_id TEXT;
    ALTER TABLE conversations ADD COLUMN root_conversation_id TEXT;
    ALTER TABLE conversations ADD COLUMN forked_from_path_entry_id TEXT;
    ALTER TABLE conversations ADD COLUMN title_source TEXT NOT NULL DEFAULT 'legacy'
      CHECK (title_source IN ('generated', 'manual', 'legacy'));
    ALTER TABLE conversations ADD COLUMN archived_at INTEGER;
    ALTER TABLE conversations ADD COLUMN metadata_revision INTEGER NOT NULL DEFAULT 1
      CHECK (metadata_revision >= 1);
    ALTER TABLE conversations ADD COLUMN subtree_updated_at INTEGER;
    ALTER TABLE executions ADD COLUMN strand_id TEXT;
    ALTER TABLE turns ADD COLUMN origin_strand_id TEXT;
    UPDATE conversations
      SET root_conversation_id = conversation_id,
          subtree_updated_at = updated_at;
  `);
  createObjectsFromSchema(database, VERSION_SEVEN_OBJECTS, 'Version 7');
  database.exec(`
    INSERT INTO conversation_strands(
      strand_id, conversation_id, source_strand_id, source_path_entry_id,
      cutoff_kind, reason, root_execution_id, state, created_at, ready_at, failed_at
    )
    SELECT 'legacy-strand:' || conversation_id, conversation_id, NULL, NULL,
      'root', 'legacy', root_execution_id, 'ready', created_at, updated_at, NULL
    FROM conversations;

    INSERT INTO conversation_heads(conversation_id, strand_id, revision, switched_at)
    SELECT conversation_id, 'legacy-strand:' || conversation_id, 1, updated_at
    FROM conversations;

    UPDATE executions
    SET strand_id = 'legacy-strand:' || conversation_id;

    UPDATE turns
    SET origin_strand_id = 'legacy-strand:' || conversation_id;

    INSERT INTO native_turn_bindings(
      native_binding_id, provider_instance_id, native_session_execution_id,
      turn_id, native_turn_id, branch_cursor_json, cursor_version,
      binding_state, validated_at
    )
    SELECT 'legacy-binding:' || t.turn_id, e.provider_instance_id, t.execution_id,
      t.turn_id, t.native_turn_id,
      CASE WHEN e.provider = 'codex'
        THEN json_object('version', 1, 'nativeTurnId', t.native_turn_id)
        ELSE NULL END,
      CASE WHEN e.provider = 'codex' THEN 1 ELSE NULL END,
      CASE WHEN e.provider = 'codex' THEN 'authoritative' ELSE 'legacy-unbranchable' END,
      t.updated_at
    FROM turns t
    JOIN executions e USING(execution_id)
    WHERE t.native_turn_id IS NOT NULL;

    INSERT INTO strand_turn_path(
      path_entry_id, strand_id, ordinal, turn_id, source_path_entry_id,
      relation, branch_binding_id
    )
    SELECT 'legacy-path:' || ranked.turn_id,
      'legacy-strand:' || ranked.conversation_id,
      ranked.ordinal,
      ranked.turn_id,
      NULL,
      'local',
      CASE WHEN ranked.native_turn_id IS NULL
        THEN NULL ELSE 'legacy-binding:' || ranked.turn_id END
    FROM (
      SELECT t.*,
        ROW_NUMBER() OVER (
          PARTITION BY t.conversation_id
          ORDER BY t.created_at, t.rowid
        ) - 1 AS ordinal
      FROM turns t
    ) AS ranked;
  `);
}

const VERSION_FIVE_OBJECTS = [
  'events',
  'legacy_events',
  'events_conversation_sequence',
  'events_execution_sequence',
  'events_turn_sequence',
  'events_provider_sequence',
  'legacy_events_conversation_sequence',
  'legacy_events_execution_sequence',
  'legacy_events_turn_sequence',
  'turn_passes',
  'turn_blocks',
  'turn_passes_turn_ordinal',
  'turn_blocks_turn_order',
  'conversation_control_events',
  'usage_snapshots',
  'usage_snapshots_conversation_observed',
  'provider_account_usage',
  'composer_preferences',
  'compaction_operations',
  'queued_compactions',
] as const;

function createVersionFiveObjects(database: DatabaseSync) {
  createObjectsFromSchema(database, VERSION_FIVE_OBJECTS, 'Version 5');
}

function createObjectsFromSchema(
  database: DatabaseSync,
  objects: readonly string[],
  label: string,
) {
  const wanted = new Set<string>(objects);
  const statements = SCHEMA_SQL.split(';')
    .map((statement) => statement.trim())
    .filter(Boolean)
    .filter((statement) => {
      const match = /^CREATE\s+(?:TABLE|INDEX)\s+([A-Za-z0-9_]+)/iu.exec(statement);
      if (!match || !wanted.has(match[1]!)) return false;
      const type = /^CREATE\s+TABLE/iu.test(statement) ? 'table' : 'index';
      return !schemaObjectExists(database, type, match[1]!);
    });
  const found = new Set(statements.flatMap((statement) => {
    const match = /^CREATE\s+(?:TABLE|INDEX)\s+([A-Za-z0-9_]+)/iu.exec(statement);
    return match ? [match[1]!] : [];
  }));
  for (const object of wanted) {
    if (!found.has(object)
        && !schemaObjectExists(database, 'table', object)
        && !schemaObjectExists(database, 'index', object)) {
      throw new NativeAgentSchemaError(`${label} schema object ${object} is missing.`);
    }
  }
  for (const statement of statements) {
    try {
      database.exec(`${statement};`);
    } catch (error) {
      const name = /^CREATE\s+(?:TABLE|INDEX)\s+([A-Za-z0-9_]+)/iu.exec(statement)?.[1] ?? 'unknown';
      throw new NativeAgentSchemaError(
        `Could not create ${label} schema object ${name}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

function schemaObjectExists(database: DatabaseSync, type: 'table' | 'index', name: string) {
  return Boolean(database.prepare(`
    SELECT 1 AS present FROM sqlite_schema WHERE type = ? AND name = ?
  `).get(type, name));
}

function schemaColumnExists(database: DatabaseSync, table: string, column: string) {
  return (database.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>)
    .some(({ name }) => name === column);
}

export function listNativeAgentTables(database: DatabaseSync) {
  return (database.prepare(`
    SELECT name FROM sqlite_schema
    WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
    ORDER BY name
  `).all() as Array<{ name: string }>).map(({ name }) => name);
}

export function validateNativeAgentSchema(database: DatabaseSync) {
  const version = pragmaNumber(database, 'user_version');
  const applicationId = pragmaNumber(database, 'application_id');
  if (version !== NATIVE_AGENT_SCHEMA_VERSION || applicationId !== NATIVE_AGENT_APPLICATION_ID) {
    throw new NativeAgentSchemaError(
      `Native Agent database identity mismatch (application=${applicationId}, version=${version}).`,
    );
  }
  const schemaId = database.prepare('SELECT value_json FROM meta WHERE key = ?').get('schema_id') as
    | { value_json: string }
    | undefined;
  if (!schemaId || JSON.parse(schemaId.value_json) !== NATIVE_AGENT_SCHEMA_ID) {
    throw new NativeAgentSchemaError('Native Agent database schema ID is missing or invalid.');
  }
  const tables = listNativeAgentTables(database);
  for (const table of NATIVE_AGENT_TABLES) {
    if (!tables.includes(table)) throw new NativeAgentSchemaError(`Native Agent table ${table} is missing.`);
  }
  const quick = database.prepare('PRAGMA quick_check').all() as Array<Record<string, unknown>>;
  if (quick.length !== 1 || Object.values(quick[0] ?? {})[0] !== 'ok') {
    throw new NativeAgentSchemaError('Native Agent database failed SQLite quick_check.');
  }
}

export class NativeAgentSchemaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NativeAgentSchemaError';
  }
}

function pragmaNumber(database: DatabaseSync, name: string) {
  const row = database.prepare(`PRAGMA ${name}`).get() as Record<string, unknown> | undefined;
  const value = row ? Object.values(row)[0] : undefined;
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new NativeAgentSchemaError(`Invalid SQLite PRAGMA ${name}.`);
  }
  return value;
}
