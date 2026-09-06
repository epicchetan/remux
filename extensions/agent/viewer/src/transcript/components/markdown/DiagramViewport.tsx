import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type RefObject } from 'react';

import { createPortal } from 'react-dom';
import { RotateCcw } from 'lucide-react';

import {
  clampDiagramTransform,
  fitDiagramImage,
  initialDiagramTransform,
  panDiagram,
  zoomDiagramAt,
  type DiagramPoint,
  type DiagramSize,
  type DiagramTransform,
} from './diagramViewport';
import './diagramViewport.css';

export type DiagramViewportProps = Readonly<{
  controlsRef: RefObject<HTMLSpanElement | null>;
  identity: string;
  imageHeight: number;
  imageWidth: number;
  onImageError: () => void;
  src: string;
}>;

type Gesture =
  | { kind: 'idle' }
  | { identifier: number; kind: 'pending'; start: DiagramPoint }
  | { kind: 'native' }
  | { identifier: number; kind: 'pan'; previous: DiagramPoint }
  | { distance: number; focal: DiagramPoint; kind: 'pinch'; zoom: number };

const movementSlop = 8;

export function DiagramViewport({ controlsRef, identity, imageHeight, imageWidth, onImageError, src }: DiagramViewportProps) {
  const elementRef = useRef<HTMLDivElement | null>(null);
  const gestureRef = useRef<Gesture>({ kind: 'idle' });
  const gestureBoundaryRef = useRef<Element | null>(null);
  const ownedRef = useRef(false);
  const [viewport, setViewport] = useState<DiagramSize>({ height: 0, width: 0 });
  const [transform, setTransform] = useState<DiagramTransform>(initialDiagramTransform);
  const transformRef = useRef(transform);
  const image = { height: imageHeight, width: imageWidth };
  const fittedImage = fitDiagramImage(viewport, image);
  const geometryRef = useRef({ fittedImage, viewport });
  geometryRef.current = { fittedImage, viewport };

  function commit(next: DiagramTransform) {
    transformRef.current = next;
    setTransform(next);
  }

  function publish(target: EventTarget | null, phase: 'start' | 'end') {
    target?.dispatchEvent(new CustomEvent('remux-diagram-gesture', {
      bubbles: true,
      detail: { phase },
    }));
  }

  function beginOwnership() {
    if (ownedRef.current) return;
    ownedRef.current = true;
    const element = elementRef.current;
    gestureBoundaryRef.current = element?.closest('[data-testid="agent-transcript-scroll"]') ?? null;
    publish(element, 'start');
  }

  function endOwnership() {
    if (!ownedRef.current) return;
    ownedRef.current = false;
    publish(gestureBoundaryRef.current ?? elementRef.current, 'end');
    gestureBoundaryRef.current = null;
  }

  function resetView() {
    gestureRef.current = { kind: 'idle' };
    endOwnership();
    commit(initialDiagramTransform);
  }

  useEffect(() => {
    const element = elementRef.current;
    if (!element) return undefined;
    const measure = () => {
      const nextViewport = { height: element.clientHeight, width: element.clientWidth };
      const previousViewport = geometryRef.current.viewport;
      const changed = nextViewport.height !== previousViewport.height || nextViewport.width !== previousViewport.width;
      setViewport(nextViewport);
      const nextFitted = fitDiagramImage(nextViewport, image);
      if (changed) resetView();
      else commit(clampDiagramTransform(transformRef.current, nextViewport, nextFitted));
    };
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    measure();
    return () => observer.disconnect();
  }, [imageHeight, imageWidth]);

  useEffect(() => {
    resetView();
  }, [identity]);

  useEffect(() => {
    const element = elementRef.current;
    if (!element) return undefined;

    const ownEvent = (event: TouchEvent) => {
      event.preventDefault();
      event.stopPropagation();
    };
    const startPan = (touch: Touch) => {
      beginOwnership();
      gestureRef.current = { identifier: touch.identifier, kind: 'pan', previous: point(touch, element) };
    };
    const startPinch = (touches: readonly Touch[]) => {
      const pair = touchPair(touches, element);
      if (!pair) return;
      beginOwnership();
      gestureRef.current = {
        distance: distance(pair[0], pair[1]),
        focal: midpoint(pair[0], pair[1]),
        kind: 'pinch',
        zoom: transformRef.current.zoom,
      };
    };
    const finish = () => {
      gestureRef.current = { kind: 'idle' };
      endOwnership();
    };

    const onTouchStart = (event: TouchEvent) => {
      if (event.target instanceof Element && event.target.closest('button')) return;
      const touches = localTouches(event.touches, element);
      const gesture = gestureRef.current;
      if (gesture.kind === 'native') return;
      if ((gesture.kind === 'idle' || gesture.kind === 'pending') && touches.length !== event.touches.length) {
        gestureRef.current = { kind: 'native' };
        return;
      }
      if ((gesture.kind === 'pending' || gesture.kind === 'pan') && touches.length >= 2) {
        startPinch(touches);
        ownEvent(event);
        return;
      }
      if (gesture.kind !== 'idle') {
        if (ownedRef.current) ownEvent(event);
        return;
      }
      if (touches.length >= 2) {
        startPinch(touches);
        ownEvent(event);
      } else if (touches.length === 1) {
        const touch = touches[0]!;
        if (transformRef.current.zoom > 1) {
          startPan(touch);
          ownEvent(event);
        } else {
          gestureRef.current = { identifier: touch.identifier, kind: 'pending', start: point(touch, element) };
        }
      }
    };

    const onTouchMove = (event: TouchEvent) => {
      const touches = localTouches(event.touches, element);
      const gesture = gestureRef.current;
      if ((gesture.kind === 'idle' || gesture.kind === 'pending') && touches.length !== event.touches.length) {
        gestureRef.current = { kind: 'native' };
        return;
      }
      if (gesture.kind === 'pending') {
        const touch = findTouch(touches, gesture.identifier);
        if (touch && distance(gesture.start, point(touch, element)) >= movementSlop) gestureRef.current = { kind: 'native' };
        return;
      }
      if (gesture.kind === 'native' || gesture.kind === 'idle') return;
      const { fittedImage: fitted, viewport: size } = geometryRef.current;
      if (gesture.kind === 'pan') {
        const touch = findTouch(touches, gesture.identifier);
        if (touch) {
          const next = point(touch, element);
          commit(panDiagram(transformRef.current, { x: next.x - gesture.previous.x, y: next.y - gesture.previous.y }, size, fitted));
          gestureRef.current = { ...gesture, previous: next };
        }
      } else {
        const pair = touchPair(touches, element);
        if (pair) {
          const nextDistance = distance(pair[0], pair[1]);
          const nextFocal = midpoint(pair[0], pair[1]);
          const nextZoom = gesture.distance > 0 ? gesture.zoom * nextDistance / gesture.distance : gesture.zoom;
          commit(zoomDiagramAt(transformRef.current, nextZoom, gesture.focal, nextFocal, size, fitted));
          gestureRef.current = { distance: nextDistance, focal: nextFocal, kind: 'pinch', zoom: transformRef.current.zoom };
        }
      }
      ownEvent(event);
    };

    const onTouchEnd = (event: TouchEvent) => {
      const touches = localTouches(event.touches, element);
      const gesture = gestureRef.current;
      if ((gesture.kind === 'idle' || gesture.kind === 'pending') && touches.length > 0 && touches.length !== event.touches.length) {
        gestureRef.current = { kind: 'native' };
        return;
      }
      if (gesture.kind === 'native') {
        if (touches.length === 0) finish();
        return;
      }
      if (!ownedRef.current) {
        if (touches.length === 0) finish();
        return;
      }
      ownEvent(event);
      if (touches.length === 0) finish();
      else if (touches.length === 1) startPan(touches[0]!);
      else startPinch(touches);
    };
    const onTouchCancel = (event: TouchEvent) => {
      if (ownedRef.current) ownEvent(event);
      finish();
    };
    const onGestureCancel = () => resetView();
    const onVisibility = () => { if (document.hidden) finish(); };

    element.addEventListener('remux-diagram-gesture-cancel', onGestureCancel);
    element.addEventListener('touchstart', onTouchStart, { passive: false });
    element.addEventListener('touchmove', onTouchMove, { passive: false });
    element.addEventListener('touchend', onTouchEnd, { passive: false });
    element.addEventListener('touchcancel', onTouchCancel, { passive: false });
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      element.removeEventListener('remux-diagram-gesture-cancel', onGestureCancel);
      element.removeEventListener('touchstart', onTouchStart);
      element.removeEventListener('touchmove', onTouchMove);
      element.removeEventListener('touchend', onTouchEnd);
      element.removeEventListener('touchcancel', onTouchCancel);
      document.removeEventListener('visibilitychange', onVisibility);
      finish();
    };
  }, []);

  function keyboardZoom(event: KeyboardEvent<HTMLDivElement>) {
    if (!['+', '=', '-', '0'].includes(event.key)) return;
    event.preventDefault();
    const factor = event.key === '-' ? 1 / 1.25 : 1.25;
    if (event.key === '0') {
      resetView();
      return;
    }
    const nextZoom = transform.zoom * factor;
    const center = { x: viewport.width / 2, y: viewport.height / 2 };
    commit(zoomDiagramAt(transform, nextZoom, center, center, viewport, fittedImage));
  }

  const imageStyle = {
    height: fittedImage.height,
    left: `calc(50% + ${transform.panX}px)`,
    top: `calc(50% + ${transform.panY}px)`,
    transform: `translate(-50%, -50%) scale(${transform.zoom})`,
    width: fittedImage.width,
  } satisfies CSSProperties;

  return <div
    aria-label="Diagram viewport"
    className="agent-diagram-viewport"
    data-diagram-zoom={transform.zoom}
    onKeyDown={keyboardZoom}
    ref={elementRef}
    style={{ touchAction: transform.zoom > 1 ? 'none' : 'pan-y' }}
    tabIndex={0}
  >
    {fittedImage.width > 0 ? <img alt="Mermaid diagram" draggable={false} height={imageHeight} onError={onImageError} src={src} style={imageStyle} width={imageWidth} /> : null}
    {transform.zoom > 1 && controlsRef.current ? createPortal(<button aria-label="Reset view" onClick={resetView} type="button"><RotateCcw /></button>, controlsRef.current) : null}
  </div>;
}

function point(touch: Touch, element: HTMLElement): DiagramPoint {
  const bounds = element.getBoundingClientRect();
  return { x: touch.clientX - bounds.left, y: touch.clientY - bounds.top };
}
function localTouches(touches: TouchList, element: HTMLElement) {
  return Array.from(touches).filter((touch) => touch.target instanceof Node && element.contains(touch.target));
}
function findTouch(touches: readonly Touch[], identifier: number) {
  for (const touch of touches) if (touch.identifier === identifier) return touch;
  return null;
}
function touchPair(touches: readonly Touch[], element: HTMLElement): [DiagramPoint, DiagramPoint] | null {
  return touches.length >= 2 ? [point(touches[0]!, element), point(touches[1]!, element)] : null;
}
function midpoint(first: DiagramPoint, second: DiagramPoint): DiagramPoint {
  return { x: (first.x + second.x) / 2, y: (first.y + second.y) / 2 };
}
function distance(first: DiagramPoint, second: DiagramPoint) {
  return Math.hypot(second.x - first.x, second.y - first.y);
}
