export type CodexImageSource =
  | {
      type: 'localPath';
      path: string;
    }
  | {
      type: 'uri';
      uri: string;
    };

export type CodexMediaPreview = {
  id: string;
  label: string | null;
  source: CodexImageSource;
};

export function codexImageSourceFromString(value: string | null | undefined): CodexImageSource | null {
  const source = value?.trim();

  if (!source) {
    return null;
  }

  if (source.startsWith('file://')) {
    return {
      path: decodeFileUri(source),
      type: 'localPath',
    };
  }

  if (source.startsWith('/')) {
    return {
      path: source,
      type: 'localPath',
    };
  }

  if (/^https?:\/\//i.test(source) || /^data:image\//i.test(source)) {
    return {
      type: 'uri',
      uri: source,
    };
  }

  if (looksLikeImageBase64(source)) {
    return {
      type: 'uri',
      uri: `data:image/png;base64,${source}`,
    };
  }

  return {
    type: 'uri',
    uri: source,
  };
}

export function imageSourceLabel(source: CodexImageSource) {
  if (source.type === 'localPath') {
    return fileName(source.path);
  }

  return fileName(source.uri) || 'Image';
}

export function inferImageMime(source: string) {
  const extension = source.split('?')[0].split('#')[0].split('.').pop()?.toLowerCase();

  switch (extension) {
    case 'avif':
      return 'image/avif';
    case 'gif':
      return 'image/gif';
    case 'heic':
    case 'heif':
      return 'image/heic';
    case 'jpg':
    case 'jpeg':
      return 'image/jpeg';
    case 'png':
      return 'image/png';
    case 'svg':
      return 'image/svg+xml';
    case 'webp':
      return 'image/webp';
    default:
      return 'image/png';
  }
}

function decodeFileUri(uri: string) {
  try {
    return decodeURIComponent(uri.replace(/^file:\/\//i, ''));
  } catch {
    return uri.replace(/^file:\/\//i, '');
  }
}

function fileName(value: string) {
  const clean = value.split('?')[0].split('#')[0].replace(/\\/g, '/');
  const [name] = clean.split('/').filter(Boolean).slice(-1);
  return name ?? '';
}

function looksLikeImageBase64(value: string) {
  if (value.length < 80 || value.length % 4 !== 0) {
    return false;
  }

  return /^[A-Za-z0-9+/]+={0,2}$/.test(value.slice(0, 256));
}
