import { openHostHref } from '@remux/viewer-kit/links';
import {
  createElement,
  memo,
  type ComponentPropsWithoutRef,
  type MouseEvent,
  type ReactNode,
} from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';

import { MarkdownCodeBlock } from './MarkdownCodeBlock';
import { MarkdownImage } from './MarkdownImage';
import { markdownRehypePlugins, markdownRemarkPlugins } from './markdownPipeline';

export type MarkdownPreviewProps = {
  content: string;
  filePath: string;
  onShowSource?: () => void;
};

export const MarkdownPreview = memo(function MarkdownPreview({ content, filePath, onShowSource }: MarkdownPreviewProps) {
  // Bound the synchronous Markdown AST/DOM work separately from Source's byte
  // budget. CodeMirror can virtualize large text; ReactMarkdown cannot.
  if (content.length > 512_000 || exceedsLineBudget(content)) {
    return <section className="remux-editor-empty"><div className="remux-editor-empty-card">
      <div className="remux-editor-empty-title">This document is too large to preview</div>
      <p className="remux-editor-empty-copy">Open Source to read the complete file.</p>
      <button onClick={onShowSource}>Show source</button>
    </div></section>;
  }
  return (
    <section className="remux-viewer-markdown" data-file-path={filePath}>
      <article className="remux-viewer-markdown-document">
        <ReactMarkdown
          components={markdownComponents(filePath)}
          rehypePlugins={markdownRehypePlugins}
          remarkPlugins={markdownRemarkPlugins}
        >
          {content}
        </ReactMarkdown>
      </article>
    </section>
  );
});

function markdownComponents(filePath: string): Components {
  const headingSlugCounts = new Map<string, number>();
  const heading = (level: 1 | 2 | 3 | 4 | 5 | 6) => function Heading({ children, node: _node, ...props }: ComponentPropsWithoutRef<'h1'> & { node?: unknown }) {
    return <MarkdownHeading counts={headingSlugCounts} level={level} {...props}>{children}</MarkdownHeading>;
  };

  return {
    a({ children, href, node: _node, ...props }) {
      return <a {...props} href={href} onClick={(event) => handleLink(event, href, filePath)} rel="noreferrer">{children}</a>;
    },
    blockquote({ children, className, node: _node, ...props }) {
      const alertKind = alertKindFromClassName(className);
      return (
        <blockquote className={className} {...props}>
          {alertKind ? <div className="remux-viewer-markdown-alert-title">{alertKind}</div> : null}
          {children}
        </blockquote>
      );
    },
    code(props) {
      return <MarkdownCodeBlock {...props} />;
    },
    h1: heading(1), h2: heading(2), h3: heading(3),
    h4: heading(4), h5: heading(5), h6: heading(6),
    img({ alt, node: _node, src, ...props }) {
      return <span className="remux-viewer-markdown-image-wrap"><MarkdownImage alt={alt ?? ''} filePath={filePath} src={src} {...props} /></span>;
    },
    pre({ children }) {
      return <div className="remux-viewer-markdown-pre-block">{children}</div>;
    },
    table({ children, node: _node, ...props }) {
      return <div className="remux-viewer-markdown-table-scroll"><table {...props}>{children}</table></div>;
    },
  };
}

function MarkdownHeading({ children, counts, level, ...props }: ComponentPropsWithoutRef<'h1'> & {
  counts: Map<string, number>;
  level: 1 | 2 | 3 | 4 | 5 | 6;
}) {
  return createElement(`h${level}`, { ...props, id: props.id ?? uniqueSlug(nodeText(children), counts) }, children);
}

function handleLink(event: MouseEvent<HTMLAnchorElement>, href: string | undefined, filePath: string) {
  if (!href) return;
  if (href.startsWith('#')) {
    const fragment = decodeFragment(href.slice(1));
    // Sanitization prefixes IDs to prevent DOM clobbering; generated footnote
    // links retain their original fragment and need the same safe lookup.
    const target = document.getElementById(fragment) ?? document.getElementById(`user-content-${fragment}`);
    if (!target) return;
    event.preventDefault();
    target.scrollIntoView({ behavior: 'smooth', block: 'start' });
    window.history.replaceState(null, '', `#${encodeURIComponent(target.id)}`);
    return;
  }
  event.preventDefault();
  void openHostHref(href, { baseFilePath: filePath, parseLine: true });
}

function decodeFragment(value: string) {
  try { return decodeURIComponent(value); } catch { return value; }
}

function uniqueSlug(children: ReactNode, counts: Map<string, number>) {
  const base = nodeText(children).trim().toLowerCase()
    .replace(/[^\p{Letter}\p{Number}\s-]/gu, '')
    .replace(/\s+/gu, '-')
    .replace(/-+/gu, '-')
    .replace(/^-|-$/gu, '') || 'section';
  const count = counts.get(base) ?? 0;
  counts.set(base, count + 1);
  return count === 0 ? base : `${base}-${count}`;
}

function nodeText(node: ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(nodeText).join('');
  if (node && typeof node === 'object' && 'props' in node) {
    return nodeText((node as { props?: { children?: ReactNode } }).props?.children);
  }
  return '';
}

function alertKindFromClassName(className: string | undefined) {
  const match = /(?:^|\s)remux-viewer-markdown-alert-(note|tip|important|warning|caution)(?:\s|$)/u.exec(className ?? '');
  return match?.[1]?.toUpperCase() ?? null;
}

function exceedsLineBudget(content: string) {
  let lines = 1;
  for (let index = 0; index < content.length; index += 1) {
    if (content.charCodeAt(index) === 10 && ++lines > 10_000) return true;
  }
  return false;
}
