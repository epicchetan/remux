import ReactMarkdown, { type Components } from 'react-markdown';
import {
  createElement,
  memo,
  useLayoutEffect,
  useRef,
  type ComponentPropsWithoutRef,
  type MouseEvent,
  type ReactNode,
} from 'react';
import type { Pluggable, PluggableList } from 'unified';

import { openHostHref } from '@remux/viewer-kit/links';

import { MarkdownCodeBlock } from './MarkdownCodeBlock';
import { MarkdownImage } from './MarkdownImage';
import { markdownRehypePlugins, markdownRemarkPlugins } from './markdownPipeline';
import { rehypeNarrationBindings } from './narrationBindings';
import type { MarkdownNarrationModel } from './narrationModel';
import { useNarrationStore } from '../narration/client';
import { registerNarrationDom } from '../narration/domIndex';

type MarkdownRendererProps = {
  content: string;
  filePath: string;
  narrationModel: MarkdownNarrationModel | null;
};

export const MarkdownRenderer = memo(function MarkdownRenderer({
  content,
  filePath,
  narrationModel,
}: MarkdownRendererProps) {
  const articleRef = useRef<HTMLElement | null>(null);
  const components = markdownComponents(filePath);
  const narrationBinding: Pluggable | null = narrationModel
    ? [rehypeNarrationBindings, { model: narrationModel }]
    : null;
  const rehypePlugins: PluggableList = narrationBinding
    ? [...markdownRehypePlugins, narrationBinding]
    : markdownRehypePlugins;

  useLayoutEffect(() => {
    if (!articleRef.current || !narrationModel) {
      return undefined;
    }
    return registerNarrationDom(articleRef.current, narrationModel);
  }, [narrationModel]);

  const seekFromClick = (event: MouseEvent<HTMLElement>) => {
    const narration = useNarrationStore.getState();
    const narrationSeekable = Boolean(
      narrationModel
      && narration.target?.sourceHash === narrationModel.sourceHash
      && (narration.phase === 'ready'
        || narration.phase === 'buffering'
        || narration.phase === 'playing'
        || narration.phase === 'paused'),
    );
    if (!narrationSeekable || !(event.target instanceof Element)) {
      return;
    }
    if (event.target.closest('a, button, input, [data-remux-no-narration-seek]')) {
      return;
    }
    const selection = window.getSelection();
    if (selection && !selection.isCollapsed) {
      return;
    }
    const blockId = event.target.closest<HTMLElement>('[data-narration-block-id]')
      ?.dataset.narrationBlockId;
    if (!blockId) {
      return;
    }
    if (narration.followSuspendedByUser) {
      narration.toggleFollow();
    }
    void narration.seekToBlock(blockId);
  };

  return (
    <article
      className="remux-markdown-document"
      data-file-path={filePath}
      onClick={seekFromClick}
      ref={articleRef}
    >
      <ReactMarkdown
        components={components}
        rehypePlugins={rehypePlugins}
        remarkPlugins={markdownRemarkPlugins}
      >
        {content}
      </ReactMarkdown>
    </article>
  );
});

