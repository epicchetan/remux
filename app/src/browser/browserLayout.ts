export const bottomBarControlHeight = 34;
export const bottomBarMinPaddingBottom = 12;
export const bottomBarPaddingTop = 12;
export const tabCardBorderWidth = 2;
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
