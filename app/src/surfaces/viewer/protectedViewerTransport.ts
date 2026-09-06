export const PROTECTED_VIEWER_PAYLOAD_MAX_CHARS = 512 * 1024;
export const PROTECTED_VIEWER_ENVELOPE_MAX_CHARS = (PROTECTED_VIEWER_PAYLOAD_MAX_CHARS * 2) + 512;
export const PROTECTED_VIEWER_TRANSPORT_TYPE = 'remux/protected-viewer-v1';

export function createProtectedViewerToken(): string {
  const nativeUuid = (globalThis as typeof globalThis & {
    expo?: { uuidv4?: () => string };
  }).expo?.uuidv4 ?? globalThis.crypto?.randomUUID?.bind(globalThis.crypto);
  if (typeof nativeUuid !== 'function') {
    throw new Error('Secure randomness is unavailable for the protected viewer transport.');
  }
  const token = `${nativeUuid()}${nativeUuid()}`.replaceAll('-', '').toLowerCase();
  if (!/^[0-9a-f]{64}$/u.test(token)) {
    throw new Error('The native UUID generator returned an invalid capability token.');
  }
  return token;
}

export function unwrapProtectedViewerMessage(data: string, expectedToken: string): string | null {
  if (data.length > PROTECTED_VIEWER_ENVELOPE_MAX_CHARS) return null;
  try {
    const envelope = JSON.parse(data) as Record<string, unknown>;
    if (
      envelope.type !== PROTECTED_VIEWER_TRANSPORT_TYPE
      || envelope.token !== expectedToken
      || typeof envelope.payload !== 'string'
      || envelope.payload.length > PROTECTED_VIEWER_PAYLOAD_MAX_CHARS
    ) {
      return null;
    }
    return envelope.payload;
  } catch {
    return null;
  }
}

export function isProtectedViewerBlobNavigation(requestUrl: string, sourceUrl: string): boolean {
  try {
    const request = new URL(requestUrl);
    return request.protocol === 'blob:' && request.origin === new URL(sourceUrl).origin;
  } catch { return false; }
}

export function createProtectedViewerBootstrapScript(token: string, documentUrl?: string): string {
  return `
(() => {
  if (window.top !== window) return;
  const expectedDocumentUrl = ${JSON.stringify(documentUrl ?? null)};
  if (expectedDocumentUrl && location.href.split('#')[0] !== expectedDocumentUrl.split('#')[0]) return;
  if (window.__REMUX_HOST_CAPABILITIES__?.protectedHtmlPreviewTransport === true) return;
  const capabilityToken = ${JSON.stringify(token)};
  const maxPayloadChars = ${PROTECTED_VIEWER_PAYLOAD_MAX_CHARS};
  let attemptsRemaining = 200;
  function install() {
    if (window.__REMUX_HOST_CAPABILITIES__?.protectedHtmlPreviewTransport === true) return;
    const nativeBridge = window.ReactNativeWebView;
    if (!nativeBridge || typeof nativeBridge.postMessage !== 'function') {
      attemptsRemaining -= 1;
      if (attemptsRemaining > 0) window.setTimeout(install, 25);
      return;
    }
    const nativePostMessage = nativeBridge.postMessage.bind(nativeBridge);
    const protectedPostMessage = function (payload) {
      if (typeof payload !== 'string' || payload.length > maxPayloadChars) return;
      nativePostMessage(JSON.stringify({
        payload,
        token: capabilityToken,
        type: ${JSON.stringify(PROTECTED_VIEWER_TRANSPORT_TYPE)},
      }));
    };
    Object.defineProperty(window, '__REMUX_PROTECTED_POST_MESSAGE__', {
      configurable: false,
      enumerable: false,
      value: protectedPostMessage,
      writable: false,
    });
    Object.defineProperty(window, '__REMUX_HOST_CAPABILITIES__', {
      configurable: false,
      enumerable: false,
      value: Object.freeze({ protectedHtmlPreviewTransport: true }),
      writable: false,
    });
    window.dispatchEvent(new CustomEvent('remux:host-capabilities-ready'));
  }
  install();
})();
true;
`;
}
