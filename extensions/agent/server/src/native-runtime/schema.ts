import type { DatabaseSync } from 'node:sqlite';

export const NATIVE_AGENT_SCHEMA_VERSION = 15;
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
  'native_child_handles',
  'turns',
  'executions',
  'federation_checkout_reservations',
  'events',
  'legacy_events',
  'turn_passes',
  'turn_blocks',
  'conversation_control_events',
  'strand_control_path',
  'usage_snapshots',
  'provider_account_usage',
  'composer_preferences',
  'compaction_operations',
  'command_receipts',
  'delivery_attempts',
  'delivery_attempt_staging',
  'queued_messages',
  'queued_compactions',
  'artifacts',
  'artifact_grants',
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
  checkout_key TEXT,
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

CREATE INDEX executions_checkout_key_idx ON executions(checkout_key)
  WHERE checkout_key IS NOT NULL;

CREATE TABLE federation_checkout_reservations (
  execution_id TEXT PRIMARY KEY NOT NULL,
  checkout_key TEXT,
  command_id TEXT,
  expected_turn_id TEXT,
  access TEXT NOT NULL CHECK (access IN ('read-only', 'workspace-write', 'full-access')),
  scheduling TEXT NOT NULL CHECK (scheduling IN ('foreground', 'background')),
  state TEXT NOT NULL CHECK (state IN ('held', 'unknown', 'released')),
  terminal_evidence_json TEXT CHECK (terminal_evidence_json IS NULL OR json_valid(terminal_evidence_json)),
  release_reason TEXT CHECK (release_reason IS NULL OR release_reason IN ('pre-dispatch-failure', 'native-terminal')),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  updated_at INTEGER NOT NULL CHECK (updated_at >= created_at),
  released_at INTEGER CHECK (released_at IS NULL OR released_at >= created_at),
  CHECK ((command_id IS NULL) = (expected_turn_id IS NULL)),
  CHECK (state <> 'held' OR (checkout_key IS NOT NULL AND command_id IS NOT NULL AND expected_turn_id IS NOT NULL)),
  CHECK ((state = 'released') = (released_at IS NOT NULL)),
  CHECK ((state = 'released') = (release_reason IS NOT NULL)),
  CHECK (state = 'released' OR release_reason IS NULL),
  UNIQUE (command_id),
  FOREIGN KEY (execution_id) REFERENCES executions(execution_id) ON DELETE RESTRICT,
  FOREIGN KEY (command_id) REFERENCES command_receipts(command_id) ON DELETE RESTRICT
) STRICT;
CREATE INDEX federation_checkout_reservations_capacity_idx
  ON federation_checkout_reservations(checkout_key, state, access, scheduling)
  WHERE state IN ('held', 'unknown');
CREATE INDEX federation_checkout_reservations_global_unknown_idx
  ON federation_checkout_reservations(state)
  WHERE state = 'unknown' AND checkout_key IS NULL;

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

CREATE TABLE artifact_grants (
  grant_id INTEGER PRIMARY KEY,
  artifact_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  execution_id TEXT,
  provenance TEXT NOT NULL CHECK (provenance IN (
    'viewer-message', 'viewer-queue', 'provider-history',
    'execution-output', 'federation-delegation'
  )),
  source_turn_id TEXT,
  source_execution_id TEXT,
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  FOREIGN KEY (artifact_id) REFERENCES artifacts(artifact_id) ON DELETE CASCADE,
  FOREIGN KEY (conversation_id) REFERENCES conversations(conversation_id) ON DELETE CASCADE,
  FOREIGN KEY (conversation_id, execution_id)
    REFERENCES executions(conversation_id, execution_id) ON DELETE CASCADE,
  FOREIGN KEY (conversation_id, source_execution_id)
    REFERENCES executions(conversation_id, execution_id),
  FOREIGN KEY (conversation_id, source_turn_id)
    REFERENCES turns(conversation_id, turn_id),
  CHECK (execution_id IS NOT NULL OR source_execution_id IS NULL)
) STRICT;

CREATE UNIQUE INDEX artifact_grants_conversation
  ON artifact_grants(artifact_id, conversation_id) WHERE execution_id IS NULL;
CREATE UNIQUE INDEX artifact_grants_execution
  ON artifact_grants(artifact_id, conversation_id, execution_id) WHERE execution_id IS NOT NULL;
CREATE INDEX artifact_grants_scope
  ON artifact_grants(conversation_id, execution_id, artifact_id);

