export const bottomBarControlHeight = 34;
export const bottomBarMinPaddingBottom = 12;
export const bottomBarPaddingTop = 12;
export const tabCardBorderWidth = 2;
export const tabGridGap = 16;
export const tabGridHorizontalPadding = 20;
export const tabHeaderHeight = 38;
export const tabPreviewAspectRatio = 0.68;

export function getBottomBarHeight(bottomInset: number) {
  return bottomBarPaddingTop + bottomBarControlHeight + Math.max(bottomInset, bottomBarMinPaddingBottom);
}

export function getTabCardWidth(screenWidth: number) {
  return (screenWidth - tabGridHorizontalPadding * 2 - tabGridGap) / 2;
}

export function getTabCardHeight(cardWidth: number, previewAspectRatio = tabPreviewAspectRatio) {
  const previewWidth = Math.max(cardWidth - tabCardBorderWidth * 2, 1);
  return tabHeaderHeight + previewWidth / previewAspectRatio + tabCardBorderWidth * 2;
}

export function getBottomLeftTabTarget({
  bottomInset,
  screenHeight,
  screenWidth,
}: {
  bottomInset: number;
  screenHeight: number;
  screenWidth: number;
}) {
  const width = getTabCardWidth(screenWidth);
  const height = getTabCardHeight(width);
  const left = tabGridHorizontalPadding;
  const top = screenHeight - getBottomBarHeight(bottomInset) - tabGridGap - height;

  return {
    height,
    left,
    top,
    width,
  };
}
