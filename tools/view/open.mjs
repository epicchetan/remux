#!/usr/bin/env node
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { chromium, devices } from '@playwright/test';

const usage = `Usage: npm run view:open -- <view> (--shot <path.png> | --keep) [options]

Open a standalone viewer against the live runtime in disposable headless Chromium.
  <view>                  Extension route, e.g. agent or editor
  --resource-kind <kind>   remuxResourceKind query parameter
  --resource-id <id>       remuxResourceId query parameter
  --tab-id <id>            remuxTabId query parameter
  --mobile                Pixel 5 profile (390 x 844, matching agent tests)
  --shot <path.png>        Save a screenshot and close the browser
  --full                  Capture the full page with --shot
  --keep                  Print a CDP endpoint; stay open until SIGINT
  --timeout <ms>          Connection timeout (default 20000)
  --help                  Show this usage

REMUX_HOST / REMUX_PORT default to 127.0.0.1 / 48123.
Authentication comes from the repository's .remux/auth-token, installed as a cookie.
Browsers are disposable; each invocation starts a fresh browser and profile.`;

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      help: { type: 'boolean' }, mobile: { type: 'boolean' }, full: { type: 'boolean' },
      keep: { type: 'boolean' }, shot: { type: 'string' }, timeout: { type: 'string' },
      'resource-kind': { type: 'string' }, 'resource-id': { type: 'string' }, 'tab-id': { type: 'string' },
    },
  });
  if (values.help) { console.log(usage); return; }
  if (positionals.length !== 1 || !/^[\w-]+(?:\/[\w-]+)*$/.test(positionals[0])) throw new Error(usage);
  if (Boolean(values.shot) === Boolean(values.keep)) throw new Error('Choose --shot <path.png> or --keep.\n' + usage);
  if (values.full && !values.shot) throw new Error('--full requires --shot.');
  const timeout = Number(values.timeout ?? 20_000);
  if (!Number.isFinite(timeout) || timeout <= 0) throw new Error('--timeout must be a positive number of milliseconds.');
  const hostname = process.env.REMUX_HOST ?? '127.0.0.1';
  const host = hostname.includes(':') && !hostname.startsWith('[') ? `[${hostname}]` : hostname;
  const origin = `http://${host}:${process.env.REMUX_PORT ?? '48123'}`;
  const url = new URL(`/viewers/${positionals[0]}/`, origin);
  for (const [flag, param] of [['resource-kind', 'remuxResourceKind'], ['resource-id', 'remuxResourceId'], ['tab-id', 'remuxTabId']]) {
    if (values[flag] !== undefined) url.searchParams.set(param, values[flag]);
  }
  const token = (await readFile(new URL('../../.remux/auth-token', import.meta.url), 'utf8')).trim();
  if (!token) throw new Error('The Remux auth-token file is empty.');
  const profile = await mkdtemp(join(tmpdir(), 'remux-view-'));
  let context;
  let interrupted = false;
  let stop;
  const stopped = new Promise((resolveStop) => { stop = resolveStop; });
  const onSignal = () => {
    interrupted = true;
    stop();
    void context?.close().catch(() => {});
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  try {
    context = await chromium.launchPersistentContext(profile, {
      headless: true,
      ...(values.mobile ? { ...devices['Pixel 5'], viewport: { width: 390, height: 844 } } : { viewport: { width: 1280, height: 900 } }),
      args: values.keep ? ['--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1'] : [],
    });
    if (interrupted) return;
    context.on('close', stop);
    await context.addCookies([{ name: 'remux_auth', value: token, url: origin, httpOnly: true, sameSite: 'Lax' }]);
    const page = context.pages()[0] ?? await context.newPage();
    page.on('console', (message) => { if (message.type() === 'error') console.error(`[console] ${message.text()}`); });
    page.on('pageerror', (error) => console.error(`[pageerror] ${error.message}`));
    const response = await page.goto(url.href, { waitUntil: 'domcontentloaded', timeout });
    if (!response?.ok()) throw new Error(`Viewer HTTP request failed: ${response?.status() ?? 'no response'} at ${url.pathname}`);
    try {
      await page.waitForFunction(() => window.__REMUX_DIRECT_HOST__?.status.type === 'connected', null, { timeout });
    } catch {
      const state = await page.evaluate(() => window.__REMUX_DIRECT_HOST__ ?? null).catch(() => null);
      throw new Error(`Direct host did not connect within ${timeout} ms. Last status: ${JSON.stringify(state)}. ${state ? 'Check runtime WebSocket connectivity and authentication.' : 'The served viewer bundle has no direct host; build the viewer and check its served revision.'}`);
    }
    console.log(`Connected: ${url.href}`);
    if (values.shot) {
      await page.waitForLoadState('networkidle', { timeout });
      await page.evaluate(() => document.fonts.ready);
      const path = resolve(values.shot);
      await mkdir(dirname(path), { recursive: true });
      await page.screenshot({ path, fullPage: Boolean(values.full) });
      console.log(`Screenshot: ${path}`);
    } else {
      const [port, wsPath] = (await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).trim().split('\n');
      console.log(`CDP endpoint: ws://127.0.0.1:${port}${wsPath}`);
      console.log('Press Ctrl+C to close this disposable browser.');
      await stopped;
    }
  } catch (error) {
    if (!interrupted) throw error;
  } finally {
    await context?.close().catch(() => {});
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
    await rm(profile, { recursive: true, force: true });
  }
}

main().catch((error) => { console.error(error.message); process.exitCode = 1; });
