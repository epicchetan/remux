// Preserve the visible Markdown block when newly rendered diagram dimensions
// change its position within an assistant message (a row anchor is too coarse).
export type DiagramLayoutAnchor = { element: HTMLElement; offset: number };

export function captureDiagramLayoutAnchor(viewport: HTMLElement): DiagramLayoutAnchor | null {
  const bounds = viewport.getBoundingClientRect();
  for (const element of viewport.querySelectorAll<HTMLElement>('[data-markdown-block-id]')) {
    if (element.querySelector('[data-markdown-block-id]')) continue;
    const rect = element.getBoundingClientRect();
    if (rect.bottom > bounds.top && rect.top < bounds.bottom) {
      return { element, offset: rect.top - bounds.top };
    }
  }
  return null;
}

export function scrollTopForDiagramLayoutAnchor(viewport: HTMLElement, anchor: DiagramLayoutAnchor): number | null {
  if (!viewport.contains(anchor.element)) return null;
  return viewport.scrollTop + anchor.element.getBoundingClientRect().top
    - viewport.getBoundingClientRect().top - anchor.offset;
}
