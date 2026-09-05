import { lstatSync, readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { repairI3NativeChildIdentity, type I3RepairEvidence } from './i3-child-repair.ts';

const [databasePath, evidencePath] = process.argv.slice(2);
if (!databasePath || !evidencePath) throw new Error('Usage: repair-i3-child-cli <database-copy> <evidence.json>');
const metadata = lstatSync(databasePath);
if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error('Database path must be an existing regular file.');
const database = new DatabaseSync(databasePath);
try {
  database.exec('PRAGMA foreign_keys = ON');
  process.stdout.write(`${JSON.stringify(repairI3NativeChildIdentity(
    database, JSON.parse(readFileSync(evidencePath, 'utf8')) as I3RepairEvidence,
  ), null, 2)}\n`);
} finally { database.close(); }
