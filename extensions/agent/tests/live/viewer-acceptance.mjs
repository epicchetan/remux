import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import process from 'node:process';

import { chromium } from '@playwright/test';

const options = parseOptions(process.argv.slice(2));
const token = (await readFile(options.tokenFile, 'utf8')).trim();
if (!token) throw new Error(`Remux token file is empty: ${options.tokenFile}`);
await mkdir(options.outputDir, { recursive: true });

const browser = await chromium.launch({ headless: true });
const results = [];
try {
  for (const target of [
    { name: 'desktop', viewport: { height: 900, width: 1280 } },
    { name: 'mobile', viewport: { height: 844, width: 390 } },
  ]) {
    const context = await browser.newContext({ colorScheme: 'dark', viewport: target.viewport });
    await context.addCookies([{
      domain: '127.0.0.1',
      httpOnly: true,
      name: 'remux_auth',
      path: '/',
      sameSite: 'Lax',
      secure: false,
      value: token,
    }]);
    await context.addInitScript(installLiveHostBridge, {
      cwd: options.cwd,
      endpoint: options.wsEndpoint,
    });
    const page = await context.newPage();
    const pageErrors = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));
    const url = new URL('/viewers/agent/', options.httpBase);
    url.searchParams.set('remuxResourceKind', 'agentConversation');
    url.searchParams.set('remuxResourceId', options.conversationId);
    await page.goto(url.toString(), { waitUntil: 'domcontentloaded' });
    const transcript = page.getByTestId('agent-transcript-content');
    await transcript.getByText('REMUX_CLEAN_FIRST_OK', { exact: true }).waitFor({ timeout: 20_000 });
    await transcript.getByText('REMUX_CONTEXT_8AUG26 REMUX_CLEAN_SECOND_OK', { exact: true })
      .waitFor({ timeout: 20_000 });
    await page.getByRole('button', { name: 'Send message', exact: true }).waitFor();

    if (target.name === 'desktop') {
      await page.getByLabel('Agent history').waitFor();
    } else {
      await page.getByRole('button', { name: 'Open history', exact: true }).click();
      const historyDialog = page.getByRole('dialog');
      await historyDialog.waitFor();
      await historyDialog.getByText('Agent History', { exact: true }).last().waitFor();
      await page.keyboard.press('Escape');
      await historyDialog.waitFor({ state: 'hidden' });
    }

    const geometry = await page.evaluate(() => {
      const transcript = document.querySelector('[data-testid="agent-transcript-scroll"]');
      const content = document.querySelector('[data-testid="agent-transcript-content"]');
      if (!(transcript instanceof HTMLElement) || !(content instanceof HTMLElement)) {
        throw new Error('The live transcript geometry roots are missing.');
      }
      const contentRect = content.getBoundingClientRect();
      return {
        contentLeft: contentRect.left,
        contentRight: contentRect.right,
        documentOverflow: document.documentElement.scrollWidth - window.innerWidth,
        transcriptOverflow: transcript.scrollWidth - transcript.clientWidth,
        viewportWidth: window.innerWidth,
      };
    });
    assert.ok(geometry.documentOverflow <= 1, `${target.name} document overflowed by ${geometry.documentOverflow}px.`);
    assert.ok(geometry.transcriptOverflow <= 1, `${target.name} transcript overflowed by ${geometry.transcriptOverflow}px.`);
    assert.ok(geometry.contentLeft >= -1, `${target.name} transcript escaped the left edge.`);
    assert.ok(geometry.contentRight <= geometry.viewportWidth + 1, `${target.name} transcript escaped the right edge.`);
    assert.deepEqual(pageErrors, []);

    const screenshot = resolve(options.outputDir, `${target.name}.png`);
    await page.screenshot({ fullPage: true, path: screenshot });
    results.push({ geometry, screenshot, target: target.name });
    await context.close();
  }
} finally {
  await browser.close();
}

