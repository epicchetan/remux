// HTML Preview ships on the native app platforms. Device isolation acceptance
// remains tracked separately from product availability.
const supportedPlatforms: ReadonlySet<string> = new Set(['ios', 'android']);

export function htmlPreviewAvailability(platform: string): {
  enabled: boolean;
  reason: string | null;
} {
  if (supportedPlatforms.has(platform)) {
    return { enabled: true, reason: null };
  }
  return {
    enabled: false,
    reason: 'Interactive HTML preview is not available on this platform. You can open Source instead.',
  };
}
