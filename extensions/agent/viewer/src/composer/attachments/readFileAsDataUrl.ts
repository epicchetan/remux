import { isAllowedDataImageUrl } from './imageAttachments';

export function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();

    reader.onerror = () => reject(new Error('Could not read image.'));
    reader.onload = () => {
      const result = reader.result;

      if (typeof result !== 'string' || !isAllowedDataImageUrl(result)) {
        reject(new Error('Could not read image.'));
        return;
      }

      resolve(result);
    };

    reader.readAsDataURL(file);
  });
}

export function digestDataUrl(dataUrl: string) {
  let hash = 2166136261;

  for (let index = 0; index < dataUrl.length; index += 1) {
    hash ^= dataUrl.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }

  return (hash >>> 0).toString(36);
}
