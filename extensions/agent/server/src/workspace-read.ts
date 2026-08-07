import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import { createInterface } from 'node:readline';

import { Type } from '@earendil-works/pi-ai';
import { defineTool, type ToolDefinition } from '@earendil-works/pi-coding-agent';

import type { WorkspaceReadParams, WorkspaceReadResult } from '../../shared/protocol.ts';

const MAX_VISIBLE_BYTES = 32 * 1024;
const DEFAULT_LINE_COUNT = 200;
const MAX_LINE_COUNT = 1_000;

export async function readWorkspaceFile(
  workspaceRoot: string,
  params: WorkspaceReadParams,
): Promise<WorkspaceReadResult> {
  if (!params.path || isAbsolute(params.path)) {
    throw new Error('path must be a non-empty workspace-relative path');
  }

  const canonicalRoot = await realpath(workspaceRoot);
  const lexicalTarget = resolve(canonicalRoot, params.path);
  assertWithin(canonicalRoot, lexicalTarget, 'path escapes the workspace');

  const canonicalTarget = await realpath(lexicalTarget);
  assertWithin(canonicalRoot, canonicalTarget, 'path resolves outside the workspace');
  const metadata = await stat(canonicalTarget);
  if (!metadata.isFile()) {
    throw new Error('path must resolve to a regular file');
  }

  const startLine = integerInRange(params.startLine ?? 1, 1, Number.MAX_SAFE_INTEGER, 'startLine');
  const lineCount = integerInRange(params.lineCount ?? DEFAULT_LINE_COUNT, 1, MAX_LINE_COUNT, 'lineCount');
  const requestedEnd = startLine + lineCount - 1;
  const stream = createReadStream(canonicalTarget);
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  const selected: string[] = [];
  let visibleBytes = 0;
  let currentLine = 0;
  let endLine = startLine - 1;
  let truncated = false;

  for await (const line of lines) {
    currentLine += 1;
    if (currentLine < startLine) continue;
    if (currentLine > requestedEnd) {
      truncated = true;
      lines.close();
      stream.destroy();
      break;
    }
    const suffix = selected.length > 0 ? `\n${line}` : line;
    const bytes = Buffer.byteLength(suffix);
    if (visibleBytes + bytes > MAX_VISIBLE_BYTES) {
      const remaining = MAX_VISIBLE_BYTES - visibleBytes;
      if (remaining > 0) {
        selected.push(utf8Prefix(suffix, remaining));
      }
      visibleBytes = MAX_VISIBLE_BYTES;
      endLine = currentLine;
      truncated = true;
      lines.close();
      stream.destroy();
      break;
    }
    selected.push(selected.length > 0 ? `\n${line}` : line);
    visibleBytes += bytes;
    endLine = currentLine;
  }

  const text = selected.join('');
  return {
    path: relative(canonicalRoot, canonicalTarget),
    contentHash: createHash('sha256').update(text).digest('hex'),
    startLine,
    endLine,
    text,
    truncated,
  };
}

function utf8Prefix(value: string, maxBytes: number) {
  const bytes = Buffer.from(value);
  if (bytes.byteLength <= maxBytes) return value;
  let end = maxBytes;
  while (end > 0) {
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, end));
    } catch {
      end -= 1;
    }
  }
  return '';
}

export function createWorkspaceReadTool(workspaceRoot: string): ToolDefinition {
  return defineTool({
    name: 'workspace_read',
    label: 'Read workspace file',
    description: 'Read a bounded line range from a file inside the current workspace.',
    promptSnippet: 'workspace_read: inspect a bounded range of a workspace file',
    parameters: Type.Object({
      path: Type.String({ description: 'Workspace-relative file path' }),
      startLine: Type.Optional(Type.Integer({ minimum: 1 })),
      lineCount: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_LINE_COUNT })),
    }),
    async execute(_toolCallId, params) {
      const result = await readWorkspaceFile(workspaceRoot, params);
      return {
        content: [{ type: 'text', text: JSON.stringify(result) }],
        details: result,
      };
    },
  });
}

function assertWithin(root: string, target: string, message: string) {
  const pathFromRoot = relative(root, target);
  if (pathFromRoot === '..' || pathFromRoot.startsWith('../') || isAbsolute(pathFromRoot)) {
    throw new Error(message);
  }
}

function integerInRange(value: number, min: number, max: number, name: string) {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
  return value;
}
