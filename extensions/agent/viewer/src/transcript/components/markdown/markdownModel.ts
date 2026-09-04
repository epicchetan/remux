import {
  layout,
  measureNaturalWidth,
  prepare,
  prepareWithSegments,
  type PreparedText,
} from '@chenglou/pretext';
import {
  materializeRichInlineLineRange,
  measureRichInlineStats,
  prepareRichInline,
  walkRichInlineLineRanges,
  type PreparedRichInline,
  type RichInlineItem,
} from '@chenglou/pretext/rich-inline';
import { fromMarkdown } from 'mdast-util-from-markdown';
import { gfmTableFromMarkdown } from 'mdast-util-gfm-table';
import { gfmTable } from 'micromark-extension-gfm-table';
import type { AlignType, BlockContent, DefinitionContent, PhrasingContent, RootContent } from 'mdast';

import { hostFileHrefInfoFromHref, webUrlFromHref } from '@remux/viewer-kit/links';
import {
  completeMarkdownCacheScope,
  type MarkdownCacheScope,
} from './markdownCache';

export type MarkdownDensity = 'default' | 'user' | 'work';

export type MarkdownRenderOptions = {
  cacheScope?: MarkdownCacheScope;
  preserveSoftBreaks?: boolean;
  richFileLinks?: boolean;
};

export type MarkdownInline =
  | {
      text: string;
      type: 'text';
    }
  | {
      children: MarkdownInline[];
      type: 'strong';
    }
  | {
      children: MarkdownInline[];
      type: 'emphasis';
    }
  | {
      text: string;
      type: 'code';
    }
  | {
      children: MarkdownInline[];
      href: string;
      type: 'link';
    }
  | {
      file: MarkdownFileLink;
      href: string;
      type: 'fileLink';
    };

export type MarkdownFileLink = {
  displayName: string;
  extension: string | null;
  fileName: string;
  line: number | null;
  path: string;
};

export type PreparedMarkdownInlineLine = {
  displayLength: number;
  inlines: MarkdownInline[];
  itemStarts: number[];
  itemTexts: string[];
  prepared: PreparedRichInline | null;
  sources: MarkdownInlineSource[];
};

export type PreparedMarkdownBlock =
  | {
      depth: 1 | 2 | 3;
      lines: PreparedMarkdownInlineLine[];
      renderId: string;
      type: 'heading';
    }
  | {
      lines: PreparedMarkdownInlineLine[];
      renderId: string;
      type: 'paragraph';
    }
  | {
      language: string | null;
      renderId: string;
      text: string;
      type: 'code';
    }
  | {
      children: PreparedMarkdownBlock[];
      renderId: string;
      type: 'blockquote';
    }
  | {
      items: PreparedMarkdownListItem[];
      renderId: string;
      ordered: boolean;
      start: number;
      type: 'list';
    }
  | {
      align: MarkdownTableAlignment[];
      renderId: string;
      rows: PreparedMarkdownTableRow[];
      type: 'table';
    }
  | {
      renderId: string;
      type: 'rule';
    };

export type PreparedMarkdownListItem = {
  blocks: PreparedMarkdownBlock[];
  marker: string;
};

export type MarkdownTableAlignment = Exclude<AlignType, undefined>;

export type PreparedMarkdownTableCell = {
  lines: PreparedMarkdownInlineLine[];
};

export type PreparedMarkdownTableRow = {
  cells: PreparedMarkdownTableCell[];
  header: boolean;
};

export type PreparedMarkdownDocument = {
  blocks: PreparedMarkdownBlock[];
  density: MarkdownDensity;
};

export type MarkdownInlineSource = {
  emphasis: boolean;
  file?: MarkdownFileLink;
  href: string | null;
  kind: 'text' | 'code' | 'fileLink';
  strong: boolean;
};

export type MarkdownLayoutLineFragment = {
  displayEnd: number;
  displayStart: number;
  gapBefore: number;
  source: MarkdownInlineSource;
  text: string;
};

export type MarkdownLayoutTextLine = {
  fragments: MarkdownLayoutLineFragment[];
  width: number;
};

export type MarkdownLayoutBlockBase = {
  contentHeight: number;
  height: number;
  renderId: string;
  topGap: number;
};

export type MarkdownLayoutBlock =
  | (MarkdownLayoutBlockBase & {
      lineHeight: number;
      lines: MarkdownLayoutTextLine[];
      type: 'paragraph';
    })
  | (MarkdownLayoutBlockBase & {
      depth: 1 | 2 | 3;
      lineHeight: number;
      lines: MarkdownLayoutTextLine[];
      type: 'heading';
    })
  | (MarkdownLayoutBlockBase & {
      language: string | null;
      lineHeight: number;
      lines: MarkdownCodeLayoutLine[];
      naturalOuterHeight: number;
      text: string;
      textHeight: number;
      type: 'code';
    })
  | (MarkdownLayoutBlockBase & {
      children: MarkdownLayoutBlock[];
      type: 'blockquote';
    })
  | (MarkdownLayoutBlockBase & {
      items: MarkdownLayoutListItem[];
      ordered: boolean;
      start: number;
      type: 'list';
    })
  | (MarkdownLayoutBlockBase & {
      columnWidths: number[];
      lineHeight: number;
      rows: MarkdownLayoutTableRow[];
      tableWidth: number;
      type: 'table';
    })
  | (MarkdownLayoutBlockBase & {
      type: 'rule';
    });

export type MarkdownCodeLayoutLine = {
  text: string;
};

export type MarkdownLayoutListItem = {
  blocks: MarkdownLayoutBlock[];
  contentHeight: number;
  height: number;
  marker: string;
  topGap: number;
};

export type MarkdownLayoutTableCell = {
  align: MarkdownTableAlignment;
  lines: MarkdownLayoutTextLine[];
};

export type MarkdownLayoutTableRow = {
  cells: MarkdownLayoutTableCell[];
  header: boolean;
  height: number;
  lineCount: number;
};

export type MarkdownLayoutDocument = {
  blocks: MarkdownLayoutBlock[];
  density: MarkdownDensity;
  height: number;
  width: number;
};

export type RawMarkdownBlock =
  | {
      depth: 1 | 2 | 3;
      lines: MarkdownInline[][];
      renderId: string;
      type: 'heading';
    }
  | {
      lines: MarkdownInline[][];
      renderId: string;
      type: 'paragraph';
    }
  | {
      language: string | null;
      renderId: string;
      text: string;
      type: 'code';
    }
  | {
      children: RawMarkdownBlock[];
      renderId: string;
      type: 'blockquote';
    }
  | {
      items: RawMarkdownListItem[];
      renderId: string;
      ordered: boolean;
      start: number;
      type: 'list';
    }
  | {
      align: MarkdownTableAlignment[];
      renderId: string;
      rows: RawMarkdownTableRow[];
      type: 'table';
    }
  | {
      renderId: string;
      type: 'rule';
    };

