import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const packageRoot = fileURLToPath(new URL(
  '../node_modules/@earendil-works/pi-coding-agent/',
  import.meta.url,
));
const expectedVersion = '0.84.0';

const packageJson = JSON.parse(await readFile(`${packageRoot}package.json`, 'utf8'));
if (packageJson.version !== expectedVersion) {
  throw new Error(
    `Refusing to patch @earendil-works/pi-coding-agent ${packageJson.version}; expected ${expectedVersion}.`,
  );
}

const replacements = [
  {
    path: 'dist/core/sdk.js',
    before: `        onPayload: async (payload, _model) => {
            const runner = extensionRunnerRef.current;
            if (!runner?.hasHandlers("before_provider_request")) {
                return payload;
            }
            return runner.emitBeforeProviderRequest(payload);
        },`,
    after: `        onPayload: async (payload, _model) => {
            const runner = extensionRunnerRef.current;
            const nextPayload = runner?.hasHandlers("before_provider_request")
                ? await runner.emitBeforeProviderRequest(payload)
                : payload;
            await options.providerPreflight?.(nextPayload, _model);
            return nextPayload;
        },`,
  },
  {
    path: 'dist/core/sdk.d.ts',
    before: `    /** Session start event metadata for extension runtime startup. */
    sessionStartEvent?: SessionStartEvent;`,
    after: `    /**
     * Host-owned fail-closed gate called with the final payload after extension transforms.
     * A rejection aborts provider dispatch.
     */
    providerPreflight?: (payload: unknown, model: Model<any>) => void | Promise<void>;
    /** Session start event metadata for extension runtime startup. */
    sessionStartEvent?: SessionStartEvent;`,
  },
];

const pendingWrites = [];
for (const replacement of replacements) {
  const path = `${packageRoot}${replacement.path}`;
  const contents = await readFile(path, 'utf8');
  if (contents.includes(replacement.after)) continue;
  const occurrences = contents.split(replacement.before).length - 1;
  if (occurrences !== 1) {
    throw new Error(
      `Refusing to patch ${replacement.path}: expected one known Pi ${expectedVersion} seam, found ${occurrences}.`,
    );
  }
  pendingWrites.push({
    path,
    contents: contents.replace(replacement.before, replacement.after),
  });
}

for (const pending of pendingWrites) {
  await writeFile(pending.path, pending.contents);
}
