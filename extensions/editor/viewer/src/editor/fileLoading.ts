import {
  readFile,
  readFileWindow,
  type ReadFileResult,
  type ReadFileWindowResult,
} from '@remux/viewer-kit/fs';
import { decodeSourceText, FULL_DOCUMENT_MAX_BYTES } from './sourceDecode';

export const LIGHTWEIGHT_SOURCE_BYTES = 1024 * 1024;
export const LONG_LINE_CHARACTERS = 20_000;

export type FullDocument = {
  kind: 'full';
  lightweight: boolean;
  name: string;
  path: string;
  revision: string;
  sizeBytes: number;
  text: string;
};

export type WindowedDocument = {
  continuation: ReadFileWindowResult['continuation'];
  eof: boolean;
  kind: 'windowed';
  name: string;
  nextOffset: number | null;
  path: string;
  previousOffset: number | null;
  range: ReadFileWindowResult['range'];
  targetLine: ReadFileWindowResult['targetLine'];
  text: string;
  totalSizeBytes: number;
  version: string;
};

export type EditorDocument = FullDocument | WindowedDocument;

export async function loadInitialDocument(
  path: string,
  signal?: AbortSignal,
  targetLine?: number | null,
): Promise<EditorDocument> {
  const result = await readFile(path, { format: 'base64', signal });
  throwIfAborted(signal);
  if (result.tooLarge) {
    return loadDocumentWindow(path, { signal, targetLine: targetLine ?? undefined });
  }
  return fullDocumentFromResult(result);
}

export async function loadDocumentWindow(
  path: string,
  options: {
    expectedVersion?: string;
    offset?: number;
    signal?: AbortSignal;
    targetLine?: number;
  } = {},
): Promise<WindowedDocument> {
  const result = await readFileWindow(path, options);
  throwIfAborted(options.signal);
  return {
    continuation: result.continuation,
    eof: result.eof,
    kind: 'windowed',
    name: basename(path),
    nextOffset: result.nextOffset,
    path: result.path,
    previousOffset: result.previousOffset,
    range: result.range,
    targetLine: result.targetLine,
    text: result.content,
    totalSizeBytes: result.totalSizeBytes,
    version: result.version,
  };
}

function fullDocumentFromResult(result: ReadFileResult): FullDocument {
  if (result.isBinary) {
    throw new Error('The selected file contains binary data and cannot be shown as text.');
  }
  if (result.encoding !== 'base64' || typeof result.dataBase64 !== 'string') {
    throw new Error('The file response did not contain source bytes.');
  }
  const text = decodeSourceText(result.dataBase64, result.sizeBytes);
  return {
    kind: 'full',
    lightweight: result.sizeBytes > LIGHTWEIGHT_SOURCE_BYTES || hasPathologicalLine(text),
    name: result.name,
    path: result.path,
    revision: `${result.modifiedAtMs ?? 'unknown'}:${result.sizeBytes}`,
    sizeBytes: result.sizeBytes,
    text,
  };
}

function hasPathologicalLine(text: string): boolean {
  let current = 0;
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) === 10) current = 0;
    else if (++current > LONG_LINE_CHARACTERS) return true;
  }
  return false;
}

function basename(path: string) {
  return path.replace(/[\\/]+$/u, '').split(/[\\/]/u).at(-1) || path;
}

function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError');
}