export type RawMarkdownListItem = {
  blocks: RawMarkdownBlock[];
  marker: string;
};

export type RawMarkdownTableRow = {
  cells: RawMarkdownTableCell[];
  header: boolean;
};

export type RawMarkdownTableCell = {
  lines: MarkdownInline[][];
};

type InlineMarks = {
  emphasis: boolean;
  linkHref: string | null;
  strong: boolean;
};

type MarkdownParseOptions = {
  cacheScope: MarkdownCacheScope;
  preserveSoftBreaks: boolean;
  richFileLinks: boolean;
};

type MarkdownInlineParseOptions = MarkdownParseOptions & {
  autolink: boolean;
};

export type InlineVariant = 'body' | 'heading1' | 'heading2' | 'heading3';

export const markdownMetrics = {
  blockGap: {
    default: 10,
    user: 10,
    work: 8,
  },
  blockquote: {
    borderWidth: 2,
    contentInset: 13,
  },
  code: {
    borderWidth: 1,
    capHeight: {
      default: 300,
      user: 300,
      work: 300,
    },
    fontSize: {
      default: 12,
      user: 12,
      work: 12,
    },
    lineHeight: {
      default: 18,
      user: 18,
      work: 18,
    },
    paddingX: 14,
    paddingY: 12,
  },
  fontFamily: {
    mono: 'ui-monospace, "SF Mono", "SFMono-Regular", Menlo, Consolas, "Liberation Mono", monospace',
    sans: '-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif',
  },
  heading: {
    default: {
      1: { fontSize: 16, lineHeight: 22 },
      2: { fontSize: 15, lineHeight: 21 },
      3: { fontSize: 14, lineHeight: 20 },
    },
    user: {
      1: { fontSize: 16, lineHeight: 22 },
      2: { fontSize: 15, lineHeight: 21 },
      3: { fontSize: 14, lineHeight: 20 },
    },
    work: {
      1: { fontSize: 16, lineHeight: 22 },
      2: { fontSize: 15, lineHeight: 21 },
      3: { fontSize: 14, lineHeight: 20 },
    },
  },
  inlineCode: {
    extraWidth: 8,
    fontSize: {
      default: 12,
      user: 12,
      work: 12,
    },
  },
  fileLink: {
    borderWidth: 1,
    height: 16,
    iconBaselineShift: 0,
    iconGap: 4,
    iconSize: 12,
    maxWidth: 280,
    paddingX: 4,
  },
  list: {
    itemGap: {
      default: 4,
      user: 4,
      work: 4,
    },
    markerGap: 8,
    markerWidth: 24,
  },
  paragraph: {
    fontSize: {
      default: 13,
      user: 13,
      work: 13,
    },
    lineHeight: {
      default: 18,
      user: 18,
      work: 18,
    },
  },
  ruleHeight: 17,
  table: {
    borderWidth: 1,
    cellPaddingX: 10,
    cellPaddingY: 7,
    maxColumnWidth: 320,
    minColumnWidth: 96,
  },
} as const;

const documentCache = new Map<string, PreparedMarkdownDocument>();
const rawDocumentCache = new Map<string, RawMarkdownBlock[]>();
const preparedTextCache = new Map<string, PreparedText>();
const layoutCache = new Map<string, MarkdownLayoutDocument>();
const streamingDocumentCache = new Map<string, { key: string; value: PreparedMarkdownDocument }>();
const streamingRawDocumentCache = new Map<string, { key: string; value: RawMarkdownBlock[] }>();
const streamingLayoutCache = new Map<string, { key: string; value: MarkdownLayoutDocument }>();
const maxDocumentCacheEntries = 300;
const maxRawDocumentCacheEntries = 300;
const maxPreparedTextCacheEntries = 1000;
const maxLayoutCacheEntries = 500;
const maxStreamingCacheScopes = 16;

const emptyMarks: InlineMarks = {
  emphasis: false,
  linkHref: null,
  strong: false,
};

export function getPreparedMarkdownDocument(
  markdown: string,
  density: MarkdownDensity = 'default',
  options: MarkdownRenderOptions = {},
) {
  const parseOptions = markdownParseOptions(options);
  const key = `${density}\0${markdownParseCacheKey(parseOptions)}\0${markdown}`;
  const cached = readScopedCache(
    documentCache,
    streamingDocumentCache,
    parseOptions.cacheScope,
    key,
  );
  if (cached) {
    return cached;
  }

  const rawBlocks = parseMarkdownBlocks(markdown, parseOptions);
  const prepared: PreparedMarkdownDocument = {
    blocks: rawBlocks.map((block) => prepareMarkdownBlock(block, density)),
    density,
  };

  writeScopedCache(
    documentCache,
    streamingDocumentCache,
    parseOptions.cacheScope,
    key,
    prepared,
    maxDocumentCacheEntries,
  );
  return prepared;
}

export function parseMarkdownDocument(markdown: string, options: MarkdownRenderOptions = {}) {
  return parseMarkdownBlocks(markdown, markdownParseOptions(options));
}

export function releaseStreamingMarkdownCaches(scopeKey: string) {
  streamingDocumentCache.delete(scopeKey);
  streamingRawDocumentCache.delete(scopeKey);
  streamingLayoutCache.delete(scopeKey);
}

export function getMarkdownLayoutDocument(
  markdown: string,
  density: MarkdownDensity,
  width: number,
  options: MarkdownRenderOptions = {},
) {
  const parseOptions = markdownParseOptions(options);
  const safeWidth = Math.max(1, width);
  const roundedWidth = Math.round(safeWidth * 100) / 100;
  const key = `${density}\0${markdownParseCacheKey(parseOptions)}\0${roundedWidth}\0${markdown}`;
  const cached = readScopedCache(
    layoutCache,
    streamingLayoutCache,
    parseOptions.cacheScope,
    key,
  );
  if (cached) {
    return cached;
  }

  const document = getPreparedMarkdownDocument(markdown, density, parseOptions);
  const laidOutBlocks = layoutPreparedMarkdownBlocks(document.blocks, density, roundedWidth);
  const laidOut: MarkdownLayoutDocument = {
    blocks: laidOutBlocks.blocks,
    density,
    height: laidOutBlocks.height,
    width: roundedWidth,
  };

  writeScopedCache(
    layoutCache,
    streamingLayoutCache,
    parseOptions.cacheScope,
    key,
    laidOut,
    maxLayoutCacheEntries,
  );
  return laidOut;
}

