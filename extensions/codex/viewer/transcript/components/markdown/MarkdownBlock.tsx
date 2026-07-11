import { memo, useMemo, type CSSProperties, type MouseEvent, type ReactNode } from 'react';

import {
  cappedMarkdownLayoutDocumentHeight,
  getMarkdownLayoutDocument,
  markdownMetrics,
  type MarkdownDensity,
  type MarkdownFileLink,
  type MarkdownInlineSource,
  type MarkdownLayoutBlock,
  type MarkdownLayoutLineFragment,
} from './markdownModel';
import { CodeBlock } from './CodeBlock';
import { FileTypeIcon } from '../file/fileTypeIcons';
import { cn } from '@remux/viewer-kit/shadcn';
import { openHostHref, openHostTarget } from '@remux/viewer-kit/links';
import type { CodexNarrationSourceTarget } from '../../../../shared/narration';
import { useNarrationTargetRef } from '../../../narration/targetRegistry';

const fallbackMarkdownWidth = 868;

export type MarkdownNarrationHighlight = {
  targets: CodexNarrationSourceTarget[];
};

export function MarkdownBlock({
  children,
  density = 'default',
  narrationAssistantMessageId = null,
  narrationHighlight,
  narrationTargets = [],
  maxLines,
  streaming = false,
  width = fallbackMarkdownWidth,
}: {
  children: string;
  density?: MarkdownDensity;
  maxLines?: number;
  narrationAssistantMessageId?: string | null;
  narrationHighlight?: MarkdownNarrationHighlight | null;
  narrationTargets?: CodexNarrationSourceTarget[];
  streaming?: boolean;
  width?: number;
}) {
  const document = useMemo(
    () => getMarkdownLayoutDocument(children, density, width, { richFileLinks: !streaming }),
    [children, density, streaming, width],
  );
  const height = maxLines === undefined
    ? document.height
    : cappedMarkdownLayoutDocumentHeight(document, maxLines);
  const clipped = height < document.height - 0.5;

  return (
    <div
      className={cn(
        'codex-markdown',
        clipped && 'codex-markdown-clipped',
        density === 'work' && 'codex-markdown-work',
        density === 'user' && 'codex-markdown-user',
      )}
      style={{ height: `${height}px` }}
    >
      {document.blocks.map((block, index) => (
        <MarkdownBlockNode
          assistantMessageId={narrationAssistantMessageId}
          block={block}
          highlight={narrationHighlight}
          key={`${block.type}:${index}`}
          targets={narrationTargets}
        />
      ))}
    </div>
  );
}

const MarkdownBlockNode = memo(function MarkdownBlockNode({
  assistantMessageId,
  block,
  highlight,
  targets,
}: {
  assistantMessageId: string | null;
  block: MarkdownLayoutBlock;
  highlight?: MarkdownNarrationHighlight | null;
  targets: CodexNarrationSourceTarget[];
}) {
  const blockTargets = targets.filter((target) => target.blockId === block.narrationId);
  const activeTargets = highlight?.targets.filter((target) => target.blockId === block.narrationId) ?? [];
  const active = activeTargets.length > 0;
  const targetRef = useNarrationTargetRef(assistantMessageId, blockTargets.map((target) => target.id));
  return (
    <div
      className={cn('codex-md-block-frame', active && 'codex-md-block-narrating')}
      data-narration-block-id={block.narrationId}
      ref={targetRef}
      style={{ height: `${block.height}px` }}
    >
      <MarkdownBlockContent
        assistantMessageId={assistantMessageId}
        block={block}
        highlight={highlight}
        targets={targets}
      />
    </div>
  );
}, (previous, next) => (
  previous.assistantMessageId === next.assistantMessageId &&
  previous.block === next.block &&
  previous.targets === next.targets &&
  activeTargetKey(previous.highlight, previous.block.narrationId) === activeTargetKey(next.highlight, next.block.narrationId)
));

