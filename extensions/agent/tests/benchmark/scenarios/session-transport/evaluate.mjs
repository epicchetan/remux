import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const METHODS_PATH = 'crates/remux/src/methods.rs';
const MARKER = 'mod benchmark_session_transport_acceptance {';
const cwd = process.cwd();
const methodsPath = resolve(cwd, METHODS_PATH);
let methods = readFileSync(methodsPath, 'utf8');
if (!methods.includes(MARKER)) {
  const evaluatorRoot = dirname(fileURLToPath(import.meta.url));
  const acceptance = readFileSync(resolve(evaluatorRoot, 'acceptance.rs'), 'utf8');
  methods = `${methods.trimEnd()}\n\n${acceptance.trim()}\n`;
  writeFileSync(methodsPath, methods);
}

const result = spawnSync(
  'cargo',
  ['test', '-p', 'ledger-remux', 'methods::benchmark_session_transport_acceptance'],
  { cwd, stdio: 'inherit' },
);
if (result.error) throw result.error;
process.exit(result.status ?? 1);
