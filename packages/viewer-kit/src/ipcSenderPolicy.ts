export function isTrustedHostMessageEvent(event: Pick<MessageEvent, 'source'>): boolean {
  // React Native WebView dispatches host messages without a DOM Window source.
  if (event.source === null) return true;
  // A browser embedding delivers host messages from the containing window.
  return window.parent !== window && event.source === window.parent;
}
