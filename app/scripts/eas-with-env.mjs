import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const envPath = resolve(process.cwd(), '.env');

if (existsSync(envPath)) {
  const lines = readFileSync(envPath, 'utf8').split(/\r?\n/);

  for (const line of lines) {
    const trimmed = line.trim();

    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }

    const equalsIndex = trimmed.indexOf('=');

    if (equalsIndex === -1) {
      continue;
    }

    const key = trimmed.slice(0, equalsIndex).trim();
    let value = trimmed.slice(equalsIndex + 1).trim();

    if (!key || key in process.env) {
      continue;
    }

    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    process.env[key] = value;
  }
}

if (!process.env.EXPO_TOKEN) {
  console.error('Missing EXPO_TOKEN. Add it to app/.env or export it before running EAS.');
  process.exit(1);
}

const args = process.argv.slice(2);

if (args.length === 0) {
  console.error('Usage: node scripts/eas-with-env.mjs <eas command args>');
  process.exit(1);
}

// EAS keeps `--message` server-side and never delivers it to devices. Mirror
// it into the config evaluation (app.config.js reads REMUX_UPDATE_MESSAGE
// into extra.updateMessage) so the app can show what's deployed in Settings.
if (!process.env.REMUX_UPDATE_MESSAGE) {
  const flagIndex = args.findIndex((arg) => arg === '--message' || arg === '-m');
  const message = flagIndex >= 0
    ? args[flagIndex + 1]
    : args.find((arg) => arg.startsWith('--message='))?.slice('--message='.length);
  if (message) {
    process.env.REMUX_UPDATE_MESSAGE = message;
  }
}

const child = spawn('npx', ['--yes', 'eas-cli@latest', ...args], {
  env: process.env,
  stdio: 'inherit',
});

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }

  process.exit(code ?? 1);
});