function activeTargetKey(highlight: MarkdownNarrationHighlight | null | undefined, blockId: string) {
  return highlight?.targets
    .filter((target) => target.blockId === blockId)
    .map((target) => target.id)
    .join('\0') ?? '';
}

function MarkdownBlockContent({
  assistantMessageId,
  block,
  highlight,
  targets,
}: {
  assistantMessageId: string | null;
  block: MarkdownLayoutBlock;
  highlight?: MarkdownNarrationHighlight | null;
  targets: CodexNarrationSourceTarget[];
}) {
  const style = contentStyle(block);
  const activeHighlight = highlight?.targets.filter((target): target is Extract<CodexNarrationSourceTarget, { kind: 'textRange' }> =>
    target.blockId === block.narrationId && target.kind === 'textRange') ?? [];

  switch (block.type) {
    case 'paragraph':
      return (
        <div className="codex-md-block codex-md-paragraph" style={style}>
          <MarkdownTextLines highlights={activeHighlight} lineHeight={block.lineHeight} lines={block.lines} />
        </div>
      );
    case 'heading': {
      const HeadingTag = `h${block.depth}` as 'h1' | 'h2' | 'h3';
      return (
        <HeadingTag className="codex-md-block codex-md-heading" data-depth={block.depth} style={style}>
          <MarkdownTextLines highlights={activeHighlight} lineHeight={block.lineHeight} lines={block.lines} />
        </HeadingTag>
      );
    }
    case 'code':
      return <CodeBlock
        activeTargets={highlight?.targets ?? []}
        assistantMessageId={assistantMessageId}
        block={block}
        style={style}
        targets={targets}
      />;
    case 'blockquote':
      return (
        <blockquote className="codex-md-block codex-md-blockquote" style={style}>
          {block.children.map((child, index) => (
            <MarkdownBlockNode assistantMessageId={assistantMessageId} block={child} highlight={highlight} key={`${child.type}:${index}`} targets={targets} />
          ))}
        </blockquote>
      );
    case 'list':
      return (
        <div className="codex-md-block codex-md-list" role="list" style={style}>
          {block.items.map((item, index) => (
            <div className="codex-md-list-item-frame" key={`${item.marker}:${index}`} style={{ height: `${item.height}px` }}>
              <div
                className="codex-md-list-item"
                role="listitem"
                style={{
                  height: `${item.contentHeight}px`,
                  transform: item.topGap ? `translateY(${item.topGap}px)` : undefined,
                }}
              >
                <span className="codex-md-list-marker">{item.marker}</span>
                <div className="codex-md-list-content">
                  {item.blocks.map((child, childIndex) => (
                    <MarkdownBlockNode assistantMessageId={assistantMessageId} block={child} highlight={highlight} key={`${child.type}:${childIndex}`} targets={targets} />
                  ))}
                </div>
              </div>
            </div>
          ))}
        </div>
      );
    case 'table':
      return <MarkdownTable
        activeTargets={highlight?.targets ?? []}
        assistantMessageId={assistantMessageId}
        block={block}
        style={style}
        targets={targets}
      />;
    case 'rule':
      return <hr className="codex-md-block codex-md-rule" style={style} />;
  }
}

