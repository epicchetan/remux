import {
  openHostFile,
  openHostLink,
  type HostFileOpenParams,
} from './host';

export type HostOpenTarget =
  | ({ kind: 'file' } & HostFileOpenParams)
  | { kind: 'url'; url: string };

export type HostOpenTargetResult =
  | { kind: 'file'; ok: boolean; reason?: string; target: HostFileOpenParams }
  | { kind: 'url'; ok: boolean; reason?: string; target: { url: string } };

export type HostHrefOpenResult =
  | { kind: 'external'; ok: boolean; url: string }
  | { kind: 'file'; ok: boolean; target: HostFileOpenParams }
  | { kind: 'unsupported'; ok: false; reason: string };

export type HostFileOpenParamsFromHrefOptions = {
  baseDirectory?: string | null;
  baseFilePath?: string | null;
  parseLine?: boolean;
  requireFileExtension?: boolean;
  requireKnownFileExtension?: boolean;
};

export type OpenHostHrefOptions = HostFileOpenParamsFromHrefOptions & {
  fileTargetFromHref?: (href: string) => HostFileOpenParams | null;
};

export type HostFileHrefInfo = HostFileOpenParams & {
  extension: string | null;
  fileName: string;
  href: string;
};

export async function openHostHref(href: string, options: OpenHostHrefOptions = {}): Promise<HostHrefOpenResult> {
  const target = hostOpenTargetFromHref(href, options);
  if (!target) {
    return {
      kind: 'unsupported',
      ok: false,
      reason: isSchemeHref(href) ? 'unsupported-scheme' : 'invalid-file-href',
    };
  }

  const result = await openHostTarget(target);
  if (result.kind === 'url') {
    return { kind: 'external', ok: result.ok, url: result.target.url };
  }

  return { kind: 'file', ok: result.ok, target: result.target };
}

export async function openHostTarget(target: HostOpenTarget): Promise<HostOpenTargetResult> {
  if (target.kind === 'url') {
    return {
      kind: 'url',
      ok: await openExternalHostLink(target.url),
      target: { url: target.url },
    };
  }

  const fileTarget = {
    line: target.line ?? null,
    path: target.path,
  };
  try {
    const result = await openHostFile(fileTarget);
    return {
      kind: 'file',
      ok: result.ok,
      reason: result.reason,
      target: fileTarget,
    };
  } catch (error) {
    // Hosts without the handler (or a dropped connection) reject the RPC;
    // surface that as ok:false so callers never have to catch here.
    return {
      kind: 'file',
      ok: false,
      reason: error instanceof Error ? error.message : String(error),
      target: fileTarget,
    };
  }
}

export function hostOpenTargetFromHref(href: string, options: OpenHostHrefOptions = {}): HostOpenTarget | null {
  const url = webUrlFromHref(href);
  if (url) {
    return { kind: 'url', url };
  }

  const fileTarget = options.fileTargetFromHref?.(href)
    ?? hostFileOpenParamsFromHref(href, options);
  return fileTarget ? { kind: 'file', ...fileTarget } : null;
}

export async function openExternalHostLink(href: string) {
  const url = webUrlFromHref(href);
  if (!url) {
    return false;
  }

  try {
    const result = await openHostLink({ url });
    if (result.ok) {
      return true;
    }
  } catch {
    // Older hosts and plain browsers may not expose host/link/open.
  }

  return openWebUrlInPage(url);
}

