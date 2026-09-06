import { useCallback, useRef } from 'react';
import { StyleSheet } from 'react-native';
import WebView from 'react-native-webview';
import type {
  ShouldStartLoadRequest,
  WebViewErrorEvent,
  WebViewHttpErrorEvent,
} from 'react-native-webview/lib/WebViewTypes';

import { classifyHtmlPreviewNavigation } from './htmlPreviewNavigation';
import {
  HTML_PREVIEW_DOCUMENT_URL,
  type PreparedHtmlPreviewDocument,
} from './prepareHtmlPreviewDocument';

export type HtmlPreviewRendererProps = Readonly<{
  document: PreparedHtmlPreviewDocument;
  onError?: (message: string) => void;
  onRenderProcessGone?: () => void;
  testID?: string;
}>;

export function HtmlPreviewRenderer({ document, onError, onRenderProcessGone, testID }: HtmlPreviewRendererProps) {
  const initialDocumentLoadPending = useRef(true);
  const currentDocument = useRef(document);
  if (currentDocument.current !== document) {
    currentDocument.current = document;
    initialDocumentLoadPending.current = true;
  }
  const allowNavigation = useCallback((request: ShouldStartLoadRequest) => {
    const decision = classifyHtmlPreviewNavigation(request.url);
    if (decision === 'allow-fragment') return true;
    if (decision === 'allow-document' && initialDocumentLoadPending.current) {
      initialDocumentLoadPending.current = false;
      return true;
    }
    return false;
  }, []);
  const reportError = useCallback((event: WebViewErrorEvent | WebViewHttpErrorEvent) => {
    onError?.(event.nativeEvent.description || 'HTML preview failed to load.');
  }, [onError]);

  return (
    <WebView
      testID={testID}
      style={styles.webView}
      source={{ html: document.html, baseUrl: HTML_PREVIEW_DOCUMENT_URL }}
      javaScriptEnabled
      domStorageEnabled
      originWhitelist={['*']}
      onShouldStartLoadWithRequest={allowNavigation}
      onLoadStart={() => { initialDocumentLoadPending.current = false; }}
      onError={reportError}
      onHttpError={reportError}
      onRenderProcessGone={onRenderProcessGone}
      onContentProcessDidTerminate={onRenderProcessGone}
      sharedCookiesEnabled={false}
      thirdPartyCookiesEnabled={false}
      cacheEnabled={false}
      allowFileAccess={false}
      allowFileAccessFromFileURLs={false}
      allowUniversalAccessFromFileURLs={false}
      javaScriptCanOpenWindowsAutomatically={false}
      setSupportMultipleWindows={false}
      allowsLinkPreview={false}
      pullToRefreshEnabled={false}
    />
  );
}

const styles = StyleSheet.create({ webView: { flex: 1 } });
