export const transcriptLayout = {
  assistant: {
    actionHeight: 28,
    actionTopGap: 8,
  },
  compaction: {
    dividerHeight: 20,
  },
  row: {
    defaultGap: 20,
    workBoundaryGap: 14,
  },
  user: {
    actionHeight: 28,
    actionTopGap: 8,
    bubbleGap: 8,
    bubbleBorderWidth: 1,
    bubbleMaxWidthRatio: 0.86,
    bubblePaddingX: 16,
    bubblePaddingY: 10,
    collapsedBodyLines: 8,
    disclosureHeight: 22,
    railCardHeight: 62,
    steeringLabelBottomGap: 8,
    steeringLabelHeight: 18,
  },
  viewport: {
    padY: 20,
  },
  work: {
    headerHeight: 24,
    separatorHeight: 1,
    separatorMarginTop: 4,
  },
} as const;

export function userBubbleContentWidth(contentWidth: number, placement: 'topLevel' | 'work' = 'topLevel') {
  const bubbleWidth = Math.max(
    1,
    placement === 'work' ? contentWidth * transcriptLayout.user.bubbleMaxWidthRatio : contentWidth,
  );
  return Math.max(
    1,
    bubbleWidth -
      transcriptLayout.user.bubblePaddingX * 2 -
      transcriptLayout.user.bubbleBorderWidth * 2,
  );
}
