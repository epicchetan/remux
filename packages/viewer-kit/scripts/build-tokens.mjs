// Generates src/tokens/tokens.css from the typed token source in primitives.ts.
// Node strips the TypeScript types at runtime (node >= 23.6), so there is no
// build step — run with plain `node` via `npm run tokens:build`.
import { writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { renderTokensCss } from '../src/tokens/primitives.ts';

const here = dirname(fileURLToPath(import.meta.url));
const outPath = resolve(here, '../src/tokens/tokens.css');

writeFileSync(outPath, renderTokensCss());
console.log(`wrote ${outPath}`);
