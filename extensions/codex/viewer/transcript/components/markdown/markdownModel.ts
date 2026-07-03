import {
  layout,
  prepare,
  type PreparedText,
} from '@chenglou/pretext';
import {
  materializeRichInlineLineRange,
  prepareRichInline,
  walkRichInlineLineRanges,
  type PreparedRichInline,
  type RichInlineItem,
} from '@chenglou/pretext/rich-inline';
import { fromMarkdown } from 'mdast-util-from-markdown';
import type { BlockContent, DefinitionContent, PhrasingContent, RootContent } from 'mdast';

import { hostFileHrefInfoFromHref, webUrlFromHref } from '@remux/viewer-kit/links';

export type MarkdownDensity = 'default' | 'user' | 'work';

export type MarkdownRenderOptions = {
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
  inlines: MarkdownInline[];
  prepared: PreparedRichInline | null;
  sources: MarkdownInlineSource[];
};

export type PreparedMarkdownBlock =
  | {
      depth: 1 | 2 | 3;
      lines: PreparedMarkdownInlineLine[];
      type: 'heading';
    }
  | {
      lines: PreparedMarkdownInlineLine[];
      type: 'paragraph';
    }
  | {
      language: string | null;
      text: string;
      type: 'code';
    }
  | {
      children: PreparedMarkdownBlock[];
      type: 'blockquote';
    }
  | {
      items: PreparedMarkdownListItem[];
      ordered: boolean;
      start: number;
      type: 'list';
    }
  | {
      type: 'rule';
    };

export type PreparedMarkdownListItem = {
  blocks: PreparedMarkdownBlock[];
  marker: string;
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
      type: 'heading';
    }
  | {
      lines: MarkdownInline[][];
      type: 'paragraph';
    }
  | {
      language: string | null;
      text: string;
      type: 'code';
    }
  | {
      children: RawMarkdownBlock[];
      type: 'blockquote';
    }
  | {
      items: RawMarkdownListItem[];
      ordered: boolean;
      start: number;
      type: 'list';
    }
  | {
      type: 'rule';
    };

export type RawMarkdownListItem = {
  blocks: RawMarkdownBlock[];
  marker: string;
};

type InlineMarks = {
  emphasis: boolean;
  linkHref: string | null;
  strong: boolean;
};

type MarkdownParseOptions = Required<MarkdownRenderOptions>;

type MarkdownInlineParseOptions = MarkdownParseOptions & {
  autolink: boolean;
};

export type InlineVariant = 'body' | 'heading1' | 'heading2' | 'heading3';

export const markdownMetrics = {
  blockGap: {
    default: 8,
    user: 8,
    work: 8,
  },
  blockquote: {
    borderWidth: 3,
    contentInset: 16,
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
    mono: 'Menlo, Consolas, "Liberation Mono", monospace',
    sans: 'Arial, "Helvetica Neue", sans-serif',
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
} as const;

const documentCache = new Map<string, PreparedMarkdownDocument>();
const preparedTextCache = new Map<string, PreparedText>();
const layoutCache = new Map<string, MarkdownLayoutDocument>();
const maxDocumentCacheEntries = 300;
const maxPreparedTextCacheEntries = 1000;
const maxLayoutCacheEntries = 500;

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
  const key = `${density}\0${parseOptions.richFileLinks ? 'richFiles' : 'plainFiles'}\0${markdown}`;
  const cached = documentCache.get(key);
  if (cached) {
    return cached;
  }

  const rawBlocks = parseMarkdownBlocks(markdown, parseOptions);
  const prepared: PreparedMarkdownDocument = {
    blocks: rawBlocks.map((block) => prepareMarkdownBlock(block, density)),
    density,
  };

  remember(documentCache, key, prepared, maxDocumentCacheEntries);
  return prepared;
}

export function parseMarkdownDocument(markdown: string, options: MarkdownRenderOptions = {}) {
  return parseMarkdownBlocks(markdown, markdownParseOptions(options));
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
  const key = `${density}\0${parseOptions.richFileLinks ? 'richFiles' : 'plainFiles'}\0${roundedWidth}\0${markdown}`;
  const cached = layoutCache.get(key);
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

  remember(layoutCache, key, laidOut, maxLayoutCacheEntries);
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
        ordered: block.ordered,
        start: block.start,
        topGap,
        type: 'list',
      };
    }
    case 'rule':
      return {
        contentHeight: markdownMetrics.ruleHeight,
        height: topGap + markdownMetrics.ruleHeight,
        topGap,
        type: 'rule',
      };
  }
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
    case 'rule':
      return {
        height: block.topGap + block.contentHeight,
        remainingLines: remainingLines - 1,
      };
  }
}

