export type MarkdownMathDelimiter =
  | 'backslashDisplay'
  | 'backslashInline'
  | 'dollarDisplay'
  | 'dollarInline';

export type MarkdownMathSource = {
  delimiter: MarkdownMathDelimiter;
  originalSource: string;
  sourceEnd: number;
  sourceStart: number;
  tex: string;
};

export type MarkdownMathToken =
  | {
      kind: 'display' | 'inline';
      marker: string;
      source: MarkdownMathSource;
    }
  | {
      kind: 'literal';
      marker: string;
      originalSource: string;
      placement: 'block' | 'inline';
      reason: 'incomplete' | 'invalid' | 'overLimit';
      sourceEnd: number;
      sourceStart: number;
    };

export type MarkdownMathMask = {
  masked: string;
  tokenByMarker: ReadonlyMap<string, MarkdownMathToken>;
};

export type MarkdownSourceRange = {
  end: number;
  start: number;
};

type SourceRange = MarkdownSourceRange;

type MathCandidate = {
  delimiter: MarkdownMathDelimiter;
  end: number;
  kind: 'display' | 'inline';
  start: number;
  texEnd: number;
  texStart: number;
};

const defaultMaxFormulaCodeUnits = 16_384;
const defaultMaxFormulas = 128;
const markerRangeStart = 0xe000;
const markerRangeEnd = 0xf8ff;

export function maskMarkdownMath(
  markdown: string,
  {
    maxFormulaCodeUnits = defaultMaxFormulaCodeUnits,
    maxFormulas = defaultMaxFormulas,
    protectedRanges: parserProtectedRanges = [],
    streaming = false,
  }: {
    maxFormulaCodeUnits?: number;
    maxFormulas?: number;
    protectedRanges?: readonly MarkdownSourceRange[];
    streaming?: boolean;
  } = {},
): MarkdownMathMask {
  if (!markdown) {
    return { masked: markdown, tokenByMarker: new Map() };
  }

  const protectedRanges = markdownProtectedRanges(markdown, parserProtectedRanges);
  const candidates: MathCandidate[] = [];
  const literals: Array<Omit<Extract<MarkdownMathToken, { kind: 'literal' }>, 'marker'>> = [];
  let formulaCount = 0;
  let rangeIndex = 0;

  for (let index = 0; index < markdown.length;) {
    while (protectedRanges[rangeIndex]?.end <= index) rangeIndex += 1;
    const protectedRange = protectedRanges[rangeIndex];
    if (protectedRange && protectedRange.start <= index) {
      index = protectedRange.end;
      continue;
    }

    const candidate = mathCandidateAt(markdown, index, protectedRanges);
    if (!candidate) {
      const incomplete = incompleteCandidateAt(markdown, index, protectedRanges);
      if (incomplete) {
        const literalEnd = streaming ? markdown.length : incomplete.openerEnd;
        literals.push({
          kind: 'literal',
          originalSource: markdown.slice(index, literalEnd),
          placement: incomplete.kind === 'display' ? 'block' : 'inline',
          reason: 'incomplete',
          sourceEnd: literalEnd,
          sourceStart: index,
        });
        index = literalEnd;
        continue;
      }
      index += 1;
      continue;
    }

    const sourceLength = candidate.end - candidate.start;
    const tex = markdown.slice(candidate.texStart, candidate.texEnd);
    formulaCount += 1;
    if (!tex.trim()) {
      literals.push({
        kind: 'literal',
        originalSource: markdown.slice(candidate.start, candidate.end),
        placement: candidate.kind === 'display' ? 'block' : 'inline',
        reason: 'invalid',
        sourceEnd: candidate.end,
        sourceStart: candidate.start,
      });
    } else if (formulaCount > maxFormulas || sourceLength > maxFormulaCodeUnits) {
      literals.push({
        kind: 'literal',
        originalSource: markdown.slice(candidate.start, candidate.end),
        placement: candidate.kind === 'display' ? 'block' : 'inline',
        reason: 'overLimit',
        sourceEnd: candidate.end,
        sourceStart: candidate.start,
      });
    } else {
      candidates.push(candidate);
    }
    index = candidate.end;
  }

  const tokenInputs = [
    ...candidates.map((candidate) => ({
      candidate,
      end: candidate.end,
      start: candidate.start,
      type: 'candidate' as const,
    })),
    ...literals.map((literal) => ({
      end: literal.sourceEnd,
      literal,
      start: literal.sourceStart,
      type: 'literal' as const,
    })),
  ].sort((left, right) => left.start - right.start);

  const tokenByMarker = new Map<string, MarkdownMathToken>();
  const maskedParts: string[] = [];
  const markers = availableMarkers(markdown, tokenInputs.length);
  let cursor = 0;
  for (let tokenIndex = 0; tokenIndex < tokenInputs.length; tokenIndex += 1) {
    const input = tokenInputs[tokenIndex];
    const marker = markers[tokenIndex];
    if (!input || !marker || input.start < cursor) continue;
    maskedParts.push(markdown.slice(cursor, input.start), marker.repeat(input.end - input.start));
    cursor = input.end;

    if (input.type === 'literal') {
      tokenByMarker.set(marker, { ...input.literal, marker });
      continue;
    }

    const candidate = input.candidate;
    tokenByMarker.set(marker, {
      kind: candidate.kind,
      marker,
      source: {
        delimiter: candidate.delimiter,
        originalSource: markdown.slice(candidate.start, candidate.end),
        sourceEnd: candidate.end,
        sourceStart: candidate.start,
        tex: markdown.slice(candidate.texStart, candidate.texEnd).replace(/\r\n?/g, '\n'),
      },
    });
  }
  maskedParts.push(markdown.slice(cursor));

  return { masked: maskedParts.join(''), tokenByMarker };
}

