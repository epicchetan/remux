import ReactMarkdown, { type Components } from 'react-markdown';
import rehypeKatex from 'rehype-katex';
import rehypeRaw from 'rehype-raw';
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import { createElement, type ComponentPropsWithoutRef, type MouseEvent, type ReactNode } from 'react';

import { openHostFile } from '@remux/extension-api/host';

import { MarkdownCodeBlock } from './MarkdownCodeBlock';
import { MarkdownImage } from './MarkdownImage';

type MarkdownRendererProps = {
  content: string;
  filePath: string;
};

export function MarkdownRenderer({ content, filePath }: MarkdownRendererProps) {
  const components = markdownComponents(filePath);

  return (
    <article className="remux-markdown-document" data-file-path={filePath}>
      <ReactMarkdown
        components={components}
        rehypePlugins={[
          rehypeRaw,
          [rehypeSanitize, remuxMarkdownSanitizeSchema],
          rehypeKatex,
        ]}
        remarkPlugins={[
          remarkGfm,
          remarkGitHubAlerts,
          remarkMath,
        ]}
      >
        {content}
      </ReactMarkdown>
    </article>
  );
}

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
    pre({ children }) {
      return (
        <div className="remux-markdown-pre-block">
          {children}
        </div>
      );
    },
    table({ children, node: _node, ...props }) {
      return (
        <div className="remux-markdown-table-scroll">
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
  if (isExternalUrl(href)) {
    return;
  }

  const targetPath = filePathFromHref(href, filePath);
  if (!targetPath) {
    return;
  }

  void openHostFile({ path: targetPath });
}

function isExternalUrl(href: string) {
  return !/^[a-z]:[\\/]/iu.test(href)
    && (/^(?:[a-z][a-z\d+.-]*:)?\/\//iu.test(href) || /^(?:mailto:|tel:)/iu.test(href));
}

function filePathFromHref(href: string, filePath: string) {
  const pathPart = href.split(/[?#]/u, 1)[0];
  if (!pathPart) {
    return null;
  }

  const decodedPath = decodePathPart(pathPart);
  return decodedPath.startsWith('/')
    ? normalizePath(decodedPath)
    : normalizePath(`${dirname(filePath)}/${decodedPath}`);
}

function decodePathPart(pathPart: string) {
  try {
    return decodeURIComponent(pathPart);
  } catch {
    return pathPart;
  }
}

function dirname(filePath: string) {
  const normalized = filePath.replace(/\/+$/u, '');
  const index = normalized.lastIndexOf('/');
  return index > 0 ? normalized.slice(0, index) : '/';
}

function normalizePath(filePath: string) {
  const absolute = filePath.startsWith('/');
  const parts = filePath.split('/');
  const stack: string[] = [];

  for (const part of parts) {
    if (!part || part === '.') {
      continue;
    }

    if (part === '..') {
      stack.pop();
      continue;
    }

    stack.push(part);
  }

  return `${absolute ? '/' : ''}${stack.join('/')}`;
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

function remarkGitHubAlerts() {
  return (tree: MarkdownAstNode) => {
    visitMarkdownAst(tree, (node) => {
      if (node.type !== 'blockquote') {
        return;
      }

      const firstChild = node.children?.[0];
      const firstInline = firstChild?.children?.[0];
      if (firstChild?.type !== 'paragraph' || firstInline?.type !== 'text' || typeof firstInline.value !== 'string') {
        return;
      }

      const match = /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\][ \t]*(?:\n)?/iu.exec(firstInline.value);
      if (!match) {
        return;
      }

      const kind = match[1].toLowerCase();
      firstInline.value = firstInline.value.slice(match[0].length).replace(/^[ \t]*\n?/u, '');
      if (!firstInline.value && firstChild.children) {
        firstChild.children.shift();
      }
      if (firstChild.children?.length === 0) {
        node.children?.shift();
      }

      node.data = {
        ...(node.data ?? {}),
        hProperties: {
          ...(node.data?.hProperties ?? {}),
          className: [
            'remux-markdown-alert',
            `remux-markdown-alert-${kind}`,
          ],
        },
      };
    });
  };
}

type MarkdownAstNode = {
  children?: MarkdownAstNode[];
  data?: {
    hProperties?: Record<string, unknown>;
  };
  type?: string;
  value?: string;
};

function visitMarkdownAst(node: MarkdownAstNode, visitor: (node: MarkdownAstNode) => void) {
  visitor(node);
  for (const child of node.children ?? []) {
    visitMarkdownAst(child, visitor);
  }
}

const remuxMarkdownSanitizeSchema = {
  ...defaultSchema,
  attributes: {
    ...defaultSchema.attributes,
    a: [
      ...(defaultSchema.attributes?.a ?? []),
      ['dataFootnoteBackref'],
      ['dataFootnoteRef'],
      ['ariaDescribedBy'],
    ],
    blockquote: [
      ...(defaultSchema.attributes?.blockquote ?? []),
      ['className', 'remux-markdown-alert', /^remux-markdown-alert-(?:note|tip|important|warning|caution)$/u],
    ],
    code: [
      ...(defaultSchema.attributes?.code ?? []),
      ['className', /^language-[\w-]+$/u, 'math-inline', 'math-display'],
    ],
    div: [
      ...(defaultSchema.attributes?.div ?? []),
      ['className', 'math', 'math-display'],
    ],
    h1: [
      ...(defaultSchema.attributes?.h1 ?? []),
      ['id'],
    ],
    h2: [
      ...(defaultSchema.attributes?.h2 ?? []),
      ['id'],
    ],
    h3: [
      ...(defaultSchema.attributes?.h3 ?? []),
      ['id'],
    ],
    h4: [
      ...(defaultSchema.attributes?.h4 ?? []),
      ['id'],
    ],
    h5: [
      ...(defaultSchema.attributes?.h5 ?? []),
      ['id'],
    ],
    h6: [
      ...(defaultSchema.attributes?.h6 ?? []),
      ['id'],
    ],
    li: [
      ...(defaultSchema.attributes?.li ?? []),
      ['className', 'task-list-item'],
    ],
    ol: [
      ...(defaultSchema.attributes?.ol ?? []),
      ['className', 'contains-task-list'],
    ],
    section: [
      ...(defaultSchema.attributes?.section ?? []),
      ['className', 'footnotes'],
      ['dataFootnotes'],
    ],
    span: [
      ...(defaultSchema.attributes?.span ?? []),
      ['className', 'math', 'math-inline'],
    ],
    sup: [
      ...(defaultSchema.attributes?.sup ?? []),
      ['id'],
    ],
    ul: [
      ...(defaultSchema.attributes?.ul ?? []),
      ['className', 'contains-task-list'],
    ],
  },
};
