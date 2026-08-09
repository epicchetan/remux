import { createHash } from 'node:crypto';

import type { AgentComposerMessagePart } from '../../shared/protocol.ts';

export const MAX_AGENT_INPUT_PARTS = 128;
export const MAX_AGENT_INPUT_TEXT_BYTES = 256 * 1024;
export const MAX_AGENT_IMAGE_ATTACHMENTS = 4;
export const MAX_AGENT_IMAGE_BYTES = 6 * 1024 * 1024;

const ALLOWED_IMAGE_MIME_TYPES = new Set([
  'image/gif',
  'image/heic',
  'image/heif',
  'image/jpeg',
  'image/png',
  'image/webp',
]);

export type AgentPromptImage = {
  data: string;
  mimeType: string;
};

export function parseAgentComposerParts(value: unknown): AgentComposerMessagePart[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_AGENT_INPUT_PARTS) {
    throw new TypeError(`parts must contain between 1 and ${MAX_AGENT_INPUT_PARTS} entries.`);
  }
  let textBytes = 0;
  let imageCount = 0;
  return value.map((entry, index): AgentComposerMessagePart => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new TypeError(`parts[${index}] must be an object.`);
    }
    const part = entry as Record<string, unknown>;
    if (part.type === 'text') {
      if (typeof part.text !== 'string' || part.text.length === 0) {
        throw new TypeError(`parts[${index}].text must be a non-empty string.`);
      }
      textBytes += Buffer.byteLength(part.text, 'utf8');
      if (textBytes > MAX_AGENT_INPUT_TEXT_BYTES) {
        throw new TypeError('Message text is larger than 256 KiB.');
      }
      return { text: part.text, type: 'text' };
    }
    if (part.type === 'mention') {
      if (typeof part.path !== 'string' || !part.path.trim() || Buffer.byteLength(part.path, 'utf8') > 16 * 1024) {
        throw new TypeError(`parts[${index}].path must contain 1 to 16384 UTF-8 bytes.`);
      }
      if (part.kind !== undefined && part.kind !== 'directory' && part.kind !== 'file') {
        throw new TypeError(`parts[${index}].kind must be directory or file.`);
      }
      if (part.name !== undefined && part.name !== null && typeof part.name !== 'string') {
        throw new TypeError(`parts[${index}].name must be a string.`);
      }
      return {
        ...(part.kind ? { kind: part.kind } : {}),
        ...(typeof part.name === 'string' ? { name: part.name } : {}),
        path: part.path,
        type: 'mention',
      };
    }
    if (part.type === 'image') {
      imageCount += 1;
      if (imageCount > MAX_AGENT_IMAGE_ATTACHMENTS) {
        throw new TypeError(`A message may attach at most ${MAX_AGENT_IMAGE_ATTACHMENTS} images.`);
      }
      if (typeof part.dataUrl !== 'string') {
        throw new TypeError(`parts[${index}].dataUrl must be a base64 image data URL.`);
      }
      const decoded = decodeAgentImageDataUrl(part.dataUrl);
      if (part.mimeType !== undefined && part.mimeType !== null && part.mimeType !== decoded.mimeType) {
        throw new TypeError(`parts[${index}].mimeType does not match its data URL.`);
      }
      if (part.name !== undefined && part.name !== null && typeof part.name !== 'string') {
        throw new TypeError(`parts[${index}].name must be a string.`);
      }
      return {
        dataUrl: part.dataUrl,
        mimeType: decoded.mimeType,
        ...(typeof part.name === 'string' ? { name: part.name.slice(0, 1024) } : {}),
        type: 'image',
      };
    }
    throw new TypeError(`parts[${index}].type is not supported.`);
  });
}

export function agentPromptText(parts: readonly AgentComposerMessagePart[]) {
  const text = parts.map((part) => {
    if (part.type === 'text') return part.text;
    if (part.type === 'mention') return `@${part.path}`;
    return '';
  }).join('').trim();
  if (text) return text;
  const images = parts.filter((part) => part.type === 'image');
  return images.length === 1 ? '[Attached image]' : `[Attached ${images.length} images]`;
}

export function agentPromptImages(parts: readonly AgentComposerMessagePart[]): AgentPromptImage[] {
  return parts.flatMap((part) => {
    if (part.type !== 'image') return [];
    const decoded = decodeAgentImageDataUrl(part.dataUrl);
    return [{ data: decoded.data, mimeType: decoded.mimeType }];
  });
}

export function agentComposerPartsHashValue(parts: readonly AgentComposerMessagePart[]) {
  return parts.map((part) => {
    if (part.type === 'text') return part;
    if (part.type === 'mention') return part;
    const decoded = decodeAgentImageDataUrl(part.dataUrl);
    return {
      dataHash: createHash('sha256').update(decoded.bytes).digest('hex'),
      mimeType: decoded.mimeType,
      name: part.name ?? null,
      sizeBytes: decoded.bytes.byteLength,
      type: 'image' as const,
    };
  });
}

export function decodeAgentImageDataUrl(dataUrl: string) {
  const match = /^data:([^;,]+);base64,([a-z0-9+/]*={0,2})$/iu.exec(dataUrl);
  if (!match) throw new TypeError('Image attachment must be a base64 data URL.');
  const mimeType = match[1]!.toLowerCase();
  if (!ALLOWED_IMAGE_MIME_TYPES.has(mimeType)) {
    throw new TypeError(`Image type ${mimeType} is not supported.`);
  }
  const data = match[2]!;
  const bytes = Buffer.from(data, 'base64');
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_AGENT_IMAGE_BYTES) {
    throw new TypeError('Image attachment must contain between 1 byte and 6 MiB.');
  }
  if (bytes.toString('base64').replace(/=+$/u, '') !== data.replace(/=+$/u, '')) {
    throw new TypeError('Image attachment contains invalid base64 data.');
  }
  return { bytes, data, mimeType };
}
