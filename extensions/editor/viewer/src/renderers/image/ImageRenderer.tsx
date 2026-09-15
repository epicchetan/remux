import { useEffect, useRef, useState, type PointerEvent, type WheelEvent } from 'react';
import type { RendererProps } from '../registry';

type Point = { x: number; y: number };
type Size = { width: number; height: number };
type Transform = Point & { scale: number };
const distance = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);
const midpoint = (a: Point, b: Point): Point => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
const doubleTapMs = 300;
const doubleTapDistance = 30;
// How much of an overshoot survives while a finger is still down; the rest
// springs back on release.
const give = 0.35;

// The rest state is fit-to-screen on both axes. Zooming stops at 1:1 or four
// times fit, whichever is larger, so small images can still be enlarged.
const fitScale = (stage: Size, natural: Size) => Math.min(stage.width / natural.width, stage.height / natural.height);
const maxScale = (fit: number) => Math.max(1, fit * 4);
const zoomedIn = (scale: number, fit: number) => scale > fit * 1.001;

function settle(value: number, min: number, max: number, slack: number) {
  const clamped = Math.min(max, Math.max(min, value));
  return clamped + (value - clamped) * slack;
}

// Keeps the image inside the stage: axes shorter than the stage are centered,
// longer ones may not expose the background. With slack, the excess is kept
// as a rubber band; with none, the transform is fully clamped.
function constrain(transform: Transform, stage: Size, natural: Size, slack: number): Transform {
  const fit = fitScale(stage, natural);
  const scale = slack ? Math.min(maxScale(fit) * 1.5, Math.max(fit * 0.5, transform.scale)) : Math.min(maxScale(fit), Math.max(fit, transform.scale));
  const ratio = scale / transform.scale;
  // A scale correction pivots on the stage center, then the offsets clamp.
  const center = { x: stage.width / 2, y: stage.height / 2 };
  const x = center.x - (center.x - transform.x) * ratio;
  const y = center.y - (center.y - transform.y) * ratio;
  const axis = (value: number, stageSize: number, imageSize: number) => imageSize <= stageSize
    ? settle(value, (stageSize - imageSize) / 2, (stageSize - imageSize) / 2, slack)
    : settle(value, stageSize - imageSize, 0, slack);
  return { scale, x: axis(x, stage.width, natural.width * scale), y: axis(y, stage.height, natural.height * scale) };
}

function fitTransform(stage: Size, natural: Size): Transform {
  const scale = fitScale(stage, natural);
  return { scale, x: (stage.width - natural.width * scale) / 2, y: (stage.height - natural.height * scale) / 2 };
}

function scaleAbout(transform: Transform, scale: number, pivot: Point): Transform {
  const ratio = scale / transform.scale;
  return { scale, x: pivot.x - (pivot.x - transform.x) * ratio, y: pivot.y - (pivot.y - transform.y) * ratio };
}

