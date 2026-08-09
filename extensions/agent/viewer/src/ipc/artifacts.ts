import { rpc } from '@remux/viewer-kit/ipc';

import {
  AGENT_METHODS,
  type ArtifactReadParams,
  type ArtifactReadResult,
} from '../../../shared/protocol';

export function readArtifactRange(params: ArtifactReadParams) {
  return rpc.query<ArtifactReadResult>(AGENT_METHODS.artifactRead, params);
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
