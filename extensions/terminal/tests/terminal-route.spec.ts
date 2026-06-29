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
  setTmuxContext: (context: unknown) => void;
  setViewportMetrics: (metrics: ViewportMetrics) => void;
};

declare global {
  interface Window {
    __remuxTerminalAttachReplay?: Array<{ dataBase64: string; seq: number }>;
    __remuxTerminalClipboardText?: string;
    __remuxTerminalInitialTmuxContext?: unknown;
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
    await expect(keyRow.locator('.remux-terminal-key')).toHaveCount(13);
    await expect(fixedKeys.locator('.remux-terminal-key')).toHaveCount(2);
    await expect(fixedKeys.locator('.remux-terminal-key').nth(0)).toHaveAttribute('aria-label', 'Open tabs');
    await expect(fixedKeys.locator('.remux-terminal-key').nth(1)).toHaveAttribute('aria-label', 'Terminal menu');
    await expect(scrollKeys.locator('.remux-terminal-key')).toHaveCount(11);

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
    expect(rowMetrics.offsetHeight).toBe(41);

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

  test('requests a host reload from the terminal menu', async ({ page }) => {
    await page.goto('/?remuxLaunch=new-terminal');
    await waitForHostRequest(page, 'remux/terminal/session/start');

    await page.getByLabel('Terminal menu').click();
    await page.getByRole('menuitem', { name: 'Reload viewer' }).click();
    await waitForHostRequest(page, 'host/view/reload');
  });

  test('toggles keyboard by tapping the terminal viewport', async ({ page }) => {
    await page.goto('/?remuxLaunch=new-terminal');
    await waitForHostRequest(page, 'remux/terminal/session/start');

    await page.locator('.remux-terminal-container').click({ position: { x: 24, y: 24 } });
    await page.getByLabel('Terminal menu').click();
    await expect(page.getByRole('menuitem', { name: 'Hide keyboard' })).toBeVisible();

    await page.getByRole('menuitem', { name: 'Hide keyboard' }).click();
    await waitForHostRequest(page, 'host/keyboard/dismiss');

    await page.getByLabel('Terminal menu').click();
    await expect(page.getByRole('menuitem', { name: 'Show keyboard' })).toBeVisible();
  });

  test('pastes from the terminal menu', async ({ page }) => {
    await page.goto('/?remuxLaunch=new-terminal');
    await waitForHostRequest(page, 'remux/terminal/session/start');
    await page.evaluate(() => navigator.clipboard.writeText('echo remux'));

    const writeCount = await hostRequestCount(page, 'remux/terminal/session/write');
    await page.getByLabel('Terminal menu').click();
    await page.getByRole('menuitem', { name: 'Paste' }).click();

    await waitForHostRequest(page, 'host/clipboard/read');
    const writeRequest = await waitForHostRequest(page, 'remux/terminal/session/write', writeCount + 1);
    const writeParams = recordParams(writeRequest);
    expect(Buffer.from(String(writeParams.dataBase64), 'base64').toString('utf8')).toBe('echo remux');
  });

  test('selects terminal text and copies it from selection mode', async ({ page }) => {
    await page.goto('/?remuxLaunch=new-terminal');
    const startRequest = await waitForHostRequest(page, 'remux/terminal/session/start');
    const startParams = recordParams(startRequest);

    await sendTerminalOutput(page, 1, 'hello world\r\n');
    await page.waitForTimeout(100);

    await page.getByLabel('Terminal menu').click();
    await page.getByRole('menuitem', { name: 'Select text' }).click();
    await expect(page.locator('.remux-terminal-container')).toHaveClass(/is-selecting/);
    await expect(page.getByLabel('Copy selection')).toBeDisabled();

    const screenBox = await page.locator('.xterm-screen').boundingBox();
    expect(screenBox).not.toBeNull();
    const cols = Number(startParams.cols);
    const rows = Number(startParams.rows);
    expect(cols).toBeGreaterThan(0);
    expect(rows).toBeGreaterThan(0);
    const cellWidth = screenBox!.width / cols;
    const cellHeight = screenBox!.height / rows;
    const y = screenBox!.y + cellHeight * 0.5;
    await page.mouse.move(screenBox!.x + cellWidth * 0.1, y);
    await page.mouse.down();
    await page.mouse.move(screenBox!.x + cellWidth * 4.6, y, { steps: 5 });
    await page.mouse.up();

    await expect(page.getByLabel('Copy selection')).toBeEnabled();
    await page.getByLabel('Copy selection').click();
    await expect(page.locator('.remux-terminal-container')).not.toHaveClass(/is-selecting/);
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe('hello');
  });

  test('publishes a compact tab title without action bar footer status', async ({ page }) => {
    await page.goto('/?remuxLaunch=new-terminal');
    await waitForHostRequest(page, 'remux/terminal/session/start');

    await expect(page.locator('.remux-extension-action-status')).toHaveCount(0);
    await page.waitForFunction(() => {
      return (window.__remuxTerminalHost?.requests ?? []).some((request) => {
        const params = request.params;
        return (
          request.method === 'host/tab/update' &&
          Boolean(params) &&
          typeof params === 'object' &&
          !Array.isArray(params) &&
          (params as Record<string, unknown>).title === 'workspace/remux'
        );
      });
    });

    const metadataUpdate = (await hostRequests(page, 'host/tab/update'))
      .map(recordParams)
      .find((params) => params.title === 'workspace/remux');
    expect(metadataUpdate).toMatchObject({
      status: 'sh',
      title: 'workspace/remux',
    });
  });

  test('updates tab title from shell integration cwd and command lifecycle', async ({ page }) => {
    await page.goto('/?remuxLaunch=new-terminal');
    await waitForHostRequest(page, 'remux/terminal/session/start');

    let requestCount = await hostRequestCount(page, 'host/tab/update');
    await sendTerminalOutput(page, 1, '\x1b]633;P;Cwd=/workspace/remux/extensions/terminal\x07');
    await waitForHostTabTitle(page, 'extensions/terminal', requestCount);

    requestCount = await hostRequestCount(page, 'host/tab/update');
    await sendTerminalOutput(page, 2, '\x1b]633;E;npm test\x07\x1b]633;C\x07');
    await waitForHostTabTitle(page, 'npm test', requestCount);

    requestCount = await hostRequestCount(page, 'host/tab/update');
    await sendTerminalOutput(page, 3, '\x1b]633;D;0\x07\x1b]633;P;Cwd=/workspace/remux/extensions/terminal\x07');
    await waitForHostTabTitle(page, 'extensions/terminal', requestCount);
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
    await expect(actionBar).toHaveCSS('padding-top', '10px');
    await expect(actionBar).toHaveCSS('padding-bottom', '10px');
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

  test('does not forward terminal query responses generated from replay', async ({ page }) => {
    await page.addInitScript((replay) => {
      window.__remuxTerminalAttachReplay = replay;
    }, [
      replayFrame(1, '\x1b[c\x1b[>c\x1b]10;?\x1b\\\x1b]11;?\x1b\\'),
    ]);
    await page.goto('/?remuxResourceKind=terminalSession&remuxResourceId=session-from-host&remuxTabId=tab-1');

    await waitForHostRequest(page, 'remux/terminal/session/attach');
    await page.waitForTimeout(250);

    expect(await hostRequestCount(page, 'remux/terminal/session/write')).toBe(0);
  });

  test('shows attached tmux windows with fixed scroll and menu actions', async ({ page }) => {
    await page.addInitScript((context) => {
      window.__remuxTerminalInitialTmuxContext = context;
    }, attachedTmuxContext());
    await page.goto('/?remuxLaunch=new-terminal');

    await waitForHostRequest(page, 'remux/terminal/session/start');
    await waitForHostRequest(page, 'remux/terminal/tmux/context/get');

    const actionStack = page.locator('.remux-terminal-action-stack');
    await expect(actionStack.locator('.remux-terminal-tmux-row')).toHaveCount(1);
    await expect(actionStack.locator('.remux-terminal-key-row')).toHaveCount(1);

    const tabs = page.locator('.remux-terminal-tmux-tab-key');
    await expect(tabs).toHaveCount(2);
    await expect(tabs.nth(0)).toHaveClass(/is-active/);
    await expect(page.getByLabel('tmux menu')).toHaveCount(0);
    await expect(page.getByLabel('tmux sessions')).toBeVisible();
    await expect(page.locator('.remux-terminal-tmux-fixed .remux-terminal-key')).toHaveCount(3);
    await expect(page.getByLabel('Scroll tmux up')).toBeVisible();
    await expect(page.getByLabel('Scroll tmux down')).toBeVisible();
    await expect(page.getByLabel('tmux actions')).toBeVisible();

    await tabs.nth(1).click();
    const actionRequest = await waitForHostRequest(page, 'remux/terminal/tmux/action');
    const actionParams = recordParams(actionRequest);
    expect(actionParams.action).toBe('select-window');
    expect(actionParams.socketPath).toBeNull();
    expect(actionParams.target).toMatchObject({ tmuxWindowId: '@1' });

    await page.getByLabel('Scroll tmux up').click();
    const scrollRequest = await waitForHostRequest(page, 'remux/terminal/tmux/action', 2);
    const scrollParams = recordParams(scrollRequest);
    expect(scrollParams.action).toBe('scroll-up');
    expect(scrollParams.lines).toBe(5);
    expect(scrollParams.target).toBeNull();

    await page.getByLabel('tmux actions').click();
    await expect(page.getByRole('menuitem', { name: 'New tab' })).toBeVisible();
    await expect(page.getByRole('menuitem', { name: 'Close tab' })).toBeVisible();
    await expect(page.getByRole('menuitem', { name: 'Exit tmux' })).toBeVisible();

    await page.getByRole('menuitem', { name: 'New tab' }).click();
    const newWindowRequest = await waitForHostRequest(page, 'remux/terminal/tmux/action', 3);
    const newWindowParams = recordParams(newWindowRequest);
    expect(newWindowParams.action).toBe('new-window');
    expect(newWindowParams.target).toMatchObject({ tmuxSessionId: '$0' });

    await page.getByLabel('tmux actions').click();
    await page.getByRole('menuitem', { name: 'Close tab' }).click();
    const closeWindowRequest = await waitForHostRequest(page, 'remux/terminal/tmux/action', 4);
    const closeWindowParams = recordParams(closeWindowRequest);
    expect(closeWindowParams.action).toBe('close-window');
    expect(closeWindowParams.target).toMatchObject({ tmuxWindowId: '@0' });

    await page.getByLabel('tmux actions').click();
    await page.getByRole('menuitem', { name: 'Exit tmux' }).click();
    const exitTmuxRequest = await waitForHostRequest(page, 'remux/terminal/tmux/action', 5);
    const exitTmuxParams = recordParams(exitTmuxRequest);
    expect(exitTmuxParams.action).toBe('exit-tmux');
    expect(exitTmuxParams.target).toBeNull();
  });

  test('lists tmux sessions with tab info and switches from the session picker', async ({ page }) => {
    await page.addInitScript((context) => {
      window.__remuxTerminalInitialTmuxContext = context;
    }, attachedTmuxContext());
    await page.goto('/?remuxLaunch=new-terminal');

    await waitForHostRequest(page, 'remux/terminal/session/start');
    await waitForHostRequest(page, 'remux/terminal/tmux/context/get');
    await expect(page.locator('.remux-terminal-tmux-row')).toBeVisible();

    await page.getByLabel('tmux sessions').click();
    await expect(page.getByRole('menuitem', { name: 'work: shell, logs' })).toBeVisible();
    await expect(page.getByRole('menuitem', { name: 'api: server' })).toBeVisible();

    await page.getByRole('menuitem', { name: 'api: server' }).click();
    const switchRequest = await waitForHostRequest(page, 'remux/terminal/tmux/action');
    const switchParams = recordParams(switchRequest);
    expect(switchParams.action).toBe('switch-session');
    expect(switchParams.socketPath).toBeNull();
    expect(switchParams.target).toMatchObject({ tmuxSessionId: '$1' });
    expect(switchParams.target).not.toHaveProperty('tmuxWindowId');
  });

  test('repeats tmux scroll while the scroll button is held', async ({ page }) => {
    await page.addInitScript((context) => {
      window.__remuxTerminalInitialTmuxContext = context;
    }, attachedTmuxContext());
    await page.goto('/?remuxLaunch=new-terminal');

    await waitForHostRequest(page, 'remux/terminal/session/start');
    await waitForHostRequest(page, 'remux/terminal/tmux/context/get');
    await expect(page.locator('.remux-terminal-tmux-row')).toBeVisible();

    const scrollButton = page.getByLabel('Scroll tmux up');
    const scrollButtonBox = await scrollButton.boundingBox();
    expect(scrollButtonBox).not.toBeNull();

    const beforeHoldCount = await hostRequestCount(page, 'remux/terminal/tmux/action');
    await page.mouse.move(
      scrollButtonBox!.x + scrollButtonBox!.width / 2,
      scrollButtonBox!.y + scrollButtonBox!.height / 2,
    );
    await page.mouse.down();
    try {
      await page.waitForFunction(({ count, method }) => {
        const requests = window.__remuxTerminalHost?.requests ?? [];
        return requests.filter((request) => request.method === method).length >= count;
      }, {
        count: beforeHoldCount + 3,
        method: 'remux/terminal/tmux/action',
      }, { timeout: 2_000 });
    } finally {
      await page.mouse.up();
    }

    const afterReleaseCount = await hostRequestCount(page, 'remux/terminal/tmux/action');
    expect(afterReleaseCount).toBeGreaterThanOrEqual(beforeHoldCount + 3);

    await page.waitForTimeout(260);
    expect(await hostRequestCount(page, 'remux/terminal/tmux/action')).toBe(afterReleaseCount);

    const scrollRequests = (await hostRequests(page, 'remux/terminal/tmux/action')).slice(beforeHoldCount);
    expect(scrollRequests.length).toBeGreaterThanOrEqual(3);
    expect(recordParams(scrollRequests[0]!).lines).toBe(5);
    for (const request of scrollRequests.slice(1)) {
      const params = recordParams(request);
      expect(params.action).toBe('scroll-up');
      expect(params.lines).toBe(3);
      expect(params.target).toBeNull();
    }
  });

  test('rapid tmux scroll taps send tap-sized scroll actions', async ({ page }) => {
    await page.addInitScript((context) => {
      window.__remuxTerminalInitialTmuxContext = context;
    }, attachedTmuxContext());
    await page.goto('/?remuxLaunch=new-terminal');

    await waitForHostRequest(page, 'remux/terminal/session/start');
    await waitForHostRequest(page, 'remux/terminal/tmux/context/get');
    await expect(page.locator('.remux-terminal-tmux-row')).toBeVisible();

    const beforeTapCount = await hostRequestCount(page, 'remux/terminal/tmux/action');
    const scrollButton = page.getByLabel('Scroll tmux up');
    await scrollButton.click();
    await scrollButton.click();
    await scrollButton.click();

    await page.waitForFunction(({ count, method }) => {
      const requests = window.__remuxTerminalHost?.requests ?? [];
      return requests.filter((request) => request.method === method).length >= count;
    }, {
      count: beforeTapCount + 3,
      method: 'remux/terminal/tmux/action',
    });

    const scrollRequests = (await hostRequests(page, 'remux/terminal/tmux/action')).slice(beforeTapCount);
    expect(scrollRequests).toHaveLength(3);
    for (const request of scrollRequests) {
      const params = recordParams(request);
      expect(params.action).toBe('scroll-up');
      expect(params.lines).toBe(5);
      expect(params.target).toBeNull();
    }
  });

  test('does not show tmux UI for available detached sessions', async ({ page }) => {
    await page.addInitScript((context) => {
      window.__remuxTerminalInitialTmuxContext = context;
    }, availableTmuxContext());
    await page.goto('/?remuxLaunch=new-terminal');

    await waitForHostRequest(page, 'remux/terminal/session/start');
    await waitForHostRequest(page, 'remux/terminal/tmux/context/get');

    await expect(page.locator('.remux-terminal-tmux-row')).toHaveCount(0);
    await expect(page.locator('.remux-terminal-tmux-tab-key')).toHaveCount(0);
  });

  test('does not send touch-scroll input while attached to tmux', async ({ page }) => {
    await page.addInitScript((context) => {
      window.__remuxTerminalInitialTmuxContext = context;
    }, attachedTmuxContext());
    await page.goto('/?remuxLaunch=new-terminal');

    await waitForHostRequest(page, 'remux/terminal/session/start');
    await waitForHostRequest(page, 'remux/terminal/tmux/context/get');
    await expect(page.locator('.remux-terminal-tmux-row')).toBeVisible();

    const writeCount = await hostRequestCount(page, 'remux/terminal/session/write');
    await page.evaluate(() => {
      const container = document.querySelector('.remux-terminal-container');
      if (!container) {
        throw new Error('missing terminal container');
      }
      const terminalContainer = container;

      function dispatchTouch(type: string, y: number) {
        const event = new Event(type, {
          bubbles: true,
          cancelable: true,
        });
        Object.defineProperty(event, 'touches', {
          value: type === 'touchend' ? [] : [{ clientY: y }],
        });
        Object.defineProperty(event, 'changedTouches', {
          value: [{ clientY: y }],
        });
        terminalContainer.dispatchEvent(event);
      }

      dispatchTouch('touchstart', 180);
      dispatchTouch('touchmove', 100);
      dispatchTouch('touchmove', 60);
      dispatchTouch('touchend', 60);
    });

    expect(await hostRequestCount(page, 'remux/terminal/session/write')).toBe(writeCount);
  });
});

async function installMockRemuxHost(page: Page) {
  await page.addInitScript(() => {
    const state = {
      clipboardText: '',
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
      tmuxContext: null as unknown,
    };

    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        readText: () => Promise.resolve(state.clipboardText),
        writeText: (text: string) => {
          state.clipboardText = text;
          window.__remuxTerminalClipboardText = text;
          return Promise.resolve();
        },
      },
    });

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
      setTmuxContext(context: unknown) {
        state.tmuxContext = context;
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
        case 'host/view/reload':
        case 'remux/terminal/session/kill':
        case 'remux/terminal/session/resize':
        case 'remux/terminal/session/write':
          postResult(request, { ok: true });
          return;

        case 'host/clipboard/read':
          postResult(request, { text: state.clipboardText });
          return;

        case 'host/viewport/get':
          postResult(request, state.metrics);
          return;

        case 'remux/system/info':
          postResult(request, { cwd: '/workspace/remux' });
          return;

        case 'remux/terminal/tmux/context/get':
          postResult(request, {
            context: state.tmuxContext ?? window.__remuxTerminalInitialTmuxContext ?? noneTmuxContext(),
          });
          return;

        case 'remux/terminal/tmux/action':
          postResult(request, {
            context: state.tmuxContext ?? window.__remuxTerminalInitialTmuxContext ?? noneTmuxContext(),
            ok: true,
          });
          return;

        case 'remux/terminal/session/attach': {
          const sessionId = typeof params.sessionId === 'string' ? params.sessionId : state.sessionId;
          state.sessionId = sessionId;
          postResult(request, {
            exitCode: null,
            exitSignal: null,
            nextSeq: 1,
            replay: window.__remuxTerminalAttachReplay ?? [],
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

    function noneTmuxContext() {
      return {
        currentClient: null,
        generatedAt: Date.now(),
        mode: 'none',
        sockets: [],
        terminalSessionId: state.sessionId,
        terminalTty: '/dev/pts/8',
      };
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

async function waitForHostTabTitle(page: Page, title: string, afterCount = 0) {
  await page.waitForFunction(({ afterCount, title }) => {
    const requests = (window.__remuxTerminalHost?.requests ?? [])
      .filter((request) => request.method === 'host/tab/update')
      .slice(afterCount);
    return requests.some((request) => {
      const params = request.params;
      return (
        Boolean(params) &&
        typeof params === 'object' &&
        !Array.isArray(params) &&
        (params as Record<string, unknown>).title === title
      );
    });
  }, { afterCount, title });
}

async function sendTerminalOutput(
  page: Page,
  seq: number,
  data: string,
  sessionId = 'mock-terminal-session',
) {
  await page.evaluate(({ frame, sessionId }) => {
    window.__remuxTerminalHost?.sendTerminalEvent({
      jsonrpc: '2.0',
      method: 'remux/terminal/session/output',
      params: {
        frame,
        sessionId,
      },
    });
  }, { frame: replayFrame(seq, data), sessionId });
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

function replayFrame(seq: number, data: string) {
  return {
    dataBase64: Buffer.from(data, 'utf8').toString('base64'),
    seq,
  };
}

function attachedTmuxContext() {
  return {
    currentClient: {
      controlMode: false,
      height: 24,
      pid: 456,
      sessionId: '$0',
      sessionName: 'work',
      socketPath: null,
      tty: '/dev/pts/8',
      width: 80,
    },
    generatedAt: Date.now(),
    mode: 'attached',
    sockets: [
      {
        available: true,
        error: null,
        options: {
          mouse: false,
          prefix: 'C-b',
          prefix2: null,
        },
        sessions: [
          {
            activeWindowId: '@0',
            attached: 1,
            id: '$0',
            name: 'work',
            windowCount: 2,
            windows: [
              tmuxWindow('@0', '$0', 0, 'shell', true, [tmuxPane('%0', '@0', true)]),
              tmuxWindow('@1', '$0', 1, 'logs', false, [tmuxPane('%1', '@1', true)]),
            ],
          },
          {
            activeWindowId: '@2',
            attached: 0,
            id: '$1',
            name: 'api',
            windowCount: 1,
            windows: [
              tmuxWindow('@2', '$1', 0, 'server', true, [tmuxPane('%2', '@2', true)]),
            ],
          },
        ],
        socketPath: null,
      },
    ],
    terminalSessionId: 'mock-terminal-session',
    terminalTty: '/dev/pts/8',
  };
}

function availableTmuxContext() {
  const context = attachedTmuxContext();
  return {
    ...context,
    currentClient: null,
    mode: 'available',
    sockets: [
      {
        ...context.sockets[0],
        sessions: [
          {
            ...context.sockets[0].sessions[0],
            attached: 0,
          },
        ],
      },
    ],
  };
}

function tmuxWindow(
  id: string,
  sessionId: string,
  index: number,
  name: string,
  active: boolean,
  panes: unknown[],
) {
  return {
    active,
    id,
    index,
    last: false,
    layout: 'layout',
    name,
    paneCount: panes.length,
    panes,
    sessionId,
  };
}

function tmuxPane(id: string, windowId: string, active: boolean) {
  return {
    active,
    currentCommand: 'bash',
    currentPath: '/workspace/remux',
    height: 24,
    id,
    inMode: false,
    index: 0,
    pid: 789,
    tty: '/dev/pts/9',
    width: 80,
    windowId,
  };
}
