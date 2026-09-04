import { rpc } from '@remux/viewer-kit/ipc';

import { NATIVE_AGENT_METHODS, type NativeArtifactReadResult } from '../../../shared/native-agent-protocol.ts';
import type { ArtifactReadParams, ArtifactReadResult } from '../../../shared/protocol.ts';

export function readArtifactRange(params: ArtifactReadParams) {
  const offset = params.range.kind === 'lines' ? 0 : params.range.offset;
  const byteLength = params.range.kind === 'lines' ? 256 * 1024 : params.range.byteLength;
  return rpc.query<NativeArtifactReadResult>(NATIVE_AGENT_METHODS.artifactRead, {
    artifactId: params.hash,
    offset,
    byteLength,
  }).then((result): ArtifactReadResult => {
    const nextOffset = result.offset + result.byteLength;
    const hasNext = nextOffset < result.totalByteLength;
    if (params.range.kind === 'utf8') {
      return {
        hash: result.artifactId,
        mediaType: result.mimeType,
        totalByteLength: result.totalByteLength,
        totalLineCount: null,
        range: { kind: 'utf8', offset: result.offset, byteLength: result.byteLength },
        encoding: 'utf8',
        content: decodeBase64Utf8(result.base64),
        truncated: hasNext,
        nextRange: hasNext ? {
          kind: 'utf8',
          offset: nextOffset,
          byteLength: Math.min(48 * 1024, result.totalByteLength - nextOffset),
        } : null,
      };
    }
    return {
      hash: result.artifactId,
      mediaType: result.mimeType,
      totalByteLength: result.totalByteLength,
      totalLineCount: null,
      range: { kind: 'bytes', offset: result.offset, byteLength: result.byteLength },
      encoding: 'base64',
      content: result.base64,
      truncated: hasNext,
      nextRange: hasNext ? {
        kind: 'bytes',
        offset: nextOffset,
        byteLength: Math.min(48 * 1024, result.totalByteLength - nextOffset),
      } : null,
    };
  });
}

function decodeBase64Utf8(encoded: string) {
  const binary = atob(encoded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return new TextDecoder().decode(bytes);
}

export async function readArtifactDataUrl(hash: string, mimeType: string, byteLength: number) {
  const chunks: string[] = [];
  let offset = 0;
  while (offset < byteLength) {
    const result = await readArtifactRange({
      hash,
      range: { kind: 'bytes', offset, byteLength: Math.min(48 * 1024, byteLength - offset) },
    });
    if (result.encoding !== 'base64' || result.range.kind !== 'bytes') {
      throw new Error(`Artifact ${hash} did not return binary content.`);
    }
    chunks.push(result.content);
    const readBytes = result.range.byteLength;
    if (readBytes <= 0) throw new Error(`Artifact ${hash} returned an empty range.`);
    offset += readBytes;
  }
  const binary = chunks.map((chunk) => atob(chunk)).join('');
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  let encoded = '';
  const stride = 24 * 1024;
  for (let index = 0; index < bytes.length; index += stride) {
    encoded += btoa(String.fromCharCode(...bytes.subarray(index, index + stride)));
  }
  return `data:${mimeType};base64,${encoded}`;
}
