export type MermaidRenderOptions = Readonly<{
  signal?: AbortSignal;
  theme: 'light' | 'dark';
}>;

export type MermaidRenderResult = Readonly<{
  height: number;
  svg: string;
  width: number;
}>;

const MAX_SOURCE_LENGTH = 20_000;
const CACHE_LIMIT = 32;
const configDirectivePattern = /%%\{\s*(?:init|config)\s*:/iu;
const frontMatterPattern = /^---\s*[\r\n]+([\s\S]*?)[\r\n]+---(?:\s*[\r\n]+|$)/u;

type CacheEntry =
  | { result: MermaidRenderResult; status: 'success' }
  | { error: Error; status: 'failure' };

const cache = new Map<string, CacheEntry>();
const inFlight = new Map<string, Promise<MermaidRenderResult>>();
let mermaidModulePromise: Promise<typeof import('mermaid')> | null = null;
let renderQueue: Promise<void> = Promise.resolve();
let renderSequence = 0;

export function renderMermaid(
  source: string,
  { signal, theme }: MermaidRenderOptions,
): Promise<MermaidRenderResult> {
  try {
    validateSource(source);
    throwIfAborted(signal);
  } catch (error) {
    return Promise.reject(error);
  }

  const key = `${theme}\0${source}`;
  const cached = cache.get(key);
  if (cached) {
    touchCache(key, cached);
    return subscribe(Promise.resolve().then(() => {
      if (cached.status === 'failure') throw cached.error;
      return cached.result;
    }), signal);
  }

  let shared = inFlight.get(key);
  if (!shared) {
    shared = enqueueRender(source, theme).then(
      (result) => {
        remember(key, { result, status: 'success' });
        inFlight.delete(key);
        return result;
      },
      (error: unknown) => {
        const renderError = toError(error);
        remember(key, { error: renderError, status: 'failure' });
        inFlight.delete(key);
        throw renderError;
      },
    );
    // Every caller observes the promise through subscribe(), but retain a rejection
    // handler here too so an immediately aborted sole subscriber cannot orphan it.
    void shared.catch(() => undefined);
    inFlight.set(key, shared);
  }
  return subscribe(shared, signal);
}

function enqueueRender(source: string, theme: MermaidRenderOptions['theme']) {
  const task = renderQueue.then(
    () => performRender(source, theme),
    () => performRender(source, theme),
  );
  renderQueue = task.then(() => undefined, () => undefined);
  return task;
}

async function performRender(source: string, theme: MermaidRenderOptions['theme']) {
  await waitForFonts();
  const mermaid = (await loadMermaid()).default;
  mermaid.initialize({
    darkMode: theme === 'dark',
    fontFamily: 'Arial, "Helvetica Neue", sans-serif',
    htmlLabels: false,
    maxEdges: 200,
    maxTextSize: MAX_SOURCE_LENGTH,
    secure: ['securityLevel', 'maxTextSize', 'maxEdges', 'htmlLabels', 'startOnLoad'],
    securityLevel: 'strict',
    startOnLoad: false,
    theme: theme === 'dark' ? 'dark' : 'default',
  });
  renderSequence += 1;
  const { svg } = await mermaid.render(`remux-mermaid-${renderSequence}`, source);
  return validateSvg(svg);
}

function loadMermaid() {
  mermaidModulePromise ??= import('mermaid');
  return mermaidModulePromise;
}

async function waitForFonts() {
  if (typeof document !== 'undefined' && document.fonts) await document.fonts.ready;
}

function validateSource(source: string) {
  if (source.length > MAX_SOURCE_LENGTH) {
    throw new Error('This diagram is too large to preview. Its source is shown below.');
  }
  if (configDirectivePattern.test(source)) {
    throw new Error('Mermaid configuration directives are not supported.');
  }
  const frontMatter = source.match(frontMatterPattern)?.[1];
  if (frontMatter && /^\s*config\s*:/imu.test(frontMatter)) {
    throw new Error('Mermaid configuration front matter is not supported.');
  }
}

function validateSvg(svgSource: string): MermaidRenderResult {
  const parsed = new DOMParser().parseFromString(svgSource, 'image/svg+xml');
  const root = parsed.documentElement;
  if (root.localName !== 'svg' || parsed.querySelector('parsererror')) {
    throw new Error('Mermaid returned an invalid SVG document.');
  }
  if (parsed.querySelector('script, foreignObject, iframe, object, embed')) {
    throw new Error('Mermaid returned unsupported active SVG content.');
  }
  for (const element of parsed.querySelectorAll('*')) {
    for (const attribute of element.attributes) {
      if (/^on/iu.test(attribute.name)) {
        throw new Error('Mermaid returned unsupported active SVG content.');
      }
      if ((attribute.localName === 'href' || attribute.name === 'src') && !attribute.value.startsWith('#')) {
        throw new Error('Mermaid returned an unsupported external SVG reference.');
      }
    }
  }
  for (const style of parsed.querySelectorAll('style')) {
    const css = style.textContent ?? '';
    const hasExternalUrl = [...css.matchAll(/url\(\s*([^)]*?)\s*\)/giu)].some((match) => {
      const value = match[1]!.trim().replace(/^(['"])(.*)\1$/u, '$2').trim();
      return !value.startsWith('#');
    });
    if (/@import/iu.test(css) || hasExternalUrl) {
      throw new Error('Mermaid returned an unsupported external SVG style.');
    }
  }

  const dimensions = readDimensions(root);
  if (!root.hasAttribute('xmlns')) root.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  return { svg: new XMLSerializer().serializeToString(root), ...dimensions };
}

function readDimensions(root: Element) {
  const viewBox = root.getAttribute('viewBox')?.trim().split(/[ ,]+/u).map(Number);
  if (viewBox?.length === 4 && viewBox.every(Number.isFinite) && viewBox[2]! > 0 && viewBox[3]! > 0) {
    return { width: viewBox[2]!, height: viewBox[3]! };
  }
  const width = Number.parseFloat(root.getAttribute('width') ?? '');
  const height = Number.parseFloat(root.getAttribute('height') ?? '');
  if (Number.isFinite(width) && width > 0 && Number.isFinite(height) && height > 0) return { width, height };
  throw new Error('Mermaid returned an SVG without usable dimensions.');
}

function subscribe<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(abortError());
    signal.addEventListener('abort', abort, { once: true });
    void promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw abortError();
}

function abortError() {
  return new DOMException('The Mermaid render was aborted.', 'AbortError');
}

function toError(error: unknown) {
  return error instanceof Error ? error : new Error(String(error));
}

function remember(key: string, entry: CacheEntry) {
  cache.delete(key);
  cache.set(key, entry);
  while (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value!);
}

function touchCache(key: string, entry: CacheEntry) {
  cache.delete(key);
  cache.set(key, entry);
}