export function splitMarkdownMathMarkers(
  value: string,
  tokenByMarker: ReadonlyMap<string, MarkdownMathToken>,
): Array<{ text: string; type: 'text' } | { raw: string; token: MarkdownMathToken; type: 'token' }> {
  if (tokenByMarker.size === 0 || !value) {
    return value ? [{ text: value, type: 'text' }] : [];
  }

  const parts: Array<
    { text: string; type: 'text' } |
    { raw: string; token: MarkdownMathToken; type: 'token' }
  > = [];
  let textStart = 0;
  for (let index = 0; index < value.length;) {
    const token = tokenByMarker.get(value[index] ?? '');
    if (!token) {
      index += 1;
      continue;
    }
    if (index > textStart) {
      parts.push({ text: value.slice(textStart, index), type: 'text' });
    }
    let end = index + 1;
    while (value[end] === token.marker) end += 1;
    parts.push({ raw: value.slice(index, end), token, type: 'token' });
    index = end;
    textStart = end;
  }
  if (textStart < value.length) {
    parts.push({ text: value.slice(textStart), type: 'text' });
  }
  return parts;
}

function mathCandidateAt(source: string, index: number, protectedRanges: SourceRange[]): MathCandidate | null {
  if (source.startsWith('\\[', index) && !isEscaped(source, index)) {
    const close = findUnescapedSequence(source, index + 2, '\\]', protectedRanges);
    if (close === -1) return null;
    return {
      delimiter: 'backslashDisplay',
      end: close + 2,
      kind: 'display',
      start: index,
      texEnd: close,
      texStart: index + 2,
    };
  }

  if (source.startsWith('\\(', index) && !isEscaped(source, index)) {
    const close = findUnescapedSequence(source, index + 2, '\\)', protectedRanges);
    if (close === -1) return null;
    const tex = source.slice(index + 2, close);
    if (/\n[ \t]*\n/u.test(tex)) return null;
    return {
      delimiter: 'backslashInline',
      end: close + 2,
      kind: 'inline',
      start: index,
      texEnd: close,
      texStart: index + 2,
    };
  }

  if (
    source.startsWith('$$', index) &&
    source[index - 1] !== '$' &&
    source[index + 2] !== '$' &&
    !isEscaped(source, index)
  ) {
    const close = findDollarDisplayClose(source, index + 2, protectedRanges);
    if (close === -1) return null;
    return {
      delimiter: 'dollarDisplay',
      end: close + 2,
      kind: 'display',
      start: index,
      texEnd: close,
      texStart: index + 2,
    };
  }

  if (
    source[index] === '$' &&
    source[index - 1] !== '$' &&
    source[index + 1] !== '$' &&
    !isEscaped(source, index) &&
    source[index + 1] !== undefined &&
    !/\s/u.test(source[index + 1]!)
  ) {
    const close = findDollarInlineClose(source, index + 1, protectedRanges);
    if (close === -1) return null;
    const tex = source.slice(index + 1, close);
    if (!tex.trim() || /^[\d.,]+$/u.test(tex)) return null;
    return {
      delimiter: 'dollarInline',
      end: close + 1,
      kind: 'inline',
      start: index,
      texEnd: close,
      texStart: index + 1,
    };
  }
  return null;
}

function incompleteCandidateAt(
  source: string,
  index: number,
  protectedRanges: SourceRange[],
): { kind: 'display' | 'inline'; openerEnd: number } | null {
  if (source.startsWith('\\[', index) && !isEscaped(source, index)) {
    return findUnescapedSequence(source, index + 2, '\\]', protectedRanges) === -1
      ? { kind: 'display', openerEnd: index + 2 }
      : null;
  }
  if (source.startsWith('\\(', index) && !isEscaped(source, index)) {
    return findUnescapedSequence(source, index + 2, '\\)', protectedRanges) === -1
      ? { kind: 'inline', openerEnd: index + 2 }
      : null;
  }
  if (
    source.startsWith('$$', index) &&
    source[index - 1] !== '$' &&
    source[index + 2] !== '$' &&
    !isEscaped(source, index)
  ) {
    return findDollarDisplayClose(source, index + 2, protectedRanges) === -1
      ? { kind: 'display', openerEnd: index + 2 }
      : null;
  }
  return null;
}