export function measureMarkdownDocumentHeight(
  markdown: string,
  density: MarkdownDensity,
  width: number,
  options: MarkdownRenderOptions = {},
) {
  return getMarkdownLayoutDocument(markdown, density, width, options).height;
}

export function measureMarkdownDocumentCappedHeight(
  markdown: string,
  density: MarkdownDensity,
  width: number,
  maxLines: number,
  options: MarkdownRenderOptions = {},
) {
  return cappedMarkdownLayoutDocumentHeight(getMarkdownLayoutDocument(markdown, density, width, options), maxLines);
}

export function cappedMarkdownLayoutDocumentHeight(document: MarkdownLayoutDocument, maxLines: number) {
  if (maxLines <= 0 || document.height <= 0) {
    return 0;
  }

  const capped = cappedMarkdownBlocksHeight(document.blocks, maxLines);
  return Math.min(document.height, capped.height);
}

export function measurePreparedMarkdownBlocks(blocks: PreparedMarkdownBlock[], density: MarkdownDensity, width: number) {
  return layoutPreparedMarkdownBlocks(blocks, density, width).height;
}

export function measurePreparedMarkdownBlock(block: PreparedMarkdownBlock, density: MarkdownDensity, width: number): number {
  return layoutPreparedMarkdownBlock(block, density, width, 0).height;
}

function layoutPreparedMarkdownBlocks(blocks: PreparedMarkdownBlock[], density: MarkdownDensity, width: number) {
  const laidOutBlocks: MarkdownLayoutBlock[] = [];
  let height = 0;

  for (let index = 0; index < blocks.length; index += 1) {
    const topGap = index > 0 ? markdownMetrics.blockGap[density] : 0;
    const block = layoutPreparedMarkdownBlock(blocks[index], density, width, topGap);
    laidOutBlocks.push(block);
    height += block.height;
  }

  return {
    blocks: laidOutBlocks,
    height,
  };
}

function layoutPreparedMarkdownBlock(
  block: PreparedMarkdownBlock,
  density: MarkdownDensity,
  width: number,
  topGap: number,
): MarkdownLayoutBlock {
  const safeWidth = Math.max(1, width);

  switch (block.type) {
    case 'paragraph': {
      const lineHeight = markdownMetrics.paragraph.lineHeight[density];
      const lines = layoutInlineLines(block.lines, safeWidth);
      const contentHeight = lines.length * lineHeight;

      return {
        contentHeight,
        height: topGap + contentHeight,
        lineHeight,
        lines,
        renderId: block.renderId,
        topGap,
        type: 'paragraph',
      };
    }
    case 'heading': {
      const metrics = markdownMetrics.heading[density][block.depth];
      const lines = layoutInlineLines(block.lines, safeWidth);
      const contentHeight = lines.length * metrics.lineHeight;

      return {
        contentHeight,
        depth: block.depth,
        height: topGap + contentHeight,
        lineHeight: metrics.lineHeight,
        lines,
        renderId: block.renderId,
        topGap,
        type: 'heading',
      };
    }
    case 'code': {
      const lineHeight = markdownMetrics.code.lineHeight[density];
      const lines = logicalCodeLines(block.text);
      const textHeight = Math.max(1, lines.length) * lineHeight;
      const naturalOuterHeight =
        textHeight + markdownMetrics.code.paddingY * 2 + markdownMetrics.code.borderWidth * 2;
      const contentHeight = Math.min(naturalOuterHeight, markdownMetrics.code.capHeight[density]);

      return {
        contentHeight,
        height: topGap + contentHeight,
        language: block.language,
        lineHeight,
        lines,
        naturalOuterHeight,
        renderId: block.renderId,
        text: block.text,
        textHeight,
        topGap,
        type: 'code',
      };
    }
    case 'blockquote': {
      const innerWidth = Math.max(
        1,
        safeWidth - markdownMetrics.blockquote.borderWidth - markdownMetrics.blockquote.contentInset,
      );
      const children = layoutPreparedMarkdownBlocks(block.children, density, innerWidth);

      return {
        children: children.blocks,
        contentHeight: children.height,
        height: topGap + children.height,
        renderId: block.renderId,
        topGap,
        type: 'blockquote',
      };
    }
    case 'list': {
      const contentWidth = Math.max(
        1,
        safeWidth - markdownMetrics.list.markerWidth - markdownMetrics.list.markerGap,
      );
      let contentHeight = 0;
      const items = block.items.map((item, index): MarkdownLayoutListItem => {
        const itemTopGap = index > 0 ? markdownMetrics.list.itemGap[density] : 0;
        const laidOut = layoutPreparedMarkdownBlocks(item.blocks, density, contentWidth);
        const height = itemTopGap + laidOut.height;
        contentHeight += height;

        return {
          blocks: laidOut.blocks,
          contentHeight: laidOut.height,
          height,
          marker: item.marker,
          topGap: itemTopGap,
        };
      });

      return {
        contentHeight,
        height: topGap + contentHeight,
        items,
        renderId: block.renderId,
        ordered: block.ordered,
        start: block.start,
        topGap,
        type: 'list',
      };
    }
    case 'table':
      return layoutPreparedMarkdownTable(block, density, safeWidth, topGap);
    case 'rule':
      return {
        contentHeight: markdownMetrics.ruleHeight,
        height: topGap + markdownMetrics.ruleHeight,
        renderId: block.renderId,
        topGap,
        type: 'rule',
      };
  }
}

