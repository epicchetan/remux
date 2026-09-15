import type { RemuxConnection } from '../remote/RemuxConnectionProvider';

const createDirectoryMethod = 'remux/fs/createDirectory';
const deleteMethod = 'remux/fs/delete';
const renameMethod = 'remux/fs/rename';

export async function createDirectory(
  request: RemuxConnection['command'],
  path: string,
): Promise<void> {
  await request<unknown>(createDirectoryMethod, { path });
}

export async function renameEntry(
  request: RemuxConnection['command'],
  from: string,
  to: string,
  options: { overwrite?: boolean } = {},
): Promise<void> {
  await request<unknown>(renameMethod, {
    from,
    to,
    ...(options.overwrite === true ? { overwrite: true } : {}),
  });
}

// `recursive` is never defaulted on: the runtime behaves like `rm`, so the
// typed delete confirmation is the only caller allowed to pass it.
export async function deleteEntry(
  request: RemuxConnection['command'],
  path: string,
  options: { recursive?: boolean } = {},
): Promise<void> {
  await request<unknown>(deleteMethod, {
    path,
    ...(options.recursive === true ? { recursive: true } : {}),
  });
}

/**
 * Mutation failures come back as JSON-RPC `-32013` with the reason in
 * `data.kind` (`exists | notFound | notEmpty | versionChanged | crossDevice |
 * tooLarge | io`). `RemuxRpcClient` rejects with an Error that carries the
 * server's `code` and `data`, so the kind is read structurally.
 */
export function mutationErrorKind(error: unknown): string | null {
  const data = isRecord(error) ? error.data : null;
  const kind = isRecord(data) ? data.kind : null;
  return typeof kind === 'string' && kind.length > 0 ? kind : null;
}

// Server paths are absolute and '/'-separated; they are joined and split
// verbatim, exactly like isPathWithinServerPath compares them.
export function joinPath(directory: string, name: string) {
  return `${directory.replace(/\/+$/u, '')}/${name}`;
}

export function parentPath(path: string) {
  const trimmed = path.replace(/\/+$/u, '');
  const separator = trimmed.lastIndexOf('/');
  return separator > 0 ? trimmed.slice(0, separator) : '/';
}

export function isValidEntryName(name: string) {
  return (
    name.length > 0 &&
    name !== '.' &&
    name !== '..' &&
    !name.includes('/') &&
    !name.includes('\u0000')
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