function markdownComponents(filePath: string): Components {
  const headingSlugCounts = new Map<string, number>();

  return {
    a({ children, href, node: _node, ...props }) {
      return (
        <a
          {...props}
          href={href}
          onClick={(event) => {
            handleMarkdownLinkClick(event, href, filePath);
          }}
          rel="noreferrer"
        >
          {children}
        </a>
      );
    },
    blockquote({ children, className, node: _node, ...props }) {
      const alertKind = alertKindFromClassName(className);
      if (!alertKind) {
        return <blockquote className={className} {...props}>{children}</blockquote>;
      }

      return (
        <blockquote className={className} {...props}>
          <div className="remux-markdown-alert-title">
            {alertKind}
          </div>
          {children}
        </blockquote>
      );
    },
    code(props) {
      return <MarkdownCodeBlock {...props} />;
    },
    div({ children, className, node: _node, ...props }) {
      const data = props as typeof props & Record<string, unknown>;
      const displayMathSurface = data['data-narration-surface'] === 'block'
        && isDisplayMathClassName(className);
      return (
        <div
          {...props}
          className={className}
          data-narration-render-surface={displayMathSurface ? 'code' : undefined}
        >
          {children}
        </div>
      );
    },
    h1({ children, node: _node, ...props }) {
      return <MarkdownHeading counts={headingSlugCounts} level={1} {...props}>{children}</MarkdownHeading>;
    },
    h2({ children, node: _node, ...props }) {
      return <MarkdownHeading counts={headingSlugCounts} level={2} {...props}>{children}</MarkdownHeading>;
    },
    h3({ children, node: _node, ...props }) {
      return <MarkdownHeading counts={headingSlugCounts} level={3} {...props}>{children}</MarkdownHeading>;
    },
    h4({ children, node: _node, ...props }) {
      return <MarkdownHeading counts={headingSlugCounts} level={4} {...props}>{children}</MarkdownHeading>;
    },
    h5({ children, node: _node, ...props }) {
      return <MarkdownHeading counts={headingSlugCounts} level={5} {...props}>{children}</MarkdownHeading>;
    },
    h6({ children, node: _node, ...props }) {
      return <MarkdownHeading counts={headingSlugCounts} level={6} {...props}>{children}</MarkdownHeading>;
    },
    img({ alt, node: _node, src, ...props }) {
      return (
        <span className="remux-markdown-image-wrap">
          <MarkdownImage alt={alt ?? ''} filePath={filePath} src={src} {...props} />
        </span>
      );
    },
    pre({ children, node: _node, ...props }) {
      const data = props as typeof props & Record<string, unknown>;
      return (
        <div
          className="remux-markdown-pre-block"
          data-narration-binding-error={data['data-narration-binding-error'] as string | undefined}
          data-narration-block-id={data['data-narration-block-id'] as string | undefined}
          data-narration-surface={data['data-narration-surface'] as string | undefined}
        >
          {children}
        </div>
      );
    },
    span({ children, className, node: _node, ...props }) {
      const data = props as typeof props & Record<string, unknown>;
      const displayMathSurface = data['data-narration-surface'] === 'block'
        && isDisplayMathClassName(className);
      return (
        <span
          {...props}
          className={className}
          data-narration-render-surface={displayMathSurface ? 'code' : undefined}
        >
          {children}
        </span>
      );
    },
    table({ children, node: _node, ...props }) {
      return (
        <div
          className="remux-markdown-table-scroll"
          data-narration-render-surface="table"
        >
          <table {...props}>{children}</table>
        </div>
      );
    },
  };
}

function MarkdownHeading({
  children,
  counts,
  level,
  ...props
}: ComponentPropsWithoutRef<'h1'> & {
  counts: Map<string, number>;
  level: 1 | 2 | 3 | 4 | 5 | 6;
}) {
  const slug = uniqueSlug(reactNodeText(children), counts);
  return createElement(`h${level}`, {
    ...props,
    id: slug,
  }, children);
}

function scrollToHeading(event: MouseEvent<HTMLAnchorElement>, href: string) {
  const rawId = href.slice(1);
  if (!rawId) {
    return;
  }

  let id = rawId;
  try {
    id = decodeURIComponent(rawId);
  } catch {
    id = rawId;
  }

  const target = document.getElementById(id);
  if (!target) {
    return;
  }

  event.preventDefault();
  target.scrollIntoView({
    behavior: 'smooth',
    block: 'start',
  });
  window.history.replaceState(null, '', `#${encodeURIComponent(id)}`);
}

function handleMarkdownLinkClick(
  event: MouseEvent<HTMLAnchorElement>,
  href: string | undefined,
  filePath: string,
) {
  if (!href) {
    event.preventDefault();
    return;
  }

  if (href.startsWith('#')) {
    scrollToHeading(event, href);
    return;
  }

  event.preventDefault();
  void openHostHref(href, { baseFilePath: filePath, parseLine: true });
}

function uniqueSlug(text: string, counts: Map<string, number>) {
  const base = slugifyHeading(text) || 'section';
  const count = counts.get(base) ?? 0;
  counts.set(base, count + 1);
  return count === 0 ? base : `${base}-${count}`;
}

function slugifyHeading(text: string) {
  return text
    .trim()
    .toLowerCase()
    .replace(/[^\p{Letter}\p{Number}\s-]/gu, '')
    .replace(/\s+/gu, '-')
    .replace(/-+/gu, '-')
    .replace(/^-|-$/gu, '');
}

function reactNodeText(node: ReactNode): string {
  if (node === null || node === undefined || typeof node === 'boolean') {
    return '';
  }

  if (typeof node === 'string' || typeof node === 'number') {
    return String(node);
  }

  if (Array.isArray(node)) {
    return node.map((child) => reactNodeText(child)).join('');
  }

  if (typeof node === 'object' && 'props' in node) {
    return reactNodeText((node as { props?: { children?: ReactNode } }).props?.children);
  }

  return '';
}

function alertKindFromClassName(className: string | undefined) {
  const match = /(?:^|\s)remux-markdown-alert-(note|tip|important|warning|caution)(?:\s|$)/u.exec(className ?? '');
  return match?.[1]?.toUpperCase() ?? null;
}

function isDisplayMathClassName(className: string | undefined) {
  const names = className?.split(/\s+/u) ?? [];
  return names.includes('math-display') || names.includes('katex-display');
}