function layoutPreparedMarkdownTable(
  block: Extract<PreparedMarkdownBlock, { type: 'table' }>,
  density: MarkdownDensity,
  width: number,
  topGap: number,
): Extract<MarkdownLayoutBlock, { type: 'table' }> {
  const borderWidth = markdownMetrics.table.borderWidth;
  const columnCount = Math.max(block.align.length, ...block.rows.map((row) => row.cells.length), 0);
  if (columnCount === 0) {
    return {
      columnWidths: [],
      contentHeight: 0,
      height: topGap,
      lineHeight: markdownMetrics.paragraph.lineHeight[density],
      renderId: block.renderId,
      rows: [],
      tableWidth: 0,
      topGap,
      type: 'table',
    };
  }

  const availableInnerWidth = Math.max(1, width - borderWidth * 2);
  const preferredColumnWidths: number[] = Array.from(
    { length: columnCount },
    () => markdownMetrics.table.minColumnWidth,
  );
  for (const row of block.rows) {
    for (let columnIndex = 0; columnIndex < columnCount; columnIndex += 1) {
      const cell = row.cells[columnIndex];
      const naturalWidth = cell ? preparedInlineLinesNaturalWidth(cell.lines) : 0;
      preferredColumnWidths[columnIndex] = Math.max(
        preferredColumnWidths[columnIndex],
        Math.min(
          markdownMetrics.table.maxColumnWidth,
          naturalWidth + markdownMetrics.table.cellPaddingX * 2 +
            (columnIndex < columnCount - 1 ? borderWidth : 0),
        ),
      );
    }
  }

  const columnWidths = fitTableColumnWidths(preferredColumnWidths, availableInnerWidth);
  const lineHeight = markdownMetrics.paragraph.lineHeight[density];
  const rows = block.rows.map((row, rowIndex): MarkdownLayoutTableRow => {
    let lineCount = 1;
    const cells = Array.from({ length: columnCount }, (_, columnIndex): MarkdownLayoutTableCell => {
      const innerWidth = Math.max(
        1,
        columnWidths[columnIndex] - markdownMetrics.table.cellPaddingX * 2 -
          (columnIndex < columnCount - 1 ? borderWidth : 0),
      );
      const lines = layoutInlineLines(row.cells[columnIndex]?.lines ?? [], innerWidth);
      lineCount = Math.max(lineCount, lines.length);
      return {
        align: block.align[columnIndex] ?? null,
        lines,
      };
    });
    const rowBorderHeight = rowIndex < block.rows.length - 1 ? borderWidth : 0;

    return {
      cells,
      header: row.header,
      height: lineCount * lineHeight + markdownMetrics.table.cellPaddingY * 2 + rowBorderHeight,
      lineCount,
    };
  });
  const contentHeight = rows.length > 0
    ? borderWidth * 2 + rows.reduce((total, row) => total + row.height, 0)
    : 0;
  const tableWidth = columnWidths.reduce((total, columnWidth) => total + columnWidth, 0) + borderWidth * 2;

  return {
    columnWidths,
    contentHeight,
    height: topGap + contentHeight,
    lineHeight,
    renderId: block.renderId,
    rows,
    tableWidth,
    topGap,
    type: 'table',
  };
}

function preparedInlineLinesNaturalWidth(lines: PreparedMarkdownInlineLine[]) {
  let width = 0;
  for (const line of lines) {
    if (line.prepared) {
      width = Math.max(width, measureRichInlineStats(line.prepared, Number.POSITIVE_INFINITY).maxLineWidth);
    }
  }
  return width;
}

function fitTableColumnWidths(preferredWidths: number[], availableWidth: number) {
  const minimumWidth = markdownMetrics.table.minColumnWidth;
  const minimumTotal = minimumWidth * preferredWidths.length;
  if (minimumTotal >= availableWidth) {
    return preferredWidths.map(() => minimumWidth);
  }

  const preferredTotal = preferredWidths.reduce((total, columnWidth) => total + columnWidth, 0);
  if (preferredTotal > availableWidth) {
    const flexibleTotal = preferredTotal - minimumTotal;
    const availableFlexibleWidth = availableWidth - minimumTotal;
    return preferredWidths.map((preferredWidth) =>
      minimumWidth + (preferredWidth - minimumWidth) / flexibleTotal * availableFlexibleWidth
    );
  }

  const extraWidth = availableWidth - preferredTotal;
  return preferredWidths.map((preferredWidth) =>
    preferredWidth + extraWidth * preferredWidth / preferredTotal
  );
}

function cappedMarkdownBlocksHeight(blocks: MarkdownLayoutBlock[], maxLines: number) {
  let height = 0;
  let remainingLines = maxLines;

  for (const block of blocks) {
    if (remainingLines <= 0) {
      break;
    }

    const capped = cappedMarkdownBlockHeight(block, remainingLines);
    height += capped.height;
    remainingLines = capped.remainingLines;
  }

  return { height, remainingLines };
}

function cappedMarkdownBlockHeight(block: MarkdownLayoutBlock, remainingLines: number) {
  if (remainingLines <= 0) {
    return { height: 0, remainingLines };
  }

  switch (block.type) {
    case 'paragraph':
    case 'heading': {
      const lineCount = Math.max(1, block.lines.length);
      const visibleLines = Math.min(lineCount, remainingLines);
      return {
        height: block.topGap + visibleLines * block.lineHeight,
        remainingLines: remainingLines - visibleLines,
      };
    }
    case 'code': {
      const lineCount = Math.max(1, block.lines.length);
      const visibleLines = Math.min(lineCount, remainingLines);
      const chromeHeight = markdownMetrics.code.paddingY * 2 + markdownMetrics.code.borderWidth * 2;
      return {
        height: block.topGap + Math.min(block.contentHeight, chromeHeight + visibleLines * block.lineHeight),
        remainingLines: remainingLines - visibleLines,
      };
    }
    case 'blockquote': {
      const capped = cappedMarkdownBlocksHeight(block.children, remainingLines);
      return {
        height: block.topGap + capped.height,
        remainingLines: capped.remainingLines,
      };
    }
    case 'list': {
      let height = block.topGap;
      let nextRemainingLines = remainingLines;
      for (const item of block.items) {
        if (nextRemainingLines <= 0) {
          break;
        }
        const capped = cappedMarkdownBlocksHeight(item.blocks, nextRemainingLines);
        height += item.topGap + capped.height;
        nextRemainingLines = capped.remainingLines;
      }
      return {
        height,
        remainingLines: nextRemainingLines,
      };
    }
    case 'table': {
      let height = block.topGap + markdownMetrics.table.borderWidth;
      let nextRemainingLines = remainingLines;
      let completedRows = 0;
      for (const row of block.rows) {
        if (nextRemainingLines <= 0) {
          break;
        }
        const visibleLines = Math.min(row.lineCount, nextRemainingLines);
        nextRemainingLines -= visibleLines;
        if (visibleLines < row.lineCount) {
          height += markdownMetrics.table.cellPaddingY + visibleLines * block.lineHeight;
          return { height, remainingLines: nextRemainingLines };
        }
        height += row.height;
        completedRows += 1;
      }
      if (completedRows === block.rows.length) {
        height += markdownMetrics.table.borderWidth;
      }
      return {
        height,
        remainingLines: nextRemainingLines,
      };
    }
    case 'rule':
      return {
        height: block.topGap + block.contentHeight,
        remainingLines: remainingLines - 1,
      };
  }
}

