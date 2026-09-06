// Enable a platform only after recording native bridge/storage/navigation
// acceptance in docs/specs/html-file-preview-v1.md. Browser tests do not
// establish the React Native WebView boundary.
const verifiedPlatforms: ReadonlySet<string> = new Set();

export function htmlPreviewAvailability(platform: string): {
  enabled: boolean;
  reason: string | null;
} {
  if (verifiedPlatforms.has(platform)) {
    return { enabled: true, reason: null };
  }
  return {
    enabled: false,
    reason: platform === 'ios' || platform === 'android'
      ? 'Interactive HTML preview is awaiting validation on this platform. You can open Source in the meantime.'
      : 'Interactive HTML preview is not available on this platform. You can open Source instead.',
  };
}
