import {
  Component,
  memo,
  useMemo,
  useSyncExternalStore,
  type CSSProperties,
  type ErrorInfo,
  type MouseEvent,
  type ReactNode,
} from 'react';

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
import {
  mathMetricsRevision,
  subscribeMathMetrics,
} from './mathMetricsStore';
import { CodeBlock } from './CodeBlock';
import { fileReferenceStyle } from '../file/FileReferenceChip';
import { FileTypeIcon } from '../file/fileTypeIcons';
import { cn } from '@remux/viewer-kit/shadcn';
import { openHostHref, openHostTarget } from '@remux/viewer-kit/links';

const fallbackMarkdownWidth = 868;

export function MarkdownBlock({
  children,
  density = 'default',
  maxLines,
  messageCacheKey = null,
  streaming = false,
  width = fallbackMarkdownWidth,
}: {
  children: string;
  density?: MarkdownDensity;
  maxLines?: number;
  messageCacheKey?: string | null;
  streaming?: boolean;
  width?: number;
}) {
  const metricsRevision = useSyncExternalStore(
    subscribeMathMetrics,
    mathMetricsRevision,
    mathMetricsRevision,
  );
  const cacheScope = streaming && messageCacheKey
    ? { key: messageCacheKey, kind: 'streaming' as const }
    : { kind: 'complete' as const };
  const document = useMemo(
    () => getMarkdownLayoutDocument(children, density, width, {
      cacheScope,
      richFileLinks: !streaming,
    }),
    [children, density, messageCacheKey, metricsRevision, streaming, width],
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
          block={block}
          key={markdownBlockRenderKey(block, index)}
        />
      ))}
    </div>
  );
}

const MarkdownBlockNode = memo(function MarkdownBlockNode({
  block,
}: {
  block: MarkdownLayoutBlock;
}) {
  return (
    <div
      className="codex-md-block-frame"
      style={{ height: `${block.height}px` }}
    >
      <MarkdownBlockContent
        block={block}
      />
    </div>
  );
}, (previous, next) => previous.block === next.block);

function MarkdownBlockContent({
  block,
}: {
  block: MarkdownLayoutBlock;
}) {
  const style = contentStyle(block);
  switch (block.type) {
    case 'paragraph':
      return (
        <div className="codex-md-block codex-md-paragraph" style={style}>
          <MarkdownTextLines lineHeight={block.lineHeight} lines={block.lines} />
        </div>
      );
    case 'heading': {
      const HeadingTag = `h${block.depth}` as 'h1' | 'h2' | 'h3';
      return (
        <HeadingTag className="codex-md-block codex-md-heading" data-depth={block.depth} style={style}>
          <MarkdownTextLines lineHeight={block.lineHeight} lines={block.lines} />
        </HeadingTag>
      );
    }
    case 'code':
      return <CodeBlock
        block={block}
        style={style}
      />;
    case 'mathDisplay':
      return <MarkdownDisplayMath block={block} style={style} />;
    case 'blockquote':
      return (
        <blockquote className="codex-md-block codex-md-blockquote" style={style}>
          {block.children.map((child, index) => (
            <MarkdownBlockNode block={child} key={markdownBlockRenderKey(child, index)} />
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
                    <MarkdownBlockNode block={child} key={markdownBlockRenderKey(child, childIndex)} />
                  ))}
                </div>
              </div>
            </div>
          ))}
        </div>
      );
    case 'table':
      return <MarkdownTable
        block={block}
        style={style}
      />;
    case 'rule':
      return <hr className="codex-md-block codex-md-rule" style={style} />;
  }
}

function MarkdownTable({
  block,
  style,
}: {
  block: Extract<MarkdownLayoutBlock, { type: 'table' }>;
  style: CSSProperties;
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
                align={cell.align}
                header={row.header}
                key={cellIndex}
                lineHeight={block.lineHeight}
                lines={cell.lines}
              />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

function MarkdownTableCell({
  align,
  header,
  lineHeight,
  lines,
}: {
  align: string | null;
  header: boolean;
  lineHeight: number;
  lines: Extract<MarkdownLayoutBlock, { type: 'table' }>['rows'][number]['cells'][number]['lines'];
}) {
  return (
    <div
      className="codex-md-table-cell"
      data-align={align ?? 'left'}
      role={header ? 'columnheader' : 'cell'}
    >
      <MarkdownTextLines lineHeight={lineHeight} lines={lines} />
    </div>
  );
}

function contentStyle(block: MarkdownLayoutBlock): CSSProperties {
  return {
    height: `${block.contentHeight}px`,
    transform: block.topGap ? `translateY(${block.topGap}px)` : undefined,
  };
}

function markdownBlockRenderKey(block: MarkdownLayoutBlock, index: number) {
  return block.type === 'mathDisplay'
    ? 'math:' + block.sourceStart + ':' + block.sourceEnd + ':' + stableTextHash(block.tex)
    : block.type + ':' + index;
}

function stableTextHash(value: string) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16);
}