CREATE TABLE notification_state (
  conversation_id TEXT PRIMARY KEY NOT NULL,
  last_terminal_turn_id TEXT,
  updated_at INTEGER NOT NULL CHECK (updated_at >= 0),
  FOREIGN KEY (conversation_id) REFERENCES conversations(conversation_id) ON DELETE CASCADE
) STRICT;

CREATE TABLE delivery_attempts (
  attempt_id TEXT PRIMARY KEY NOT NULL,
  command_id TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL CHECK (kind IN ('root-turn', 'steer', 'manual-compact')),
  provider TEXT NOT NULL CHECK (provider IN ('codex', 'claude-code', 'fixture')),
  provider_instance_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  execution_id TEXT NOT NULL,
  intended_turn_id TEXT,
  client_message_id TEXT,
  native_client_message_id TEXT,
  compact_operation_id TEXT,
  recovery_payload_hash TEXT NOT NULL CHECK (length(recovery_payload_hash) = 64 AND recovery_payload_hash NOT GLOB '*[^0-9a-f]*'),
  recovery_payload_json TEXT NOT NULL CHECK (json_valid(recovery_payload_json) AND length(CAST(recovery_payload_json AS BLOB)) <= 67108864),
  native_session_id TEXT NOT NULL,
  process_generation TEXT,
  native_turn_id TEXT,
  native_operation_id TEXT,
  owner_instance_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('preparing', 'dispatching', 'accepted', 'rejected', 'unknown')),
  crossed_at INTEGER, accepted_at INTEGER, rejected_at INTEGER, unknown_at INTEGER,
  acceptance_evidence_json TEXT CHECK (acceptance_evidence_json IS NULL OR (json_valid(acceptance_evidence_json) AND length(CAST(acceptance_evidence_json AS BLOB)) <= 65536)),
  rejection_json TEXT CHECK (rejection_json IS NULL OR (json_valid(rejection_json) AND length(CAST(rejection_json AS BLOB)) <= 65536)),
  recovery_json TEXT CHECK (recovery_json IS NULL OR (json_valid(recovery_json) AND length(CAST(recovery_json AS BLOB)) <= 65536)),
  transcript_gap INTEGER NOT NULL DEFAULT 0 CHECK (transcript_gap IN (0, 1)),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  updated_at INTEGER NOT NULL CHECK (updated_at >= created_at),
  CHECK ((kind = 'root-turn' AND intended_turn_id IS NOT NULL AND client_message_id IS NOT NULL AND native_client_message_id IS NOT NULL AND compact_operation_id IS NULL) OR (kind = 'steer' AND intended_turn_id IS NOT NULL AND client_message_id IS NOT NULL AND native_client_message_id IS NOT NULL AND compact_operation_id IS NULL) OR (kind = 'manual-compact' AND intended_turn_id IS NULL AND client_message_id IS NULL AND compact_operation_id IS NOT NULL)),
  CHECK ((state IN ('preparing', 'rejected') AND crossed_at IS NULL) OR (state IN ('dispatching', 'accepted', 'unknown') AND crossed_at IS NOT NULL)),
  CHECK ((state = 'accepted') = (accepted_at IS NOT NULL)),
  CHECK ((state = 'rejected') = (rejected_at IS NOT NULL)),
  CHECK ((state = 'unknown') = (unknown_at IS NOT NULL)),
  CHECK (state != 'accepted' OR acceptance_evidence_json IS NOT NULL),
  CHECK (acceptance_evidence_json IS NULL OR state IN ('dispatching', 'unknown', 'accepted')),
  CHECK ((state = 'rejected') = (rejection_json IS NOT NULL)),
  CHECK (crossed_at IS NULL OR (crossed_at >= created_at AND updated_at >= crossed_at)),
  CHECK (accepted_at IS NULL OR (accepted_at >= created_at AND updated_at >= accepted_at)),
  CHECK (rejected_at IS NULL OR (rejected_at >= created_at AND updated_at >= rejected_at)),
  CHECK (unknown_at IS NULL OR (unknown_at >= created_at AND updated_at >= unknown_at)),
  FOREIGN KEY (command_id) REFERENCES command_receipts(command_id) ON DELETE RESTRICT,
  FOREIGN KEY (provider_instance_id) REFERENCES provider_instances(provider_instance_id) ON DELETE RESTRICT,
  FOREIGN KEY (conversation_id) REFERENCES conversations(conversation_id) ON DELETE RESTRICT,
  FOREIGN KEY (execution_id) REFERENCES executions(execution_id) ON DELETE RESTRICT,
  FOREIGN KEY (compact_operation_id) REFERENCES compaction_operations(operation_id) ON DELETE RESTRICT
) STRICT;
CREATE INDEX delivery_attempts_lane ON delivery_attempts(conversation_id, state, created_at);
CREATE INDEX delivery_attempts_execution ON delivery_attempts(execution_id, state, created_at);
CREATE TABLE delivery_attempt_staging (
  attempt_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0 AND ordinal < 256),
  observation_id TEXT NOT NULL,
  envelope_json TEXT NOT NULL CHECK (json_valid(envelope_json) AND length(CAST(envelope_json AS BLOB)) <= 33554432),
  byte_length INTEGER NOT NULL CHECK (byte_length = length(CAST(envelope_json AS BLOB)) AND byte_length <= 33554432),
  observed_at INTEGER NOT NULL CHECK (observed_at >= 0),
  PRIMARY KEY (attempt_id, ordinal), UNIQUE (attempt_id, observation_id),
  FOREIGN KEY (attempt_id) REFERENCES delivery_attempts(attempt_id) ON DELETE RESTRICT
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

