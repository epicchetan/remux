import rehypeKatex from 'rehype-katex';
import rehypeRaw from 'rehype-raw';
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import type { Element, Root, RootContent, Text } from 'hast';
import type { PluggableList, Plugin } from 'unified';

export function remarkGitHubAlerts() {
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

// mdast-util-to-hast emits a literal newline text node after every Markdown
// hard-break element so serialized HTML stays readable. The <br> already owns
// that logical newline for narration, so remove the serialization-only copy in
// the exact tree shared by model projection and React rendering.
export const rehypeNormalizeBreakText: Plugin<[], Root> = () => (
  (tree: Root) => normalizeBreakText(tree)
);

function normalizeBreakText(parent: Root | Element) {
  for (let index = 0; index < parent.children.length; index += 1) {
    const child = parent.children[index];
    if (isHastElement(child)) {
      normalizeBreakText(child);
    }
    if (!isHastElement(child) || child.tagName !== 'br') {
      continue;
    }
    const next = parent.children[index + 1];
    if (!isHastText(next) || !next.value.startsWith('\n')) {
      continue;
    }
    next.value = next.value.slice(1);
    if (!next.value) {
      parent.children.splice(index + 1, 1);
    }
  }
}

function isHastElement(node: RootContent): node is Element {
  return node.type === 'element';
}

function isHastText(node: RootContent | undefined): node is Text {
  return node?.type === 'text';
}

export const remuxMarkdownSanitizeSchema = {
  ...defaultSchema,
  protocols: {
    ...defaultSchema.protocols,
    href: ['http', 'https', 'file'],
  },
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

export const markdownRemarkPlugins: PluggableList = [
  remarkGfm,
  remarkGitHubAlerts,
  remarkMath,
];

export const markdownRehypePlugins: PluggableList = [
  rehypeRaw,
  [rehypeSanitize, remuxMarkdownSanitizeSchema],
  rehypeNormalizeBreakText,
  rehypeKatex,
];
