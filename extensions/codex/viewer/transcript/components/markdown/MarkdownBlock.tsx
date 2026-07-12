import { memo, useMemo, type CSSProperties, type MouseEvent, type RefCallback } from 'react';

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
import { fileReferenceStyle } from '../file/FileReferenceChip';
import { FileTypeIcon } from '../file/fileTypeIcons';
import { cn } from '@remux/viewer-kit/shadcn';
import { openHostHref, openHostTarget } from '@remux/viewer-kit/links';
import type { CodexNarrationSourceTarget } from '../../../../shared/narration';
import { useNarrationTargetRef } from '../../../narration/targetRegistry';
import { useNarrationTextLeafRegistration } from '../../../narration/textLeafRegistry';

const fallbackMarkdownWidth = 868;

export function MarkdownBlock({
  children,
  density = 'default',
  narrationAssistantMessageId = null,
  narrationTargets = [],
  maxLines,
  streaming = false,
  width = fallbackMarkdownWidth,
}: {
  children: string;
  density?: MarkdownDensity;
  maxLines?: number;
  narrationAssistantMessageId?: string | null;
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
  targets,
}: {
  assistantMessageId: string | null;
  block: MarkdownLayoutBlock;
  targets: CodexNarrationSourceTarget[];
}) {
  const blockTargets = targets.filter((target) => target.blockId === block.narrationId && target.kind === 'block');
  const targetRef = useNarrationTargetRef(assistantMessageId, blockTargets.map((target) => target.id));
  return (
    <div
      className="codex-md-block-frame"
      data-narration-block-id={block.narrationId}
      ref={targetRef}
      style={{ height: `${block.height}px` }}
    >
      <div aria-hidden="true" className="codex-narration-paint-layer" hidden />
      <MarkdownBlockContent
        assistantMessageId={assistantMessageId}
        block={block}
        targets={targets}
      />
    </div>
  );
}, (previous, next) => (
  previous.assistantMessageId === next.assistantMessageId &&
  previous.block === next.block &&
  previous.targets === next.targets
));

function MarkdownBlockContent({
  assistantMessageId,
  block,
  targets,
}: {
  assistantMessageId: string | null;
  block: MarkdownLayoutBlock;
  targets: CodexNarrationSourceTarget[];
}) {
  const style = contentStyle(block);
  switch (block.type) {
    case 'paragraph':
      return (
        <div className="codex-md-block codex-md-paragraph" data-narration-surface="prose" style={style}>
          <MarkdownTextLines assistantMessageId={assistantMessageId} blockId={block.narrationId} lineHeight={block.lineHeight} lines={block.lines} />
        </div>
      );
    case 'heading': {
      const HeadingTag = `h${block.depth}` as 'h1' | 'h2' | 'h3';
      return (
        <HeadingTag className="codex-md-block codex-md-heading" data-depth={block.depth} data-narration-surface="prose" style={style}>
          <MarkdownTextLines assistantMessageId={assistantMessageId} blockId={block.narrationId} lineHeight={block.lineHeight} lines={block.lines} />
        </HeadingTag>
      );
    }
    case 'code':
      return <CodeBlock
        block={block}
        style={style}
      />;
    case 'blockquote':
      return (
        <blockquote className="codex-md-block codex-md-blockquote" style={style}>
          {block.children.map((child, index) => (
            <MarkdownBlockNode assistantMessageId={assistantMessageId} block={child} key={`${child.type}:${index}`} targets={targets} />
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
                    <MarkdownBlockNode assistantMessageId={assistantMessageId} block={child} key={`${child.type}:${childIndex}`} targets={targets} />
                  ))}
                </div>
              </div>
            </div>
          ))}
        </div>
      );
    case 'table':
      return <MarkdownTable
        assistantMessageId={assistantMessageId}
        block={block}
        style={style}
      />;
    case 'rule':
      return <hr className="codex-md-block codex-md-rule" style={style} />;
  }
}

function MarkdownTable({
  assistantMessageId,
  block,
  style,
}: {
  assistantMessageId: string | null;
  block: Extract<MarkdownLayoutBlock, { type: 'table' }>;
  style: CSSProperties;
}) {
  const gridTemplateColumns = block.columnWidths.map((columnWidth) => `${columnWidth}px`).join(' ');

  return (
    <div className="codex-md-block codex-md-table-scroll" style={style}>
      <div
        className="codex-md-table"
        data-narration-surface="table"
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
                assistantMessageId={assistantMessageId}
                blockId={block.narrationId}
                column={cellIndex}
                header={row.header}
                key={cellIndex}
                lineHeight={block.lineHeight}
                lines={cell.lines}
                row={rowIndex}
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
  assistantMessageId,
  blockId,
  column,
  header,
  lineHeight,
  lines,
  row,
}: {
  align: string | null;
  assistantMessageId: string | null;
  blockId: string;
  column: number;
  header: boolean;
  lineHeight: number;
  lines: Extract<MarkdownLayoutBlock, { type: 'table' }>['rows'][number]['cells'][number]['lines'];
  row: number;
}) {
  return (
    <div
      className="codex-md-table-cell"
      data-align={align ?? 'left'}
      data-narration-column={column}
      data-narration-row={row}
      role={header ? 'columnheader' : 'cell'}
    >
      <MarkdownTextLines assistantMessageId={assistantMessageId} blockId={blockId} lineHeight={lineHeight} lines={lines} />
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
  assistantMessageId,
  blockId,
  lineHeight,
  lines,
}: {
  assistantMessageId: string | null;
  blockId: string;
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
              assistantMessageId={assistantMessageId}
              blockId={blockId}
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
  assistantMessageId,
  blockId,
  fragment,
}: {
  assistantMessageId: string | null;
  blockId: string;
  fragment: MarkdownLayoutLineFragment;
}) {
  const registration = useNarrationTextLeafRegistration({
    assistantMessageId,
    blockId,
    displayEnd: fragment.displayEnd,
    displayStart: fragment.displayStart,
    expectedText: fragment.text,
  });
  if (!fragment.text) return null;
  const style = fragment.gapBefore > 0 ? { marginLeft: `${fragment.gapBefore}px` } : undefined;
  const source = fragment.source;

  if (source.kind === 'fileLink' && source.file && source.href) {
    return <FileLink
      file={source.file}
      href={source.href}
      style={style}
      text={fragment.text}
      textRef={registration.setTextElement}
    />;
  }

  if (source.kind === 'code') {
    const code = (
      <code className={inlineClassName(source)} ref={registration.setTextElement} style={style}>
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
      <a className={inlineClassName(source)} href={href} onClick={(event) => handleCodexLinkClick(event, href)} ref={registration.setTextElement} style={style}>
        {fragment.text}
      </a>
    );
  }

  const Tag = source.strong ? 'strong' : source.emphasis ? 'em' : 'span';

  return (
    <Tag className={inlineClassName(source)} ref={registration.setTextElement} style={style}>
      {fragment.text}
    </Tag>
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
  textRef,
}: {
  file: MarkdownFileLink;
  href: string;
  style?: CSSProperties;
  text: string;
  textRef: RefCallback<HTMLElement>;
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
      <span className="codex-md-file-link-name" ref={textRef}>{text}</span>
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
