-- Provenance: accepted pre-F1 schema v12 snapshot saved 2026-09-05 at
-- /tmp/remux-audit-implementation/s1-pre-migration-v12/fresh-schema.sql.
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
  service_tier TEXT,
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
  service_tier TEXT,
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

CREATE TABLE native_child_handles (
  execution_id TEXT PRIMARY KEY NOT NULL,
  native_session_id TEXT NOT NULL,
  private_ref_json TEXT NOT NULL CHECK (json_valid(private_ref_json)),
  updated_at INTEGER NOT NULL CHECK (updated_at >= 0),
  FOREIGN KEY (execution_id) REFERENCES executions(execution_id) ON DELETE CASCADE
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
  service_tier TEXT,
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
  provider_subject_key TEXT,
  native_identity TEXT,
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  completed_at INTEGER,
  UNIQUE (conversation_id, operation_id, state),
  FOREIGN KEY (conversation_id) REFERENCES conversations(conversation_id) ON DELETE CASCADE
) STRICT;

CREATE UNIQUE INDEX conversation_control_subject_state
  ON conversation_control_events(conversation_id, provider_subject_key, state)
  WHERE provider_subject_key IS NOT NULL;

CREATE TABLE strand_control_path (
  path_entry_id TEXT PRIMARY KEY NOT NULL,
  strand_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  previous_turn_id TEXT,
  next_turn_id TEXT,
  native_ordinal INTEGER NOT NULL DEFAULT 0 CHECK (native_ordinal >= 0),
  relation TEXT NOT NULL CHECK (relation IN ('local', 'inherited')),
  UNIQUE(strand_id, operation_id),
  FOREIGN KEY (strand_id) REFERENCES conversation_strands(strand_id) ON DELETE CASCADE,
  FOREIGN KEY (operation_id) REFERENCES compaction_operations(operation_id) ON DELETE CASCADE,
  FOREIGN KEY (previous_turn_id) REFERENCES turns(turn_id),
  FOREIGN KEY (next_turn_id) REFERENCES turns(turn_id),
  CHECK (previous_turn_id IS NOT NULL OR next_turn_id IS NOT NULL)
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
  service_tier TEXT,
  revision INTEGER NOT NULL CHECK (revision >= 1),
  updated_at INTEGER NOT NULL CHECK (updated_at >= 0),
  PRIMARY KEY (scope, scope_id),
  CHECK (
    (scope = 'default-provider' AND model IS NULL AND effort IS NULL AND service_tier IS NULL) OR
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
  provider_subject_key TEXT,
  error_json TEXT CHECK (error_json IS NULL OR json_valid(error_json)),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  started_at INTEGER,
  completed_at INTEGER,
  updated_at INTEGER NOT NULL CHECK (updated_at >= created_at),
  FOREIGN KEY (conversation_id) REFERENCES conversations(conversation_id) ON DELETE CASCADE,
  FOREIGN KEY (command_id) REFERENCES command_receipts(command_id) ON DELETE CASCADE
) STRICT;

CREATE UNIQUE INDEX compaction_operation_subject
  ON compaction_operations(conversation_id, provider_subject_key)
  WHERE provider_subject_key IS NOT NULL;

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
  service_tier TEXT,
  access TEXT NOT NULL CHECK (access IN ('read-only', 'workspace-write', 'full-access')),
  state TEXT NOT NULL DEFAULT 'queued'
    CHECK (state IN ('queued', 'dispatching', 'blocked', 'delivery_unknown')),
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  UNIQUE (conversation_id, ordinal),
  UNIQUE (conversation_id, client_message_id),
  FOREIGN KEY (conversation_id) REFERENCES conversations(conversation_id) ON DELETE CASCADE,
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