function layoutInlineLines(lines: PreparedMarkdownInlineLine[], width: number) {
  const laidOutLines: MarkdownLayoutTextLine[] = [];
  let logicalLineStart = 0;

  for (const line of lines) {
    if (!line.prepared) {
      laidOutLines.push({
        fragments: [],
        width: 0,
      });
      logicalLineStart += line.displayLength + 1;
      continue;
    }

    let emitted = false;
    const itemSourceCursors = line.itemStarts.map(() => 0);
    walkRichInlineLineRanges(line.prepared, Math.max(1, width), (range) => {
      const materialized = materializeRichInlineLineRange(line.prepared!, range);
      emitted = true;
      laidOutLines.push({
        fragments: materialized.fragments.map((fragment) => {
          const itemIndex = fragment.itemIndex;
          const itemText = line.itemTexts[itemIndex] ?? '';
          const sourceCursor = itemSourceCursors[itemIndex] ?? 0;
          const locatedStart = itemText.indexOf(fragment.text, sourceCursor);
          const fragmentStart = locatedStart >= sourceCursor ? locatedStart : sourceCursor;
          const displayStart = logicalLineStart + (line.itemStarts[itemIndex] ?? 0) + fragmentStart;
          itemSourceCursors[itemIndex] = fragmentStart + fragment.text.length;
          return {
            displayEnd: displayStart + fragment.text.length,
            displayStart,
            gapBefore: fragment.gapBefore,
            source: line.sources[itemIndex] ?? fallbackInlineSource,
            text: fragment.text,
          };
        }),
        width: materialized.width,
      });
    });

    if (!emitted) {
      laidOutLines.push({
        fragments: [],
        width: 0,
      });
    }
    logicalLineStart += line.displayLength + 1;
  }

  return laidOutLines;
}

function logicalCodeLines(text: string): MarkdownCodeLayoutLine[] {
  const sourceLines = text.length > 0 ? text.split('\n') : [''];
  return sourceLines.map((line) => ({ text: line }));
}

const fallbackInlineSource: MarkdownInlineSource = {
  emphasis: false,
  href: null,
  kind: 'text',
  strong: false,
};

export function preparePlainText(text: string, font: string, options?: { whiteSpace?: 'normal' | 'pre-wrap' }) {
  const key = `${font}\0${options?.whiteSpace ?? 'normal'}\0${text}`;
  const cached = preparedTextCache.get(key);
  if (cached) {
    return cached;
  }

  const prepared = prepare(text, font, options);
  remember(preparedTextCache, key, prepared, maxPreparedTextCacheEntries);
  return prepared;
}

export function measurePlainTextHeight({
  capHeight = Number.POSITIVE_INFINITY,
  font,
  lineHeight,
  text,
  whiteSpace = 'normal',
  width,
}: {
  capHeight?: number;
  font: string;
  lineHeight: number;
  text: string;
  whiteSpace?: 'normal' | 'pre-wrap';
  width: number;
}) {
  if (!text) {
    return 0;
  }

  const prepared = preparePlainText(text, font, { whiteSpace });
  const { lineCount } = layout(prepared, Math.max(1, width), lineHeight);
  return Math.min(Math.max(1, lineCount) * lineHeight, capHeight);
}

export function fontForPlainText({
  density,
  family = 'sans',
  italic = false,
  strong = false,
  variant = 'body',
}: {
  density: MarkdownDensity;
  family?: keyof typeof markdownMetrics.fontFamily;
  italic?: boolean;
  strong?: boolean;
  variant?: InlineVariant;
}) {
  const style = italic ? 'italic ' : '';
  const weight = strong ? 700 : family === 'mono' ? 500 : 400;
  const size = fontSizeForVariant(density, variant, family);
  return `${style}${weight} ${size}px ${markdownMetrics.fontFamily[family]}`;
}

function prepareMarkdownBlock(block: RawMarkdownBlock, density: MarkdownDensity): PreparedMarkdownBlock {
  switch (block.type) {
    case 'paragraph':
      return {
        lines: block.lines.map((line) => prepareInlineLine(line, density, 'body')),
        renderId: block.renderId,
        type: 'paragraph',
      };
    case 'heading':
      return {
        depth: block.depth,
        lines: block.lines.map((line) => prepareInlineLine(line, density, headingVariant(block.depth))),
        renderId: block.renderId,
        type: 'heading',
      };
    case 'code':
      return {
        language: block.language,
        renderId: block.renderId,
        text: stripSingleTrailingNewline(block.text),
        type: 'code',
      };
    case 'blockquote':
      return {
        children: block.children.map((child) => prepareMarkdownBlock(child, density)),
        renderId: block.renderId,
        type: 'blockquote',
      };
    case 'list':
      return {
        items: block.items.map((item) => ({
          blocks: item.blocks.map((child) => prepareMarkdownBlock(child, density)),
          marker: item.marker,
        })),
        renderId: block.renderId,
        ordered: block.ordered,
        start: block.start,
        type: 'list',
      };
    case 'table':
      return {
        align: block.align,
        renderId: block.renderId,
        rows: block.rows.map((row) => ({
          cells: row.cells.map((cell) => ({
            lines: cell.lines.map((line) => prepareInlineLine(
              line,
              density,
              'body',
              row.header ? { ...emptyMarks, strong: true } : emptyMarks,
            )),
          })),
          header: row.header,
        })),
        type: 'table',
      };
    case 'rule':
      return { renderId: block.renderId, type: 'rule' };
  }
}

function prepareInlineLine(
  inlines: MarkdownInline[],
  density: MarkdownDensity,
  variant: InlineVariant,
  initialMarks: InlineMarks = emptyMarks,
): PreparedMarkdownInlineLine {
  const { items, sources } = inlineRichItems(inlines, density, variant, initialMarks);
  const itemStarts: number[] = [];
  let displayLength = 0;
  for (const item of items) {
    itemStarts.push(displayLength);
    displayLength += item.text.length;
  }

  return {
    displayLength,
    inlines,
    itemStarts,
    itemTexts: items.map((item) => item.text),
    prepared: items.length > 0 ? prepareRichInline(items) : null,
    sources,
  };
}

