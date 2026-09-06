import { defaultTreeAdapter, html, parse, serialize, type DefaultTreeAdapterMap } from 'parse5';

export const HTML_PREVIEW_DOCUMENT_URL = 'https://html-preview.invalid/document';
export const HTML_PREVIEW_LINK_LIMIT = 100;

export const HTML_PREVIEW_CONTENT_SECURITY_POLICY = [
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  "img-src data: blob:",
  "font-src data:",
  "media-src data: blob:",
  "connect-src 'none'",
  "worker-src 'none'",
  "child-src 'none'",
  "frame-src 'none'",
  "object-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
].join('; ');

export type PreparedHtmlLink = Readonly<{
  href: string;
  label: string;
}>;

export type PreparedHtmlPreviewDocument = Readonly<{
  html: string;
  links: readonly PreparedHtmlLink[];
  linksTruncated: boolean;
}>;

export class HtmlPreviewPreparationError extends Error {
  override name = 'HtmlPreviewPreparationError';
}

type Document = DefaultTreeAdapterMap['document'];
type Element = DefaultTreeAdapterMap['element'];
type Node = DefaultTreeAdapterMap['node'];
type ParentNode = DefaultTreeAdapterMap['parentNode'];

function isElement(node: Node): node is Element {
  return 'tagName' in node;
}

function getAttribute(element: Element, name: string) {
  return element.attrs.find((attribute) => attribute.name.toLowerCase() === name)?.value;
}

function removeAttribute(element: Element, name: string) {
  element.attrs = element.attrs.filter((attribute) => attribute.name.toLowerCase() !== name);
}

function textContent(node: Node): string {
  if ('value' in node && typeof node.value === 'string') return node.value;
  if ('childNodes' in node) return node.childNodes.map(textContent).join('');
  return '';
}

function isCompanionHref(href: string) {
  const trimmed = href.trim();
  if (!trimmed || trimmed.startsWith('#')) return false;
  if (/^[a-z][a-z\d+.-]*:/iu.test(trimmed)) {
    return /^https?:/iu.test(trimmed);
  }
  return !trimmed.startsWith('//');
}

function walkAndHarden(parent: ParentNode, links: PreparedHtmlLink[], linkState: { seen: Set<string>; supported: number }) {
  for (let index = 0; index < parent.childNodes.length;) {
    const node = parent.childNodes[index];
    if (!isElement(node)) {
      index += 1;
      continue;
    }

    const tagName = node.tagName.toLowerCase();
    if (tagName === 'base' || (tagName === 'meta' && getAttribute(node, 'http-equiv')?.toLowerCase() === 'refresh')) {
      parent.childNodes.splice(index, 1);
      continue;
    }

    if (tagName === 'a') {
      const href = getAttribute(node, 'href');
      const normalizedHref = href?.trim();
      if (normalizedHref && isCompanionHref(normalizedHref) && !linkState.seen.has(normalizedHref)) {
        linkState.seen.add(normalizedHref);
        linkState.supported += 1;
        if (links.length < HTML_PREVIEW_LINK_LIMIT) {
          const authoredLabel = textContent(node).trim();
          links.push({ href: normalizedHref, label: (authoredLabel || normalizedHref).slice(0, 512) });
        }
      } else if (href && !href.trim().startsWith('#')) {
        // Prevent script/data/custom-scheme URL actions inside authored content.
        removeAttribute(node, 'href');
      }
      removeAttribute(node, 'ping');
    }

    if ('childNodes' in node) walkAndHarden(node, links, linkState);
    index += 1;
  }
}

function findElement(document: Document, tagName: string): Element | undefined {
  const queue: Node[] = [...document.childNodes];
  while (queue.length > 0) {
    const node = queue.shift()!;
    if (isElement(node) && node.tagName.toLowerCase() === tagName) return node;
    if ('childNodes' in node) queue.push(...node.childNodes);
  }
  return undefined;
}

export function prepareHtmlPreviewDocument(source: string): PreparedHtmlPreviewDocument {
  try {
    const document = parse(source) as Document;
    const links: PreparedHtmlLink[] = [];
    const linkState = { seen: new Set<string>(), supported: 0 };
    walkAndHarden(document, links, linkState);

    const head = findElement(document, 'head');
    if (!head) throw new HtmlPreviewPreparationError('HTML parser did not produce a document head.');

    const policy = defaultTreeAdapter.createElement(
      'meta',
      html.NS.HTML,
      [
        { name: 'http-equiv', value: 'Content-Security-Policy' },
        { name: 'content', value: HTML_PREVIEW_CONTENT_SECURITY_POLICY },
      ],
    );
    defaultTreeAdapter.appendChild(head, policy);
    head.childNodes.unshift(head.childNodes.pop()!);

    return {
      html: serialize(document),
      links,
      linksTruncated: linkState.supported > HTML_PREVIEW_LINK_LIMIT,
    };
  } catch (error) {
    if (error instanceof HtmlPreviewPreparationError) throw error;
    throw new HtmlPreviewPreparationError(
      `Could not prepare HTML preview: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
