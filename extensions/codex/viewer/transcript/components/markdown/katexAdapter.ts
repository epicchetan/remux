import katex, { type KatexOptions } from 'katex';

import type { MarkdownCacheScope } from './markdownCache';

declare const trustedKatexMarkupBrand: unique symbol;

export type TrustedKatexMarkup = string & {
  readonly [trustedKatexMarkupBrand]: true;
};

export type KatexRenderResult =
  | {
      html: TrustedKatexMarkup;
      status: 'valid';
    }
  | {
      message: string;
      status: 'invalid';
    };

const maxDurableEntries = 500;
const maxStreamingEntriesPerScope = 256;
const maxStreamingScopes = 16;
const durableCache = new Map<string, KatexRenderResult>();
const streamingCache = new Map<string, Map<string, KatexRenderResult>>();
const trustRequiringCommands = new Set([
  'href',
  'htmlClass',
  'htmlData',
  'htmlId',
  'htmlStyle',
  'includegraphics',
  'url',
]);
let diagnosticCount = 0;

export function renderKatex(
  tex: string,
  displayMode: boolean,
  cacheScope: MarkdownCacheScope,
): KatexRenderResult {
  const key = (displayMode ? 'display\0' : 'inline\0') + tex;
  if (cacheScope.kind === 'complete') {
    const cached = durableCache.get(key);
    if (cached) {
      touch(durableCache, key, cached);
      return cached;
    }
    const result = renderUncached(tex, displayMode);
    remember(durableCache, key, result, maxDurableEntries);
    return result;
  }

  const existingScope = streamingCache.get(cacheScope.key);
  if (existingScope?.has(key)) {
    const cached = existingScope.get(key)!;
    touch(streamingCache, cacheScope.key, existingScope);
    return cached;
  }

  const durable = durableCache.get(key);
  if (durable) return durable;
  const scope = existingScope ?? new Map<string, KatexRenderResult>();
  const result = renderUncached(tex, displayMode);
  remember(scope, key, result, maxStreamingEntriesPerScope);
  touch(streamingCache, cacheScope.key, scope);
  pruneOldest(streamingCache, maxStreamingScopes);
  return result;
}

export function releaseStreamingKatexCache(scopeKey: string) {
  streamingCache.delete(scopeKey);
}

export function resetKatexCachesForTests() {
  durableCache.clear();
  streamingCache.clear();
  diagnosticCount = 0;
}

function renderUncached(tex: string, displayMode: boolean): KatexRenderResult {
  const unsafeCommand = firstTrustRequiringCommand(tex);
  if (unsafeCommand) {
    const message = 'Trust-requiring KaTeX command is disabled: \\' + unsafeCommand;
    reportDiagnostic('trust', message);
    return { message, status: 'invalid' };
  }
  try {
    const rendered = katex.renderToString(tex, katexOptions(displayMode));
    const html = (displayMode
      ? addDisplayBreakOpportunities(rendered)
      : rendered) as TrustedKatexMarkup;
    return { html, status: 'valid' };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    reportDiagnostic('render', message);
    return { message, status: 'invalid' };
  }
}

function addDisplayBreakOpportunities(html: string) {
  // KaTeX emits sibling `.base` spans only at TeXBook-safe outer-level
  // relations and binary operators. Its string output has no whitespace
  // between those siblings, so browsers otherwise have no line-break point.
  // The adapter is pinned to an exact KaTeX version; keep this transformation
  // here at the generated-markup trust boundary rather than rewriting TeX.
  return html.replaceAll(
    '</span><span class="base">',
    '</span><wbr><span class="base">',
  );
}

function firstTrustRequiringCommand(tex: string) {
  const commandPattern = /\\([A-Za-z]+)\b/gu;
  let match: RegExpExecArray | null;
  while ((match = commandPattern.exec(tex))) {
    const command = match[1];
    if (command && trustRequiringCommands.has(command)) return command;
  }
  return null;
}

function katexOptions(displayMode: boolean): KatexOptions {
  return {
    displayMode,
    globalGroup: false,
    macros: {},
    maxExpand: 1000,
    maxSize: 20,
    output: 'htmlAndMathml',
    strict(errorCode, errorMessage) {
      reportDiagnostic(errorCode, errorMessage);
      return 'ignore';
    },
    throwOnError: true,
    trust: false,
  };
}

function reportDiagnostic(kind: string, message: string) {
  const development = (import.meta as ImportMeta & { env?: { DEV?: boolean } }).env?.DEV === true;
  if (!development || diagnosticCount >= 20) return;
  diagnosticCount += 1;
  console.warn('[codex:math] KaTeX rejected or relaxed an expression', { kind, message });
}

function remember<K, V>(cache: Map<K, V>, key: K, value: V, maximum: number) {
  touch(cache, key, value);
  pruneOldest(cache, maximum);
}

function touch<K, V>(cache: Map<K, V>, key: K, value: V) {
  cache.delete(key);
  cache.set(key, value);
}

function pruneOldest<K, V>(cache: Map<K, V>, maximum: number) {
  while (cache.size > maximum) {
    const oldest = cache.keys().next().value as K | undefined;
    if (oldest === undefined) return;
    cache.delete(oldest);
  }
}