function inlineRichItems(
  inlines: MarkdownInline[],
  density: MarkdownDensity,
  variant: InlineVariant,
  initialMarks: InlineMarks = emptyMarks,
) {
  const items: RichInlineItem[] = [];
  const sources: MarkdownInlineSource[] = [];

  const walk = (children: MarkdownInline[], marks: InlineMarks, pendingExtraWidth = 0): number => {
    let extraWidth = pendingExtraWidth;

    for (const child of children) {
      switch (child.type) {
        case 'text':
          if (child.text) {
            items.push({
              ...(extraWidth > 0 ? { extraWidth } : null),
              font: fontForInlineText(density, variant, marks),
              text: child.text,
            });
            sources.push(sourceFromMarks('text', marks));
            extraWidth = 0;
          }
          break;
        case 'strong':
          extraWidth = walk(child.children, { ...marks, strong: true }, extraWidth);
          break;
        case 'emphasis':
          extraWidth = walk(child.children, { ...marks, emphasis: true }, extraWidth);
          break;
        case 'code':
          if (child.text) {
            items.push({
              break: 'normal',
              extraWidth: markdownMetrics.inlineCode.extraWidth + extraWidth,
              font: fontForPlainText({ density, family: 'mono' }),
              text: child.text,
            });
            sources.push(sourceFromMarks('code', marks));
            extraWidth = 0;
          }
          break;
        case 'link':
          extraWidth = walk(child.children, { ...marks, linkHref: child.href }, extraWidth);
          break;
        case 'fileLink': {
          const font = fontForInlineText(density, variant, { ...marks, linkHref: child.href });
          const chromeWidth =
            markdownMetrics.fileLink.iconSize +
            markdownMetrics.fileLink.iconGap +
            markdownMetrics.fileLink.paddingX * 2 +
            markdownMetrics.fileLink.borderWidth * 2 +
            extraWidth;
          const textWidth = measureNaturalWidth(prepareWithSegments(child.file.displayName, font));
          const occupiedWidth = Math.min(
            textWidth + chromeWidth,
            markdownMetrics.fileLink.maxWidth,
          );
          items.push({
            break: 'never',
            // PreText keeps the full label for measurement and highlighting, while
            // this adjustment gives its atomic box the same capped width as the
            // rendered, ellipsized file chip.
            extraWidth: occupiedWidth - textWidth,
            font,
            text: child.file.displayName,
          });
          sources.push({
            emphasis: marks.emphasis,
            file: child.file,
            href: child.href,
            kind: 'fileLink',
            strong: marks.strong,
          });
          extraWidth = 0;
          break;
        }
      }
    }

    return extraWidth;
  };

  walk(inlines, initialMarks);
  return { items, sources };
}

function sourceFromMarks(kind: 'text' | 'code', marks: InlineMarks): MarkdownInlineSource {
  if (kind === 'code') {
    return {
      emphasis: false,
      href: marks.linkHref,
      kind,
      strong: false,
    };
  }

  return {
    emphasis: marks.emphasis,
    href: marks.linkHref,
    kind,
    strong: marks.strong,
  };
}

function fontForInlineText(density: MarkdownDensity, variant: InlineVariant, marks: InlineMarks) {
  const style = marks.emphasis ? 'italic ' : '';
  const weight = inlineWeight(variant, marks);
  const size = fontSizeForVariant(density, variant, 'sans');
  return `${style}${weight} ${size}px ${markdownMetrics.fontFamily.sans}`;
}

function inlineWeight(variant: InlineVariant, marks: InlineMarks) {
  if (variant === 'heading1' || variant === 'heading2' || variant === 'heading3') {
    return 700;
  }

  if (marks.strong) {
    return 700;
  }

  if (marks.linkHref) {
    return 500;
  }

  return 400;
}

function fontSizeForVariant(density: MarkdownDensity, variant: InlineVariant, family: keyof typeof markdownMetrics.fontFamily) {
  if (family === 'mono') {
    return markdownMetrics.code.fontSize[density];
  }

  switch (variant) {
    case 'heading1':
      return markdownMetrics.heading[density][1].fontSize;
    case 'heading2':
      return markdownMetrics.heading[density][2].fontSize;
    case 'heading3':
      return markdownMetrics.heading[density][3].fontSize;
    case 'body':
      return markdownMetrics.paragraph.fontSize[density];
  }
}

function headingVariant(depth: 1 | 2 | 3): InlineVariant {
  switch (depth) {
    case 1:
      return 'heading1';
    case 2:
      return 'heading2';
    case 3:
      return 'heading3';
  }
}

function markdownParseOptions(options: MarkdownRenderOptions = {}): MarkdownParseOptions {
  return {
    cacheScope: options.cacheScope ?? completeMarkdownCacheScope,
    preserveSoftBreaks: options.preserveSoftBreaks ?? false,
    richFileLinks: options.richFileLinks ?? true,
  };
}

function markdownParseCacheKey(options: MarkdownParseOptions) {
  return [
    options.richFileLinks ? 'richFiles' : 'plainFiles',
    options.preserveSoftBreaks ? 'preserveSoftBreaks' : 'collapseSoftBreaks',
  ].join(':');
}

function parseMarkdownBlocks(markdown: string, options: MarkdownParseOptions): RawMarkdownBlock[] {
  const key = `${markdownParseCacheKey(options)}\0${markdown}`;
  const cached = readScopedCache(
    rawDocumentCache,
    streamingRawDocumentCache,
    options.cacheScope,
    key,
  );
  if (cached) return cached;
  const blocks = rootContentToRawBlocks(fromMarkdown(markdown, {
    extensions: [gfmTable()],
    mdastExtensions: [gfmTableFromMarkdown()],
  }).children, options);
  assignRenderIds(blocks, '');
  writeScopedCache(
    rawDocumentCache,
    streamingRawDocumentCache,
    options.cacheScope,
    key,
    blocks,
    maxRawDocumentCacheEntries,
  );
  return blocks;
}

function assignRenderIds(blocks: RawMarkdownBlock[], parentPath: string) {
  blocks.forEach((block, blockIndex) => {
    const path = parentPath ? `${parentPath}/${blockIndex}` : String(blockIndex);
    block.renderId = `md:${path}`;
    if (block.type === 'blockquote') {
      assignRenderIds(block.children, `${path}/blockquote`);
    } else if (block.type === 'list') {
      block.items.forEach((item, itemIndex) => {
        assignRenderIds(item.blocks, `${path}/list/${itemIndex}`);
      });
    }
  });
}

function sanitizeHref(href: string) {
  if (fileLinkFromHref(href)) {
    return href;
  }

  return webUrlFromHref(href);
}

function rootContentToRawBlocks(nodes: readonly RootContent[], options: MarkdownParseOptions): RawMarkdownBlock[] {
  return nodes.flatMap((node) => {
    return isBlockContent(node) ? blockContentToRawBlock(node, options) : [];
  });
}

