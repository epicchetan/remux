import type { IBufferLine, Terminal } from '@xterm/xterm';

// Characters that end a word for tap-to-select. Whitespace-adjacent runs stay
// whole so paths, URLs, and flags come out as one selection.
const wordSeparators = " \t'\"`(){}[]<>|;,";

// Selection points are cell boundaries: column ranges 0..cols (a column of
// `cols` sits after the last cell) and row is an absolute buffer row.
export type TerminalSelectionPoint = {
  column: number;
  row: number;
};

export type TerminalSelectionRange = {
  end: TerminalSelectionPoint;
  start: TerminalSelectionPoint;
};

// Maps a client coordinate to the nearest cell boundary, so drags select up to
// the character edge the pointer is closest to (caret-style selection).
export function terminalSelectionPoint(
  terminal: Terminal | null,
  container: HTMLElement | null,
  clientX: number,
  clientY: number,
): TerminalSelectionPoint | null {
  const metrics = terminalScreenMetrics(terminal, container);
  if (!terminal || !metrics) {
    return null;
  }

  const column = clampSelectionValue(
    Math.ceil((clientX - metrics.rect.left + metrics.cellWidth / 2) / metrics.cellWidth) - 1,
    0,
    terminal.cols,
  );
  const visibleRow = clampSelectionValue(
    Math.ceil((clientY - metrics.rect.top) / metrics.cellHeight) - 1,
    0,
    terminal.rows - 1,
  );

  return {
    column,
    row: terminal.buffer.active.viewportY + visibleRow,
  };
}

// Maps a client coordinate to the cell under the pointer (not the nearest
// boundary), for word snapping where the tapped character matters.
export function terminalSelectionCell(
  terminal: Terminal | null,
  container: HTMLElement | null,
  clientX: number,
  clientY: number,
): TerminalSelectionPoint | null {
  const metrics = terminalScreenMetrics(terminal, container);
  if (!terminal || !metrics) {
    return null;
  }

  const column = clampSelectionValue(
    Math.floor((clientX - metrics.rect.left) / metrics.cellWidth),
    0,
    terminal.cols - 1,
  );
  const visibleRow = clampSelectionValue(
    Math.floor((clientY - metrics.rect.top) / metrics.cellHeight),
    0,
    terminal.rows - 1,
  );

  return {
    column,
    row: terminal.buffer.active.viewportY + visibleRow,
  };
}

// Applies the selection between two boundary points (in either order) and
// returns the normalized range, always covering at least one cell.
export function applyTerminalSelectionRange(
  terminal: Terminal,
  anchor: TerminalSelectionPoint,
  focus: TerminalSelectionPoint,
): TerminalSelectionRange | null {
  const cols = terminal.cols;
  if (cols <= 0) {
    return null;
  }

  const bufferEnd = Math.max(1, terminal.buffer.active.length * cols);
  const anchorLinear = clampSelectionValue((anchor.row * cols) + anchor.column, 0, bufferEnd);
  const focusLinear = clampSelectionValue((focus.row * cols) + focus.column, 0, bufferEnd);
  const startLinear = Math.min(anchorLinear, focusLinear, bufferEnd - 1);
  const endLinear = Math.min(Math.max(anchorLinear, focusLinear, startLinear + 1), bufferEnd);

  terminal.select(startLinear % cols, Math.floor(startLinear / cols), endLinear - startLinear);

  return {
    start: { column: startLinear % cols, row: Math.floor(startLinear / cols) },
    // Keep the end boundary on the row of the last selected cell (column can be
    // `cols`) so the end handle renders beside that cell, not on the next row.
    end: endLinear % cols === 0
      ? { column: cols, row: (endLinear / cols) - 1 }
      : { column: endLinear % cols, row: Math.floor(endLinear / cols) },
  };
}

// Word range around a cell for tap-to-select; falls back to the single tapped
// cell when the tap lands on whitespace or a separator.
export function terminalWordRangeAt(
  terminal: Terminal,
  cell: TerminalSelectionPoint,
): TerminalSelectionRange {
  const buffer = terminal.buffer.active;
  const row = clampSelectionValue(cell.row, 0, Math.max(0, buffer.length - 1));
  const column = clampSelectionValue(cell.column, 0, Math.max(0, terminal.cols - 1));
  const line = buffer.getLine(row);
  const singleCell: TerminalSelectionRange = {
    end: { column: column + 1, row },
    start: { column, row },
  };
  if (!line) {
    return singleCell;
  }

  const isWordCell = (x: number) => {
    const bufferCell = line.getCell(x);
    if (!bufferCell) {
      return false;
    }
    if (bufferCell.getWidth() === 0) {
      // Zero-width cells trail wide characters; they belong to the glyph.
      return true;
    }

    const chars = bufferCell.getChars();
    return Boolean(chars) && chars !== ' ' && !wordSeparators.includes(chars);
  };

  if (!isWordCell(column)) {
    return singleCell;
  }

  let left = column;
  while (left > 0 && isWordCell(left - 1)) {
    left -= 1;
  }
  let right = column;
  while (right < terminal.cols - 1 && isWordCell(right + 1)) {
    right += 1;
  }

  return {
    end: { column: right + 1, row },
    start: { column: left, row },
  };
}