function layoutInlineLines(lines: PreparedMarkdownInlineLine[], width: number) {
  const laidOutLines: MarkdownLayoutTextLine[] = [];

  for (const line of lines) {
    if (!line.prepared) {
      laidOutLines.push({
        fragments: [],
        width: 0,
      });
      continue;
    }

    let emitted = false;
    walkRichInlineLineRanges(line.prepared, Math.max(1, width), (range) => {
      const materialized = materializeRichInlineLineRange(line.prepared!, range);
      emitted = true;
      laidOutLines.push({
        fragments: materialized.fragments.map((fragment) => ({
          gapBefore: fragment.gapBefore,
          source: line.sources[fragment.itemIndex] ?? fallbackInlineSource,
          text: fragment.text,
        })),
        width: materialized.width,
      });
    });

    if (!emitted) {
      laidOutLines.push({
        fragments: [],
        width: 0,
      });
    }
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
        type: 'paragraph',
      };
    case 'heading':
      return {
        depth: block.depth,
        lines: block.lines.map((line) => prepareInlineLine(line, density, headingVariant(block.depth))),
        type: 'heading',
      };
    case 'code':
      return {
        language: block.language,
        text: stripSingleTrailingNewline(block.text),
        type: 'code',
      };
    case 'blockquote':
      return {
        children: block.children.map((child) => prepareMarkdownBlock(child, density)),
        type: 'blockquote',
      };
    case 'list':
      return {
        items: block.items.map((item) => ({
          blocks: item.blocks.map((child) => prepareMarkdownBlock(child, density)),
          marker: item.marker,
        })),
        ordered: block.ordered,
        start: block.start,
        type: 'list',
      };
    case 'rule':
      return block;
  }
}

function prepareInlineLine(inlines: MarkdownInline[], density: MarkdownDensity, variant: InlineVariant): PreparedMarkdownInlineLine {
  const { items, sources } = inlineRichItems(inlines, density, variant);

  return {
    inlines,
    prepared: items.length > 0 ? prepareRichInline(items) : null,
    sources,
  };
}

function inlineRichItems(inlines: MarkdownInline[], density: MarkdownDensity, variant: InlineVariant) {
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
        case 'fileLink':
          items.push({
            break: 'never',
            extraWidth:
              markdownMetrics.fileLink.iconSize +
              markdownMetrics.fileLink.iconGap +
              markdownMetrics.fileLink.paddingX * 2 +
              markdownMetrics.fileLink.borderWidth * 2 +
              extraWidth,
            font: fontForInlineText(density, variant, { ...marks, linkHref: child.href }),
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

    return extraWidth;
  };

  walk(inlines, emptyMarks);
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
    richFileLinks: options.richFileLinks ?? true,
  };
}

function parseMarkdownBlocks(markdown: string, options: MarkdownParseOptions): RawMarkdownBlock[] {
  return rootContentToRawBlocks(fromMarkdown(markdown).children, options);
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
          type: 'paragraph',
        },
      ];
    case 'heading':
      return [
        {
          depth: Math.min(node.depth, 3) as 1 | 2 | 3,
          lines: phrasingToInlineLines(node.children, options),
          type: 'heading',
        },
      ];
    case 'code':
      return [
        {
          language: node.lang?.trim() || null,
          text: node.value,
          type: 'code',
        },
      ];
    case 'blockquote':
      return [
        {
          children: blockContentToRawBlocks(node.children, options),
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
          ordered,
          start,
          type: 'list',
        },
      ];
    }
    case 'thematicBreak':
      return [{ type: 'rule' }];
    case 'html':
      return textToParagraphBlocks(node.value);
    case 'table':
      return textToParagraphBlocks(markdownTextFromNode(node));
    default:
      return [];
  }
}

function textToParagraphBlocks(text: string): RawMarkdownBlock[] {
  return text.trim()
    ? [
        {
          lines: [[{ text, type: 'text' }]],
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
      appendInlineText(lines, node.value, options.autolink);
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
        const file = options.richFileLinks ? fileLinkFromHref(href, phrasingNodesText(node.children)) : null;
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
        appendInlineText(lines, markdownTextFromNode(node), options.autolink);
      }
      return;
    }
    case 'linkReference':
    case 'delete':
      appendInlineLines(lines, phrasingToInlineLines(node.children, options));
      return;
    case 'image':
      appendInlineText(lines, node.alt || node.url, options.autolink);
      return;
    case 'imageReference':
      appendInlineText(lines, node.alt || node.label || node.identifier, options.autolink);
      return;
    case 'html':
      appendInlineText(lines, node.value, options.autolink);
      return;
    case 'footnoteReference':
      appendInlineText(lines, `[^${node.label ?? node.identifier}]`, options.autolink);
      return;
  }
}

function appendInlineText(lines: MarkdownInline[][], text: string, autolink = true) {
  const normalized = text.replace(/\s+/g, ' ');
  if (normalized) {
    for (const inline of textToInlines(normalized, autolink)) {
      appendInline(lines, inline);
    }
  }
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
