const { appendFileSync, mkdirSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');

const maxStringLength = 8_000;
const maxArrayLength = 50;
const maxDepth = 5;

function createRemuxLogger({
  now = () => new Date(),
  rootDir = process.cwd(),
  terminal = console,
} = {}) {
  const logsDir = join(rootDir, '.remux', 'logs');
  const runId = runIdFromDate(now());
  const currentPath = join(logsDir, 'current.jsonl');
  const runPath = join(logsDir, `${runId}.jsonl`);

  mkdirSync(logsDir, { recursive: true });
  writeFileSync(currentPath, '');

  function event({
    detail,
    label,
    level = 'info',
    message,
    scope,
    source = 'cli',
    terminal: terminalMode = 'mirror',
    ts,
  }) {
    const entry = {
      ts: ts || now().toISOString(),
      level,
      source,
      runId,
      ...(scope ? { scope } : {}),
      ...(label ? { label } : {}),
      ...(message ? { message } : {}),
      ...(detail !== undefined ? { detail: normalizeDetail(detail) } : {}),
    };

    writeEntry(entry);

    if (terminalMode !== 'silent') {
      writeTerminal({ detail, level, message: message || label || source });
    }

    return entry;
  }

  function log(message, detail) {
    event({
      detail,
      label: 'console',
      level: 'info',
      message: String(message),
    });
  }

  function warn(message, detail) {
    event({
      detail,
      label: 'console',
      level: 'warn',
      message: String(message),
    });
  }

  function error(message, detail) {
    event({
      detail,
      label: 'console',
      level: 'error',
      message: String(message),
    });
  }

  function writeEntry(entry) {
    const line = `${JSON.stringify(entry)}\n`;
    try {
      appendFileSync(currentPath, line);
      appendFileSync(runPath, line);
    } catch (writeError) {
      terminal.error?.(`[remux] failed to write log: ${errorMessage(writeError)}`);
    }
  }

  function writeTerminal({ detail, level, message }) {
    const text = detail === undefined
      ? String(message)
      : `${message} ${typeof detail === 'string' ? detail : safeJson(detail)}`;

    if (level === 'error') {
      terminal.error?.(text);
      return;
    }

    if (level === 'warn') {
      terminal.warn?.(text);
      return;
    }

    terminal.log?.(text);
  }

  return {
    currentPath,
    error,
    event,
    log,
    logsDir,
    runId,
    runPath,
    warn,
  };
}

function normalizeDetail(value, depth = 0, seen = new WeakSet()) {
  if (value === undefined || value === null) {
    return value;
  }

  if (typeof value === 'string') {
    return truncateString(value);
  }

  if (typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }

  if (typeof value === 'bigint') {
    return value.toString();
  }

  if (typeof value === 'function' || typeof value === 'symbol') {
    return String(value);
  }

  if (depth >= maxDepth) {
    return '[MaxDepth]';
  }

  if (seen.has(value)) {
    return '[Circular]';
  }

  seen.add(value);

  if (Array.isArray(value)) {
    return value
      .slice(0, maxArrayLength)
      .map((item) => normalizeDetail(item, depth + 1, seen));
  }

  const normalized = {};
  for (const [key, item] of Object.entries(value)) {
    normalized[key] = normalizeDetail(item, depth + 1, seen);
  }
  return normalized;
}

function runIdFromDate(date) {
  return date.toISOString().replace(/[:.]/gu, '-');
}

function safeJson(value) {
  try {
    return JSON.stringify(normalizeDetail(value));
  } catch {
    return String(value);
  }
}

function truncateString(value) {
  if (value.length <= maxStringLength) {
    return value;
  }

  return `${value.slice(0, maxStringLength)}... [truncated ${value.length - maxStringLength} chars]`;
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

module.exports = {
  createRemuxLogger,
  normalizeDetail,
  runIdFromDate,
};
