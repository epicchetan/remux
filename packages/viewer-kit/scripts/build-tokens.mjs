// Generates CSS artifacts from the typed token source in primitives.ts.
// Node strips the TypeScript types at runtime (node >= 23.6), so there is no
// build step — run with plain `node` via `npm run tokens:build`.
import { writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { renderNativeTokensTs, renderThemeCss, renderTokensCss } from '../src/tokens/primitives.ts';

const here = dirname(fileURLToPath(import.meta.url));
const tokensPath = resolve(here, '../src/tokens/tokens.css');
const themePath = resolve(here, '../src/tokens/theme.css');
const nativeTokensPath = resolve(here, '../src/tokens/tokens.native.ts');

writeFileSync(tokensPath, renderTokensCss());
writeFileSync(themePath, renderThemeCss());
writeFileSync(nativeTokensPath, renderNativeTokensTs());
console.log(`wrote ${tokensPath}`);
console.log(`wrote ${themePath}`);
console.log(`wrote ${nativeTokensPath}`);