process.stdout.write(`${JSON.stringify({
  ok: true,
  conversationId: options.conversationId,
  results,
}, null, 2)}\n`);

function parseOptions(args) {
  const values = new Map();
  for (let index = 0; index < args.length; index += 1) {
    const key = args[index];
    const value = args[index + 1];
    if (!key?.startsWith('--') || !value || value.startsWith('--')) {
      throw new Error(`Expected --name value arguments; received ${key ?? '<end>'}.`);
    }
    values.set(key, value);
    index += 1;
  }
  const repositoryRoot = resolve(import.meta.dirname, '../../../..');
  const conversationId = values.get('--conversation-id');
  if (!conversationId) throw new Error('--conversation-id is required.');
  return {
    conversationId,
    cwd: resolve(values.get('--cwd') ?? repositoryRoot),
    httpBase: values.get('--http-base') ?? 'http://127.0.0.1:48123',
    outputDir: resolve(values.get('--output-dir') ?? '/tmp/remux-agent-live-viewer'),
    tokenFile: resolve(values.get('--token-file') ?? resolve(repositoryRoot, '.remux/auth-token')),
    wsEndpoint: values.get('--ws-endpoint') ?? 'ws://127.0.0.1:48123/ws',
  };
}

function installLiveHostBridge(options) {
  const pendingFrames = [];
  let hostReady = false;
  let socketReady = false;
  const socket = new WebSocket(options.endpoint);

  const dispatch = (message) => {
    const event = new MessageEvent('message', { data: JSON.stringify(message) });
    window.dispatchEvent(event);
    document.dispatchEvent(event);
  };
  const announceReady = () => {
    if (!hostReady || !socketReady) return;
    dispatch({
      error: null,
      status: { cwd: options.cwd, generation: 1, type: 'connected' },
      type: 'remux/status',
    });
    dispatch({
      lifecycle: { epoch: 1, reason: 'connect', state: 'active' },
      type: 'remux/lifecycle',
    });
  };
  const send = (frame) => {
    if (socketReady) socket.send(JSON.stringify(frame));
    else pendingFrames.push(frame);
  };
  const respond = (id, result) => dispatch({ id, result, type: 'remux/response' });

  socket.addEventListener('open', () => {
    socketReady = true;
    for (const frame of pendingFrames.splice(0)) socket.send(JSON.stringify(frame));
    announceReady();
  });
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(String(event.data));
    if (message.id !== undefined) {
      if (message.error) dispatch({ error: message.error, id: message.id, type: 'remux/error' });
      else respond(message.id, message.result);
      return;
    }
    if (message.method) dispatch({ message, type: 'remux/event' });
  });
  socket.addEventListener('close', () => {
    dispatch({ error: 'Live viewer bridge disconnected.', status: { type: 'closed' }, type: 'remux/status' });
  });

  Object.defineProperty(window, 'ReactNativeWebView', {
    configurable: true,
    value: {
      postMessage(raw) {
        const request = JSON.parse(raw);
        if (request.type === 'remux/ready' || request.type === 'ready') {
          hostReady = true;
          announceReady();
          return;
        }
        if (request.type === 'remux/cancel') return;
        if (request.method?.startsWith('host/')) {
          if (request.id === undefined) return;
          if (request.method === 'host/viewport/get') {
            respond(request.id, {
              keyboardHeight: 0,
              keyboardVisible: false,
              visibleBottom: window.innerHeight,
              visibleTop: 0,
              viewportHeight: window.innerHeight,
              viewportWidth: window.innerWidth,
            });
          } else {
            respond(request.id, { ok: true });
          }
          return;
        }
        if (request.type === 'remux/notify') {
          send({ jsonrpc: '2.0', method: request.method, params: request.params });
          return;
        }
        if (request.type === 'remux/request') {
          send({
            id: request.id,
            jsonrpc: '2.0',
            method: request.method,
            params: request.params,
            remuxContract: request.contract,
          });
        }
      },
    },
  });
}
