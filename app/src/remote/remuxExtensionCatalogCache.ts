import AsyncStorage from '@react-native-async-storage/async-storage';

import {
  parseRemuxExtensionCatalog,
  type RemuxExtensionCatalog,
} from './remuxExtensions';

const catalogSchemaVersion = 1;
const catalogKeyPrefix = 'remux.extensionCatalog.v1:';

type CachedRemuxExtensionCatalog = {
  catalog: RemuxExtensionCatalog;
  fetchedAt: number;
  origin: string;
  schemaVersion: typeof catalogSchemaVersion;
};

export async function readCachedRemuxExtensionCatalog(
  origin: string,
): Promise<RemuxExtensionCatalog | null> {
  const normalizedOrigin = normalizeRemuxOrigin(origin);
  const text = await AsyncStorage.getItem(catalogStorageKey(normalizedOrigin));
  if (!text) {
    return null;
  }

  try {
    const value: unknown = JSON.parse(text);
    if (
      !isRecord(value)
      || value.schemaVersion !== catalogSchemaVersion
      || value.origin !== normalizedOrigin
      || typeof value.fetchedAt !== 'number'
      || !Number.isFinite(value.fetchedAt)
    ) {
      return null;
    }

    return parseRemuxExtensionCatalog(value.catalog, normalizedOrigin);
  } catch {
    return null;
  }
}

export async function writeCachedRemuxExtensionCatalog(
  origin: string,
  catalog: RemuxExtensionCatalog,
) {
  const normalizedOrigin = normalizeRemuxOrigin(origin);
  const value: CachedRemuxExtensionCatalog = {
    catalog,
    fetchedAt: Date.now(),
    origin: normalizedOrigin,
    schemaVersion: catalogSchemaVersion,
  };
  await AsyncStorage.setItem(catalogStorageKey(normalizedOrigin), JSON.stringify(value));
}

export function normalizeRemuxOrigin(origin: string) {
  const parsed = new URL(origin);
  parsed.hash = '';
  parsed.pathname = '';
  parsed.search = '';
  return parsed.toString().replace(/\/$/u, '');
}

function catalogStorageKey(normalizedOrigin: string) {
  return `${catalogKeyPrefix}${encodeURIComponent(normalizedOrigin)}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
