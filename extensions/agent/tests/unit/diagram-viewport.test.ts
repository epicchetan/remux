import assert from 'node:assert/strict';
import { test } from '@playwright/test';

import {
  clampDiagramTransform,
  fitDiagramImage,
  initialDiagramTransform,
  panDiagram,
  zoomDiagramAt,
} from '../../viewer/src/transcript/components/markdown/diagramViewport.ts';

const viewport = { width: 300, height: 200 };

test('fits without upscaling and clamps zoom and pan', () => {
  assert.deepEqual(fitDiagramImage(viewport, { width: 600, height: 200 }), { width: 300, height: 100 });
  assert.deepEqual(fitDiagramImage(viewport, { width: 100, height: 50 }), { width: 100, height: 50 });
  assert.deepEqual(clampDiagramTransform({ zoom: 0.5, panX: 10, panY: 10 }, viewport, { width: 300, height: 100 }), initialDiagramTransform);
  assert.deepEqual(clampDiagramTransform({ zoom: 10, panX: 9999, panY: -999 }, viewport, { width: 300, height: 100 }), {
    zoom: 8,
    panX: 1050,
    panY: -300,
  });
});

test('pans only through visible overflow and resets at one', () => {
  const fitted = { width: 300, height: 100 };
  assert.deepEqual(panDiagram({ zoom: 2, panX: 0, panY: 0 }, { x: 500, y: 500 }, viewport, fitted), {
    zoom: 2,
    panX: 150,
    panY: 0,
  });
  assert.deepEqual(clampDiagramTransform({ zoom: 1, panX: 80, panY: 40 }, viewport, fitted), initialDiagramTransform);
});

test('keeps the image point beneath a moving pinch focal point', () => {
  const fitted = { width: 300, height: 200 };
  const result = zoomDiagramAt(
    initialDiagramTransform,
    2,
    { x: 100, y: 80 },
    { x: 120, y: 90 },
    viewport,
    fitted,
  );
  assert.deepEqual(result, { zoom: 2, panX: 70, panY: 30 });
  assert.deepEqual(zoomDiagramAt(result, 1, { x: 120, y: 90 }, { x: 120, y: 90 }, viewport, fitted), initialDiagramTransform);
});
