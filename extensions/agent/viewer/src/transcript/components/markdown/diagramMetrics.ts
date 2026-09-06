export type DiagramNaturalMetrics = Readonly<{
  height: number;
  width: number;
}>;

type DiagramMetricsListener = () => void;

const maxDiagramMetricsEntries = 128;
const metricsBySource = new Map<string, DiagramNaturalMetrics>();
const pendingMetricsBySource = new Map<string, DiagramNaturalMetrics>();
const listeners = new Set<DiagramMetricsListener>();
let revision = 0;
let holdCount = 0;

export function getDiagramMetrics(source: string): DiagramNaturalMetrics | null {
  const metrics = metricsBySource.get(source) ?? null;
  if (metrics) {
    metricsBySource.delete(source);
    metricsBySource.set(source, metrics);
  }
  return metrics;
}

export function getDiagramMetricsRevision() {
  return revision;
}

export function publishDiagramMetrics(source: string, metrics: DiagramNaturalMetrics) {
  if (!source || !validDimension(metrics.width) || !validDimension(metrics.height)) return false;
  const normalized = Object.freeze({ height: metrics.height, width: metrics.width });
  if (holdCount > 0) {
    const effective = pendingMetricsBySource.get(source) ?? metricsBySource.get(source);
    if (effective?.width === normalized.width && effective.height === normalized.height) return false;
    const current = metricsBySource.get(source);
    if (current?.width === normalized.width && current.height === normalized.height) {
      pendingMetricsBySource.delete(source);
    } else {
      pendingMetricsBySource.delete(source);
      pendingMetricsBySource.set(source, normalized);
      trimOldest(pendingMetricsBySource);
    }
    return true;
  }

  const previous = metricsBySource.get(source);
  if (previous?.width === normalized.width && previous.height === normalized.height) {
    getDiagramMetrics(source);
    return false;
  }
  remember(source, normalized);
  revision += 1;
  notifyListeners();
  return true;
}

export function holdDiagramMetricsUpdates() {
  holdCount += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    holdCount = Math.max(0, holdCount - 1);
    if (holdCount === 0) flushPendingMetrics();
  };
}

export function subscribeDiagramMetrics(listener: DiagramMetricsListener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function validDimension(value: number) {
  return Number.isFinite(value) && value > 0;
}

function flushPendingMetrics() {
  if (pendingMetricsBySource.size === 0) return;
  const pending = [...pendingMetricsBySource];
  pendingMetricsBySource.clear();
  let changed = false;
  for (const [source, metrics] of pending) {
    const previous = metricsBySource.get(source);
    if (previous?.width === metrics.width && previous.height === metrics.height) continue;
    remember(source, metrics);
    changed = true;
  }
  if (!changed) return;
  revision += 1;
  notifyListeners();
}

function remember(source: string, metrics: DiagramNaturalMetrics) {
  metricsBySource.delete(source);
  metricsBySource.set(source, metrics);
  trimOldest(metricsBySource);
}

function trimOldest(map: Map<string, DiagramNaturalMetrics>) {
  while (map.size > maxDiagramMetricsEntries) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) return;
    map.delete(oldest);
  }
}

function notifyListeners() {
  for (const listener of [...listeners]) listener();
}
