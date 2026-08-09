import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

import { AGENT_JOURNAL_SCHEMA_VERSION } from './schema.ts';
import { canonicalJson, type CanonicalJsonValue } from './canonical-json.ts';

const PROJECTION_VERSION = 'agent-projection-v2';

const projectionTables = [
  { name: 'projects', order: ['project_id'] },
  { name: 'context_spaces', order: ['space_id'] },
  { name: 'project_primaries', order: ['primary_id'] },
  { name: 'context_bindings', order: ['space_id', 'primary_id'] },
  { name: 'project_relations', order: ['relation_id'] },
  { name: 'conversations', order: ['conversation_id'] },
  { name: 'strands', order: ['strand_id'] },
  { name: 'strand_context_spaces', order: ['strand_id'] },
  { name: 'turns', order: ['turn_id'] },
  { name: 'execution_scopes', order: ['scope_id'] },
  { name: 'transcript_items', order: ['item_id'] },
  { name: 'resources', order: ['resource_key'] },
  { name: 'operations', order: ['operation_id'] },
  { name: 'artifacts', order: ['hash'], omit: ['storage_path'] },
  { name: 'epochs', order: ['epoch_id'] },
  { name: 'epoch_blocks', order: ['epoch_id', 'ordinal'] },
  { name: 'inferences', order: ['inference_id'] },
  { name: 'context_compilations', order: ['compilation_id'] },
] as const;

export function durableProjectionSnapshot(database: DatabaseSync): CanonicalJsonValue {
  const tables: Record<string, CanonicalJsonValue> = {};
  for (const table of projectionTables) {
    const columns = (database.prepare(`PRAGMA table_info(${quoteIdentifier(table.name)})`).all() as Array<{
      name: string;
    }>).map(({ name }) => name).filter((name) => !('omit' in table) || !table.omit.includes(name as never));
    if (columns.length === 0) throw new Error(`Projection table ${table.name} has no columns.`);
    for (const order of table.order) {
      if (!columns.includes(order)) throw new Error(`Projection table ${table.name} is missing ${order}.`);
    }
    const rows = database.prepare(`
      SELECT ${columns.map(quoteIdentifier).join(', ')}
      FROM ${quoteIdentifier(table.name)}
      ORDER BY ${table.order.map(quoteIdentifier).join(', ')}
    `).all() as Array<Record<string, string | number | null>>;
    tables[table.name] = rows as CanonicalJsonValue;
  }
  return {
    journalSchemaVersion: AGENT_JOURNAL_SCHEMA_VERSION,
    projectionVersion: PROJECTION_VERSION,
    tables,
  };
}

export function durableProjectionDigest(database: DatabaseSync) {
  const bytes = canonicalJson(durableProjectionSnapshot(database));
  return {
    bytes,
    hash: createHash('sha256').update(bytes).digest('hex'),
    projectionVersion: PROJECTION_VERSION,
  };
}

function quoteIdentifier(value: string) {
  return `"${value.replaceAll('"', '""')}"`;
}
