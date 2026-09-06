const DEFAULT_HTML_PREVIEW_DOCUMENT_URL = 'https://html-preview.invalid/document';

export type HtmlPreviewNavigationDecision = 'allow-document' | 'allow-fragment' | 'block';

export function classifyHtmlPreviewNavigation(
  requestUrl: string,
  syntheticDocumentUrl = DEFAULT_HTML_PREVIEW_DOCUMENT_URL,
): HtmlPreviewNavigationDecision {
  try {
    const requested = new URL(requestUrl);
    const document = new URL(syntheticDocumentUrl);
    if (requested.origin !== document.origin || requested.pathname !== document.pathname || requested.search !== document.search) {
      return 'block';
    }
    return requested.hash ? 'allow-fragment' : 'allow-document';
  } catch {
    return 'block';
  }
}
