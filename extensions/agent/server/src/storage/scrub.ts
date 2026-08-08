import { resolve } from 'node:path';

import { AgentJournalRepository } from './repository.ts';

const dataRoot = dataRootArgument(process.argv.slice(2));
const repository = await AgentJournalRepository.open(dataRoot ? { dataRoot } : {});
try {
  const report = await repository.scrubArtifacts();
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} finally {
  await repository.close();
}

function dataRootArgument(args: string[]) {
  if (args.length === 0) return null;
  if (args.length !== 2 || args[0] !== '--data-root' || !args[1]?.trim()) {
    throw new TypeError('Usage: npm --workspace @remux/agent run storage:scrub -- --data-root <path>');
  }
  return resolve(args[1]);
}