function blockContentToRawBlocks(
  nodes: readonly (BlockContent | DefinitionContent)[],
  options: MarkdownParseOptions,
): RawMarkdownBlock[] {
  return nodes.flatMap((node) => {
    return isBlockContent(node) ? blockContentToRawBlock(node, options) : [];
  });
}

function isBlockContent(node: RootContent | BlockContent | DefinitionContent): node is BlockContent {
  switch (node.type) {
    case 'blockquote':
    case 'code':
    case 'heading':
    case 'html':
    case 'list':
    case 'paragraph':
    case 'table':
    case 'thematicBreak':
      return true;
    default:
      return false;
  }
}

function blockContentToRawBlock(node: BlockContent, options: MarkdownParseOptions): RawMarkdownBlock[] {
  switch (node.type) {
    case 'paragraph':
      return [
        {
          lines: phrasingToInlineLines(node.children, options),
          renderId: '',
          type: 'paragraph',
        },
      ];
    case 'heading':
      return [
        {
          depth: Math.min(node.depth, 3) as 1 | 2 | 3,
          lines: phrasingToInlineLines(node.children, options),
          renderId: '',
          type: 'heading',
        },
      ];
    case 'code':
      return [
        {
          language: node.lang?.trim() || null,
          renderId: '',
          text: node.value,
          type: 'code',
        },
      ];
    case 'blockquote':
      return [
        {
          children: blockContentToRawBlocks(node.children, options),
          renderId: '',
          type: 'blockquote',
        },
      ];
    case 'list': {
      const ordered = Boolean(node.ordered);
      const start = ordered ? node.start ?? 1 : 1;
      return [
        {
          items: node.children.map((item, index) => ({
            blocks: blockContentToRawBlocks(item.children, options),
            marker: ordered ? `${start + index}.` : '•',
          })),
          renderId: '',
          ordered,
          start,
          type: 'list',
        },
      ];
    }
    case 'thematicBreak':
      return [{ renderId: '', type: 'rule' }];
    case 'html':
      return textToParagraphBlocks(node.value);
    case 'table':
      return [
        {
          align: (node.align ?? []).map((alignment) => alignment ?? null),
          renderId: '',
          rows: node.children.map((row, rowIndex) => ({
            cells: row.children.map((cell) => ({
              lines: phrasingToInlineLines(cell.children, options),
            })),
            header: rowIndex === 0,
          })),
          type: 'table',
        },
      ];
    default:
      return [];
  }
}

function textToParagraphBlocks(text: string): RawMarkdownBlock[] {
  return text.trim()
    ? [
        {
          lines: [[{ text, type: 'text' }]],
          renderId: '',
          type: 'paragraph',
        },
      ]
    : [];
}

function phrasingToInlineLines(
  nodes: readonly PhrasingContent[],
  options: MarkdownRenderOptions & { autolink?: boolean } = {},
): MarkdownInline[][] {
  const lines: MarkdownInline[][] = [[]];
  const inlineOptions: MarkdownInlineParseOptions = {
    autolink: options.autolink ?? true,
    preserveSoftBreaks: options.preserveSoftBreaks ?? false,
    richFileLinks: options.richFileLinks ?? true,
  };

  for (const node of nodes) {
    appendPhrasingNode(lines, node, inlineOptions);
  }

  return lines.map(mergeAdjacentText);
}

function appendPhrasingNode(lines: MarkdownInline[][], node: PhrasingContent, options: MarkdownInlineParseOptions) {
  switch (node.type) {
    case 'text':
      appendInlineText(lines, node.value, options.autolink, options.preserveSoftBreaks);
      return;
    case 'inlineCode':
      appendInline(lines, {
        text: node.value.replace(/\s+/g, ' '),
        type: 'code',
      });
      return;
    case 'break':
      lines.push([]);
      return;
    case 'emphasis':
      appendWrappedInlineLines(lines, phrasingToInlineLines(node.children, options), (children) => ({
        children,
        type: 'emphasis',
      }));
      return;
    case 'strong':
      appendWrappedInlineLines(lines, phrasingToInlineLines(node.children, options), (children) => ({
        children,
        type: 'strong',
      }));
      return;
    case 'link': {
      const href = sanitizeHref(node.url);
      if (href) {
        const label = phrasingNodesText(node.children);
        const file = options.richFileLinks ? fileLinkFromHref(href, label) : null;
        if (file) {
          appendInline(lines, {
            file,
            href,
            type: 'fileLink',
          });
        } else {
          appendWrappedInlineLines(lines, phrasingToInlineLines(node.children, {
            ...options,
            autolink: false,
          }), (children) => ({
            children,
            href,
            type: 'link',
          }));
        }
      } else {
        appendInlineText(lines, markdownTextFromNode(node), options.autolink, options.preserveSoftBreaks);
      }
      return;
    }
    case 'linkReference':
    case 'delete':
      appendInlineLines(lines, phrasingToInlineLines(node.children, options));
      return;
    case 'image':
      appendInlineText(lines, node.alt || node.url, options.autolink, options.preserveSoftBreaks);
      return;
    case 'imageReference':
      appendInlineText(
        lines,
        node.alt || node.label || node.identifier,
        options.autolink,
        options.preserveSoftBreaks,
      );
      return;
    case 'html':
      appendInlineText(lines, node.value, options.autolink, options.preserveSoftBreaks);
      return;
    case 'footnoteReference':
      appendInlineText(
        lines,
        `[^${node.label ?? node.identifier}]`,
        options.autolink,
        options.preserveSoftBreaks,
      );
      return;
  }
}

function appendInlineText(
  lines: MarkdownInline[][],
  text: string,
  autolink = true,
  preserveSoftBreaks = false,
) {
  const logicalLines = preserveSoftBreaks ? text.split(/\r\n?|\n/g) : [text];
  logicalLines.forEach((logicalLine, index) => {
    if (index > 0) lines.push([]);
    const normalized = logicalLine.replace(/\s+/g, ' ');
    if (normalized) {
      for (const inline of textToInlines(normalized, autolink)) {
        appendInline(lines, inline);
      }
    }
  });
}