function MarkdownTable({
  activeTargets,
  assistantMessageId,
  block,
  style,
  targets,
}: {
  activeTargets: CodexNarrationSourceTarget[];
  assistantMessageId: string | null;
  block: Extract<MarkdownLayoutBlock, { type: 'table' }>;
  style: CSSProperties;
  targets: CodexNarrationSourceTarget[];
}) {
  const gridTemplateColumns = block.columnWidths.map((columnWidth) => `${columnWidth}px`).join(' ');

  return (
    <div className="codex-md-block codex-md-table-scroll" style={style}>
      <div
        className="codex-md-table"
        role="table"
        style={{
          height: `${block.contentHeight}px`,
          width: `${block.tableWidth}px`,
        }}
      >
        {block.rows.map((row, rowIndex) => (
          <div
            className="codex-md-table-row"
            data-header={row.header ? 'true' : undefined}
            key={rowIndex}
            role="row"
            style={{
              gridTemplateColumns,
              height: `${row.height}px`,
            }}
          >
            {row.cells.map((cell, cellIndex) => (
              <MarkdownTableCell
                activeTargets={activeTargets}
                align={cell.align}
                assistantMessageId={assistantMessageId}
                blockId={block.narrationId}
                column={cellIndex}
                header={row.header}
                key={cellIndex}
                lineHeight={block.lineHeight}
                lines={cell.lines}
                row={rowIndex}
                targets={targets}
              />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

function MarkdownTableCell({
  activeTargets,
  align,
  assistantMessageId,
  blockId,
  column,
  header,
  lineHeight,
  lines,
  row,
  targets,
}: {
  activeTargets: CodexNarrationSourceTarget[];
  align: string | null;
  assistantMessageId: string | null;
  blockId: string;
  column: number;
  header: boolean;
  lineHeight: number;
  lines: Extract<MarkdownLayoutBlock, { type: 'table' }>['rows'][number]['cells'][number]['lines'];
  row: number;
  targets: CodexNarrationSourceTarget[];
}) {
  const cellTargets = targets.filter((target) =>
    target.blockId === blockId && (
      (target.kind === 'tableCell' && target.row === row && target.column === column) ||
      (target.kind === 'tableRegion' && row >= target.rowStart && row <= target.rowEnd && column >= target.columnStart && column <= target.columnEnd)
    ));
  const active = activeTargets.some((target) => cellTargets.some((candidate) => candidate.id === target.id));
  const targetRef = useNarrationTargetRef(assistantMessageId, cellTargets.map((target) => target.id));
  return (
    <div
      className={cn('codex-md-table-cell', active && 'codex-md-target-narrating')}
      data-align={align ?? 'left'}
      ref={targetRef}
      role={header ? 'columnheader' : 'cell'}
    >
      <MarkdownTextLines highlights={[]} lineHeight={lineHeight} lines={lines} />
    </div>
  );
}

function contentStyle(block: MarkdownLayoutBlock): CSSProperties {
  return {
    height: `${block.contentHeight}px`,
    transform: block.topGap ? `translateY(${block.topGap}px)` : undefined,
  };
}

function MarkdownTextLines({
  highlights,
  lineHeight,
  lines,
}: {
  highlights: Extract<CodexNarrationSourceTarget, { kind: 'textRange' }>[];
  lineHeight: number;
  lines: Extract<MarkdownLayoutBlock, { type: 'paragraph' }>['lines'];
}) {
  return (
    <>
      {lines.map((line, lineIndex) => (
        <div
          className="codex-md-text-line"
          key={lineIndex}
          style={{ height: `${lineHeight}px`, lineHeight: `${lineHeight}px` }}
        >
          {line.fragments.map((fragment, fragmentIndex) => (
            <MarkdownLineFragment
              fragment={fragment}
              highlights={highlights}
              key={`${lineIndex}:${fragmentIndex}:${fragment.text}`}
            />
          ))}
        </div>
      ))}
    </>
  );
}

function MarkdownLineFragment({
  fragment,
  highlights,
}: {
  fragment: MarkdownLayoutLineFragment;
  highlights: Extract<CodexNarrationSourceTarget, { kind: 'textRange' }>[];
}) {
  if (!fragment.text) {
    return null;
  }

  const style = fragment.gapBefore > 0 ? { marginLeft: `${fragment.gapBefore}px` } : undefined;
  const source = fragment.source;
  const content = highlightedFragment(fragment, highlights);

  if (source.kind === 'fileLink' && source.file && source.href) {
    return <FileLink file={source.file} href={source.href} style={style} text={content} />;
  }

  if (source.kind === 'code') {
    const code = (
      <code className={inlineClassName(source)} style={style}>
        {content}
      </code>
    );

    const href = source.href;
    return href ? (
      <a className="codex-md-line-code-link" href={href} onClick={(event) => handleCodexLinkClick(event, href)}>
        {code}
      </a>
    ) : (
      code
    );
  }

  if (source.href) {
    const href = source.href;
    return (
      <a className={inlineClassName(source)} href={href} onClick={(event) => handleCodexLinkClick(event, href)} style={style}>
        {content}
      </a>
    );
  }

  const Tag = source.strong ? 'strong' : source.emphasis ? 'em' : 'span';

  return (
    <Tag className={inlineClassName(source)} style={style}>
      {content}
    </Tag>
  );
}

function highlightedFragment(
  fragment: MarkdownLayoutLineFragment,
  highlights: Extract<CodexNarrationSourceTarget, { kind: 'textRange' }>[],
) {
  const ranges = highlights
    .map((highlight) => ({
      end: Math.min(fragment.text.length, highlight.displayEnd - fragment.displayStart),
      start: Math.max(0, highlight.displayStart - fragment.displayStart),
    }))
    .filter((range) => range.end > range.start)
    .sort((left, right) => left.start - right.start);
  if (ranges.length === 0) return fragment.text;
  const merged = ranges.reduce<Array<{ end: number; start: number }>>((output, range) => {
    const previous = output.at(-1);
    if (previous && range.start <= previous.end) previous.end = Math.max(previous.end, range.end);
    else output.push({ ...range });
    return output;
  }, []);
  const content: ReactNode[] = [];
  let cursor = 0;
  merged.forEach((range, index) => {
    if (range.start > cursor) content.push(fragment.text.slice(cursor, range.start));
    content.push(<span className="codex-md-narrated-word" key={`${index}:${range.start}`}>{fragment.text.slice(range.start, range.end)}</span>);
    cursor = range.end;
  });
  if (cursor < fragment.text.length) content.push(fragment.text.slice(cursor));
  return (
    <>{content}</>
  );
}

function inlineClassName(source: MarkdownInlineSource) {
  return cn(
    'codex-md-line-fragment',
    source.kind === 'code' && 'codex-md-inline-code',
    source.href && 'codex-md-line-link',
    source.strong && 'codex-md-inline-strong',
    source.emphasis && 'codex-md-inline-emphasis',
  );
}

function FileLink({
  file,
  href,
  style,
  text,
}: {
  file: MarkdownFileLink;
  href: string;
  style?: CSSProperties;
  text?: ReactNode;
}) {
  const title = file.line ? `${file.path}:${file.line}` : file.path;
  const linkStyle = {
    ...style,
    '--codex-md-file-icon-baseline-shift': `${markdownMetrics.fileLink.iconBaselineShift}px`,
    '--codex-md-file-icon-gap': `${markdownMetrics.fileLink.iconGap}px`,
    '--codex-md-file-icon-size': `${markdownMetrics.fileLink.iconSize}px`,
    '--codex-md-file-link-height': `${markdownMetrics.fileLink.height}px`,
    '--codex-md-file-link-padding-x': `${markdownMetrics.fileLink.paddingX}px`,
  } as CSSProperties;

  return (
    <a
      className="codex-md-file-link"
      data-extension={file.extension ?? ''}
      href={href}
      onClick={(event) => {
        event.preventDefault();
        void openHostTarget({ kind: 'file', line: file.line, path: file.path });
      }}
      style={linkStyle}
      title={title}
    >
      <span className="codex-md-file-icon-frame">
        <FileLinkIcon file={file} />
      </span>
      <span className="codex-md-file-link-name">{text ?? file.displayName}</span>
    </a>
  );
}

function FileLinkIcon({ file }: { file: MarkdownFileLink }) {
  return <FileTypeIcon extension={file.extension} fileName={file.fileName} />;
}

function handleCodexLinkClick(event: MouseEvent<HTMLAnchorElement>, href: string) {
  event.preventDefault();
  void openHostHref(href, { parseLine: true });
}
