import type { TranscriptGeometryIndex } from '../geometry/geometryIndex';
import { transcriptViewportAnchorScrollTop } from './viewportReducer';
import type { TranscriptViewportAnchor } from './viewportTypes';

export function distanceFromBottom(node: HTMLElement) {
  return Math.max(0, node.scrollHeight - node.clientHeight - node.scrollTop);
}

export function maxScrollableTop(node: HTMLElement) {
  return Math.max(0, node.scrollHeight - node.clientHeight);
}

export function computeAnchorExtentFloorHeight(
  viewport: HTMLElement,
  content: HTMLElement,
  desiredScrollTop: number,
) {
  const viewportBounds = viewport.getBoundingClientRect();
  const contentBounds = content.getBoundingClientRect();
  const contentTop = viewport.scrollTop + contentBounds.top - viewportBounds.top;
  return Math.max(0, Math.ceil(desiredScrollTop + viewport.clientHeight - contentTop));
}

export function naturalTranscriptMaxScrollableTop(
  viewport: HTMLElement,
  transcriptBody: HTMLElement | null,
  content: HTMLElement | null,
) {
  if (!transcriptBody || !content) return maxScrollableTop(viewport);
  const viewportBounds = viewport.getBoundingClientRect();
  const bodyBounds = transcriptBody.getBoundingClientRect();
  const contentStyle = window.getComputedStyle(content);
  const bodyBottom = viewport.scrollTop + bodyBounds.bottom - viewportBounds.top;
  return Math.max(
    0,
    bodyBottom + parseCssPixels(contentStyle.paddingBottom, 0) - viewport.clientHeight,
  );
}

export function naturalTranscriptContentMaxScrollableTop(
  viewport: HTMLElement,
  transcriptBody: HTMLElement | null,
) {
  if (!transcriptBody) return maxScrollableTop(viewport);
  const viewportBounds = viewport.getBoundingClientRect();
  const bodyBounds = transcriptBody.getBoundingClientRect();
  const bodyBottom = viewport.scrollTop + bodyBounds.bottom - viewportBounds.top;
  return Math.max(0, bodyBottom - viewport.clientHeight);
}

export function captureTranscriptViewportAnchor({
  geometry,
  scrollTop,
  topPadding,
}: {
  geometry: TranscriptGeometryIndex;
  scrollTop: number;
  topPadding: number;
}): TranscriptViewportAnchor | null {
  const positions = geometry.rowPositions(topPadding);
  if (positions.length === 0) return null;

  let anchor = positions[0]!;
  const target = scrollTop + 1;
  for (const position of positions) {
    if (position.scrollTop > target) break;
    anchor = position;
  }
  return {
    offset: scrollTop - anchor.scrollTop,
    rowId: anchor.rowId,
    segmentId: anchor.segmentId,
    turnId: anchor.turnId,
  };
}

export function scrollTopForViewportAnchor({
  anchor,
  geometry,
  topPadding,
}: {
  anchor: TranscriptViewportAnchor;
  geometry: TranscriptGeometryIndex;
  topPadding: number;
}) {
  return transcriptViewportAnchorScrollTop(anchor, geometry.rowPositions(topPadding));
}

export function parseCssPixels(value: string, fallback: number) {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}
