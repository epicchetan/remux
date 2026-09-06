import { toByteArray } from 'base64-js';
import type { PreparedHtmlPreviewDocument } from './prepareHtmlPreviewDocument';

export const HTML_PREVIEW_MAX_BYTES = 5 * 1024 * 1024;

export type HtmlPreviewMode = 'preview' | 'source';
export type HtmlPreviewLoadStatus = 'idle' | 'loading' | 'ready' | 'refreshing' | 'error';
export type HtmlPreviewConnectionGeneration = number | string;

export type HtmlPreviewLoadState = Readonly<{
  connectionGeneration: HtmlPreviewConnectionGeneration;
  document: PreparedHtmlPreviewDocument | null;
  error: string | null;
  loadGeneration: number;
  mode: HtmlPreviewMode;
  path: string;
  status: HtmlPreviewLoadStatus;
}>;

export type HtmlPreviewLoadToken = Readonly<{
  connectionGeneration: HtmlPreviewConnectionGeneration;
  loadGeneration: number;
  path: string;
}>;

export type HtmlPreviewQuery = <T>(
  method: string,
  params?: unknown,
  options?: { resourceKey?: string; signal?: AbortSignal },
) => Promise<T>;

type ReadFileResponse = {
  dataBase64?: unknown;
  encoding?: unknown;
  isBinary?: unknown;
  path?: unknown;
  sizeBytes?: unknown;
  tooLarge?: unknown;
};

export async function readHtmlPreviewFile(
  query: HtmlPreviewQuery,
  options: Readonly<{
    path: string;
    requestIdentity: string;
    signal?: AbortSignal;
  }>,
): Promise<string> {
  const response = await query<ReadFileResponse>(
    'remux/fs/readFile',
    { format: 'base64', path: options.path },
    {
      resourceKey: `${options.requestIdentity}:html-preview:base64`,
      ...(options.signal ? { signal: options.signal } : {}),
    },
  );

  if (!response || typeof response !== 'object') {
    throw new Error('The file response was invalid.');
  }
  if (response.tooLarge === true) {
    throw new Error('This HTML file is larger than the 5 MiB preview limit.');
  }
  if (response.tooLarge !== false) {
    throw new Error('The file response did not contain a valid size status.');
  }
  if (response.isBinary !== false) {
    throw new Error('The selected file contains binary data and cannot be previewed as HTML.');
  }
  if (response.encoding !== 'base64' || typeof response.dataBase64 !== 'string') {
    throw new Error('The file response did not contain base64 data.');
  }
  if (typeof response.path !== 'string' || !samePath(response.path, options.path)) {
    throw new Error('The file response did not match the requested path.');
  }
  if (!Number.isSafeInteger(response.sizeBytes) || (response.sizeBytes as number) < 0) {
    throw new Error('The file response did not contain a valid size.');
  }
  const declaredSize = response.sizeBytes as number;
  if (declaredSize > HTML_PREVIEW_MAX_BYTES) {
    throw new Error('This HTML file is larger than the 5 MiB preview limit.');
  }

  const bytes = decodeBase64(response.dataBase64);
  if (bytes.length !== declaredSize) {
    throw new Error('The file response was truncated.');
  }
  if (bytes.length > HTML_PREVIEW_MAX_BYTES) {
    throw new Error('This HTML file is larger than the 5 MiB preview limit.');
  }
  return decodeUtf8(bytes);
}

export class HtmlPreviewLoadController {
  private current: HtmlPreviewLoadState;
  private readonly listeners = new Set<(state: HtmlPreviewLoadState) => void>();

  constructor(options: Readonly<{
    connectionGeneration: HtmlPreviewConnectionGeneration;
    mode?: HtmlPreviewMode;
    path: string;
  }>) {
    this.current = {
      connectionGeneration: options.connectionGeneration,
      document: null,
      error: null,
      loadGeneration: 0,
      mode: options.mode ?? 'preview',
      path: options.path,
      status: 'idle',
    };
  }

  snapshot(): HtmlPreviewLoadState {
    return this.current;
  }

