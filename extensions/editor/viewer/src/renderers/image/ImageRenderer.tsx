import { useEffect, useRef, useState, type PointerEvent } from 'react';
import type { RendererProps } from '../registry';

type Point = { x: number; y: number };
type Transform = Point & { scale: number };
const distance = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);
const midpoint = (a: Point, b: Point): Point => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });

export function Component({ document, descriptor, onInfo, onReload, onError }: RendererProps) {
  const stage = useRef<HTMLDivElement>(null);
  const pointers = useRef(new Map<number, Point>());
  const gesture = useRef<{ points: Point[]; transform: Transform; moved: boolean } | null>(null);
  const [naturalWidth, setNaturalWidth] = useState(0);
  const [stageWidth, setStageWidth] = useState(0);
  const [transform, setTransform] = useState<Transform>({ scale: 1, x: 0, y: 0 });
  const transformRef = useRef(transform);
  const [failed, setFailed] = useState(false);
  const [zoomed, setZoomed] = useState(false);
  const zoomedRef = useRef(false);
  const zoom = (value: boolean) => { zoomedRef.current = value; setZoomed(value); };
  const update = (next: Transform) => { transformRef.current = next; setTransform(next); };
  const fitScale = naturalWidth > 0 && stageWidth > 0 ? stageWidth / naturalWidth : 1;

  useEffect(() => {
    setFailed(false);
    zoom(false);
    pointers.current.clear();
    gesture.current = null;
    update({ scale: 1, x: 0, y: 0 });
  }, [document]);
  useEffect(() => {
    if (!stage.current) return;
    const observer = new ResizeObserver(([entry]) => setStageWidth(entry.contentRect.width));
    observer.observe(stage.current);
    return () => observer.disconnect();
  }, []);

  const point = (event: PointerEvent): Point => {
    const rect = stage.current!.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  };
  const start = (event: PointerEvent<HTMLDivElement>) => {
    if (event.target instanceof Element && event.target.closest('button')) return;
    if (pointers.current.size >= 2) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    pointers.current.set(event.pointerId, point(event));
    gesture.current = { points: [...pointers.current.values()], transform: transformRef.current, moved: pointers.current.size > 1 };
  };
  const move = (event: PointerEvent<HTMLDivElement>) => {
    if (!pointers.current.has(event.pointerId) || !gesture.current) return;
    pointers.current.set(event.pointerId, point(event));
    const current = [...pointers.current.values()];
    const initial = gesture.current;
    if (current.length === 2 && initial.points.length === 2) {
      const before = midpoint(initial.points[0], initial.points[1]);
      const after = midpoint(current[0], current[1]);
      const scale = Math.max(0.1, Math.min(Math.max(16, 16 / fitScale),
        initial.transform.scale * distance(current[0], current[1]) / Math.max(1, distance(initial.points[0], initial.points[1]))));
      const ratio = scale / initial.transform.scale;
      update({ scale, x: after.x - (before.x - initial.transform.x) * ratio,
        y: after.y - (before.y - initial.transform.y) * ratio });
      zoom(true);
      initial.moved = true;
    } else if (current.length === 1) {
      const dx = current[0].x - initial.points[0].x;
      const dy = current[0].y - initial.points[0].y;
      if (Math.hypot(dx, dy) > 5) initial.moved = true;
      if (zoomedRef.current) update({ ...initial.transform, x: initial.transform.x + dx, y: initial.transform.y + dy });
    }
  };
  const end = (event: PointerEvent<HTMLDivElement>) => {
    if (!pointers.current.has(event.pointerId)) return;
    const wasTap = event.type === 'pointerup' && pointers.current.size === 1 && gesture.current && !gesture.current.moved;
    pointers.current.delete(event.pointerId);
    if (wasTap) {
      const scale = zoomedRef.current ? 1 : 1 / fitScale;
      const at = point(event);
      update(zoomedRef.current ? { scale: 1, x: 0, y: 0 } : { scale, x: at.x * (1 - scale), y: at.y * (1 - scale) });
      zoom(!zoomedRef.current);
    }
    gesture.current = pointers.current.size
      ? { points: [...pointers.current.values()], transform: transformRef.current, moved: true } : null;
  };

  if (document.kind !== 'media') return null;
  return <div ref={stage} className={`remux-editor-image-stage${zoomed ? ' remux-editor-image-zoomed' : ''}`}
    onPointerDown={start} onPointerMove={move} onPointerUp={end} onPointerCancel={end} onLostPointerCapture={end}>
    {failed ? <section className="remux-editor-empty"><div className="remux-editor-empty-card">
      <h1 className="remux-editor-empty-title">Could not load image</h1>
      <button onClick={onReload}>Retry</button>
    </div></section> : <img alt={descriptor.name} src={document.url} draggable={false}
      style={{ transform: `translate(${transform.x}px, ${transform.y}px) scale(${transform.scale})` }}
      onLoad={(event) => {
        setNaturalWidth(event.currentTarget.naturalWidth);
        onInfo?.(`${event.currentTarget.naturalWidth}×${event.currentTarget.naturalHeight}`);
      }}
      onError={() => { setFailed(true); onError?.('Could not load image'); }} />}
  </div>;
}
