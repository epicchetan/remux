import type { KatexRenderResult, TrustedKatexMarkup } from './katexAdapter';
import type { MarkdownCacheScope } from './markdownCache';

export type MathMetricContext = {
  fontSize: number;
  lineHeight: number;
  variant: string;
};

export type MathMetrics = {
  ascent: number;
  depth: number;
  height: number;
  html: TrustedKatexMarkup;
  naturalWidth: number;
  status: 'valid';
};

const maxDurableEntries = 500;
const maxStreamingEntriesPerScope = 256;
const maxStreamingScopes = 16;
const durableCache = new Map<string, MathMetrics>();
const streamingCache = new Map<string, Map<string, MathMetrics>>();
const listeners = new Set<() => void>();
let measurementRoot: HTMLDivElement | null = null;
let revision = 0;
let initialized = false;

export function initializeMathMetricsStore() {
  if (initialized || typeof document === 'undefined') return;
  initialized = true;
  ensureMeasurementRoot();
  const fonts = document.fonts;
  if (!fonts) return;
  const fontsSettled = () => invalidateMeasuredMath();
  void fonts.ready.then(fontsSettled);
  fonts.addEventListener('loadingdone', fontsSettled);
}

export function mathMetricsRevision() {
  return revision;
}

export function subscribeMathMetrics(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function resolveMathMetrics(
  tex: string,
  displayMode: boolean,
  render: KatexRenderResult,
  context: MathMetricContext,
  cacheScope: MarkdownCacheScope,
  measurementWidth?: number,
): MathMetrics | null {
  if (render.status !== 'valid') return null;
  const key = [
    displayMode ? 'display' : 'inline',
    context.variant,
    context.fontSize,
    context.lineHeight,
    measurementWidth === undefined ? 'natural' : normalizedWidth(measurementWidth),
    tex,
  ].join('\0');

  if (cacheScope.kind === 'complete') {
    const cached = durableCache.get(key);
    if (cached) {
      touch(durableCache, key, cached);
      return cached;
    }
    const metrics = measureMath(render.html, tex, displayMode, context, measurementWidth);
    remember(durableCache, key, metrics, maxDurableEntries);
    return metrics;
  }

  const existingScope = streamingCache.get(cacheScope.key);
  const cached = existingScope?.get(key);
  if (cached) {
    touch(streamingCache, cacheScope.key, existingScope!);
    return cached;
  }
  const durable = durableCache.get(key);
  if (durable) return durable;
  const scope = existingScope ?? new Map<string, MathMetrics>();
  const metrics = measureMath(render.html, tex, displayMode, context, measurementWidth);
  remember(scope, key, metrics, maxStreamingEntriesPerScope);
  touch(streamingCache, cacheScope.key, scope);
  pruneOldest(streamingCache, maxStreamingScopes);
  return metrics;
}

export function releaseStreamingMathMetrics(scopeKey: string) {
  streamingCache.delete(scopeKey);
}

export function resetMathMetricsForTests() {
  durableCache.clear();
  streamingCache.clear();
  revision = 0;
}

function measureMath(
  html: TrustedKatexMarkup,
  tex: string,
  displayMode: boolean,
  context: MathMetricContext,
  measurementWidth?: number,
): MathMetrics {
  if (typeof document === 'undefined') {
    return estimatedMetrics(html, tex, displayMode, context, measurementWidth);
  }
  const root = ensureMeasurementRoot();
  if (!root) return estimatedMetrics(html, tex, displayMode, context, measurementWidth);

  const row = document.createElement('span');
  row.className = 'codex-md-math-measure-row';
  row.style.fontSize = context.fontSize + 'px';
  row.style.lineHeight = context.lineHeight + 'px';
  row.style.whiteSpace = measurementWidth === undefined ? 'nowrap' : 'normal';
  if (measurementWidth !== undefined) {
    row.style.display = 'block';
    row.style.width = normalizedWidth(measurementWidth) + 'px';
  }

  const host = document.createElement('span');
  host.className = displayMode
    ? 'codex-md-math codex-md-display-math'
    : 'codex-md-math codex-md-inline-math';
  host.dataset.mathVariant = context.variant;
  if (displayMode && measurementWidth === undefined) {
    host.style.display = 'inline-block';
    host.style.flex = '0 0 auto';
    host.style.maxWidth = 'none';
    host.style.width = 'max-content';
  } else if (displayMode) {
    const width = normalizedWidth(measurementWidth!);
    host.dataset.constrained = 'true';
    host.style.display = 'block';
    host.style.flex = `0 0 ${width}px`;
    host.style.maxWidth = width + 'px';
    host.style.width = width + 'px';
  } else {
    // The visible inline host is a local overflow container. CSS therefore
    // assigns its bottom edge as the inline-block baseline. Measure with
    // overflow visible to recover KaTeX's real typographic baseline; the
    // renderer uses the resulting depth to place the overflow box correctly.
    host.style.maxWidth = 'none';
    host.style.overflow = 'visible';
  }
  host.innerHTML = html;

  const probe = document.createElement('span');
  probe.className = 'codex-md-math-baseline-probe';
  row.append(host, probe);
  root.append(row);

  const katexElement = host.querySelector<HTMLElement>('.katex') ?? host;
  // Inline layout positions the overflow host, whose line box can include
  // leading beyond the KaTeX glyph rectangle. Use that occupied box so the
  // measured depth is also the exact vertical-align correction. Display math
  // continues to use the KaTeX content rectangle for its content height.
  const measuredElement = displayMode ? katexElement : host;
  const rectangle = measuredElement.getBoundingClientRect();
  const baseline = probe.getBoundingClientRect().top;
  const height = Math.max(1, rectangle.height);
  const ascent = displayMode
    ? height
    : Math.max(0, Math.min(height, baseline - rectangle.top));
  const depth = displayMode
    ? 0
    : Math.max(0, Math.min(height, rectangle.bottom - baseline));
  const naturalWidth = Math.max(1, katexElement.scrollWidth, rectangle.width);
  row.remove();

  return {
    ascent,
    depth,
    height,
    html,
    naturalWidth,
    status: 'valid',
  };
}

function estimatedMetrics(
  html: TrustedKatexMarkup,
  tex: string,
  displayMode: boolean,
  context: MathMetricContext,
  measurementWidth?: number,
): MathMetrics {
  const baseHeight = Math.max(context.lineHeight, context.fontSize * (displayMode ? 1.8 : 1.25));
  const estimatedWidth = Math.max(context.fontSize * 1.5, tex.length * context.fontSize * 0.62);
  const estimatedLines = displayMode && measurementWidth !== undefined
    ? Math.max(1, Math.ceil(estimatedWidth / Math.max(1, measurementWidth)))
    : 1;
  const height = baseHeight * estimatedLines;
  return {
    ascent: displayMode ? height : height * 0.8,
    depth: displayMode ? 0 : height * 0.2,
    height,
    html,
    naturalWidth: measurementWidth === undefined
      ? estimatedWidth
      : Math.min(estimatedWidth, Math.max(1, measurementWidth)),
    status: 'valid',
  };
}

function normalizedWidth(width: number) {
  return Math.max(1, Math.round(width * 100) / 100);
}

function ensureMeasurementRoot() {
  if (measurementRoot?.isConnected) return measurementRoot;
  if (typeof document === 'undefined' || !document.body) return null;
  const root = document.createElement('div');
  root.className = 'codex-md-math-measure-root';
  root.setAttribute('aria-hidden', 'true');
  document.body.append(root);
  measurementRoot = root;
  return root;
}

function invalidateMeasuredMath() {
  if (durableCache.size === 0 && streamingCache.size === 0) return;
  durableCache.clear();
  streamingCache.clear();
  revision += 1;
  for (const listener of listeners) listener();
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
