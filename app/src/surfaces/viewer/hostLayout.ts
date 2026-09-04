import type { RemuxViewHostChrome } from '../../remote/remuxExtensions';

export const minimalHostControlInsetLeft = 52;
export const minimalHostControlMargin = 8;
export const minimalHostControlSize = 44;

export type NativeSafeAreaInsets = {
  bottom: number;
  left: number;
  right: number;
  top: number;
};

export function createWebViewHostLayoutScript(
  hostChrome: RemuxViewHostChrome,
  hostControlInsetLeft: number,
  safeAreaInsets: NativeSafeAreaInsets,
) {
  const serialized = JSON.stringify({
    hostChrome,
    hostControlInsetLeft,
    safeAreaBottom: safeAreaInsets.bottom,
    safeAreaLeft: safeAreaInsets.left,
    safeAreaRight: safeAreaInsets.right,
    safeAreaTop: safeAreaInsets.top,
  });
  return `
  (function () {
    var layout = ${serialized};
    var root = document.documentElement;
    root.setAttribute('data-remux-host-chrome', layout.hostChrome);
    root.style.setProperty('--remux-host-control-inset-left', layout.hostControlInsetLeft + 'px');
    root.style.setProperty('--remux-safe-area-top', layout.safeAreaTop + 'px');
    root.style.setProperty('--remux-safe-area-right', layout.safeAreaRight + 'px');
    root.style.setProperty('--remux-safe-area-bottom', layout.safeAreaBottom + 'px');
    root.style.setProperty('--remux-safe-area-left', layout.safeAreaLeft + 'px');
    window.__remuxHostLayout = layout;
    return true;
  })();
  true;
`;
}