export function migrateNativeAgentSchema(
  database: DatabaseSync,
  fromVersion: number,
  repairContext?: { backupPath?: string; migratedAt?: number },
) {
  if (fromVersion < 1 || fromVersion > 14) {
    throw new NativeAgentSchemaError(`No Native Agent migration exists from schema ${fromVersion}.`);
  }
  for (const name of ['delivery_attempts', 'delivery_attempts_lane',
    'delivery_attempts_execution', 'delivery_attempt_staging']) {
    if (database.prepare('SELECT 1 FROM sqlite_schema WHERE name = ?').get(name) &&
        !schemaObjectMatchesDefinition(database, name)) {
      throw new NativeAgentSchemaError(`Version 15 found conflicting preexisting object ${name}.`);
    }
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
  if (fromVersion <= 9 && !schemaObjectExists(database, 'table', 'native_child_handles')) {
    database.exec(`
      CREATE TABLE native_child_handles (
        execution_id TEXT PRIMARY KEY NOT NULL,
        native_session_id TEXT NOT NULL,
        private_ref_json TEXT NOT NULL CHECK (json_valid(private_ref_json)),
        updated_at INTEGER NOT NULL CHECK (updated_at >= 0),
        FOREIGN KEY (execution_id) REFERENCES executions(execution_id) ON DELETE CASCADE
      ) STRICT;
    `);
  }
  if (fromVersion <= 10) migrateVersionEleven(database, fromVersion, repairContext);
  if (fromVersion <= 11) migrateVersionTwelve(database);
  if (fromVersion <= 12) migrateVersionThirteen(database, fromVersion, repairContext);
  if (fromVersion <= 13) migrateVersionFourteen(database);
  if (fromVersion <= 14) migrateVersionFifteen(database);
  database.exec(`PRAGMA user_version = ${NATIVE_AGENT_SCHEMA_VERSION}`);
}

function schemaObjectMatchesDefinition(database: DatabaseSync, name: string) {
  const actual = database.prepare('SELECT sql FROM sqlite_schema WHERE name = ?').get(name) as
    { sql: string | null } | undefined;
  const expected = SCHEMA_SQL.split(';').map((statement) => statement.trim()).find((statement) =>
    new RegExp(`^CREATE\\s+(?:TABLE|(?:UNIQUE\\s+)?INDEX)\\s+${name}\\b`, 'iu').test(statement));
  const normalize = (sql: string) => sql.replace(/\s+/gu, ' ').trim().replace(/;$/u, '');
  return Boolean(actual?.sql && expected && normalize(actual.sql) === normalize(expected));
}

function migrateVersionFifteen(database: DatabaseSync) {
  for (const table of ['command_receipts', 'provider_instances', 'conversations', 'executions', 'compaction_operations']) {
    if (!schemaObjectExists(database, 'table', table)) throw new NativeAgentSchemaError(`Version 15 requires ${table}.`);
  }
  createObjectsFromSchema(database, ['delivery_attempts', 'delivery_attempts_lane',
    'delivery_attempts_execution', 'delivery_attempt_staging'], 'Version 15');
}

function migrateVersionFourteen(database: DatabaseSync) {
  if (!schemaObjectExists(database, 'table', 'executions') ||
      !schemaObjectExists(database, 'table', 'command_receipts')) {
    throw new NativeAgentSchemaError('Version 14 requires executions and command_receipts.');
  }
  if (!schemaColumnExists(database, 'executions', 'checkout_key')) {
    database.exec('ALTER TABLE executions ADD COLUMN checkout_key TEXT;');
  }
  createObjectsFromSchema(database, [
    'executions_checkout_key_idx',
    'federation_checkout_reservations',
    'federation_checkout_reservations_capacity_idx',
    'federation_checkout_reservations_global_unknown_idx',
  ], 'Version 14');
}

function migrateVersionThirteen(
  database: DatabaseSync,
  sourceVersion: number,
  context?: { backupPath?: string; migratedAt?: number },
) {
  for (const table of ['artifacts', 'conversations', 'executions', 'turns']) {
    if (!schemaObjectExists(database, 'table', table)) {
      throw new NativeAgentSchemaError(`Version 13 requires historical table ${table}.`);
    }
  }
  ensureCompositeGrantParent(database, 'executions', ['conversation_id', 'execution_id']);
  ensureCompositeGrantParent(database, 'turns', ['conversation_id', 'turn_id']);
  createObjectsFromSchema(database, [
    'artifact_grants', 'artifact_grants_conversation',
    'artifact_grants_execution', 'artifact_grants_scope',
  ], 'Version 13');
  const report = {
    sourceVersion,
    targetVersion: 13,
    backupPath: context?.backupPath ?? null,
    migratedAt: context?.migratedAt ?? Date.now(),
    message: { candidates: 0, inserted: 0, excluded: {} as Record<string, number> },
    queue: { candidates: 0, inserted: 0, excluded: {} as Record<string, number> },
    assistant: { candidates: 0, inserted: 0, excluded: {} as Record<string, number> },
  };
  const exclude = (group: 'message' | 'queue' | 'assistant', reason: string) => {
    const excluded = report[group].excluded;
    excluded[reason] = (excluded[reason] ?? 0) + 1;
  };
  const insert = database.prepare(`
    INSERT OR IGNORE INTO artifact_grants(
      artifact_id, conversation_id, execution_id, provenance,
      source_turn_id, source_execution_id, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  if (['turns', 'command_receipts', 'executions', 'conversation_strands', 'artifacts']
    .every((name) => schemaObjectExists(database, 'table', name))) {
    const rows = database.prepare(`
      SELECT t.turn_id, t.conversation_id, t.execution_id, t.command_id,
        t.user_content_json, t.origin_strand_id, t.created_at,
        r.kind, r.state AS receipt_state, r.result_json,
        e.ownership, s.root_execution_id AS strand_root_execution_id
      FROM turns t
      LEFT JOIN command_receipts r USING(command_id)
      LEFT JOIN executions e ON e.execution_id = t.execution_id
      LEFT JOIN conversation_strands s ON s.strand_id = t.origin_strand_id
    `).all() as Array<Record<string, unknown>>;
    for (const row of rows) for (const image of imageReferences(row.user_content_json)) {
      report.message.candidates += 1;
      const kind = row.kind === null ? null : String(row.kind);
      if (row.receipt_state !== 'accepted') { exclude('message', 'missing-or-nonaccepted-receipt'); continue; }
      if (!['turn.send', 'conversation.edit', 'conversation.fork'].includes(kind ?? '')) {
        exclude('message', 'untrusted-command-kind'); continue;
      }
      const result = parseObject(row.result_json);
      if (result?.turnId !== row.turn_id ||
          (result?.conversationId !== undefined && result.conversationId !== row.conversation_id)) {
        exclude('message', 'receipt-destination-mismatch'); continue;
      }
      if (row.ownership !== 'root' || row.strand_root_execution_id !== row.execution_id) {
        exclude('message', 'strand-root-mismatch'); continue;
      }
      if (!artifactImageMatches(database, image.artifactId, image.mimeType)) {
        exclude('message', 'missing-or-mime-mismatch'); continue;
      }
      const changed = insert.run(image.artifactId, String(row.conversation_id), null,
        'viewer-message', String(row.turn_id), null, Number(row.created_at)).changes;
      report.message.inserted += Number(changed);
    }
  }
  if (schemaObjectExists(database, 'table', 'queued_messages')) {
    const rows = database.prepare(`
      SELECT q.*, r.kind, r.state AS receipt_state, r.result_json,
        c.root_execution_id
      FROM queued_messages q
      LEFT JOIN command_receipts r USING(command_id)
      JOIN conversations c USING(conversation_id)
    `).all() as Array<Record<string, unknown>>;
    for (const row of rows) for (const image of imageReferences(row.content_json)) {
      report.queue.candidates += 1;
      const result = parseObject(row.result_json);
      if (row.kind !== 'turn.send' || row.receipt_state !== 'accepted' ||
          result?.turnId !== row.turn_id) {
        exclude('queue', 'unproven-receipt-destination'); continue;
      }
      if (!artifactImageMatches(database, image.artifactId, image.mimeType)) {
        exclude('queue', 'missing-or-mime-mismatch'); continue;
      }
      report.queue.inserted += Number(insert.run(image.artifactId, String(row.conversation_id),
        null, 'viewer-queue', null, null, Number(row.created_at)).changes);
    }
  }
  const assistants = ['turns', 'artifacts'].every((name) => schemaObjectExists(database, 'table', name)) &&
      schemaColumnExists(database, 'turns', 'assistant_artifact_id') ? database.prepare(`
    SELECT t.turn_id, t.conversation_id, t.execution_id, t.assistant_artifact_id,
      t.updated_at, a.media_type, a.visibility
    FROM turns t LEFT JOIN artifacts a ON a.artifact_id = t.assistant_artifact_id
    WHERE t.assistant_artifact_id IS NOT NULL
  `).all() as Array<Record<string, unknown>> : [];
  for (const row of assistants) {
    report.assistant.candidates += 1;
    if (row.visibility !== 'viewer' || !String(row.media_type ?? '').startsWith('text/')) {
      exclude('assistant', 'missing-or-nontext-artifact'); continue;
    }
    report.assistant.inserted += Number(insert.run(String(row.assistant_artifact_id),
      String(row.conversation_id), String(row.execution_id), 'execution-output', String(row.turn_id),
      String(row.execution_id), Number(row.updated_at)).changes);
  }
  database.prepare(`
    INSERT INTO meta(key, value_json) VALUES ('schema_v13_artifact_grants', ?)
    ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json
  `).run(JSON.stringify(report));
}

function hasUniqueColumns(database: DatabaseSync, table: string, columns: readonly string[]) {
  const indexes = database.prepare(`PRAGMA index_list(${table})`).all() as
    Array<{ name: string; unique: number; partial: number }>;
  return indexes.some((index) => index.unique === 1 && index.partial === 0 &&
    (database.prepare(`PRAGMA index_info(${index.name})`).all() as Array<{ name: string }>)
      .map(({ name }) => name).join('\0') === columns.join('\0'));
}

function ensureCompositeGrantParent(
  database: DatabaseSync,
  table: 'executions' | 'turns',
  columns: readonly ['conversation_id', 'execution_id' | 'turn_id'],
) {
  const available = new Set((database.prepare(`PRAGMA table_info(${table})`).all() as
    Array<{ name: string }>).map(({ name }) => name));
  for (const column of columns) if (!available.has(column)) {
    throw new NativeAgentSchemaError(`Version 13 requires ${table}.${column}.`);
  }
  if (hasUniqueColumns(database, table, columns)) return;
  const suffix = columns.join('_');
  database.exec(`CREATE UNIQUE INDEX ${table}_${suffix}_v13 ON ${table}(${columns.join(', ')})`);
}

function imageReferences(value: unknown): Array<{ artifactId: string; mimeType: string }> {
  try {
    const parsed = JSON.parse(String(value));
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((part) => part && typeof part === 'object' &&
      (part as Record<string, unknown>).type === 'image-artifact' &&
      typeof (part as Record<string, unknown>).artifactId === 'string' &&
      typeof (part as Record<string, unknown>).mimeType === 'string'
      ? [{ artifactId: String((part as Record<string, unknown>).artifactId),
          mimeType: String((part as Record<string, unknown>).mimeType) }]
      : []);
  } catch { return []; }
}

function parseObject(value: unknown): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(String(value));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown> : undefined;
  } catch { return undefined; }
}

function artifactImageMatches(database: DatabaseSync, artifactId: string, mimeType: string) {
  const row = database.prepare(`
    SELECT 1 AS matched FROM artifacts
    WHERE artifact_id = ? AND visibility = 'viewer' AND media_type = ? AND media_type LIKE 'image/%'
  `).get(artifactId, mimeType) as { matched: number } | undefined;
  return row?.matched === 1;
}

/**
 * Version 12 makes provider service tier part of the durable inference
 * profile. Historical turns remain unknown; resumable Codex sessions and
 * pending work are intentionally pinned to the standard tier.
 */
function migrateVersionTwelve(database: DatabaseSync) {
  for (const table of [
    'conversations', 'executions', 'turns', 'composer_preferences', 'queued_messages',
  ]) {
    if (schemaObjectExists(database, 'table', table) &&
        !schemaColumnExists(database, table, 'service_tier')) {
      database.exec(`ALTER TABLE ${table} ADD COLUMN service_tier TEXT;`);
    }
  }
  if (schemaObjectExists(database, 'table', 'conversations') &&
      schemaObjectExists(database, 'table', 'provider_instances') &&
      schemaColumnExists(database, 'conversations', 'provider_instance_id') &&
      schemaColumnExists(database, 'provider_instances', 'provider')) {
    database.exec(`
      UPDATE conversations
      SET service_tier = 'default'
      WHERE provider_instance_id IN (
        SELECT provider_instance_id FROM provider_instances WHERE provider = 'codex'
      );
    `);
  }
  if (schemaObjectExists(database, 'table', 'executions') &&
      schemaColumnExists(database, 'executions', 'provider')) {
    database.exec("UPDATE executions SET service_tier = 'default' WHERE provider = 'codex';");
  }
  if (schemaObjectExists(database, 'table', 'composer_preferences') &&
      schemaObjectExists(database, 'table', 'provider_instances') &&
      schemaColumnExists(database, 'composer_preferences', 'provider_instance_id') &&
      schemaColumnExists(database, 'provider_instances', 'provider')) {
    database.exec(`
      UPDATE composer_preferences
      SET service_tier = 'default'
      WHERE scope != 'default-provider'
        AND provider_instance_id IN (
          SELECT provider_instance_id FROM provider_instances WHERE provider = 'codex'
        );
    `);
  }
  if (schemaObjectExists(database, 'table', 'queued_messages') &&
      schemaObjectExists(database, 'table', 'conversations') &&
      schemaObjectExists(database, 'table', 'provider_instances') &&
      schemaColumnExists(database, 'queued_messages', 'conversation_id') &&
      schemaColumnExists(database, 'conversations', 'provider_instance_id') &&
      schemaColumnExists(database, 'provider_instances', 'provider')) {
    database.exec(`
      UPDATE queued_messages
      SET service_tier = 'default'
      WHERE conversation_id IN (
        SELECT c.conversation_id
        FROM conversations c
        JOIN provider_instances p USING(provider_instance_id)
        WHERE p.provider = 'codex'
      );
    `);
  }
}

type VersionElevenControlRow = {
  control_event_id: string;
  conversation_id: string;
  operation_id: string;
  state: 'started' | 'completed' | 'failed';
  boundary_json: string;
  payload_json: string;
  created_at: number;
  native_kind: string;
  command_id: string | null;
  trigger: 'manual' | 'automatic';
  operation_created_at: number;
};

/**
 * Version 11 is the authority-boundary migration. It deliberately repairs only
 * rows for which provider identity is provable: a Codex compaction-only native
 * turn has exactly one semantic occurrence at ordinal zero. Inline historical
 * compactions remain unkeyed unless the v4 adapter supplies their occurrence.
 */
function migrateVersionEleven(
  database: DatabaseSync,
  sourceVersion: number,
  context?: { backupPath?: string; migratedAt?: number },
) {
  const canMigrateControls = [
    'conversation_control_events', 'compaction_operations', 'events', 'provider_instances',
  ].every((table) => schemaObjectExists(database, 'table', table));
  if (canMigrateControls &&
      !schemaColumnExists(database, 'conversation_control_events', 'provider_subject_key')) {
    database.exec('ALTER TABLE conversation_control_events ADD COLUMN provider_subject_key TEXT;');
  }
  if (canMigrateControls &&
      !schemaColumnExists(database, 'compaction_operations', 'provider_subject_key')) {
    database.exec('ALTER TABLE compaction_operations ADD COLUMN provider_subject_key TEXT;');
  }

  const canCreateControlPath = canMigrateControls && [
    'conversation_strands', 'turns',
  ].every((table) => schemaObjectExists(database, 'table', table));
  if (canCreateControlPath && !schemaObjectExists(database, 'table', 'strand_control_path')) {
    database.exec(`
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
    `);
  }

  // A queue turn ID is an idempotency reservation, not canonical history.
  // Rebuild the table without the old turn foreign key before deleting safe
  // pre-accept materializations, otherwise ON DELETE CASCADE would erase the
  // queue record that owns the pending work.
  let safeQueueTurnIds: string[] = [];
  const canMigrateQueue = [
    'queued_messages', 'conversations', 'command_receipts', 'turns',
    'native_turn_bindings', 'events', 'turn_passes', 'executions',
    'strand_turn_path', 'branch_operations', 'conversation_heads',
  ].every((table) => schemaObjectExists(database, 'table', table));
  if (canMigrateQueue) database.exec(`
    CREATE TABLE queued_messages_v11 (
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
      FOREIGN KEY (command_id) REFERENCES command_receipts(command_id) ON DELETE CASCADE
    ) STRICT;
    INSERT INTO queued_messages_v11(
      command_id, conversation_id, turn_id, client_message_id, content_json,
      model, effort, access, state, ordinal, created_at
    )
    SELECT command_id, conversation_id, turn_id, client_message_id, content_json,
      model, effort, access, state, ordinal, created_at
    FROM queued_messages;
    DROP TABLE queued_messages;
    ALTER TABLE queued_messages_v11 RENAME TO queued_messages;

    CREATE TEMP TABLE remux_v11_safe_queue_turns(turn_id TEXT PRIMARY KEY) WITHOUT ROWID;
    INSERT INTO remux_v11_safe_queue_turns(turn_id)
    SELECT t.turn_id
    FROM turns t
    JOIN queued_messages q ON q.turn_id = t.turn_id
    WHERE q.state IN ('queued', 'blocked')
      AND t.state = 'queued'
      AND t.started_at IS NULL
      AND t.native_turn_id IS NULL
      AND NOT EXISTS (SELECT 1 FROM native_turn_bindings b WHERE b.turn_id = t.turn_id)
      AND NOT EXISTS (SELECT 1 FROM events e WHERE e.turn_id = t.turn_id)
      AND NOT EXISTS (SELECT 1 FROM turn_passes p WHERE p.turn_id = t.turn_id)
      AND NOT EXISTS (SELECT 1 FROM executions e WHERE e.root_turn_id = t.turn_id)
      AND NOT EXISTS (
        SELECT 1 FROM strand_turn_path child
        JOIN strand_turn_path parent ON parent.path_entry_id = child.source_path_entry_id
        WHERE parent.turn_id = t.turn_id
      )
      AND NOT EXISTS (
        SELECT 1 FROM branch_operations b
        JOIN strand_turn_path p ON p.path_entry_id = b.source_path_entry_id
        WHERE p.turn_id = t.turn_id
      );
  `);
  if (canMigrateQueue) safeQueueTurnIds = (database.prepare(`
    SELECT turn_id FROM remux_v11_safe_queue_turns ORDER BY turn_id
  `).all() as Array<{ turn_id: string }>).map(({ turn_id }) => turn_id);
  if (canMigrateQueue) database.exec(`
    DELETE FROM strand_turn_path
    WHERE turn_id IN (SELECT turn_id FROM remux_v11_safe_queue_turns);
    DELETE FROM turns
    WHERE turn_id IN (SELECT turn_id FROM remux_v11_safe_queue_turns);
    UPDATE conversations
    SET latest_turn_id = (
      SELECT p.turn_id FROM conversation_heads h
      JOIN strand_turn_path p ON p.strand_id = h.strand_id
      WHERE h.conversation_id = conversations.conversation_id
      ORDER BY p.ordinal DESC LIMIT 1
    )
    WHERE latest_turn_id IN (SELECT turn_id FROM remux_v11_safe_queue_turns);
    DROP TABLE remux_v11_safe_queue_turns;
  `);

  const controls = canMigrateControls ? database.prepare(`
    SELECT c.control_event_id, c.conversation_id, c.operation_id, c.state,
      c.boundary_json, c.payload_json, c.created_at, e.native_kind,
      o.command_id, o.trigger, o.created_at AS operation_created_at
    FROM conversation_control_events c
    JOIN events e ON e.event_id = c.control_event_id
    JOIN compaction_operations o ON o.operation_id = c.operation_id
    JOIN provider_instances p ON p.provider_instance_id = e.provider_instance_id
    WHERE c.kind = 'compaction'
      AND p.provider = 'codex'
      AND e.native_kind LIKE 'control/%'
      AND json_extract(c.boundary_json, '$.kind') = 'between-turns'
      AND json_type(c.boundary_json, '$.nativeTurnId') = 'text'
    ORDER BY c.conversation_id, c.created_at, c.control_event_id
  `).all() as VersionElevenControlRow[] : [];
  const bySubject = new Map<string, VersionElevenControlRow[]>();
  for (const row of controls) {
    const boundary = JSON.parse(row.boundary_json) as { nativeTurnId: string };
    const subject = `codex:context-compaction:${boundary.nativeTurnId}:0`;
    const key = `${row.conversation_id}\0${subject}`;
    const rows = bySubject.get(key) ?? [];
    rows.push(row);
    bySubject.set(key, rows);
  }

  const repairedCompactions: Array<{
    conversationId: string;
    providerSubject: string;
    canonicalOperationId: string;
    removedOperationIds: string[];
  }> = [];
  const ambiguousCompactions: Array<{ conversationId: string; providerSubject: string }> = [];
  for (const [key, rows] of bySubject) {
    const separator = key.indexOf('\0');
    const conversationId = key.slice(0, separator);
    const subject = key.slice(separator + 1);
    const operations = [...new Map(rows.map((row) => [row.operation_id, row])).values()]
      .sort((left, right) => left.operation_created_at - right.operation_created_at ||
        left.operation_id.localeCompare(right.operation_id));
    const commandBackedManual = operations.filter((row) =>
      row.command_id !== null && row.trigger === 'manual');
    const mergeIsProven = commandBackedManual.length === 1 ||
      (commandBackedManual.length === 0 && operations.every((row) =>
        row.command_id === null && row.trigger === 'automatic'));
    if (!mergeIsProven) {
      ambiguousCompactions.push({ conversationId, providerSubject: subject });
      continue;
    }
    const canonical = commandBackedManual[0] ?? operations[0]!;
    const canonicalTrigger = canonical.trigger;
    database.prepare(`
      UPDATE compaction_operations SET provider_subject_key = ? WHERE operation_id = ?
    `).run(subject, canonical.operation_id);
    for (const row of rows) {
      const payload = JSON.parse(row.payload_json) as Record<string, unknown>;
      payload.trigger = canonicalTrigger;
      const stateExists = database.prepare(`
        SELECT 1 AS present FROM conversation_control_events
        WHERE conversation_id = ? AND operation_id = ? AND state = ?
      `).get(conversationId, canonical.operation_id, row.state) as { present: number } | undefined;
      if (row.operation_id !== canonical.operation_id && stateExists) {
        database.prepare('DELETE FROM conversation_control_events WHERE control_event_id = ?')
          .run(row.control_event_id);
        database.prepare('DELETE FROM events WHERE event_id = ?').run(row.control_event_id);
      } else {
        database.prepare(`
          UPDATE conversation_control_events
          SET operation_id = ?, provider_subject_key = ?, payload_json = ?
          WHERE control_event_id = ?
        `).run(canonical.operation_id, subject, JSON.stringify(payload), row.control_event_id);
      }
    }
    const removedOperationIds = operations
      .map(({ operation_id }) => operation_id)
      .filter((operationId) => operationId !== canonical.operation_id);
    for (const operationId of removedOperationIds) {
      database.prepare(`
        DELETE FROM compaction_operations
        WHERE operation_id = ?
          AND NOT EXISTS (
            SELECT 1 FROM conversation_control_events c WHERE c.operation_id = ?
          )
          AND NOT EXISTS (
            SELECT 1 FROM queued_compactions q WHERE q.operation_id = ?
          )
      `).run(operationId, operationId, operationId);
    }
    if (removedOperationIds.length > 0) {
      repairedCompactions.push({
        conversationId,
        providerSubject: subject,
        canonicalOperationId: canonical.operation_id,
        removedOperationIds,
      });
    }
  }

  if (canMigrateControls) database.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS conversation_control_subject_state
      ON conversation_control_events(conversation_id, provider_subject_key, state)
      WHERE provider_subject_key IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS compaction_operation_subject
      ON compaction_operations(conversation_id, provider_subject_key)
      WHERE provider_subject_key IS NOT NULL;
  `);
  const audit = {
    sourceVersion,
    targetVersion: 11,
    backupPath: context?.backupPath ?? null,
    migratedAt: context?.migratedAt ?? Date.now(),
    queue: { safeTurnCandidates: safeQueueTurnIds.length, removedTurnIds: safeQueueTurnIds },
    compaction: {
      candidateSubjects: bySubject.size,
      repairedSubjects: repairedCompactions.length,
      repairs: repairedCompactions.slice(0, 100),
      ambiguousSubjects: ambiguousCompactions.length,
      ambiguous: ambiguousCompactions.slice(0, 100),
    },
  };
  if (schemaObjectExists(database, 'table', 'meta')) database.prepare(`
    INSERT INTO meta(key, value_json) VALUES ('schema_v11_repair', ?)
    ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json
  `).run(JSON.stringify(audit));
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
      const match = /^CREATE\s+(?:TABLE|(?:UNIQUE\s+)?INDEX)\s+([A-Za-z0-9_]+)/iu.exec(statement);
      if (!match || !wanted.has(match[1]!)) return false;
      const type = /^CREATE\s+TABLE/iu.test(statement) ? 'table' : 'index';
      return !schemaObjectExists(database, type, match[1]!);
    });
  const found = new Set(statements.flatMap((statement) => {
    const match = /^CREATE\s+(?:TABLE|(?:UNIQUE\s+)?INDEX)\s+([A-Za-z0-9_]+)/iu.exec(statement);
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
      const name = /^CREATE\s+(?:TABLE|(?:UNIQUE\s+)?INDEX)\s+([A-Za-z0-9_]+)/iu.exec(statement)?.[1] ?? 'unknown';
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