function MarkdownDisplayMath({
  block,
  style,
}: {
  block: Extract<MarkdownLayoutBlock, { type: 'mathDisplay' }>;
  style: CSSProperties;
}) {
  return (
    <div
      className="codex-md-block codex-md-display-math-frame"
      data-constrained={block.constrained ? 'true' : undefined}
      data-wrapped={block.wrapped ? 'true' : undefined}
      style={style}
    >
      <MathRenderBoundary fallback={(
        <code className="codex-md-math-literal">{block.originalSource}</code>
      )}>
        {block.html ? (
          <div
            className="codex-md-math codex-md-display-math"
            data-constrained={block.constrained ? 'true' : undefined}
            dangerouslySetInnerHTML={{ __html: block.html }}
          />
        ) : (
          <code className="codex-md-math-literal">{block.originalSource}</code>
        )}
      </MathRenderBoundary>
    </div>
  );
}

function MarkdownTextLines({
  lineHeight,
  lines,
}: {
  lineHeight: number;
  lines: Extract<MarkdownLayoutBlock, { type: 'paragraph' }>['lines'];
}) {
  return (
    <>
      {lines.map((line, lineIndex) => (
        <div
          className="codex-md-text-line"
          key={lineIndex}
          style={{ height: `${line.height}px`, lineHeight: `${lineHeight}px` }}
        >
          {line.fragments.map((fragment, fragmentIndex) => (
            <MarkdownLineFragment
              fragment={fragment}
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
}: {
  fragment: MarkdownLayoutLineFragment;
}) {
  if (!fragment.text) return null;
  const source = fragment.source;
  const style = {
    ...(fragment.gapBefore > 0 ? { marginLeft: `${fragment.gapBefore}px` } : null),
    ...(source.kind === 'math' && source.math?.metrics
      ? { verticalAlign: `${-source.math.metrics.depth}px` }
      : null),
  } satisfies CSSProperties;

  if (source.kind === 'math' && source.math?.html) {
    const math = (
      <span
        className={inlineClassName(source)}
        dangerouslySetInnerHTML={{ __html: source.math.html }}
        style={style}
      />
    );
    return source.href ? (
      <a
        className="codex-md-line-math-link"
        href={source.href}
        onClick={(event) => handleCodexLinkClick(event, source.href!)}
      >
        <MathRenderBoundary fallback={source.math.source.originalSource}>{math}</MathRenderBoundary>
      </a>
    ) : (
      <MathRenderBoundary fallback={source.math.source.originalSource}>{math}</MathRenderBoundary>
    );
  }

  if (source.kind === 'fileLink' && source.file && source.href) {
    return <FileLink
      file={source.file}
      href={source.href}
      style={style}
      text={fragment.text}
    />;
  }

  if (source.kind === 'code') {
    const code = (
      <code className={inlineClassName(source)}  style={style}>
        {fragment.text}
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
      <a className={inlineClassName(source)} href={href} onClick={(event) => handleCodexLinkClick(event, href)}  style={style}>
        {fragment.text}
      </a>
    );
  }

  const Tag = source.strong ? 'strong' : source.emphasis ? 'em' : 'span';

  return (
    <Tag className={inlineClassName(source)}  style={style}>
      {fragment.text}
    </Tag>
  );
}

function inlineClassName(source: MarkdownInlineSource) {
  return cn(
    'codex-md-line-fragment',
    source.kind === 'code' && 'codex-md-inline-code',
    source.kind === 'math' && 'codex-md-math codex-md-inline-math',
    source.href && 'codex-md-line-link',
    source.strong && 'codex-md-inline-strong',
    source.emphasis && 'codex-md-inline-emphasis',
  );
}

class MathRenderBoundary extends Component<
  { children: ReactNode; fallback: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    const development = (import.meta as ImportMeta & { env?: { DEV?: boolean } }).env?.DEV === true;
    if (development) {
      console.warn('[codex:math] Math node render failed', { error, info });
    }
  }

  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
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
  text: string;
}) {
  const title = file.line ? `${file.path}:${file.line}` : file.path;
  const linkStyle = {
    ...fileReferenceStyle(),
    ...style,
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
      <span className="codex-md-file-link-name">{text}</span>
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
