import { resolve } from 'node:path';

import { AgentStateStore } from './agent-state-store.ts';

const dataRoot = dataRootArgument(process.argv.slice(2));
const store = await AgentStateStore.open(dataRoot ? { dataRoot } : {});
try {
  const report = await store.scrubArtifacts();
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} finally {
  await store.close();
}

function dataRootArgument(args: string[]) {
  if (args.length === 0) return null;
  if (args.length !== 2 || args[0] !== '--data-root' || !args[1]?.trim()) {
    throw new TypeError('Usage: npm --workspace @remux/agent run storage:scrub -- --data-root <path>');
  }
  return resolve(args[1]);
}