function findUnescapedSequence(source: string, start: number, sequence: string, ranges: SourceRange[]) {
  for (let index = source.indexOf(sequence, start); index !== -1; index = source.indexOf(sequence, index + 1)) {
    if (!isProtected(index, ranges) && !isEscaped(source, index)) return index;
  }
  return -1;
}

function findDollarDisplayClose(source: string, start: number, ranges: SourceRange[]) {
  for (let index = source.indexOf('$$', start); index !== -1; index = source.indexOf('$$', index + 2)) {
    if (
      !isProtected(index, ranges) &&
      !isEscaped(source, index) &&
      source[index - 1] !== '$' &&
      source[index + 2] !== '$'
    ) return index;
  }
  return -1;
}

function findDollarInlineClose(source: string, start: number, ranges: SourceRange[]) {
  for (let index = start; index < source.length; index += 1) {
    const character = source[index];
    if (character === '\n' || character === '\r') return -1;
    if (
      character === '$' &&
      !isProtected(index, ranges) &&
      !isEscaped(source, index) &&
      source[index - 1] !== '$' &&
      source[index + 1] !== '$' &&
      index > start &&
      !/\s/u.test(source[index - 1]!)
    ) return index;
  }
  return -1;
}

function markdownProtectedRanges(
  source: string,
  parserProtectedRanges: readonly MarkdownSourceRange[],
): SourceRange[] {
  const ranges = [...parserProtectedRanges, ...fencedCodeRanges(source)];
  ranges.push(...htmlBlockRanges(source, ranges));
  ranges.push(...inlineCodeRanges(source, ranges));
  ranges.push(...plainUrlRanges(source, ranges));
  ranges.push(...angleRanges(source, ranges));
  ranges.push(...linkDestinationRanges(source, ranges));
  return mergeRanges(ranges);
}

function plainUrlRanges(source: string, existing: SourceRange[]) {
  const ranges: SourceRange[] = [];
  const pattern = /https?:\/\/[^\s<>"'\x60]+/gu;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source))) {
    if (!isProtected(match.index, existing)) {
      ranges.push({ end: match.index + match[0].length, start: match.index });
    }
  }
  return ranges;
}

function htmlBlockRanges(source: string, existing: SourceRange[]) {
  const ranges: SourceRange[] = [];
  const rawTagPattern = /<(script|pre|style|textarea)(?:\s|>)/giu;
  let rawMatch: RegExpExecArray | null;
  while ((rawMatch = rawTagPattern.exec(source))) {
    if (isProtected(rawMatch.index, existing)) continue;
    const tag = rawMatch[1]!;
    const closePattern = new RegExp('</' + tag + '\\s*>', 'giu');
    closePattern.lastIndex = rawTagPattern.lastIndex;
    const close = closePattern.exec(source);
    ranges.push({
      end: close ? close.index + close[0].length : source.length,
      start: rawMatch.index,
    });
  }

  for (let index = source.indexOf('<!--'); index !== -1; index = source.indexOf('<!--', index + 4)) {
    if (isProtected(index, existing)) continue;
    const close = source.indexOf('-->', index + 4);
    ranges.push({ end: close === -1 ? source.length : close + 3, start: index });
  }

  const blockTag = /^ {0,3}<\/?(?:address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h1|h2|h3|h4|h5|h6|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul)(?:\s|\/?>|$)/iu;
  for (let lineStart = 0; lineStart < source.length;) {
    const lineEnd = nextLineEnd(source, lineStart);
    const line = source.slice(lineStart, lineEnd).replace(/\r?\n$/u, '');
    if (!isProtected(lineStart, existing) && blockTag.test(line)) {
      let end = lineEnd;
      while (end < source.length) {
        const candidateEnd = nextLineEnd(source, end);
        const candidate = source.slice(end, candidateEnd).replace(/\r?\n$/u, '');
        if (!candidate.trim()) break;
        end = candidateEnd;
      }
      ranges.push({ end, start: lineStart });
      lineStart = end;
      continue;
    }
    lineStart = lineEnd;
  }
  return ranges;
}

