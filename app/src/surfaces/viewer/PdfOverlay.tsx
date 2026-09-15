import { useCallback, useMemo } from 'react';
import { StyleSheet, View } from 'react-native';
import WebView from 'react-native-webview';
import type { ShouldStartLoadRequest } from 'react-native-webview/lib/WebViewTypes';
import { logRemuxDebug } from '../../remote/remuxDebug';

export const rawFileRoutePath = '/remux/fs/raw';

// A rectangle in the viewer page's CSS pixels, which iOS maps 1:1 to points.
export type HostPdfFrame = {
  height: number;
  width: number;
  x: number;
  y: number;
};

// Builds the top-level PDF url on the viewer's own origin. The host never
// loads a url the page hands it; the page only names a path.
export function pdfOverlayUrl(sourceUrl: string, path: string, version: string | null | undefined) {
  const url = new URL(rawFileRoutePath, sourceUrl);
  url.searchParams.set('path', path);
  if (version) {
    url.searchParams.set('v', version);
  }
  return url.href;
}

type PdfOverlayProps = {
  authToken: string | null;
  backgroundColor: string;
  frame: HostPdfFrame;
  url: string;
};

// A second WebView that loads the PDF as its top-level document, so WebKit
// draws it with its native PDF view (fit-to-width, pinch zoom, page
// scrolling). The overlay covers only the rectangle the Viewer's renderer
// measured, leaving the page's toolbar and status line untouched.
export function PdfOverlay({ authToken, backgroundColor, frame, url }: PdfOverlayProps) {
  const documentUrl = useMemo(() => new URL(url), [url]);
  // Only this document may load here: no link taps, no redirects, no
  // subframes. A PDF cannot script the origin, but it can carry links.
  const handleShouldStartLoadWithRequest = useCallback((request: ShouldStartLoadRequest) => {
    let requested: URL;
    try {
      requested = new URL(request.url);
    } catch {
      return false;
    }

    const allowed = request.isTopFrame !== false
      && requested.origin === documentUrl.origin
      && requested.pathname === rawFileRoutePath
      && requested.searchParams.get('path') === documentUrl.searchParams.get('path');
    if (!allowed) {
      logRemuxDebug('pdf-overlay:navigation-blocked', request.url);
    }

    return allowed;
  }, [documentUrl]);

  return (
    <View
      pointerEvents="auto"
      style={[
        styles.overlay,
        {
          backgroundColor,
          height: frame.height,
          left: frame.x,
          top: frame.y,
          width: frame.width,
        },
      ]}
    >
      <WebView
        allowsBackForwardNavigationGestures={false}
        allowsLinkPreview={false}
        applicationNameForUserAgent="RemuxMobile"
        cacheEnabled
        javaScriptEnabled={false}
        key={url}
        onShouldStartLoadWithRequest={handleShouldStartLoadWithRequest}
        originWhitelist={['*']}
        setSupportMultipleWindows={false}
        source={{
          headers: authToken ? { Authorization: `Bearer ${authToken}` } : undefined,
          uri: url,
        }}
        style={[styles.webView, { backgroundColor }]}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  overlay: {
    overflow: 'hidden',
    position: 'absolute',
  },
  webView: {
    flex: 1,
  },
});
