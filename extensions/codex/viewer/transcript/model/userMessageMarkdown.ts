import type { TextElement } from '@remux/codex/protocol/v2';

export type UserTextElementSpan = {
  byteEnd: number;
  byteStart: number;
  jsEnd: number;
  jsStart: number;
  outputText: string;
  placeholder: string | null;
  sourceIndex: number;
};

export function normalizeUserTextToMarkdown(text: string, textElements: readonly TextElement[] = []) {
  const spans = normalizeTextElementSpans(text, textElements);
  if (spans.length === 0) {
    return text;
  }

  let cursor = 0;
  let markdown = '';

  for (const span of spans) {
    markdown += text.slice(cursor, span.jsStart);
    markdown += escapeMarkdownLiteral(span.outputText);
    cursor = span.jsEnd;
  }

  markdown += text.slice(cursor);
  return markdown;
}

export function normalizeTextElementSpans(text: string, textElements: readonly TextElement[] = []): UserTextElementSpan[] {
  const spans = textElements
    .map((element, sourceIndex): UserTextElementSpan | null => {
      const byteStart = element.byteRange.start;
      const byteEnd = element.byteRange.end;
      const jsStart = byteOffsetToJsIndex(text, byteStart);
      const jsEnd = byteOffsetToJsIndex(text, byteEnd);

      if (
        jsStart === null ||
        jsEnd === null ||
        byteStart < 0 ||
        byteEnd <= byteStart ||
        jsEnd <= jsStart
      ) {
        return null;
      }

      return {
        byteEnd,
        byteStart,
        jsEnd,
        jsStart,
        outputText: element.placeholder ?? text.slice(jsStart, jsEnd),
        placeholder: element.placeholder,
        sourceIndex,
      };
    })
    .filter((span): span is UserTextElementSpan => Boolean(span))
    .sort((left, right) => left.jsStart - right.jsStart || left.jsEnd - right.jsEnd);

  const nonOverlapping: UserTextElementSpan[] = [];
  let cursor = 0;

  for (const span of spans) {
    if (span.jsStart < cursor) {
      continue;
    }

    nonOverlapping.push(span);
    cursor = span.jsEnd;
  }

  return nonOverlapping;
}

export function textElementsRevision(textElements: readonly TextElement[] = []) {
  return textElements
    .map((element) => `${element.byteRange.start}:${element.byteRange.end}:${element.placeholder ?? ''}`)
    .join('|');
}

function byteOffsetToJsIndex(text: string, offset: number) {
  if (!Number.isFinite(offset) || offset < 0) {
    return null;
  }

  let byteCursor = 0;
  let jsCursor = 0;

  for (const char of text) {
    if (byteCursor === offset) {
      return jsCursor;
    }

    const nextByteCursor = byteCursor + utf8ByteLength(char);
    if (offset > byteCursor && offset < nextByteCursor) {
      return null;
    }

    byteCursor = nextByteCursor;
    jsCursor += char.length;
  }

  return byteCursor === offset ? text.length : null;
}

function utf8ByteLength(value: string) {
  let length = 0;

  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x7f) {
      length += 1;
    } else if (code <= 0x7ff) {
      length += 2;
    } else if (code >= 0xd800 && code <= 0xdbff) {
      length += 4;
      index += 1;
    } else {
      length += 3;
    }
  }

  return length;
}

function escapeMarkdownLiteral(value: string) {
  return value.replace(/[\\`*_{}[\]()#+\-.!|>]/g, '\\$&');
}
