import { useMemo, type CSSProperties, type MouseEvent, type ReactNode } from 'react';

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

const fallbackMarkdownWidth = 868;

export function MarkdownBlock({
  children,
  density = 'default',
  maxLines,
  streaming = false,
  width = fallbackMarkdownWidth,
}: {
  children: string;
  density?: MarkdownDensity;
  maxLines?: number;
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
        <MarkdownBlockNode block={block} key={`${block.type}:${index}`} />
      ))}
    </div>
  );
}

function MarkdownBlockNode({ block }: { block: MarkdownLayoutBlock }) {
  return (
    <div className="codex-md-block-frame" style={{ height: `${block.height}px` }}>
      <MarkdownBlockContent block={block} />
    </div>
  );
}

function MarkdownBlockContent({ block }: { block: MarkdownLayoutBlock }) {
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
      return <CodeBlock block={block} style={style} />;
    case 'blockquote':
      return (
        <blockquote className="codex-md-block codex-md-blockquote" style={style}>
          {block.children.map((child, index) => (
            <MarkdownBlockNode block={child} key={`${child.type}:${index}`} />
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
                    <MarkdownBlockNode block={child} key={`${child.type}:${childIndex}`} />
                  ))}
                </div>
              </div>
            </div>
          ))}
        </div>
      );
    case 'rule':
      return <hr className="codex-md-block codex-md-rule" style={style} />;
  }
}

function contentStyle(block: MarkdownLayoutBlock): CSSProperties {
  return {
    height: `${block.contentHeight}px`,
    transform: block.topGap ? `translateY(${block.topGap}px)` : undefined,
  };
}

function MarkdownTextLines({
  lineHeight,
  lines,
}: {
  lineHeight: number;
  lines: Extract<MarkdownLayoutBlock, { type: 'paragraph' | 'heading' }>['lines'];
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
              key={`${lineIndex}:${fragmentIndex}:${fragment.text}`}
            />
          ))}
        </div>
      ))}
    </>
  );
}

function MarkdownLineFragment({ fragment }: { fragment: MarkdownLayoutLineFragment }) {
  if (!fragment.text) {
    return null;
  }

  const style = fragment.gapBefore > 0 ? { marginLeft: `${fragment.gapBefore}px` } : undefined;
  const source = fragment.source;

  if (source.kind === 'fileLink' && source.file && source.href) {
    return <FileLink file={source.file} href={source.href} style={style} text={fragment.text} />;
  }

  if (source.kind === 'code') {
    const code = (
      <code className={inlineClassName(source)} style={style}>
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
      <a className={inlineClassName(source)} href={href} onClick={(event) => handleCodexLinkClick(event, href)} style={style}>
        {fragment.text}
      </a>
    );
  }

  const Tag = source.strong ? 'strong' : source.emphasis ? 'em' : 'span';

  return (
    <Tag className={inlineClassName(source)} style={style}>
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
