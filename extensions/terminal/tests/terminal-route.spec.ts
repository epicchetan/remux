import { expect, type Page, test } from '@playwright/test';

import { terminalModifierAutoClearMs } from '../viewer/src/terminal/keyEncoding';

type HostRequest = {
  id?: number | string;
  method?: string;
  params?: unknown;
  timeoutMs?: number;
  type?: string;
};

type ViewportMetrics = {
  keyboardHeight: number;
  keyboardVisible: boolean;
  visibleBottom: number;
  visibleTop: number;
  viewportHeight: number;
  viewportWidth: number;
};

type TerminalHostMock = {
  requests: HostRequest[];
  sendTerminalEvent: (message: unknown) => void;
  setViewportMetrics: (metrics: ViewportMetrics) => void;
};

declare global {
  interface Window {
    __remuxTerminalHost?: TerminalHostMock;
  }
}

test.describe('terminal viewer route', () => {
  test.beforeEach(async ({ page }) => {
    await installMockRemuxHost(page);
  });

  test('starts a session and keeps terminal controls in one aligned row', async ({ page }) => {
    await page.goto('/?remuxLaunch=new-terminal');

    const startRequest = await waitForHostRequest(page, 'remux/terminal/session/start');
    const startParams = recordParams(startRequest);
    expect(startParams.cols).toEqual(expect.any(Number));
    expect(startParams.rows).toEqual(expect.any(Number));
    expect(startParams.cols as number).toBeGreaterThan(2);
    expect(startParams.rows as number).toBeGreaterThan(2);

    const keyRow = page.locator('.remux-terminal-key-row');
    const fixedKeys = page.locator('.remux-terminal-key-fixed');
    const scrollKeys = page.locator('.remux-terminal-key-scroll');
    await expect(keyRow).toBeVisible();
    await expect(keyRow.locator('.remux-terminal-key')).toHaveCount(14);
    await expect(fixedKeys.locator('.remux-terminal-key')).toHaveCount(2);
    await expect(fixedKeys.locator('.remux-terminal-key').nth(0)).toHaveAttribute('aria-label', 'Open tabs');
    await expect(fixedKeys.locator('.remux-terminal-key').nth(1)).toHaveAttribute('aria-label', 'Show keyboard');
    await expect(scrollKeys.locator('.remux-terminal-key')).toHaveCount(12);

    const rowMetrics = await scrollKeys.evaluate((element) => ({
      clientWidth: element.clientWidth,
      offsetHeight: element.getBoundingClientRect().height,
      overflowX: getComputedStyle(element).overflowX,
      scrollbarWidth: getComputedStyle(element).scrollbarWidth,
      scrollWidth: element.scrollWidth,
    }));
    expect(rowMetrics.overflowX).toBe('auto');
    expect(rowMetrics.scrollbarWidth).toBe('none');
    expect(rowMetrics.scrollWidth).toBeGreaterThan(0);
    expect(rowMetrics.clientWidth).toBeGreaterThan(0);
    expect(rowMetrics.offsetHeight).toBe(36);

    await scrollKeys.evaluate((element) => {
      element.scrollLeft = element.scrollWidth;
    });
    const segmentMetrics = await keyRow.evaluate((element) => {
      const fixed = element.querySelector('.remux-terminal-key-fixed')?.getBoundingClientRect();
      const scroll = element.querySelector('.remux-terminal-key-scroll')?.getBoundingClientRect();
      return {
        fixedRight: fixed?.right ?? null,
        scrollLeft: scroll?.left ?? null,
      };
    });
    expect(segmentMetrics.fixedRight).not.toBeNull();
    expect(segmentMetrics.scrollLeft).not.toBeNull();
    expect(Math.abs(segmentMetrics.scrollLeft! - segmentMetrics.fixedRight!)).toBeLessThanOrEqual(8);

    const centerDelta = await keyRow.locator('.remux-terminal-key').evaluateAll((buttons) => {
      const centers = buttons.map((button) => {
        const rect = button.getBoundingClientRect();
        return rect.top + rect.height / 2;
      });
      return Math.max(...centers) - Math.min(...centers);
    });
    expect(centerDelta).toBeLessThanOrEqual(1.5);
  });

  test('moves the bottom action bar above host keyboard metrics', async ({ page }) => {
    await page.goto('/?remuxLaunch=new-terminal');
    await waitForHostRequest(page, 'remux/terminal/session/start');

    const terminalBoxBefore = await page.locator('.remux-terminal-container').boundingBox();
    expect(terminalBoxBefore).not.toBeNull();

    const keyboardHeight = await page.evaluate(() => Math.min(320, window.innerHeight - 220));
    await page.evaluate((height) => {
      window.__remuxTerminalHost?.setViewportMetrics({
        keyboardHeight: height,
        keyboardVisible: true,
        visibleBottom: window.innerHeight - height,
        visibleTop: 0,
        viewportHeight: window.innerHeight,
        viewportWidth: window.innerWidth,
      });
    }, keyboardHeight);

    const actionBar = page.locator('.remux-terminal-action-bar');
    await expect(actionBar).toHaveCSS('margin-bottom', `${keyboardHeight}px`);
    await page.waitForFunction((height) => {
      const bar = document.querySelector('.remux-terminal-action-bar');
      if (!bar) {
        return false;
      }
      return bar.getBoundingClientRect().bottom <= window.innerHeight - height + 2;
    }, keyboardHeight);

    const terminalBoxAfter = await page.locator('.remux-terminal-container').boundingBox();
    expect(terminalBoxAfter).not.toBeNull();
    expect(terminalBoxAfter!.height).toBeLessThan(terminalBoxBefore!.height);
  });

  test('encodes sticky modifier input and clears sticky modifiers', async ({ page }) => {
    await page.goto('/?remuxLaunch=new-terminal');
    await waitForHostRequest(page, 'remux/terminal/session/start');

    const controlButton = page.getByLabel('Sticky control');
    await controlButton.click();
    await expect(controlButton).toHaveClass(/is-active/);

    const writeCount = await hostRequestCount(page, 'remux/terminal/session/write');
    await page.keyboard.press('a');
    const writeRequest = await waitForHostRequest(page, 'remux/terminal/session/write', writeCount + 1);
    const writeParams = recordParams(writeRequest);
    expect([...Buffer.from(String(writeParams.dataBase64), 'base64')]).toEqual([1]);
    await expect(controlButton).not.toHaveClass(/is-active/);

    const shiftButton = page.getByLabel('Sticky shift');
    await shiftButton.click();
    await expect(shiftButton).toHaveClass(/is-active/);

    const shiftWriteCount = await hostRequestCount(page, 'remux/terminal/session/write');
    await page.getByLabel('Enter').click();
    const shiftWriteRequest = await waitForHostRequest(page, 'remux/terminal/session/write', shiftWriteCount + 1);
    const shiftWriteParams = recordParams(shiftWriteRequest);
    expect(Buffer.from(String(shiftWriteParams.dataBase64), 'base64').toString('utf8')).toBe('\x1b[13;2u');
    await expect(shiftButton).not.toHaveClass(/is-active/);

    const altButton = page.getByLabel('Sticky alt');
    await altButton.click();
    await expect(altButton).toHaveClass(/is-active/);
    await page.waitForTimeout(terminalModifierAutoClearMs + 250);
    await expect(altButton).not.toHaveClass(/is-active/);
  });

  test('attaches to an existing terminal resource and shows restart after exit', async ({ page }) => {
    await page.goto('/?remuxResourceKind=terminalSession&remuxResourceId=session-from-host&remuxTabId=tab-1');

    const attachRequest = await waitForHostRequest(page, 'remux/terminal/session/attach');
    expect(recordParams(attachRequest).sessionId).toBe('session-from-host');

    await page.evaluate(() => {
      window.__remuxTerminalHost?.sendTerminalEvent({
        jsonrpc: '2.0',
        method: 'remux/terminal/session/exited',
        params: {
          exitCode: 0,
          exitSignal: null,
          sessionId: 'session-from-host',
        },
      });
    });

    await expect(page.getByLabel('Start new shell')).toBeVisible();
  });
});

