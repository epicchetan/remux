export const maxComposerImageAttachments = 4;
export const maxComposerImageBytes = 6 * 1024 * 1024;

export type ValidComposerImage = {
  file: File;
  mimeType: string;
  name: string;
  sizeBytes: number;
};

const extensionMimeTypes = new Map([
  ['gif', 'image/gif'],
  ['heic', 'image/heic'],
  ['heif', 'image/heif'],
  ['jpeg', 'image/jpeg'],
  ['jpg', 'image/jpeg'],
  ['png', 'image/png'],
  ['webp', 'image/webp'],
]);

const allowedImageMimeTypes = new Set(extensionMimeTypes.values());

export function validateComposerImages(files: File[], existingCount: number): {
  images: ValidComposerImage[];
  message: string | null;
} {
  const images: ValidComposerImage[] = [];

  for (const file of files) {
    if (existingCount + images.length >= maxComposerImageAttachments) {
      return {
        images,
        message: 'You can attach up to 4 images.',
      };
    }

    const result = validateComposerImage(file);
    if (result.type === 'error') {
      return {
        images,
        message: result.message,
      };
    }

    images.push(result.image);
  }

  return {
    images,
    message: null,
  };
}

export function isAllowedDataImageUrl(dataUrl: string) {
  const match = /^data:([^;,]+);base64,/i.exec(dataUrl);
  return Boolean(match && allowedImageMimeTypes.has(match[1].toLowerCase()));
}

function validateComposerImage(file: File):
  | { image: ValidComposerImage; type: 'ok' }
  | { message: string; type: 'error' } {
  const name = file.name || 'Image';
  const sizeBytes = file.size;
  const mimeType = normalizeImageMimeType(file.type, name);

  if (!mimeType) {
    return {
      message: 'Only images can be attached.',
      type: 'error',
    };
  }

  if (sizeBytes > maxComposerImageBytes) {
    return {
      message: 'Image is larger than 6 MB.',
      type: 'error',
    };
  }

  return {
    image: {
      file,
      mimeType,
      name,
      sizeBytes,
    },
    type: 'ok',
  };
}

function normalizeImageMimeType(mimeType: string, fileName: string) {
  const normalizedMimeType = mimeType.trim().toLowerCase();
  if (allowedImageMimeTypes.has(normalizedMimeType)) {
    return normalizedMimeType;
  }

  if (normalizedMimeType) {
    return null;
  }

  const extension = fileName.split('.').pop()?.trim().toLowerCase() ?? '';
  return extensionMimeTypes.get(extension) ?? null;
}
