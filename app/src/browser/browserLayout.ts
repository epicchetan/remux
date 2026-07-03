export const bottomBarControlHeight = 34;
export const bottomBarMinPaddingBottom = 12;
export const bottomBarPaddingTop = 12;
export const tabCardBorderWidth = 2;
export const tabGridColumns = 2;
export const tabGridGap = 16;
export const tabGridHorizontalPadding = 20;
export const tabHeaderHeight = 24;
export const tabPreviewAspectRatio = 0.68;

export function getBottomBarHeight(bottomInset: number) {
  return bottomBarPaddingTop + bottomBarControlHeight + Math.max(bottomInset, bottomBarMinPaddingBottom);
}

export function getTabCardWidth(screenWidth: number) {
  return (screenWidth - tabGridHorizontalPadding * 2 - tabGridGap) / 2;
}

export function getTabCardHeight(cardWidth: number) {
  const previewWidth = cardWidth - tabCardBorderWidth * 2;
  return tabHeaderHeight + previewWidth / tabPreviewAspectRatio + tabCardBorderWidth * 2;
}

export function getTabGridHeight(tabCount: number, cardHeight: number) {
  const rows = Math.ceil(tabCount / tabGridColumns);
  return rows <= 0 ? 0 : rows * cardHeight + (rows - 1) * tabGridGap;
}

// Slot 0 is the bottom-left card; slots fill left-to-right, then row by row
// upward. Positions are offsets from the grid's bottom-left corner (y <= 0)
// so they stay stable when rows are added or removed above.
export function getTabSlotPosition({
  cardHeight,
  cardWidth,
  index,
}: {
  cardHeight: number;
  cardWidth: number;
  index: number;
}) {
  const column = index % tabGridColumns;
  const row = Math.floor(index / tabGridColumns);

  return {
    x: column * (cardWidth + tabGridGap),
    y: -(row * (cardHeight + tabGridGap)),
  };
}

export function getTabSlotIndexForPosition({
  cardHeight,
  cardWidth,
  tabCount,
  x,
  y,
}: {
  cardHeight: number;
  cardWidth: number;
  tabCount: number;
  x: number;
  y: number;
}) {
  if (tabCount <= 0) {
    return 0;
  }

  const column = clampValue(Math.round(x / (cardWidth + tabGridGap)), 0, tabGridColumns - 1);
  const row = clampValue(
    Math.round(-y / (cardHeight + tabGridGap)),
    0,
    Math.ceil(tabCount / tabGridColumns) - 1,
  );

  return Math.min(row * tabGridColumns + column, tabCount - 1);
}

function clampValue(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}