export function Component({ document, descriptor, onInfo, onReload, onError }: RendererProps) {
  const stage = useRef<HTMLDivElement>(null);
  const pointers = useRef(new Map<number, Point>());
  const gesture = useRef<{ points: Point[]; transform: Transform; moved: boolean } | null>(null);
  const lastTap = useRef<{ at: number; point: Point } | null>(null);
  const [natural, setNatural] = useState<Size | null>(null);
  const [stageSize, setStageSize] = useState<Size | null>(null);
  const [transform, setTransform] = useState<Transform | null>(null);
  const [settling, setSettling] = useState(false);
  const [failed, setFailed] = useState(false);
  const transformRef = useRef(transform);
  const url = document.kind === 'media' ? document.url : null;
  const fit = natural && stageSize ? fitScale(stageSize, natural) : null;
  const zoomed = transform != null && fit != null && zoomedIn(transform.scale, fit);

  const update = (next: Transform | null) => { transformRef.current = next; setTransform(next); };
  const report = (size: Size, scale: number | null) => {
    onInfo?.(`${size.width}×${size.height}${scale == null ? '' : ` · ${Math.round(scale * 100)}%`}`);
  };
  // Releases a gesture: the transform springs to its clamped value.
  const rest = (next: Transform, stageBox: Size, image: Size) => {
    const settled = constrain(next, stageBox, image, 0);
    setSettling(true);
    update(settled);
    report(image, settled.scale);
  };

  // Every reload gets a fresh document; only a new url resets the zoom.
  useEffect(() => setFailed(false), [document]);
  useEffect(() => {
    setNatural(null);
    pointers.current.clear();
    gesture.current = null;
    lastTap.current = null;
    update(null);
  }, [url]);
  useEffect(() => {
    if (!stage.current) return;
    const observer = new ResizeObserver(([entry]) => setStageSize({ width: entry.contentRect.width, height: entry.contentRect.height }));
    observer.observe(stage.current);
    return () => observer.disconnect();
  }, []);
  // A new image or a resized stage re-fits unless the user has zoomed in, in
  // which case the current zoom is kept and only re-clamped.
  useEffect(() => {
    if (!natural || !stageSize || stageSize.width <= 0 || stageSize.height <= 0) return;
    const current = transformRef.current;
    const next = current && zoomedIn(current.scale, fitScale(stageSize, natural))
      ? constrain(current, stageSize, natural, 0) : fitTransform(stageSize, natural);
    update(next);
    report(natural, next.scale);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [natural, stageSize]);

  const point = (event: { clientX: number; clientY: number }): Point => {
    const rect = stage.current!.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  };
  const ready = () => transformRef.current != null && natural != null && stageSize != null;
  const start = (event: PointerEvent<HTMLDivElement>) => {
    if (!ready() || (event.target instanceof Element && event.target.closest('button'))) return;
    if (pointers.current.size >= 2) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    pointers.current.set(event.pointerId, point(event));
    setSettling(false);
    gesture.current = { points: [...pointers.current.values()], transform: transformRef.current!, moved: pointers.current.size > 1 };
  };
  const move = (event: PointerEvent<HTMLDivElement>) => {
    if (!pointers.current.has(event.pointerId) || !gesture.current || !natural || !stageSize) return;
    pointers.current.set(event.pointerId, point(event));
    const current = [...pointers.current.values()];
    const initial = gesture.current;
    if (current.length === 2 && initial.points.length === 2) {
      const before = midpoint(initial.points[0], initial.points[1]);
      const after = midpoint(current[0], current[1]);
      const scale = initial.transform.scale * distance(current[0], current[1]) / Math.max(1, distance(initial.points[0], initial.points[1]));
      const pinched = scaleAbout(initial.transform, scale, before);
      update(constrain({ ...pinched, x: pinched.x + after.x - before.x, y: pinched.y + after.y - before.y }, stageSize, natural, give));
      initial.moved = true;
    } else if (current.length === 1) {
      const dx = current[0].x - initial.points[0].x;
      const dy = current[0].y - initial.points[0].y;
      if (Math.hypot(dx, dy) > 5) initial.moved = true;
      if (initial.moved) update(constrain({ ...initial.transform, x: initial.transform.x + dx, y: initial.transform.y + dy }, stageSize, natural, give));
    }
  };
  const end = (event: PointerEvent<HTMLDivElement>) => {
    if (!pointers.current.has(event.pointerId) || !natural || !stageSize) return;
    const wasTap = event.type === 'pointerup' && pointers.current.size === 1 && gesture.current && !gesture.current.moved;
    pointers.current.delete(event.pointerId);
    const current = transformRef.current!;
    if (wasTap) {
      const at = point(event);
      const now = performance.now();
      const previous = lastTap.current;
      lastTap.current = { at: now, point: at };
      if (previous && now - previous.at < doubleTapMs && distance(previous.point, at) < doubleTapDistance) {
        lastTap.current = null;
        const fitValue = fitScale(stageSize, natural);
        // Double tap toggles fit and a closer look at the tapped point: 1:1,
        // or twice fit for images already near their natural size.
        const target = zoomedIn(current.scale, fitValue) ? fitValue : Math.min(maxScale(fitValue), Math.max(1, fitValue * 2));
        rest(scaleAbout(current, target, at), stageSize, natural);
      }
    } else if (pointers.current.size === 0) {
      rest(current, stageSize, natural);
    }
    gesture.current = pointers.current.size
      ? { points: [...pointers.current.values()], transform: transformRef.current!, moved: true } : null;
  };
  const wheel = (event: WheelEvent<HTMLDivElement>) => {
    if (!ready() || !natural || !stageSize) return;
    const current = transformRef.current!;
    const scale = current.scale * Math.exp(-event.deltaY * 0.002);
    rest(scaleAbout(current, scale, point(event)), stageSize, natural);
  };

  if (document.kind !== 'media') return null;
  const className = ['remux-editor-image-stage', zoomed ? 'remux-editor-image-zoomed' : '', settling ? 'remux-editor-image-settling' : '']
    .filter(Boolean).join(' ');
  return <div ref={stage} className={className}
    onPointerDown={start} onPointerMove={move} onPointerUp={end} onPointerCancel={end} onLostPointerCapture={end} onWheel={wheel}>
    {failed ? <section className="remux-editor-empty"><div className="remux-editor-empty-card">
      <h1 className="remux-editor-empty-title">Could not load image</h1>
      <button onClick={onReload}>Retry</button>
    </div></section> : <img alt={descriptor.name} src={document.url} draggable={false}
      style={natural && transform ? { width: natural.width, height: natural.height,
        transform: `translate(${transform.x}px, ${transform.y}px) scale(${transform.scale})` } : { visibility: 'hidden' }}
      onTransitionEnd={() => setSettling(false)}
      onLoad={(event) => {
        const size = { width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight };
        setNatural(size);
        report(size, null);
      }}
      onError={() => { setFailed(true); onError?.('Could not load image'); }} />}
  </div>;
}
