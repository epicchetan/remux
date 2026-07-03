import type { IBufferLine, Terminal } from '@xterm/xterm';
import {
  hostOpenTargetFromHref,
  hostOpenTargetText,
  type HostOpenTarget,
} from '@remux/viewer-kit/links';

// Matches the default pattern WebLinksAddon registers for pointer hover and
// click, so tap detection agrees with what desktop pointers underline.
const terminalUrlRegex = /(https?|HTTPS?):[/]{2}[^\s"'!*(){}|\\^<>`]*[^\s"':,.!?{}|\\^~[\]`()<>]/;

// Expanding a wrap-joined line stops once it grows past this many characters,
// mirroring WebLinksAddon's windowing so hit tests agree with its matches.
const maxJoinedLineLength = 2048;

export type TerminalOpenTarget = {
  label: string;
  target: HostOpenTarget;
};

/**
 * Returns the open target under the given buffer cell, from either an OSC 8
 * hyperlink, a plain-text URL, or a likely file reference.
 */
export function terminalTargetAt(
  terminal: Terminal,
  column: number,
  row: number,
  options: { cwd?: string | null } = {},
): TerminalOpenTarget | null {
  return terminalOscTargetAt(terminal, column, row, options.cwd ?? null)
    ?? terminalUrlTargetAt(terminal, column, row)
    ?? terminalFileTargetAt(terminal, column, row, options.cwd ?? null);
}

export function terminalOpenTargetFromHref(href: string, cwd: string | null): TerminalOpenTarget | null {
  const target = hostOpenTargetFromHref(href, {
    baseDirectory: cwd,
    parseLine: true,
  });
  return target ? terminalOpenTarget(target, href) : null;
}

type TerminalOscLinkInternals = {
  _core?: {
    _oscLinkService?: {
      getLinkData(linkId: number): { uri?: string } | undefined;
    };
  };
};

function terminalOscTargetAt(
  terminal: Terminal,
  column: number,
  row: number,
  cwd: string | null,
): TerminalOpenTarget | null {
  const cell = terminal.buffer.active.getLine(row)?.getCell(column);
  // OSC 8 metadata is not part of the public buffer API; read the pinned
  // xterm internals and fall back to plain-text URL detection when absent.
  const urlId = (cell as { extended?: { urlId?: number } } | undefined)?.extended?.urlId;
  if (!urlId) {
    return null;
  }

  const core = (terminal as unknown as TerminalOscLinkInternals)._core;
  const uri = core?._oscLinkService?.getLinkData(urlId)?.uri;
  return uri ? terminalOpenTargetFromHref(uri, cwd) : null;
}

function terminalUrlTargetAt(terminal: Terminal, column: number, row: number): TerminalOpenTarget | null {
  const hit = terminalJoinedLineHit(terminal, column, row);
  if (!hit) {
    return null;
  }

  const matcher = new RegExp(terminalUrlRegex.source, 'g');
  let match: RegExpExecArray | null;
  while ((match = matcher.exec(hit.text))) {
    if (match.index > hit.tapIndex) {
      break;
    }
    if (hit.tapIndex < match.index + match[0].length) {
      return terminalOpenTargetFromHref(match[0], null);
    }
  }

  return null;
}

function terminalFileTargetAt(
  terminal: Terminal,
  column: number,
  row: number,
  cwd: string | null,
): TerminalOpenTarget | null {
  const hit = terminalJoinedLineHit(terminal, column, row);
  if (!hit) {
    return null;
  }

  const candidate = terminalCandidateAt(hit.text, hit.tapIndex);
  if (!candidate) {
    return null;
  }

  const target = hostOpenTargetFromHref(candidate.text, {
    baseDirectory: cwd,
    parseLine: true,
    requireKnownFileExtension: true,
  });
  return target?.kind === 'file' ? terminalOpenTarget(target, candidate.text) : null;
}

function terminalJoinedLineHit(
  terminal: Terminal,
  column: number,
  row: number,
): { tapIndex: number; text: string } | null {
  const buffer = terminal.buffer.active;
  const line = buffer.getLine(row);
  if (!line) {
    return null;
  }

  const current = line.translateToString(true);
  const prefixLength = line.translateToString(false, 0, column).length;
  if (prefixLength > current.length) {
    // The tap landed in trimmed trailing whitespace, past any content.
    return null;
  }

  // Join the soft-wrapped rows around the tapped row the same way
  // WebLinksAddon windows its line strings, so matches can span wraps.
  const aboveStrings: string[] = [];
  if (line.isWrapped && current[0] !== ' ') {
    let scanRow = row;
    let scanned: IBufferLine | undefined;
    let length = 0;
    while ((scanned = buffer.getLine(--scanRow)) && length < maxJoinedLineLength) {
      const content = scanned.translateToString(true);
      length += content.length;
      aboveStrings.push(content);
      if (!scanned.isWrapped || content.includes(' ')) {
        break;
      }
    }
    aboveStrings.reverse();
  }

  const belowStrings: string[] = [];
  let scanRow = row;
  let scanned: IBufferLine | undefined;
  let length = 0;
  while ((scanned = buffer.getLine(++scanRow)) && scanned.isWrapped && length < maxJoinedLineLength) {
    const content = scanned.translateToString(true);
    length += content.length;
    belowStrings.push(content);
    if (content.includes(' ')) {
      break;
    }
  }

  const text = aboveStrings.join('') + current + belowStrings.join('');
  const tapIndex = aboveStrings.reduce((sum, content) => sum + content.length, 0) + prefixLength;
  return { tapIndex, text };
}

function terminalCandidateAt(text: string, tapIndex: number) {
  if (!text) {
    return null;
  }

  const index = Math.max(0, Math.min(tapIndex, text.length - 1));
  if (isTerminalTokenBoundary(text[index])) {
    return null;
  }

  let start = index;
  while (start > 0 && !isTerminalTokenBoundary(text[start - 1])) {
    start -= 1;
  }

  let end = index + 1;
  while (end < text.length && !isTerminalTokenBoundary(text[end])) {
    end += 1;
  }

  const raw = text.slice(start, end);
  const trimmed = trimTerminalCandidate(raw);
  if (!trimmed) {
    return null;
  }

  const trimmedStart = start + trimmed.startOffset;
  const trimmedEnd = start + trimmed.endOffset;
  if (tapIndex < trimmedStart || tapIndex >= trimmedEnd) {
    return null;
  }

  return { text: trimmed.text };
}

function trimTerminalCandidate(raw: string) {
  let start = 0;
  let end = raw.length;

  while (start < end && /[([{<]/u.test(raw[start])) {
    start += 1;
  }

  while (end > start && /[.,;!?)}\]>]/u.test(raw[end - 1])) {
    end -= 1;
  }

  while (end > start && raw[end - 1] === ':') {
    end -= 1;
  }

  const text = raw.slice(start, end);
  return text ? { endOffset: end, startOffset: start, text } : null;
}

function isTerminalTokenBoundary(char: string) {
  return /\s/u.test(char) || /["'`]/u.test(char);
}

function terminalOpenTarget(target: HostOpenTarget, rawLabel: string): TerminalOpenTarget {
  return {
    label: target.kind === 'file' && !/^file:/iu.test(rawLabel)
      ? rawLabel
      : hostOpenTargetText(target),
    target,
  };
}