function textToInlines(text: string, autolink: boolean): MarkdownInline[] {
  if (!autolink) {
    return [{ text, type: 'text' }];
  }

  const inlines: MarkdownInline[] = [];
  const urlPattern = /https?:\/\/[^\s<>"'`]+/g;
  let cursor = 0;
  let match: RegExpExecArray | null;

  while ((match = urlPattern.exec(text))) {
    const rawUrl = match[0];
    const start = match.index;
    const trimmedUrl = trimTrailingUrlPunctuation(rawUrl);
    const end = start + trimmedUrl.length;
    const href = sanitizeHref(trimmedUrl);

    if (!href || trimmedUrl.length === 0) {
      continue;
    }

    if (start > cursor) {
      inlines.push({ text: text.slice(cursor, start), type: 'text' });
    }

    inlines.push({
      children: [{ text: trimmedUrl, type: 'text' }],
      href,
      type: 'link',
    });
    cursor = end;
    urlPattern.lastIndex = end;
  }

  if (cursor < text.length) {
    inlines.push({ text: text.slice(cursor), type: 'text' });
  }

  return inlines.length > 0 ? inlines : [{ text, type: 'text' }];
}

function trimTrailingUrlPunctuation(url: string) {
  let end = url.length;
  while (end > 0 && /[.,!?;:)\]}]/.test(url[end - 1])) {
    end -= 1;
  }

  return url.slice(0, end);
}

function fileLinkFromHref(href: string, label?: string): MarkdownFileLink | null {
  const file = hostFileHrefInfoFromHref(href, {
    parseLine: true,
    requireFileExtension: true,
  });
  if (!file) {
    return null;
  }

  const displayName = fileLinkDisplayName({
    fileName: file.fileName,
    href,
    label,
    line: file.line ?? null,
    path: file.path,
  });

  return {
    displayName,
    extension: file.extension,
    fileName: file.fileName,
    line: file.line ?? null,
    path: file.path,
  };
}

function fileLinkDisplayName({
  fileName,
  href,
  label,
  line,
  path,
}: {
  fileName: string;
  href: string;
  label?: string;
  line: number | null;
  path: string;
}) {
  const normalizedLabel = label?.replace(/\s+/g, ' ').trim() ?? '';
  const normalizedHref = href.trim();
  const normalizedPath = path.trim();
  const labelIsPathEquivalent =
    !normalizedLabel ||
    isPathLikeLabel(normalizedLabel) ||
    normalizedLabel === normalizedHref ||
    normalizedLabel === normalizedPath ||
    normalizedLabel === fileName;

  const baseDisplayName = labelIsPathEquivalent ? compactFileName(fileName) : normalizedLabel;

  if (!line || labelMentionsLine(baseDisplayName, line)) {
    return baseDisplayName;
  }

  return `${baseDisplayName} (line ${line})`;
}

function isPathLikeLabel(label: string) {
  return /[\\/]/.test(label) || /^[~.]/.test(label);
}

function labelMentionsLine(label: string, line: number) {
  const escapedLine = escapeRegExp(String(line));
  return (
    new RegExp(`\\bline\\s+${escapedLine}\\b`, 'i').test(label) ||
    new RegExp(`:${escapedLine}\\b`).test(label) ||
    new RegExp(`\\(${escapedLine}\\)`).test(label) ||
    new RegExp(`#L${escapedLine}\\b`, 'i').test(label)
  );
}

function compactFileName(fileName: string) {
  const maxLength = 34;
  if (fileName.length <= maxLength) {
    return fileName;
  }

  const extensionMatch = fileName.match(/(\.[a-z0-9]+)$/i);
  const extension = extensionMatch?.[1] ?? '';
  const stem = extension ? fileName.slice(0, -extension.length) : fileName;
  const suffixLength = Math.max(8, 12 - extension.length);
  const prefixLength = Math.max(10, maxLength - suffixLength - extension.length - 3);

  return `${stem.slice(0, prefixLength)}...${stem.slice(-suffixLength)}${extension}`;
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function appendInline(lines: MarkdownInline[][], inline: MarkdownInline) {
  lines[lines.length - 1].push(inline);
}

function appendInlineLines(lines: MarkdownInline[][], inlineLines: MarkdownInline[][]) {
  for (let index = 0; index < inlineLines.length; index += 1) {
    if (index > 0) {
      lines.push([]);
    }

    lines[lines.length - 1].push(...inlineLines[index]);
  }
}

function appendWrappedInlineLines(
  lines: MarkdownInline[][],
  inlineLines: MarkdownInline[][],
  wrap: (children: MarkdownInline[]) => MarkdownInline,
) {
  for (let index = 0; index < inlineLines.length; index += 1) {
    if (index > 0) {
      lines.push([]);
    }

    if (inlineLines[index].length > 0) {
      appendInline(lines, wrap(inlineLines[index]));
    }
  }
}

function markdownTextFromNode(node: unknown): string {
  if (!node || typeof node !== 'object') {
    return '';
  }

  if ('value' in node && typeof node.value === 'string') {
    return node.value;
  }

  if ('children' in node && Array.isArray(node.children)) {
    return node.children.map((child) => markdownTextFromNode(child)).join(' ');
  }

  if ('alt' in node && typeof node.alt === 'string') {
    return node.alt;
  }

  return '';
}

function phrasingNodesText(nodes: readonly PhrasingContent[]) {
  return nodes.map((node) => markdownTextFromNode(node)).join('');
}

function mergeAdjacentText(nodes: MarkdownInline[]) {
  const merged: MarkdownInline[] = [];

  for (const node of nodes) {
    const previous = merged[merged.length - 1];
    if (node.type === 'text' && previous?.type === 'text') {
      previous.text += node.text;
    } else {
      merged.push(node);
    }
  }

  return merged;
}

function stripSingleTrailingNewline(text: string) {
  return text.endsWith('\n') ? text.slice(0, -1) : text;
}

function remember<K, V>(cache: Map<K, V>, key: K, value: V, maxEntries: number) {
  if (cache.size >= maxEntries) {
    const oldest = cache.keys().next();
    if (!oldest.done) {
      cache.delete(oldest.value);
    }
  }

  cache.set(key, value);
}

function readScopedCache<V>(
  durable: Map<string, V>,
  streaming: Map<string, { key: string; value: V }>,
  scope: MarkdownCacheScope,
  key: string,
) {
  if (scope.kind === 'complete') return durable.get(key);
  const entry = streaming.get(scope.key);
  if (!entry || entry.key !== key) return undefined;
  streaming.delete(scope.key);
  streaming.set(scope.key, entry);
  return entry.value;
}

function writeScopedCache<V>(
  durable: Map<string, V>,
  streaming: Map<string, { key: string; value: V }>,
  scope: MarkdownCacheScope,
  key: string,
  value: V,
  maximum: number,
) {
  if (scope.kind === 'complete') {
    remember(durable, key, value, maximum);
    return;
  }
  streaming.delete(scope.key);
  streaming.set(scope.key, { key, value });
  while (streaming.size > maxStreamingCacheScopes) {
    const oldest = streaming.keys().next().value as string | undefined;
    if (oldest === undefined) return;
    streaming.delete(oldest);
  }
}