  subscribe(listener: (state: HtmlPreviewLoadState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  setMode(mode: HtmlPreviewMode): HtmlPreviewLoadState {
    if (this.current.mode !== mode) this.publish({ ...this.current, mode });
    return this.current;
  }

  retarget(options: Readonly<{
    connectionGeneration: HtmlPreviewConnectionGeneration;
    mode?: HtmlPreviewMode;
    path: string;
  }>): HtmlPreviewLoadState {
    if (
      this.current.path === options.path
      && this.current.connectionGeneration === options.connectionGeneration
    ) {
      return options.mode ? this.setMode(options.mode) : this.current;
    }
    this.publish({
      connectionGeneration: options.connectionGeneration,
      document: null,
      error: null,
      loadGeneration: this.current.loadGeneration + 1,
      mode: options.mode ?? 'preview',
      path: options.path,
      status: 'idle',
    });
    return this.current;
  }

  beginLoad(): HtmlPreviewLoadToken {
    const loadGeneration = this.current.loadGeneration + 1;
    const token = {
      connectionGeneration: this.current.connectionGeneration,
      loadGeneration,
      path: this.current.path,
    } as const;
    this.publish({
      ...this.current,
      error: null,
      loadGeneration,
      status: this.current.document ? 'refreshing' : 'loading',
    });
    return token;
  }

  complete(token: HtmlPreviewLoadToken, document: PreparedHtmlPreviewDocument): boolean {
    if (!this.isCurrent(token)) return false;
    this.publish({ ...this.current, document, error: null, status: 'ready' });
    return true;
  }

  fail(token: HtmlPreviewLoadToken, error: unknown): boolean {
    if (!this.isCurrent(token)) return false;
    this.publish({ ...this.current, error: loadErrorMessage(error), status: 'error' });
    return true;
  }

  async load(
    query: HtmlPreviewQuery,
    requestIdentity: string,
    prepare: (source: string) => PreparedHtmlPreviewDocument,
    signal?: AbortSignal,
  ): Promise<boolean> {
    const token = this.beginLoad();
    try {
      const source = await readHtmlPreviewFile(query, {
        path: token.path,
        requestIdentity,
        ...(signal ? { signal } : {}),
      });
      if (!this.isCurrent(token)) return false;
      const document = prepare(source);
      return this.complete(token, document);
    } catch (error) {
      return this.fail(token, error);
    }
  }

  retire(): HtmlPreviewLoadState {
    this.publish({
      ...this.current,
      document: null,
      error: null,
      loadGeneration: this.current.loadGeneration + 1,
      status: 'idle',
    });
    return this.current;
  }

  private isCurrent(token: HtmlPreviewLoadToken): boolean {
    return token.path === this.current.path
      && token.connectionGeneration === this.current.connectionGeneration
      && token.loadGeneration === this.current.loadGeneration;
  }

  private publish(state: HtmlPreviewLoadState) {
    this.current = state;
    for (const listener of this.listeners) listener(state);
  }
}

function loadErrorMessage(error: unknown): string {
  return error instanceof Error && error.message ? error.message : 'The HTML file could not be loaded.';
}

function samePath(first: string, second: string): boolean {
  return normalizePath(first) === normalizePath(second);
}

function normalizePath(path: string): string {
  const absolute = path.startsWith('/');
  const parts: string[] = [];
  for (const part of path.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') {
      if (parts.length > 0 && parts.at(-1) !== '..') parts.pop();
      else if (!absolute) parts.push(part);
    } else {
      parts.push(part);
    }
  }
  return `${absolute ? '/' : ''}${parts.join('/')}` || (absolute ? '/' : '.');
}

function decodeBase64(encoded: string): Uint8Array {
  const maxEncodedLength = Math.ceil(HTML_PREVIEW_MAX_BYTES / 3) * 4;
  if (encoded.length > maxEncodedLength || encoded.length % 4 !== 0) {
    throw new Error('The file response contained malformed base64 data.');
  }
  const padding = encoded.endsWith('==') ? 2 : encoded.endsWith('=') ? 1 : 0;
  const dataLength = encoded.length - padding;
  for (let index = 0; index < encoded.length; index += 1) {
    const code = encoded.charCodeAt(index);
    const isData = (code >= 65 && code <= 90)
      || (code >= 97 && code <= 122)
      || (code >= 48 && code <= 57)
      || code === 43
      || code === 47;
    if ((index < dataLength && !isData) || (index >= dataLength && code !== 61)) {
      throw new Error('The file response contained malformed base64 data.');
    }
  }
  if ((padding === 2 && dataLength % 4 !== 2) || (padding === 1 && dataLength % 4 !== 3)) {
    throw new Error('The file response contained malformed base64 data.');
  }
  if (
    (padding === 2 && (base64Value(encoded.charCodeAt(encoded.length - 3)) & 0x0f) !== 0)
    || (padding === 1 && (base64Value(encoded.charCodeAt(encoded.length - 2)) & 0x03) !== 0)
  ) {
    throw new Error('The file response contained malformed base64 data.');
  }
  return toByteArray(encoded);
}

function base64Value(code: number): number {
  if (code >= 65 && code <= 90) return code - 65;
  if (code >= 97 && code <= 122) return code - 71;
  if (code >= 48 && code <= 57) return code + 4;
  return code === 43 ? 62 : 63;
}

function decodeUtf8(bytes: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new Error('The HTML file is not valid UTF-8.');
  }
}