async function installMockRemuxHost(page: Page) {
  await page.addInitScript(() => {
    const state = {
      metrics: {
        keyboardHeight: 0,
        keyboardVisible: false,
        visibleBottom: window.innerHeight,
        visibleTop: 0,
        viewportHeight: window.innerHeight,
        viewportWidth: window.innerWidth,
      },
      requests: [] as HostRequest[],
      sessionId: 'mock-terminal-session',
    };

    function dispatch(message: unknown) {
      const event = new MessageEvent('message', {
        data: JSON.stringify(message),
      });
      window.dispatchEvent(event);
      document.dispatchEvent(event);
    }

    function postResult(request: HostRequest, result: unknown) {
      dispatch({
        id: request.id,
        result,
        type: 'remux/response',
      });
    }

    function postError(request: HostRequest, message: string) {
      dispatch({
        error: {
          code: -32000,
          message,
        },
        id: request.id,
        type: 'remux/error',
      });
    }

    function parseMessage(data: unknown): HostRequest | null {
      try {
        const parsed = typeof data === 'string' ? JSON.parse(data) : data;
        if (parsed && typeof parsed === 'object') {
          return parsed as HostRequest;
        }
      } catch {
        return null;
      }

      return null;
    }

    function paramsOf(request: HostRequest) {
      return isRecord(request.params) ? request.params : {};
    }

    window.__remuxTerminalHost = {
      requests: state.requests,
      sendTerminalEvent(message: unknown) {
        dispatch({
          message,
          type: 'remux/event',
        });
      },
      setViewportMetrics(metrics: ViewportMetrics) {
        state.metrics = metrics;
        dispatch({
          message: {
            jsonrpc: '2.0',
            method: 'host/viewport/changed',
            params: metrics,
          },
          type: 'remux/event',
        });
      },
    };

    window.addEventListener('message', (event) => {
      const request = parseMessage(event.data);
      if (!request || request.type !== 'remux/request') {
        return;
      }

      state.requests.push(request);
      const params = paramsOf(request);

      switch (request.method) {
        case 'host/keyboard/dismiss':
        case 'host/overview/open':
        case 'host/tab/update':
        case 'remux/terminal/session/kill':
        case 'remux/terminal/session/resize':
        case 'remux/terminal/session/write':
          postResult(request, { ok: true });
          return;

        case 'host/viewport/get':
          postResult(request, state.metrics);
          return;

        case 'remux/system/info':
          postResult(request, { cwd: '/workspace/remux' });
          return;

        case 'remux/terminal/session/attach': {
          const sessionId = typeof params.sessionId === 'string' ? params.sessionId : state.sessionId;
          state.sessionId = sessionId;
          postResult(request, {
            exitCode: null,
            exitSignal: null,
            nextSeq: 1,
            replay: [],
            replayTruncated: false,
            sessionId,
            status: 'running',
          });
          return;
        }

        case 'remux/terminal/session/start': {
          const sessionId = typeof params.sessionId === 'string' ? params.sessionId : state.sessionId;
          state.sessionId = sessionId;
          postResult(request, {
            cols: typeof params.cols === 'number' ? params.cols : 80,
            cwd: typeof params.cwd === 'string' ? params.cwd : '/workspace/remux',
            pid: 12345,
            rows: typeof params.rows === 'number' ? params.rows : 24,
            sessionId,
            shell: '/bin/sh',
          });
          return;
        }

        default:
          postError(request, `Unhandled test request: ${request.method ?? '(missing)'}`);
      }
    });

    function isRecord(value: unknown): value is Record<string, unknown> {
      return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
    }
  });
}

async function waitForHostRequest(page: Page, method: string, count = 1) {
  await page.waitForFunction(({ method, count }) => {
    const requests = window.__remuxTerminalHost?.requests ?? [];
    return requests.filter((request) => request.method === method).length >= count;
  }, { count, method });

  const requests = await hostRequests(page, method);
  return requests[count - 1]!;
}

async function hostRequests(page: Page, method: string) {
  return page.evaluate((method) => {
    return (window.__remuxTerminalHost?.requests ?? [])
      .filter((request) => request.method === method);
  }, method) as Promise<HostRequest[]>;
}

async function hostRequestCount(page: Page, method: string) {
  return (await hostRequests(page, method)).length;
}

function recordParams(request: HostRequest) {
  return isRecord(request.params) ? request.params : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
