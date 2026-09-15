// URL shape and status mapping for `PUT /remux/fs/raw`, kept free of imports
// so the mutation test script can exercise them directly.

export type FileUploadResult =
  | { status: 'conflict' }
  | { status: 'created' }
  | { status: 'replaced' }
  | { status: 'tooLarge' }
  | { reason: string; status: 'failed' };

export function rawFileUploadUrl(
  origin: string,
  path: string,
  options: { overwrite?: boolean } = {},
) {
  const target = encodeURIComponent(path);
  const overwrite = options.overwrite === true ? '&overwrite=1' : '';
  return `${origin.replace(/\/+$/u, '')}/remux/fs/raw?path=${target}${overwrite}`;
}

// The route is create-only by default: 201 created, 200 replaced, 409 when the
// target exists, 413 above the runtime's upload cap.
export function uploadResultForStatus(status: number, body = ''): FileUploadResult {
  switch (status) {
    case 200:
      return { status: 'replaced' };
    case 201:
      return { status: 'created' };
    case 409:
      return { status: 'conflict' };
    case 413:
      return { status: 'tooLarge' };
    default:
      return { reason: uploadFailureReason(status, body), status: 'failed' };
  }
}

// Failures answer with `{"error": "…"}`; anything else (an empty body, a proxy
// page) leaves the status code as the only reliable detail.
function uploadFailureReason(status: number, body: string) {
  try {
    const parsed: unknown = JSON.parse(body);
    if (isRecord(parsed) && typeof parsed.error === 'string' && parsed.error.length > 0) {
      return parsed.error;
    }
  } catch {
    // Not JSON.
  }

  return `Upload failed (${status})`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
