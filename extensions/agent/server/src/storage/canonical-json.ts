import { createHash } from 'node:crypto';

export type CanonicalJsonValue =
  | null
  | boolean
  | number
  | string
  | CanonicalJsonValue[]
  | { [key: string]: CanonicalJsonValue };

export function canonicalJson(value: unknown) {
  return encode(value, new WeakSet<object>(), '$');
}

export function canonicalJsonHash(value: unknown) {
  return createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');
}

function encode(value: unknown, ancestors: WeakSet<object>, path: string): string {
  if (value === null || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'string') return JSON.stringify(value.replace(/\r\n?/gu, '\n'));
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) {
      throw new TypeError(`Canonical JSON requires safe decimal integers at ${path}.`);
    }
    return String(Object.is(value, -0) ? 0 : value);
  }
  if (typeof value !== 'object') {
    throw new TypeError(`Unsupported canonical JSON value at ${path}: ${typeof value}.`);
  }
  if (ancestors.has(value)) throw new TypeError(`Canonical JSON cycle at ${path}.`);
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      if (Object.getOwnPropertySymbols(value).length > 0) {
        throw new TypeError(`Canonical JSON symbol property at ${path}.`);
      }
      const expectedNames = new Set(['length']);
      for (let index = 0; index < value.length; index += 1) {
        if (!(index in value)) throw new TypeError(`Canonical JSON sparse array at ${path}[${index}].`);
        expectedNames.add(String(index));
      }
      if (Object.getOwnPropertyNames(value).some((name) => !expectedNames.has(name))) {
        throw new TypeError(`Canonical JSON extra array property at ${path}.`);
      }
      const entries = value.map((_entry, index) => {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) {
          throw new TypeError(`Canonical JSON accessor at ${path}[${index}].`);
        }
        return encode(descriptor.value, ancestors, `${path}[${index}]`);
      });
      return `[${entries.join(',')}]`;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError(`Canonical JSON requires plain objects at ${path}.`);
    }
    if (Object.getOwnPropertySymbols(value).length > 0) {
      throw new TypeError(`Canonical JSON symbol property at ${path}.`);
    }
    const entries = Object.getOwnPropertyNames(value).sort().map((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) {
        throw new TypeError(`Canonical JSON accessor or hidden property at ${path}.${key}.`);
      }
      return `${JSON.stringify(key)}:${encode(descriptor.value, ancestors, `${path}.${key}`)}`;
    });
    return `{${entries.join(',')}}`;
  } finally {
    ancestors.delete(value);
  }
}
