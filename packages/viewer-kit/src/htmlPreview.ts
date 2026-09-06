import { defaultTreeAdapter, html, parse, serialize, type DefaultTreeAdapterMap } from 'parse5';

export const HTML_PREVIEW_LINK_LIMIT = 100;
export const HTML_PREVIEW_CONTENT_SECURITY_POLICY = [
  "default-src 'none'", "script-src 'unsafe-inline'", "style-src 'unsafe-inline'",
  'img-src data: blob:', 'font-src data:', 'media-src data: blob:', "connect-src 'none'",
  "worker-src 'none'", "child-src 'none'", "frame-src 'none'", "object-src 'none'",
  "form-action 'none'", "base-uri 'none'",
].join('; ');

export type PreparedHtmlLink = Readonly<{ href: string; label: string }>;
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
function isElement(node: Node): node is Element { return 'tagName' in node; }
function attribute(element: Element, name: string) { return element.attrs.find((item) => item.name.toLowerCase() === name)?.value; }
function removeAttribute(element: Element, name: string) { element.attrs = element.attrs.filter((item) => item.name.toLowerCase() !== name); }
function textContent(node: Node): string {
  if ('value' in node && typeof node.value === 'string') return node.value;
  return 'childNodes' in node ? node.childNodes.map(textContent).join('') : '';
}
function companionHref(href: string) {
  const value = href.trim();
  if (!value || value.startsWith('#')) return false;
  if (/^[a-z][a-z\d+.-]*:/iu.test(value)) return /^https?:/iu.test(value);
  return !value.startsWith('//');
}
function harden(parent: ParentNode, links: PreparedHtmlLink[], state: { seen: Set<string>; supported: number }) {
  for (let index = 0; index < parent.childNodes.length;) {
    const node = parent.childNodes[index];
    if (!isElement(node)) { index += 1; continue; }
    const tag = node.tagName.toLowerCase();
    if (tag === 'base' || (tag === 'meta' && attribute(node, 'http-equiv')?.toLowerCase() === 'refresh')) {
      parent.childNodes.splice(index, 1);
      continue;
    }
    if (tag === 'a') {
      const href = attribute(node, 'href');
      const normalized = href?.trim();
      if (normalized && companionHref(normalized) && !state.seen.has(normalized)) {
        state.seen.add(normalized);
        state.supported += 1;
        if (links.length < HTML_PREVIEW_LINK_LIMIT) {
          links.push({ href: normalized, label: (textContent(node).trim() || normalized).slice(0, 512) });
        }
      } else if (href && !href.trim().startsWith('#')) {
        removeAttribute(node, 'href');
      }
      removeAttribute(node, 'ping');
    }
    if ('childNodes' in node) harden(node, links, state);
    index += 1;
  }
}
function findElement(document: Document, tagName: string): Element | undefined {
  const queue: Node[] = [...document.childNodes];
  while (queue.length) {
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
    const state = { seen: new Set<string>(), supported: 0 };
    harden(document, links, state);
    const head = findElement(document, 'head');
    if (!head) throw new HtmlPreviewPreparationError('HTML parser did not produce a document head.');
    const policy = defaultTreeAdapter.createElement('meta', html.NS.HTML, [
      { name: 'http-equiv', value: 'Content-Security-Policy' },
      { name: 'content', value: HTML_PREVIEW_CONTENT_SECURITY_POLICY },
    ]);
    defaultTreeAdapter.appendChild(head, policy);
    head.childNodes.unshift(head.childNodes.pop()!);
    return { html: serialize(document), links, linksTruncated: state.supported > HTML_PREVIEW_LINK_LIMIT };
  } catch (error) {
    if (error instanceof HtmlPreviewPreparationError) throw error;
    throw new HtmlPreviewPreparationError(`Could not prepare HTML preview: ${error instanceof Error ? error.message : String(error)}`);
  }
}
