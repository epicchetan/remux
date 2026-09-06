export const FULL_DOCUMENT_MAX_BYTES = 5 * 1024 * 1024;

export function decodeSourceText(encoded: string, declaredSize: number): string {
  const bytes = decodeBase64(encoded);
  if (bytes.length !== declaredSize || bytes.length > FULL_DOCUMENT_MAX_BYTES) {
    throw new Error('The file response was incomplete or exceeded the source limit.');
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new Error('The selected file is not valid UTF-8.');
  }
}

function decodeBase64(encoded: string): Uint8Array {
  const maxLength = Math.ceil(FULL_DOCUMENT_MAX_BYTES / 3) * 4;
  if (encoded.length > maxLength || encoded.length % 4 !== 0) malformed();
  const padding = encoded.endsWith('==') ? 2 : encoded.endsWith('=') ? 1 : 0;
  const dataLength = encoded.length - padding;
  for (let index = 0; index < encoded.length; index += 1) {
    const code = encoded.charCodeAt(index);
    const data = (code >= 65 && code <= 90)
      || (code >= 97 && code <= 122)
      || (code >= 48 && code <= 57)
      || code === 43
      || code === 47;
    if ((index < dataLength && !data) || (index >= dataLength && code !== 61)) malformed();
  }
  if ((padding === 2 && dataLength % 4 !== 2) || (padding === 1 && dataLength % 4 !== 3)) malformed();
  if (
    (padding === 2 && (base64Value(encoded.charCodeAt(encoded.length - 3)) & 15) !== 0)
    || (padding === 1 && (base64Value(encoded.charCodeAt(encoded.length - 2)) & 3) !== 0)
  ) malformed();
  let decoded: string;
  try {
    decoded = atob(encoded);
  } catch {
    malformed();
  }
  const bytes = new Uint8Array(decoded.length);
  for (let index = 0; index < decoded.length; index += 1) bytes[index] = decoded.charCodeAt(index);
  return bytes;
}

function base64Value(code: number) {
  if (code >= 65 && code <= 90) return code - 65;
  if (code >= 97 && code <= 122) return code - 71;
  if (code >= 48 && code <= 57) return code + 4;
  return code === 43 ? 62 : 63;
}

function malformed(): never {
  throw new Error('The file response contained malformed base64 data.');
}
