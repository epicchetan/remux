import { lstatSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { applyI3PhantomGrandchildren, planI3PhantomGrandchildren } from './i3-child-repair.ts';

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const unexpected = args.filter((arg) => arg !== '--apply' && arg.startsWith('-'));
const paths = args.filter((arg) => !arg.startsWith('-'));
if (unexpected.length || paths.length !== 1) {
  throw new Error('Usage: repair-i3-child-cli [--apply] <database-copy>');
}
const databasePath = paths[0]!;
const metadata = lstatSync(databasePath);
if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error('Database path must be an existing regular file.');
const database = new DatabaseSync(databasePath, { readOnly: !apply, timeout: 5_000 });
try {
  database.exec('PRAGMA foreign_keys = ON');
  const result = apply ? applyI3PhantomGrandchildren(database) : planI3PhantomGrandchildren(database);
  process.stdout.write(`${JSON.stringify({ mode: apply ? 'apply' : 'dry-run', ...result }, null, 2)}\n`);
} finally { database.close(); }