// Logical-line range around a cell for double-tap line selection: follows soft
// wraps in both directions and ends after the last non-blank cell, so the
// padded tail of the row stays out of both the highlight and the copied text.
// Returns null when the whole logical line is blank (nothing to select).
export function terminalLineRangeAt(
  terminal: Terminal,
  cell: TerminalSelectionPoint,
): TerminalSelectionRange | null {
  const buffer = terminal.buffer.active;
  if (terminal.cols <= 0 || buffer.length === 0) {
    return null;
  }

  const row = clampSelectionValue(cell.row, 0, buffer.length - 1);
  let startRow = row;
  while (startRow > 0 && buffer.getLine(startRow)?.isWrapped) {
    startRow -= 1;
  }
  let endRow = row;
  while (endRow + 1 < buffer.length && buffer.getLine(endRow + 1)?.isWrapped) {
    endRow += 1;
  }

  for (let y = endRow; y >= startRow; y -= 1) {
    const endColumn = lineContentEndColumn(terminal, buffer.getLine(y));
    if (endColumn !== null) {
      return {
        end: { column: endColumn, row: y },
        start: { column: 0, row: startRow },
      };
    }
  }

  return null;
}

// Boundary column just past the last non-blank cell, or null for a blank row.
function lineContentEndColumn(terminal: Terminal, line: IBufferLine | undefined) {
  if (!line) {
    return null;
  }

  for (let x = Math.min(terminal.cols, line.length) - 1; x >= 0; x -= 1) {
    const bufferCell = line.getCell(x);
    if (!bufferCell || bufferCell.getWidth() === 0) {
      // Zero-width cells trail wide characters; the wide cell decides.
      continue;
    }

    const chars = bufferCell.getChars();
    if (chars && chars !== ' ') {
      return Math.min(terminal.cols, x + Math.max(1, bufferCell.getWidth()));
    }
  }

  return null;
}

// Selections spanning full rows pick up the blank cells padding each row
// (TUIs pad to the terminal width); drop that trailing run from every line.
export function terminalSelectionCopyText(text: string) {
  return text
    .split('\n')
    .map((line) => line.replace(/\s+$/u, ''))
    .join('\n');
}

// Extracts buffer text for [startRow, endRowExclusive), joining wrapped rows
// back into logical lines and dropping trailing blank lines.
export function terminalBufferText(terminal: Terminal, startRow: number, endRowExclusive: number) {
  const buffer = terminal.buffer.active;
  const start = Math.max(0, Math.floor(startRow));
  const end = Math.min(Math.floor(endRowExclusive), buffer.length);
  const lines: string[] = [];
  let current = '';

  for (let y = start; y < end; y += 1) {
    const line = buffer.getLine(y);
    if (!line) {
      continue;
    }

    const nextWrapped = y + 1 < end ? (buffer.getLine(y + 1)?.isWrapped ?? false) : false;
    current += line.translateToString(!nextWrapped);
    if (!nextWrapped) {
      lines.push(current);
      current = '';
    }
  }

  if (current) {
    lines.push(current);
  }
  while (lines.length > 0 && lines[lines.length - 1]!.trim() === '') {
    lines.pop();
  }

  return lines.join('\n');
}

export function describeTerminalSelection(text: string) {
  const lines = text.split('\n').length;
  if (lines > 1) {
    return `${lines} lines selected`;
  }

  return `${text.length} ${text.length === 1 ? 'character' : 'characters'} selected`;
}

function terminalScreenMetrics(terminal: Terminal | null, container: HTMLElement | null) {
  if (!terminal || !container || terminal.cols <= 0 || terminal.rows <= 0) {
    return null;
  }

  const screen = container.querySelector('.xterm-screen') as HTMLElement | null;
  const rect = screen?.getBoundingClientRect();
  if (!rect || rect.width <= 0 || rect.height <= 0) {
    return null;
  }

  const cellWidth = rect.width / terminal.cols;
  const cellHeight = rect.height / terminal.rows;
  if (cellWidth <= 0 || cellHeight <= 0) {
    return null;
  }

  return { cellHeight, cellWidth, rect };
}

function clampSelectionValue(value: number, min: number, max: number) {
  if (!Number.isFinite(value)) {
    return min;
  }

  return Math.max(min, Math.min(max, Math.floor(value)));
}
