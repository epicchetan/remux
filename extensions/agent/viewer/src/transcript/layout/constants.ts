export const transcriptLayout = {
  exactContentHeight: 27,
  assistant: {
    actionHeight: 40,
    actionTopGap: 6,
  },
  compaction: {
    height: 32,
  },
  row: {
    defaultGap: 22,
    workBoundaryGap: 14,
  },
  user: {
    actionHeight: 40,
    actionTopGap: 6,
    bubbleGap: 8,
    bubbleBorderWidth: 0,
    bubbleMaxWidthRatio: 0.8,
    bubbleMobileMaxWidthRatio: 0.88,
    bubbleMobileBreakpoint: 640,
    bubblePaddingX: 14,
    bubblePaddingY: 12,
    bubbleTextMeasureGuard: 8,
    collapsedBodyLines: 8,
    disclosureHeight: 22,
    railCardHeight: 62,
  },
  viewport: {
    padY: 20,
  },
  work: {
    headerHeight: 28,
    separatorHeight: 1,
    separatorMarginTop: 4,
  },
} as const;

export function userBubbleContentWidth(contentWidth: number, _placement: 'topLevel' | 'work' = 'topLevel') {
  const ratio = contentWidth < transcriptLayout.user.bubbleMobileBreakpoint
    ? transcriptLayout.user.bubbleMobileMaxWidthRatio
    : transcriptLayout.user.bubbleMaxWidthRatio;
  const bubbleWidth = Math.max(1, contentWidth * ratio);
  return Math.max(
    1,
    bubbleWidth -
      transcriptLayout.user.bubblePaddingX * 2 -
      transcriptLayout.user.bubbleBorderWidth * 2 -
      transcriptLayout.user.bubbleTextMeasureGuard,
  );
}
