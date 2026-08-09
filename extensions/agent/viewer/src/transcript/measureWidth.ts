export type TranscriptWidthMeasurement = {
  contentWidth: number;
  laneBorderWidth: number;
  lanePaddingLeft: number;
  lanePaddingRight: number;
  viewportWidth: number;
};

/**
 * Prefer the stable transcript lane's content box over a transient child
 * measurement. Native WebViews can briefly report a nearly-zero child width
 * while swapping loading and ready trees; publishing that sample makes the
 * Markdown line breaker lay out one glyph per line.
 */
export function resolveTranscriptContentWidth(input: TranscriptWidthMeasurement) {
  const laneContentWidth = input.laneBorderWidth - input.lanePaddingLeft - input.lanePaddingRight;
  const width = Math.max(input.contentWidth, laneContentWidth);
  const credibleFloor = Math.min(96, Math.max(1, input.viewportWidth * 0.5));
  return Number.isFinite(width) && width >= credibleFloor ? width : null;
}
