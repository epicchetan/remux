import type {
  RemuxExtension,
  RemuxFileHandler,
} from '../remote/remuxExtensions';
import type { FileTreeEntry } from './filesTypes';

export function matchingFileHandlers(
  extensions: RemuxExtension[],
  entry: Pick<FileTreeEntry, 'kind' | 'name'>,
): RemuxFileHandler[] {
  if (entry.kind !== 'file') {
    return [];
  }

  const extension = fileExtensionForName(entry.name);
  return extensions
    .flatMap((remuxExtension) => remuxExtension.fileHandlers)
    .map((handler, index) => ({
      handler,
      index,
      score: fileHandlerMatchScore(handler, extension),
    }))
    .filter((match) => match.score > 0)
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .map((match) => match.handler);
}

export function fileExtensionForName(fileName: string) {
  const extension = fileName.split('.').pop();
  if (!extension || extension === fileName) {
    return null;
  }

  return extension.toLowerCase();
}

// Icon-only variant: dotfiles like `.gitignore` have no visual extension.
// Handler matching keeps using fileExtensionForName so viewers still open them.
export function iconExtensionForName(fileName: string) {
  if (fileName.startsWith('.')) {
    return null;
  }

  return fileExtensionForName(fileName);
}

function fileHandlerMatchScore(handler: RemuxFileHandler, extension: string | null) {
  const handlerExtensions = handler.extensions.map((candidate) => candidate.toLowerCase());

  if (extension && handlerExtensions.includes(extension)) {
    return 2;
  }

  return handlerExtensions.includes('*') ? 1 : 0;
}