function fencedCodeRanges(source: string) {
  const ranges: SourceRange[] = [];
  let lineStart = 0;
  while (lineStart < source.length) {
    const lineEnd = nextLineEnd(source, lineStart);
    const line = source.slice(lineStart, lineEnd).replace(/\r?\n$/u, '');
    const opener = /^ {0,3}(\x60{3,}|~{3,})/u.exec(line);
    if (!opener) {
      lineStart = lineEnd;
      continue;
    }
    const fence = opener[1]!;
    const character = fence[0]!;
    const pattern = new RegExp(
      '^ {0,3}' + escapeRegExp(character) + '{' + fence.length + ',}[ \\t]*$',
      'u',
    );
    let closeEnd = source.length;
    for (let cursor = lineEnd; cursor < source.length;) {
      const candidateEnd = nextLineEnd(source, cursor);
      const candidate = source.slice(cursor, candidateEnd).replace(/\r?\n$/u, '');
      if (pattern.test(candidate)) {
        closeEnd = candidateEnd;
        break;
      }
      cursor = candidateEnd;
    }
    ranges.push({ end: closeEnd, start: lineStart });
    lineStart = closeEnd;
  }
  return ranges;
}

function inlineCodeRanges(source: string, existing: SourceRange[]) {
  const ranges: SourceRange[] = [];
  for (let index = 0; index < source.length;) {
    if (source.charCodeAt(index) !== 0x60 || isProtected(index, existing)) {
      index += 1;
      continue;
    }
    let runEnd = index + 1;
    while (source.charCodeAt(runEnd) === 0x60) runEnd += 1;
    const run = source.slice(index, runEnd);
    const close = source.indexOf(run, runEnd);
    if (close === -1 || isProtected(close, existing)) {
      index = runEnd;
      continue;
    }
    ranges.push({ end: close + run.length, start: index });
    index = close + run.length;
  }
  return ranges;
}

function angleRanges(source: string, existing: SourceRange[]) {
  const ranges: SourceRange[] = [];
  for (let index = source.indexOf('<'); index !== -1; index = source.indexOf('<', index + 1)) {
    if (isProtected(index, existing)) continue;
    const end = source.indexOf('>', index + 1);
    if (end === -1) break;
    const body = source.slice(index + 1, end);
    if (/^(?:https?:\/\/|mailto:|\/?[A-Za-z][^<>]*|!--)/u.test(body)) {
      ranges.push({ end: end + 1, start: index });
      index = end;
    }
  }
  return ranges;
}

function linkDestinationRanges(source: string, existing: SourceRange[]) {
  const ranges: SourceRange[] = [];
  for (let index = source.indexOf(']('); index !== -1; index = source.indexOf('](', index + 2)) {
    if (isProtected(index, existing)) continue;
    let depth = 1;
    let cursor = index + 2;
    const angle = source[cursor] === '<';
    if (angle) cursor += 1;
    for (; cursor < source.length; cursor += 1) {
      if (isEscaped(source, cursor)) continue;
      const character = source[cursor];
      if (angle && character === '>') {
        const close = source.indexOf(')', cursor + 1);
        if (close !== -1) ranges.push({ end: close + 1, start: index + 1 });
        break;
      }
      if (!angle && character === '(') depth += 1;
      if (!angle && character === ')') {
        depth -= 1;
        if (depth === 0) {
          ranges.push({ end: cursor + 1, start: index + 1 });
          break;
        }
      }
      if (character === '\n' || character === '\r') break;
    }
  }
  return ranges;
}

function mergeRanges(ranges: SourceRange[]) {
  const sorted = ranges
    .filter((range) => range.end > range.start)
    .sort((left, right) => left.start - right.start || left.end - right.end);
  const merged: SourceRange[] = [];
  for (const range of sorted) {
    const previous = merged.at(-1);
    if (previous && range.start <= previous.end) {
      previous.end = Math.max(previous.end, range.end);
    } else {
      merged.push({ ...range });
    }
  }
  return merged;
}

function isProtected(index: number, ranges: SourceRange[]) {
  for (const range of ranges) {
    if (range.start > index) return false;
    if (index < range.end) return true;
  }
  return false;
}

function isEscaped(source: string, index: number) {
  let backslashes = 0;
  for (let cursor = index - 1; cursor >= 0 && source[cursor] === '\\'; cursor -= 1) {
    backslashes += 1;
  }
  return backslashes % 2 === 1;
}

function availableMarkers(source: string, count: number) {
  const used = new Set(source);
  const markers: string[] = [];
  for (let code = markerRangeStart; code <= markerRangeEnd && markers.length < count; code += 1) {
    const candidate = String.fromCharCode(code);
    if (!used.has(candidate)) markers.push(candidate);
  }
  return markers;
}

function nextLineEnd(source: string, start: number) {
  const newline = source.indexOf('\n', start);
  return newline === -1 ? source.length : newline + 1;
}

function escapeRegExp(value: string) {
  return value.replace(/[-/\\^$*+?.()|[\]{}]/gu, '\\$&');
}