export function hostFileOpenParamsFromHref(
  href: string,
  options: HostFileOpenParamsFromHrefOptions = {},
): HostFileOpenParams | null {
  if (webUrlFromHref(href)) {
    return null;
  }

  const parseLine = options.parseLine === true;
  const fileUrl = fileUrlPartsFromHref(href, parseLine);
  if (!fileUrl && isSchemeHref(href)) {
    return null;
  }

  const pathPart = fileUrl?.path ?? href.split(/[?#]/u, 1)[0] ?? href;
  const explicitLine = fileUrl?.line ?? (!fileUrl && parseLine ? lineFromHrefHash(href) : null);
  const lineMatch = explicitLine == null && parseLine ? pathPart.match(/:(\d+)(?::\d+)?$/u) : null;
  const rawPath = lineMatch ? pathPart.slice(0, -lineMatch[0].length) : pathPart;
  if (!rawPath.trim()) {
    return null;
  }

  const decodedPath = decodePathPart(rawPath);
  const path = resolveHostFilePath(decodedPath, {
    baseDirectory: options.baseDirectory ?? null,
    baseFilePath: options.baseFilePath ?? null,
  });
  if (!path.trim()) {
    return null;
  }

  if (options.requireFileExtension && hostFileExtensionFromPath(path) === null) {
    return null;
  }
  if (options.requireKnownFileExtension && !isKnownHostFilePath(path)) {
    return null;
  }

  return {
    line: explicitLine ?? (lineMatch ? Number.parseInt(lineMatch[1], 10) : null),
    path,
  };
}

export function hostFileHrefInfoFromHref(
  href: string,
  options: HostFileOpenParamsFromHrefOptions = {},
): HostFileHrefInfo | null {
  const target = hostFileOpenParamsFromHref(href, {
    ...options,
    parseLine: options.parseLine ?? true,
  });
  if (!target) {
    return null;
  }

  const fileName = hostFileNameFromPath(target.path);
  if (!fileName) {
    return null;
  }

  return {
    ...target,
    extension: hostFileExtensionFromName(fileName),
    fileName,
    href,
  };
}

export function isExternalWebHref(href: string) {
  return webUrlFromHref(href) !== null;
}

export function webUrlFromHref(href: string): string | null {
  const trimmed = href.trim();
  if (!trimmed) {
    return null;
  }

  if (!/^https?:\/\//iu.test(trimmed) && !/^\/\//u.test(trimmed)) {
    return null;
  }

  try {
    const base = typeof window === 'undefined' ? 'https://remux.local/' : window.location.href;
    const url = new URL(trimmed, base);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null;
  } catch {
    return null;
  }
}

export function isSchemeHref(href: string) {
  return !isWindowsAbsolutePath(href) && /^[a-z][a-z\d+.-]*:/iu.test(href.trim());
}

export function hostOpenTargetText(target: HostOpenTarget) {
  if (target.kind === 'url') {
    return target.url;
  }

  return target.line ? `${target.path}:${target.line}` : target.path;
}

export function isKnownHostFilePath(path: string) {
  const fileName = hostFileNameFromPath(path);
  if (!fileName) {
    return false;
  }

  const lowerName = fileName.toLowerCase();
  if (knownHostFileNames.has(lowerName) || lowerName.startsWith('.env')) {
    return true;
  }

  const extension = hostFileExtensionFromName(fileName);
  return extension !== null && knownHostFileExtensions.has(extension);
}

function openWebUrlInPage(url: string) {
  if (typeof window === 'undefined') {
    return false;
  }

  try {
    const opened = window.open(url, '_blank', 'noopener,noreferrer');
    if (opened) {
      try {
        opened.opener = null;
      } catch {
        // Best effort only; opener isolation is also requested via features.
      }
      return true;
    }
  } catch {
    // Fall through to same-tab navigation.
  }

  try {
    window.location.assign(url);
    return true;
  } catch {
    return false;
  }
}

function resolveHostFilePath(
  path: string,
  options: { baseDirectory: string | null; baseFilePath: string | null },
) {
  if (isWindowsAbsolutePath(path)) {
    return path;
  }

  if (path.startsWith('/')) {
    return normalizePosixPath(path);
  }

  const baseDirectory = options.baseDirectory ?? (options.baseFilePath ? dirname(options.baseFilePath) : null);
  if (!baseDirectory) {
    return normalizePosixPath(path);
  }

  return normalizePosixPath(`${baseDirectory}/${path}`);
}

function decodePathPart(path: string) {
  try {
    return decodeURIComponent(path);
  } catch {
    return path;
  }
}

function dirname(filePath: string) {
  if (isWindowsAbsolutePath(filePath)) {
    const normalized = filePath.replace(/[\\/]+$/u, '');
    const index = Math.max(normalized.lastIndexOf('\\'), normalized.lastIndexOf('/'));
    return index > 2 ? normalized.slice(0, index) : normalized;
  }

  const normalized = filePath.replace(/\/+$/u, '');
  const index = normalized.lastIndexOf('/');
  return index > 0 ? normalized.slice(0, index) : '/';
}

function normalizePosixPath(filePath: string) {
  const absolute = filePath.startsWith('/');
  const parts = filePath.split('/');
  const stack: string[] = [];

  for (const part of parts) {
    if (!part || part === '.') {
      continue;
    }

    if (part === '..') {
      stack.pop();
      continue;
    }

    stack.push(part);
  }

  return `${absolute ? '/' : ''}${stack.join('/')}`;
}

function isWindowsAbsolutePath(path: string) {
  return /^[a-z]:[\\/]/iu.test(path.trim());
}

function fileUrlPartsFromHref(href: string, parseLine: boolean) {
  const trimmed = href.trim();
  if (!/^file:/iu.test(trimmed)) {
    return null;
  }

  try {
    const url = new URL(trimmed);
    if (url.protocol !== 'file:') {
      return null;
    }

    let path = url.host ? `//${url.host}${url.pathname}` : url.pathname;
    path = decodePathPart(path);
    if (/^\/[a-z]:[\\/]/iu.test(path)) {
      path = path.slice(1);
    }

    return {
      line: parseLine ? lineFromHash(url.hash) : null,
      path,
    };
  } catch {
    return null;
  }
}

function lineFromHash(hash: string) {
  const match = hash.match(/^#(?:L|line-)(\d+)\b/iu);
  return match ? Number.parseInt(match[1], 10) : null;
}

function lineFromHrefHash(href: string) {
  const hashIndex = href.indexOf('#');
  return hashIndex >= 0 ? lineFromHash(href.slice(hashIndex)) : null;
}

function hostFileNameFromPath(path: string) {
  return path.split(/[\\/]/u).filter(Boolean).at(-1) ?? '';
}

function hostFileExtensionFromPath(path: string) {
  return hostFileExtensionFromName(hostFileNameFromPath(path));
}

function hostFileExtensionFromName(fileName: string) {
  const match = fileName.match(/\.([a-z0-9]+)$/iu);
  return match ? match[1].toLowerCase() : null;
}

const knownHostFileExtensions = new Set([
  'astro',
  'bash',
  'c',
  'cc',
  'cjs',
  'clj',
  'cljs',
  'cpp',
  'cs',
  'css',
  'csv',
  'cxx',
  'dart',
  'dockerignore',
  'env',
  'erl',
  'ex',
  'exs',
  'fish',
  'fs',
  'fsx',
  'gitignore',
  'go',
  'gql',
  'gradle',
  'graphql',
  'h',
  'hh',
  'hpp',
  'hrl',
  'htm',
  'html',
  'hxx',
  'ini',
  'java',
  'js',
  'json',
  'jsonl',
  'jsx',
  'kt',
  'kts',
  'less',
  'lock',
  'log',
  'lua',
  'md',
  'mdx',
  'mjs',
  'npmrc',
  'php',
  'properties',
  'proto',
  'ps1',
  'py',
  'pyi',
  'r',
  'rb',
  'rs',
  'sass',
  'scala',
  'scss',
  'sh',
  'sql',
  'svelte',
  'swift',
  'toml',
  'ts',
  'tsx',
  'tsv',
  'txt',
  'vue',
  'xml',
  'yaml',
  'yml',
  'zsh',
]);

const knownHostFileNames = new Set([
  'brewfile',
  'changelog',
  'copying',
  'dockerfile',
  'gemfile',
  'justfile',
  'license',
  'makefile',
  'podfile',
  'procfile',
  'rakefile',
  'readme',
]);
