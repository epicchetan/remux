import { defaultHomePath } from '../config/defaults';

export function formatHomePath(path: string, homePath = defaultHomePath) {
  return path.startsWith(homePath) ? path.replace(homePath, '~') : path;
}
