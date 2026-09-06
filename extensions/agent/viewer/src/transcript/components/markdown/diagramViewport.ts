export type DiagramPoint = Readonly<{ x: number; y: number }>;
export type DiagramSize = Readonly<{ height: number; width: number }>;
export type DiagramTransform = Readonly<{ panX: number; panY: number; zoom: number }>;

export const diagramZoom = { max: 8, min: 1 } as const;
export const initialDiagramTransform: DiagramTransform = { panX: 0, panY: 0, zoom: 1 };

export function fitDiagramImage(viewport: DiagramSize, image: DiagramSize): DiagramSize {
  if (viewport.width <= 0 || viewport.height <= 0 || image.width <= 0 || image.height <= 0) {
    return { height: 0, width: 0 };
  }
  const scale = Math.min(1, viewport.width / image.width, viewport.height / image.height);
  return { height: image.height * scale, width: image.width * scale };
}

export function clampDiagramTransform(
  transform: DiagramTransform,
  viewport: DiagramSize,
  fittedImage: DiagramSize,
): DiagramTransform {
  const zoom = Math.min(diagramZoom.max, Math.max(diagramZoom.min, transform.zoom));
  if (zoom === diagramZoom.min) return initialDiagramTransform;
  const limitX = Math.max(0, (fittedImage.width * zoom - viewport.width) / 2);
  const limitY = Math.max(0, (fittedImage.height * zoom - viewport.height) / 2);
  return {
    panX: Math.min(limitX, Math.max(-limitX, transform.panX)),
    panY: Math.min(limitY, Math.max(-limitY, transform.panY)),
    zoom,
  };
}

export function panDiagram(
  transform: DiagramTransform,
  delta: DiagramPoint,
  viewport: DiagramSize,
  fittedImage: DiagramSize,
) {
  return clampDiagramTransform({
    ...transform,
    panX: transform.panX + delta.x,
    panY: transform.panY + delta.y,
  }, viewport, fittedImage);
}

export function zoomDiagramAt(
  transform: DiagramTransform,
  nextZoom: number,
  previousFocal: DiagramPoint,
  nextFocal: DiagramPoint,
  viewport: DiagramSize,
  fittedImage: DiagramSize,
) {
  const zoom = Math.min(diagramZoom.max, Math.max(diagramZoom.min, nextZoom));
  if (zoom === diagramZoom.min) return initialDiagramTransform;
  const center = { x: viewport.width / 2, y: viewport.height / 2 };
  const ratio = zoom / transform.zoom;
  return clampDiagramTransform({
    panX: nextFocal.x - center.x - (previousFocal.x - center.x - transform.panX) * ratio,
    panY: nextFocal.y - center.y - (previousFocal.y - center.y - transform.panY) * ratio,
    zoom,
  }, viewport, fittedImage);
}
