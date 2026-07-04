const { existsSync, readFileSync } = require('node:fs');
const { isAbsolute, join, resolve } = require('node:path');

const configRelativePath = join('.remux', 'config.toml');

function loadRemuxConfig({ rootDir = process.cwd() } = {}) {
  const configPath = join(rootDir, configRelativePath);
  if (!existsSync(configPath)) {
    return {};
  }

  return parseRemuxConfigToml(readFileSync(configPath, 'utf8'), configPath);
}

function parseRemuxConfigToml(source, configPath = configRelativePath) {
  const config = {};
  const seenKeys = new Set();
  const lines = source.split(/\r?\n/u);

  for (let index = 0; index < lines.length; index += 1) {
    const lineNumber = index + 1;
    const line = stripComment(lines[index]).trim();
    if (line.length === 0) {
      continue;
    }
    if (line.startsWith('[')) {
      throw new Error(`${configPath}:${lineNumber}: sections are not supported in Remux config`);
    }

    const equalsIndex = line.indexOf('=');
    if (equalsIndex <= 0) {
      throw new Error(`${configPath}:${lineNumber}: expected key = value`);
    }

    const rawKey = line.slice(0, equalsIndex).trim();
    const key = normalizeConfigKey(rawKey, configPath, lineNumber);
    if (seenKeys.has(key)) {
      throw new Error(`${configPath}:${lineNumber}: duplicate key ${rawKey}`);
    }
    seenKeys.add(key);

    const rawValue = line.slice(equalsIndex + 1).trim();
    config[key] = parseConfigValue(rawValue, configPath, lineNumber);
  }

  validateConfig(config, configPath);
  return config;
}

function resolveExtensionRoots(roots, rootDir) {
  return roots.map((candidate) => (
    isAbsolute(candidate) ? candidate : resolve(rootDir, candidate)
  ));
}

function normalizeConfigKey(key, configPath, lineNumber) {
  switch (key) {
    case 'host':
    case 'port':
    case 'extensionRoots':
      return key;
    case 'extension_roots':
      return 'extensionRoots';
    default:
      throw new Error(`${configPath}:${lineNumber}: unknown Remux config key ${key}`);
  }
}

function parseConfigValue(rawValue, configPath, lineNumber) {
  if (rawValue.length === 0) {
    throw new Error(`${configPath}:${lineNumber}: value is required`);
  }

  if (rawValue.startsWith('"') || rawValue.startsWith("'")) {
    return parseString(rawValue, configPath, lineNumber);
  }

  if (rawValue.startsWith('[')) {
    return parseStringArray(rawValue, configPath, lineNumber);
  }

  if (/^-?\d+$/u.test(rawValue)) {
    return Number(rawValue);
  }

  throw new Error(`${configPath}:${lineNumber}: unsupported value ${rawValue}`);
}

function parseString(rawValue, configPath, lineNumber) {
  const quote = rawValue[0];
  if (!rawValue.endsWith(quote) || rawValue.length < 2) {
    throw new Error(`${configPath}:${lineNumber}: unterminated string`);
  }

  const value = rawValue.slice(1, -1);
  if (quote === "'") {
    return value;
  }

  return value.replace(/\\(["\\nrt])/gu, (_match, escaped) => {
    switch (escaped) {
      case '"':
        return '"';
      case '\\':
        return '\\';
      case 'n':
        return '\n';
      case 'r':
        return '\r';
      case 't':
        return '\t';
      default:
        return escaped;
    }
  });
}

function parseStringArray(rawValue, configPath, lineNumber) {
  if (!rawValue.endsWith(']')) {
    throw new Error(`${configPath}:${lineNumber}: unterminated array`);
  }

  const inner = rawValue.slice(1, -1).trim();
  if (inner.length === 0) {
    return [];
  }

  const items = splitArrayItems(inner, configPath, lineNumber);
  return items.map((item) => {
    const trimmed = item.trim();
    if (!trimmed.startsWith('"') && !trimmed.startsWith("'")) {
      throw new Error(`${configPath}:${lineNumber}: extension roots must be strings`);
    }
    return parseString(trimmed, configPath, lineNumber);
  });
}

function splitArrayItems(value, configPath, lineNumber) {
  const items = [];
  let quote = null;
  let escaped = false;
  let start = 0;

  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (quote === '"' && char === '\\') {
      escaped = true;
      continue;
    }
    if (quote) {
      if (char === quote) {
        quote = null;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === ',') {
      items.push(value.slice(start, index));
      start = index + 1;
    }
  }

  if (quote) {
    throw new Error(`${configPath}:${lineNumber}: unterminated string in array`);
  }

  items.push(value.slice(start));
  return items;
}

function stripComment(line) {
  let quote = null;
  let escaped = false;

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (quote === '"' && char === '\\') {
      escaped = true;
      continue;
    }
    if (quote) {
      if (char === quote) {
        quote = null;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === '#') {
      return line.slice(0, index);
    }
  }

  return line;
}

function validateConfig(config, configPath) {
  if (config.host !== undefined && typeof config.host !== 'string') {
    throw new Error(`${configPath}: host must be a string`);
  }
  if (config.port !== undefined && !Number.isInteger(config.port)) {
    throw new Error(`${configPath}: port must be an integer`);
  }
  if (config.extensionRoots !== undefined && (
    !Array.isArray(config.extensionRoots) ||
    !config.extensionRoots.every((value) => typeof value === 'string' && value.trim().length > 0)
  )) {
    throw new Error(`${configPath}: extension_roots must be an array of non-empty strings`);
  }
}

module.exports = {
  configRelativePath,
  loadRemuxConfig,
  parseRemuxConfigToml,
  resolveExtensionRoots,
};
