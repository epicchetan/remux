import { expect, type Page, test } from '@playwright/test';
import { gzipSync } from 'node:zlib';

import { terminalModifierAutoClearMs } from '../viewer/src/terminal/keyEncoding';

type HostRequest = {
  contract?: {
    kind?: string;
    operationId?: string;
  };
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
    __remuxTerminalAttachReplay?: Array<{ dataBase64: string; seq: number; sessionGeneration: number }>;
    __remuxTerminalAttachRestore?: unknown;
    __remuxTerminalAttachRestoreSequence?: unknown[];
    __remuxTerminalEventDuringAttach?: unknown;
    __remuxTerminalFailAttachAfterFirst?: boolean;
    __remuxTerminalFailNextAttachCount?: number;
    __remuxTerminalClipboardText?: string;
    __remuxTerminalInitialTmuxContext?: unknown;
    __remuxTerminalReplacementInputStreamId?: string;
    __remuxTerminalFailNextWrite?: boolean;
    __remuxTerminalReadyFailures?: Array<'catchup-too-large' | 'gap' | 'stale-subscription'>;
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

  test('wraps menu paste when bracketed paste mode is active', async ({ page }) => {
    await page.goto('/?remuxLaunch=new-terminal');
    await waitForHostRequest(page, 'remux/terminal/session/start');
    await sendTerminalOutput(page, 1, '\x1b[?2004h');
    await page.evaluate(() => navigator.clipboard.writeText('echo bracketed'));

    const writeCount = await hostRequestCount(page, 'remux/terminal/session/write');
    await page.getByLabel('Terminal menu').click();
    await page.getByRole('menuitem', { name: 'Paste' }).click();

    await expect.poll(async () => (
      decodeWrites((await hostRequests(page, 'remux/terminal/session/write')).slice(writeCount))
    )).toContain('\x1b[200~echo bracketed\x1b[201~');
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

  test('replaces the key row with a selection bar and exits from the pinned key', async ({ page }) => {
    await page.goto('/?remuxLaunch=new-terminal');
    await waitForHostRequest(page, 'remux/terminal/session/start');

    await page.getByLabel('Terminal menu').click();
    await page.getByRole('menuitem', { name: 'Select text' }).click();

    await expect(page.locator('.remux-terminal-selection-status')).toHaveText('Drag or tap to select text');
    await expect(page.getByLabel('Open tabs')).toBeVisible();
    await expect(page.getByLabel('Exit selection')).toBeVisible();
    await expect(page.getByLabel('Copy selection')).toBeDisabled();
    await expect(page.getByLabel('Clear selection')).toBeDisabled();
    await expect(page.getByLabel('Escape')).toHaveCount(0);
    await expect(page.getByLabel('Terminal menu')).toHaveCount(0);

    await page.getByLabel('Exit selection').click();
    await expect(page.locator('.remux-terminal-container')).not.toHaveClass(/is-selecting/);
    await expect(page.getByLabel('Escape')).toBeVisible();
  });

  test('snaps a tap to the word under it and adjusts with the selection handles', async ({ page }) => {
    await page.goto('/?remuxLaunch=new-terminal');
    const startRequest = await waitForHostRequest(page, 'remux/terminal/session/start');
    const startParams = recordParams(startRequest);

    await sendTerminalOutput(page, 1, 'alpha beta gamma\r\n');
    await page.waitForTimeout(100);

    await page.getByLabel('Terminal menu').click();
    await page.getByRole('menuitem', { name: 'Select text' }).click();

    const screenBox = await page.locator('.xterm-screen').boundingBox();
    expect(screenBox).not.toBeNull();
    const cellWidth = screenBox!.width / Number(startParams.cols);
    const cellHeight = screenBox!.height / Number(startParams.rows);
    const rowCenterY = screenBox!.y + cellHeight * 0.5;

    // Tap the middle of "beta" (cells 6-9): the word snaps into the selection.
    await page.mouse.click(screenBox!.x + cellWidth * 7.5, rowCenterY);
    await expect(page.locator('.remux-terminal-selection-status')).toHaveText('4 characters selected');

    // Erase resets to the empty-selection hint; tap the word again to continue.
    await page.getByLabel('Clear selection').click();
    await expect(page.locator('.remux-terminal-selection-status')).toHaveText('Drag or tap to select text');
    await page.mouse.click(screenBox!.x + cellWidth * 7.5, rowCenterY);
    await expect(page.locator('.remux-terminal-selection-status')).toHaveText('4 characters selected');

    const endHandle = page.locator('.remux-terminal-selection-handle.is-end');
    await expect(page.locator('.remux-terminal-selection-handle.is-start')).toBeVisible();
    await expect(endHandle).toBeVisible();

    // Drag the end handle past "gamma" (end boundary at cell 16).
    const handleBox = await endHandle.boundingBox();
    expect(handleBox).not.toBeNull();
    await page.mouse.move(handleBox!.x + handleBox!.width / 2, handleBox!.y + handleBox!.height / 2);
    await page.mouse.down();
    await page.mouse.move(screenBox!.x + cellWidth * 16, rowCenterY, { steps: 4 });
    await page.mouse.up();

    await expect(page.locator('.remux-terminal-selection-status')).toHaveText('10 characters selected');
    await page.getByLabel('Copy selection').click();
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe('beta gamma');
  });

  test('a hold selects the whole trimmed line and enters selection mode', async ({ page }) => {
    await page.goto('/?remuxLaunch=new-terminal');
    const startRequest = await waitForHostRequest(page, 'remux/terminal/session/start');
    const startParams = recordParams(startRequest);

    await sendTerminalOutput(page, 1, 'alpha beta gamma    \r\n');
    await page.waitForTimeout(100);

    const screenBox = await page.locator('.xterm-screen').boundingBox();
    expect(screenBox).not.toBeNull();
    const cellWidth = screenBox!.width / Number(startParams.cols);
    const cellHeight = screenBox!.height / Number(startParams.rows);

    // Hold the middle of "beta": the whole line is selected without the
    // trailing blank padding, and the viewer enters selection mode.
    await dispatchTouchHold(page, {
      x: screenBox!.x + cellWidth * 7.5,
      y: screenBox!.y + cellHeight * 0.5,
    });
    await expect(page.locator('.remux-terminal-container')).toHaveClass(/is-selecting/);
    await expect(page.locator('.remux-terminal-selection-status')).toHaveText('16 characters selected');

    await page.getByLabel('Copy selection').click();
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe('alpha beta gamma');
  });

  test('a hold joins a soft-wrapped line without inserting spacing', async ({ page }) => {
    await page.goto('/?remuxLaunch=new-terminal');
    const startRequest = await waitForHostRequest(page, 'remux/terminal/session/start');
    const startParams = recordParams(startRequest);
    const cols = Number(startParams.cols);

    const wrapped = Array.from({ length: cols + 12 }, (_, index) => (
      String.fromCharCode(97 + (index % 26))
    )).join('');
    await sendTerminalOutput(page, 1, `${wrapped}\r\n`);
    await page.waitForTimeout(100);

    const screenBox = await page.locator('.xterm-screen').boundingBox();
    expect(screenBox).not.toBeNull();
    const cellWidth = screenBox!.width / cols;
    const cellHeight = screenBox!.height / Number(startParams.rows);

    // Hold the first visual row: the logical line spans the wrap, and the
    // copy joins the rows with no newline or padding in between.
    await dispatchTouchHold(page, {
      x: screenBox!.x + cellWidth * 5.5,
      y: screenBox!.y + cellHeight * 0.5,
    });
    await expect(page.locator('.remux-terminal-selection-status'))
      .toHaveText(`${cols + 12} characters selected`);

    await page.getByLabel('Copy selection').click();
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(wrapped);
  });

  test('a selection persists through taps until cleared, then a hold picks the line', async ({ page }) => {
    await page.goto('/?remuxLaunch=new-terminal');
    const startRequest = await waitForHostRequest(page, 'remux/terminal/session/start');
    const startParams = recordParams(startRequest);

    await sendTerminalOutput(page, 1, 'alpha beta gamma\r\n');
    await page.waitForTimeout(100);

    await page.getByLabel('Terminal menu').click();
    await page.getByRole('menuitem', { name: 'Select text' }).click();

    const screenBox = await page.locator('.xterm-screen').boundingBox();
    expect(screenBox).not.toBeNull();
    const cellWidth = screenBox!.width / Number(startParams.cols);
    const cellHeight = screenBox!.height / Number(startParams.rows);
    const rowCenterY = screenBox!.y + cellHeight * 0.5;

    await page.mouse.click(screenBox!.x + cellWidth * 7.5, rowCenterY);
    await expect(page.locator('.remux-terminal-selection-status')).toHaveText('4 characters selected');

    // A tap elsewhere must not replace the selection — it persists until Clear.
    await page.mouse.click(screenBox!.x + cellWidth * 2.5, rowCenterY);
    await expect(page.locator('.remux-terminal-selection-status')).toHaveText('4 characters selected');
    await expect(page.locator('.remux-terminal-selection-handle.is-start')).toBeVisible();

    // After Clear, a hold picks the whole line. The pointer-based hold covers
    // the on-device path where the pointer handlers claim the touch before
    // touchScroll can arm its own long-press.
    await page.getByLabel('Clear selection').click();
    await dispatchPointerHold(page, { x: screenBox!.x + cellWidth * 7.5, y: rowCenterY });
    await expect(page.locator('.remux-terminal-selection-status')).toHaveText('16 characters selected');
  });

  test('extends a selection across the viewport with edge auto-scroll', async ({ page }) => {
    await page.goto('/?remuxLaunch=new-terminal');
    const startRequest = await waitForHostRequest(page, 'remux/terminal/session/start');
    const startParams = recordParams(startRequest);
    const rows = Number(startParams.rows);

    const lines = Array.from({ length: 120 }, (_, index) => `line-${index}`).join('\r\n');
    await sendTerminalOutput(page, 1, `${lines}\r\n`);
    await page.waitForTimeout(100);

    await page.getByLabel('Terminal menu').click();
    await page.getByRole('menuitem', { name: 'Select text' }).click();

    const screenBox = await page.locator('.xterm-screen').boundingBox();
    expect(screenBox).not.toBeNull();
    const cellWidth = screenBox!.width / Number(startParams.cols);
    const cellHeight = screenBox!.height / rows;

    // Anchor near the bottom, then hold the pointer above the top-left corner;
    // the buffer auto-scrolls up while the selection keeps extending into
    // scrollback, ending at row 0 column 0.
    await page.mouse.move(screenBox!.x + cellWidth * 10, screenBox!.y + cellHeight * (rows - 5));
    await page.mouse.down();
    await page.mouse.move(screenBox!.x + 2, screenBox!.y - 40, { steps: 6 });
    await page.waitForTimeout(2500);
    await page.mouse.up();

    await page.getByLabel('Copy selection').click();
    const copied = await page.evaluate(() => navigator.clipboard.readText());
    expect(copied.startsWith('line-0')).toBeTruthy();
    expect(copied).toContain('line-60');
  });

  test('copies the last command output and the visible screen from the terminal menu', async ({ page }) => {
    await page.goto('/?remuxLaunch=new-terminal');
    await waitForHostRequest(page, 'remux/terminal/session/start');

    await page.getByLabel('Terminal menu').click();
    await expect(page.getByRole('menuitem', { name: 'Copy last output' })).toBeDisabled();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('menuitem', { name: 'Copy last output' })).toHaveCount(0);

    await sendTerminalOutput(
      page,
      1,
      '$ ls\r\n\x1b]633;C\x07file-a\r\nfile-b\r\n\x1b]633;D;0\x07$ ',
    );
    await page.waitForTimeout(100);

    await page.getByLabel('Terminal menu').click();
    const lastOutputItem = page.getByRole('menuitem', { name: 'Copy last output' });
    await expect(lastOutputItem).toBeEnabled();
    await lastOutputItem.click();
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe('file-a\nfile-b');

    await page.getByLabel('Terminal menu').click();
    await page.getByRole('menuitem', { name: 'Copy screen' }).click();
    await expect.poll(async () => {
      const screenText = await page.evaluate(() => navigator.clipboard.readText());
      return screenText.includes('$ ls') && screenText.includes('file-a') && screenText.includes('file-b');
    }).toBeTruthy();
  });

  test('bridges OSC 52 clipboard writes into the system clipboard', async ({ page }) => {
    await page.goto('/?remuxLaunch=new-terminal');
    await waitForHostRequest(page, 'remux/terminal/session/start');

    // 'git push origin main ✓' — the multibyte check mark exercises UTF-8
    // decoding of the base64 payload.
    await sendTerminalOutput(page, 1, '\x1b]52;c;Z2l0IHB1c2ggb3JpZ2luIG1haW4g4pyT\x07');
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText()))
      .toBe('git push origin main ✓');

    // Read queries and malformed payloads must leave the clipboard untouched.
    await sendTerminalOutput(page, 2, '\x1b]52;c;?\x07\x1b]52;c;not-base64!\x07');
    await page.waitForTimeout(100);
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('git push origin main ✓');
  });

  test('opens a tapped url in the browser and offers copy from the link row', async ({ page }) => {
    await page.goto('/?remuxLaunch=new-terminal');
    const startRequest = await waitForHostRequest(page, 'remux/terminal/session/start');
    const startParams = recordParams(startRequest);

    await page.evaluate(() => {
      const opened: string[] = [];
      (window as unknown as { __remuxOpenedLinks: string[] }).__remuxOpenedLinks = opened;
      window.open = ((url?: string | URL) => {
        opened.push(String(url));
        return {} as Window;
      }) as typeof window.open;
    });

    await sendTerminalOutput(page, 1, 'docs at https://example.com/guide for setup\r\n');
    await page.waitForTimeout(100);

    const screenBox = await page.locator('.xterm-screen').boundingBox();
    expect(screenBox).not.toBeNull();
    const cellWidth = screenBox!.width / Number(startParams.cols);
    const cellHeight = screenBox!.height / Number(startParams.rows);
    // 'docs at ' spans columns 0-7, so column 20 is inside the url.
    const linkX = screenBox!.x + cellWidth * 20.5;
    const linkY = screenBox!.y + cellHeight * 0.5;

    // A tap raises the link row without opening anything yet.
    const linkRow = page.locator('.remux-terminal-link-row');
    await page.mouse.click(linkX, linkY);
    await expect(linkRow).toContainText('https://example.com/guide');
    expect(await page.evaluate(() => (
      (window as unknown as { __remuxOpenedLinks: string[] }).__remuxOpenedLinks
    ))).toEqual([]);

    // Open asks the host to launch the default browser and drops the row;
    // the in-page window.open fallback stays untouched.
    await page.getByLabel('Open link').click();
    await expect(linkRow).toHaveCount(0);
    const linkOpenRequest = await waitForHostRequest(page, 'host/link/open');
    expect(recordParams(linkOpenRequest).url).toBe('https://example.com/guide');
    expect(await page.evaluate(() => (
      (window as unknown as { __remuxOpenedLinks: string[] }).__remuxOpenedLinks
    ))).toEqual([]);

    await page.mouse.click(linkX, linkY);
    await expect(linkRow).toContainText('https://example.com/guide');
    await page.getByLabel('Copy link').click();
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe('https://example.com/guide');
    await expect(linkRow).toContainText('Link copied');
    await expect(linkRow).toHaveCount(0);

    // Left alone, the row expires on its own.
    await page.mouse.click(linkX, linkY);
    await expect(linkRow).toContainText('https://example.com/guide');
    await expect(linkRow).toHaveCount(0, { timeout: 8_000 });
  });

  test('opens OSC 8 hyperlinks from a tap and dismisses the link row', async ({ page }) => {
    await page.goto('/?remuxLaunch=new-terminal');
    const startRequest = await waitForHostRequest(page, 'remux/terminal/session/start');
    const startParams = recordParams(startRequest);

    await page.evaluate(() => {
      const opened: string[] = [];
      (window as unknown as { __remuxOpenedLinks: string[] }).__remuxOpenedLinks = opened;
      window.open = ((url?: string | URL) => {
        opened.push(String(url));
        return {} as Window;
      }) as typeof window.open;
    });

    await sendTerminalOutput(
      page,
      1,
      'run \x1b]8;;https://remux.dev/help\x07the help guide\x1b]8;;\x07 now\r\n',
    );
    await page.waitForTimeout(100);

    const screenBox = await page.locator('.xterm-screen').boundingBox();
    expect(screenBox).not.toBeNull();
    const cellWidth = screenBox!.width / Number(startParams.cols);
    const cellHeight = screenBox!.height / Number(startParams.rows);

    // 'the help guide' spans columns 4-17; the uri itself is never visible.
    const linkRow = page.locator('.remux-terminal-link-row');
    await page.mouse.click(screenBox!.x + cellWidth * 10.5, screenBox!.y + cellHeight * 0.5);
    await expect(linkRow).toContainText('https://remux.dev/help');
    expect(await page.evaluate(() => (
      (window as unknown as { __remuxOpenedLinks: string[] }).__remuxOpenedLinks
    ))).toEqual([]);

    await page.getByLabel('Dismiss link').click();
    await expect(linkRow).toHaveCount(0);

    // Taps outside any link fall through to the keyboard, never the link row.
    await page.mouse.click(screenBox!.x + cellWidth * 30.5, screenBox!.y + cellHeight * 2.5);
    await page.waitForTimeout(150);
    await expect(linkRow).toHaveCount(0);
  });

  test('opens tapped file references relative to the terminal cwd', async ({ page }) => {
    await page.goto('/?remuxLaunch=new-terminal');
    const startRequest = await waitForHostRequest(page, 'remux/terminal/session/start');
    const startParams = recordParams(startRequest);

    await sendTerminalOutput(page, 1, 'edit extensions/codex/viewer/App.tsx:577 now\r\n');
    await page.waitForTimeout(100);

    const screenBox = await page.locator('.xterm-screen').boundingBox();
    expect(screenBox).not.toBeNull();
    const cellWidth = screenBox!.width / Number(startParams.cols);
    const cellHeight = screenBox!.height / Number(startParams.rows);
    // 'edit ' spans columns 0-4, so column 18 is inside the file path.
    const fileX = screenBox!.x + cellWidth * 18.5;
    const fileY = screenBox!.y + cellHeight * 0.5;

    const linkRow = page.locator('.remux-terminal-link-row');
    await page.mouse.click(fileX, fileY);
    await expect(linkRow).toContainText('extensions/codex/viewer/App.tsx:577');

    await page.getByLabel('Open file').click();
    await expect(linkRow).toHaveCount(0);
    const fileOpenRequest = await waitForHostRequest(page, 'host/file/open');
    expect(recordParams(fileOpenRequest)).toMatchObject({
      line: 577,
      path: '/workspace/remux/extensions/codex/viewer/App.tsx',
    });

    await page.mouse.click(fileX, fileY);
    await expect(linkRow).toContainText('extensions/codex/viewer/App.tsx:577');
    await page.getByLabel('Copy file').click();
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText()))
      .toBe('extensions/codex/viewer/App.tsx:577');
    await expect(linkRow).toContainText('File copied');
    await expect(linkRow).toHaveCount(0);
  });

  test('opens OSC 8 file hyperlinks from a tap', async ({ page }) => {
    await page.goto('/?remuxLaunch=new-terminal');
    const startRequest = await waitForHostRequest(page, 'remux/terminal/session/start');
    const startParams = recordParams(startRequest);

    await sendTerminalOutput(
      page,
      1,
      'open \x1b]8;;file:///workspace/remux/packages/viewer-kit/src/links.ts:12\x07links.ts:12\x1b]8;;\x07 now\r\n',
    );
    await page.waitForTimeout(100);

    const screenBox = await page.locator('.xterm-screen').boundingBox();
    expect(screenBox).not.toBeNull();
    const cellWidth = screenBox!.width / Number(startParams.cols);
    const cellHeight = screenBox!.height / Number(startParams.rows);

    // 'links.ts:12' spans columns 5-15; the file URI itself is never visible.
    const linkRow = page.locator('.remux-terminal-link-row');
    await page.mouse.click(screenBox!.x + cellWidth * 10.5, screenBox!.y + cellHeight * 0.5);
    await expect(linkRow).toContainText('/workspace/remux/packages/viewer-kit/src/links.ts:12');

    await page.getByLabel('Open file').click();
    await expect(linkRow).toHaveCount(0);
    const fileOpenRequest = await waitForHostRequest(page, 'host/file/open');
    expect(recordParams(fileOpenRequest)).toMatchObject({
      line: 12,
      path: '/workspace/remux/packages/viewer-kit/src/links.ts',
    });
  });

  test('keeps the link row alive and expiring when the host rejects a file open', async ({ page }) => {
    await page.goto('/?remuxLaunch=new-terminal');
    const startRequest = await waitForHostRequest(page, 'remux/terminal/session/start');
    const startParams = recordParams(startRequest);

    await sendTerminalOutput(page, 1, 'edit src/unopenable.ts:3 now\r\n');
    await page.waitForTimeout(100);

    const screenBox = await page.locator('.xterm-screen').boundingBox();
    expect(screenBox).not.toBeNull();
    const cellWidth = screenBox!.width / Number(startParams.cols);
    const cellHeight = screenBox!.height / Number(startParams.rows);

    // 'edit ' spans columns 0-4, so column 12 is inside the file path.
    const linkRow = page.locator('.remux-terminal-link-row');
    await page.mouse.click(screenBox!.x + cellWidth * 12.5, screenBox!.y + cellHeight * 0.5);
    await expect(linkRow).toContainText('src/unopenable.ts:3');

    await page.getByLabel('Open file').click();
    await waitForHostRequest(page, 'host/file/open');

    // The rejected open leaves the row in place, and the expiry timer is
    // re-armed rather than lost — the row must still time out on its own.
    await expect(linkRow).toContainText('src/unopenable.ts:3');
    await expect(linkRow).toHaveCount(0, { timeout: 8_000 });
  });

  test('ignores link taps that stop a scroll fling', async ({ page }) => {
    await page.goto('/?remuxLaunch=new-terminal');
    await waitForHostRequest(page, 'remux/terminal/session/start');

    const lines = Array.from({ length: 200 }, (_, index) => `https://example.com/line-${index}`).join('\r\n');
    await sendTerminalOutput(page, 1, `${lines}\r\n`);
    await page.waitForTimeout(100);

    const screenBox = await page.locator('.xterm-screen').boundingBox();
    expect(screenBox).not.toBeNull();
    const tapPoint = { x: screenBox!.x + 40, y: screenBox!.y + 60 };

    // Fling the buffer up into scrollback, leaving momentum running.
    const dragX = screenBox!.x + 150;
    const dragStartY = screenBox!.y + 100;
    await dispatchTouchDrag(page, [
      { x: dragX, y: dragStartY },
      { x: dragX, y: dragStartY + 60 },
      { x: dragX, y: dragStartY + 120 },
      { x: dragX, y: dragStartY + 180 },
    ], 20);

    // Every buffer row starts with a url, so this lands on one — but it is a
    // fling-stop, not a tap.
    const linkRow = page.locator('.remux-terminal-link-row');
    await dispatchTouchDrag(page, [tapPoint]);
    await page.waitForTimeout(300);
    await expect(linkRow).toHaveCount(0);

    // Once the buffer has settled, the same tap raises the link row.
    await page.waitForTimeout(700);
    await dispatchTouchDrag(page, [tapPoint]);
    await expect(linkRow).toContainText('https://example.com/line-');
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
    const enterKey = await settledTerminalKey(page, 'Enter');
    await enterKey.click();
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

  test('scopes durable input ids to the replacement producer stream', async ({ page }) => {
    await page.goto('/?remuxLaunch=new-terminal');
    await waitForHostRequest(page, 'remux/terminal/session/start');
    await waitForHostRequest(page, 'remux/terminal/session/ready');

    const enterKey = await settledTerminalKey(page, 'Enter');
    await enterKey.click();
    const firstWrite = await waitForHostRequest(page, 'remux/terminal/session/write');

    const readyCount = await hostRequestCount(page, 'remux/terminal/session/ready');
    await page.evaluate(() => {
      window.__remuxTerminalReplacementInputStreamId = 'replacement-input-stream';
      for (const lifecycle of [
        { epoch: 1, reason: 'appState', state: 'background' },
        { epoch: 2, reason: 'appState', state: 'active' },
      ]) {
        const event = new MessageEvent('message', {
          data: JSON.stringify({ lifecycle, type: 'remux/lifecycle' }),
        });
        window.dispatchEvent(event);
        document.dispatchEvent(event);
      }
    });
    await waitForHostRequest(page, 'remux/terminal/session/attach');
    await waitForHostRequest(page, 'remux/terminal/session/ready', readyCount + 1);

    await enterKey.click();
    const secondWrite = await waitForHostRequest(page, 'remux/terminal/session/write', 2);
    expect(recordParams(firstWrite)).toMatchObject({
      inputSeq: 1,
      inputStreamId: 'mock-input-stream',
    });
    expect(recordParams(secondWrite)).toMatchObject({
      inputSeq: 1,
      inputStreamId: 'replacement-input-stream',
    });
    expect(firstWrite.contract?.operationId).toContain(':mock-input-stream:1');
    expect(secondWrite.contract?.operationId).toContain(':replacement-input-stream:1');
    expect(secondWrite.contract?.operationId).not.toBe(firstWrite.contract?.operationId);
  });

  test('reattaches after a permanent durable input conflict', async ({ page }) => {
    await page.addInitScript(() => {
      window.__remuxTerminalFailNextWrite = true;
      window.__remuxTerminalReplacementInputStreamId = 'recovered-input-stream';
    });
    await page.goto('/?remuxLaunch=new-terminal');
    await waitForHostRequest(page, 'remux/terminal/session/start');
    const readyCount = await hostRequestCount(page, 'remux/terminal/session/ready');

    const enterKey = await settledTerminalKey(page, 'Enter');
    await enterKey.click();
    await waitForHostRequest(page, 'remux/terminal/session/write');
    await waitForHostRequest(page, 'remux/terminal/session/attach');
    await waitForHostRequest(page, 'remux/terminal/session/ready', readyCount + 1);

    await enterKey.click();
    const recoveredWrite = await waitForHostRequest(page, 'remux/terminal/session/write', 2);
    expect(recordParams(recoveredWrite)).toMatchObject({
      inputSeq: 1,
      inputStreamId: 'recovered-input-stream',
    });
  });

  test('fires a key press for every rapid tap without debouncing', async ({ page }) => {
    await page.goto('/?remuxLaunch=new-terminal');
    await waitForHostRequest(page, 'remux/terminal/session/start');

    const writeCount = await hostRequestCount(page, 'remux/terminal/session/write');
    const enterKey = await settledTerminalKey(page, 'Enter');
    for (let index = 0; index < 5; index += 1) {
      await enterKey.click();
    }

    await waitForHostRequest(page, 'remux/terminal/session/write', writeCount + 5);
    const decoded = decodeWrites(
      (await hostRequests(page, 'remux/terminal/session/write')).slice(writeCount),
    );
    expect(decoded).toEqual(['\r', '\r', '\r', '\r', '\r']);
  });

  test('does not fire a key press when the pointer drags across the key row', async ({ page }) => {
    await page.goto('/?remuxLaunch=new-terminal');
    await waitForHostRequest(page, 'remux/terminal/session/start');

    const writeCount = await hostRequestCount(page, 'remux/terminal/session/write');
    const escapeBox = await page.getByLabel('Escape').boundingBox();
    expect(escapeBox).not.toBeNull();
    const startX = escapeBox!.x + escapeBox!.width / 2;
    const startY = escapeBox!.y + escapeBox!.height / 2;
    await page.mouse.move(startX, startY);
    await page.mouse.down();
    await page.mouse.move(startX + 40, startY, { steps: 4 });
    await page.mouse.up();

    await page.waitForTimeout(150);
    expect(await hostRequestCount(page, 'remux/terminal/session/write')).toBe(writeCount);
  });

  test('repeats arrow keys while held', async ({ page }) => {
    await page.goto('/?remuxLaunch=new-terminal');
    await waitForHostRequest(page, 'remux/terminal/session/start');

    const writeCount = await hostRequestCount(page, 'remux/terminal/session/write');
    const arrowBox = await page.getByLabel('Arrow up').boundingBox();
    expect(arrowBox).not.toBeNull();
    await page.mouse.move(arrowBox!.x + arrowBox!.width / 2, arrowBox!.y + arrowBox!.height / 2);
    await page.mouse.down();
    await page.waitForTimeout(700);
    await page.mouse.up();

    await waitForHostRequest(page, 'remux/terminal/session/write', writeCount + 2);
    const decoded = decodeWrites(
      (await hostRequests(page, 'remux/terminal/session/write')).slice(writeCount),
    );
    expect(decoded.length).toBeGreaterThanOrEqual(2);
    for (const write of decoded) {
      expect(write).toBe('\x1b[A');
    }
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
          sessionGeneration: 1,
        },
      });
    });

    await expect(page.getByLabel('Start new shell')).toBeVisible();
  });

  test('restores a headless snapshot before applying its replay tail', async ({ page }) => {
    const snapshotData = gzipSync(
      Buffer.from('\x1b[?1049h\x1b[Hsnapshot-state\x1b[?1h', 'utf8'),
    ).toString('base64');
    await page.addInitScript((dataBase64) => {
      window.__remuxTerminalAttachRestore = {
        cols: 80,
        dataBase64,
        encoding: 'gzip-base64',
        kind: 'snapshot',
        rows: 24,
        throughSeq: 5,
      };
      window.__remuxTerminalAttachReplay = [{
        dataBase64: btoa('\r\nreplay-tail'),
        seq: 6,
        sessionGeneration: 1,
      }];
    }, snapshotData);
    await page.goto('/?remuxResourceKind=terminalSession&remuxResourceId=snapshot-session&remuxTabId=tab-1');

    const attachRequest = await waitForHostRequest(page, 'remux/terminal/session/attach');
    expect(recordParams(attachRequest).clientState).toEqual({ throughSeq: 0, valid: false });
    await page.waitForTimeout(200);
    await page.getByLabel('Terminal menu').click();
    await page.getByRole('menuitem', { name: 'Copy screen' }).click();
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toContain('snapshot-state');
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toContain('replay-tail');
  });

  test('retries an existing-session attach without replacing it with start', async ({ page }) => {
    await page.addInitScript(() => {
      window.__remuxTerminalFailNextAttachCount = 1;
      window.__remuxTerminalAttachReplay = [{
        dataBase64: btoa('preserved-after-attach-retry\r\n'),
        seq: 1,
        sessionGeneration: 1,
      }];
    });
    await page.goto('/?remuxResourceKind=terminalSession&remuxResourceId=retry-session&remuxTabId=tab-1');

    await waitForHostRequest(page, 'remux/terminal/session/attach', 2);
    expect(await hostRequestCount(page, 'remux/terminal/session/start')).toBe(0);
    await page.getByLabel('Terminal menu').click();
    await page.getByRole('menuitem', { name: 'Copy screen' }).click();
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText()))
      .toContain('preserved-after-attach-retry');
  });

  test('keeps snapshot client state invalid until restoration succeeds', async ({ page }) => {
    const validSnapshot = gzipSync(Buffer.from('valid-snapshot-state', 'utf8')).toString('base64');
    await page.addInitScript((dataBase64) => {
      window.__remuxTerminalAttachRestoreSequence = [
        {
          cols: 80,
          dataBase64: btoa('not-gzip'),
          encoding: 'gzip-base64',
          kind: 'snapshot',
          rows: 24,
          throughSeq: 1,
        },
        {
          cols: 80,
          dataBase64,
          encoding: 'gzip-base64',
          kind: 'snapshot',
          rows: 24,
          throughSeq: 1,
        },
      ];
    }, validSnapshot);
    await page.goto('/?remuxResourceKind=terminalSession&remuxResourceId=decode-retry&remuxTabId=tab-1');

    await waitForHostRequest(page, 'remux/terminal/session/attach', 2);
    const attaches = await hostRequests(page, 'remux/terminal/session/attach');
    expect(recordParams(attaches[1]!).clientState).toEqual({ throughSeq: 0, valid: false });
    await page.getByLabel('Terminal menu').click();
    await page.getByRole('menuitem', { name: 'Copy screen' }).click();
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText()))
      .toContain('valid-snapshot-state');
  });

  test('reattaches when a newly started subscription catchup is too large', async ({ page }) => {
    await page.addInitScript(() => {
      window.__remuxTerminalReadyFailures = ['catchup-too-large'];
      window.__remuxTerminalAttachReplay = [{
        dataBase64: btoa('startup-catchup-recovered\r\n'),
        seq: 1,
        sessionGeneration: 1,
      }];
    });
    await page.goto('/?remuxLaunch=new-terminal');

    await waitForHostRequest(page, 'remux/terminal/session/attach');
    await waitForHostRequest(page, 'remux/terminal/session/ready', 2);
    await page.getByLabel('Terminal menu').click();
    await page.getByRole('menuitem', { name: 'Copy screen' }).click();
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText()))
      .toContain('startup-catchup-recovered');
  });

  test('buffers live output that arrives while the initial attach is being parsed', async ({ page }) => {
    await page.addInitScript(() => {
      window.__remuxTerminalAttachReplay = [{
        dataBase64: btoa('replay-before-ready\r\n'),
        seq: 1,
        sessionGeneration: 1,
      }];
      window.__remuxTerminalEventDuringAttach = {
        jsonrpc: '2.0',
        method: 'remux/terminal/session/output',
        params: {
          frame: {
            dataBase64: btoa('live-during-attach\r\n'),
            seq: 2,
            sessionGeneration: 1,
          },
          sessionGeneration: 1,
          sessionId: 'initial-race-session',
        },
      };
    });
    await page.goto('/?remuxResourceKind=terminalSession&remuxResourceId=initial-race-session&remuxTabId=tab-1');

    await waitForHostRequest(page, 'remux/terminal/session/ready');
    await page.getByLabel('Terminal menu').click();
    await page.getByRole('menuitem', { name: 'Copy screen' }).click();
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toContain('replay-before-ready');
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toContain('live-during-attach');
  });

  test('keeps gap frames quarantined across a failed resync', async ({ page }) => {
    await page.addInitScript(() => {
      window.__remuxTerminalAttachReplay = [{
        dataBase64: btoa('frame-one\r\n'),
        seq: 1,
        sessionGeneration: 1,
      }];
      window.__remuxTerminalFailAttachAfterFirst = true;
    });
    await page.goto('/?remuxResourceKind=terminalSession&remuxResourceId=failed-resync-session&remuxTabId=tab-1');
    await waitForHostRequest(page, 'remux/terminal/session/ready');

    await page.evaluate(() => {
      window.__remuxTerminalHost?.sendTerminalEvent({
        jsonrpc: '2.0',
        method: 'remux/terminal/session/output',
        params: {
          frame: {
            dataBase64: btoa('frame-three\r\n'),
            seq: 3,
            sessionGeneration: 1,
          },
          sessionGeneration: 1,
          sessionId: 'failed-resync-session',
        },
      });
    });
    await waitForHostRequest(page, 'remux/terminal/session/attach', 2);
    await page.waitForTimeout(100);
    await page.getByLabel('Terminal menu').click();
    await page.getByRole('menuitem', { name: 'Copy screen' }).click();
    expect(await page.evaluate(() => navigator.clipboard.readText())).not.toContain('frame-three');

    await page.evaluate(() => {
      window.__remuxTerminalAttachReplay = [
        { dataBase64: btoa('frame-one\r\n'), seq: 1, sessionGeneration: 1 },
        { dataBase64: btoa('frame-two\r\n'), seq: 2, sessionGeneration: 1 },
      ];
      window.__remuxTerminalFailAttachAfterFirst = false;
    });
    await waitForHostRequest(page, 'remux/terminal/session/ready', 2);
    await page.getByLabel('Terminal menu').click();
    await page.getByRole('menuitem', { name: 'Copy screen' }).click();
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toContain('frame-two');
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toContain('frame-three');
  });

  test('reports effective focus across app lifecycle only after resync', async ({ page }) => {
    await page.addInitScript(() => {
      window.__remuxTerminalAttachReplay = [{
        dataBase64: btoa('\x1b[?1004h'),
        seq: 1,
        sessionGeneration: 1,
      }];
    });
    await page.goto('/?remuxResourceKind=terminalSession&remuxResourceId=focus-session&remuxTabId=tab-1');
    await waitForHostRequest(page, 'remux/terminal/session/ready');
    await page.evaluate(() => {
      const event = new MessageEvent('message', {
        data: JSON.stringify({
          lifecycle: { epoch: 1, reason: 'connect', state: 'active' },
          type: 'remux/lifecycle',
        }),
      });
      window.dispatchEvent(event);
      document.dispatchEvent(event);
    });
    await waitForHostRequest(page, 'remux/terminal/session/ready', 2);
    await sendTerminalOutput(page, 2, '\x1b[?1004h');
    await page.waitForTimeout(100);
    const writeCount = await hostRequestCount(page, 'remux/terminal/session/write');

    await page.evaluate(() => {
      const event = new MessageEvent('message', {
        data: JSON.stringify({
          lifecycle: { epoch: 2, reason: 'appState', state: 'background' },
          type: 'remux/lifecycle',
        }),
      });
      window.dispatchEvent(event);
      document.dispatchEvent(event);
    });
    await expect.poll(async () => (
      decodeWrites((await hostRequests(page, 'remux/terminal/session/write')).slice(writeCount))
    )).toContain('\x1b[O');

    const readyCount = await hostRequestCount(page, 'remux/terminal/session/ready');
    await page.evaluate(() => {
      const event = new MessageEvent('message', {
        data: JSON.stringify({
          lifecycle: { epoch: 3, reason: 'appState', state: 'active' },
          type: 'remux/lifecycle',
        }),
      });
      window.dispatchEvent(event);
      document.dispatchEvent(event);
    });
    await waitForHostRequest(page, 'remux/terminal/session/ready', readyCount + 1);
    await expect.poll(async () => (
      decodeWrites((await hostRequests(page, 'remux/terminal/session/write')).slice(writeCount))
    )).toContain('\x1b[I');
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

  test('sends SGR wheel reports for touch scroll while an app holds mouse mode', async ({ page }) => {
    await page.goto('/?remuxLaunch=new-terminal');
    await waitForHostRequest(page, 'remux/terminal/session/start');

    await sendTerminalOutput(page, 1, 'ready\r\n');
    // Negotiate VT200 mouse tracking + SGR encoding, like vim/htop/lazygit do.
    await sendTerminalOutput(page, 2, '\x1b[?1000h\x1b[?1006h');
    await page.waitForTimeout(150);

    const screenBox = await page.locator('.xterm-screen').boundingBox();
    expect(screenBox).not.toBeNull();
    const x = screenBox!.x + screenBox!.width / 2;
    const top = screenBox!.y + screenBox!.height * 0.25;
    const bottom = screenBox!.y + screenBox!.height * 0.85;

    const writeCount = await hostRequestCount(page, 'remux/terminal/session/write');
    // Finger drags down -> wheel up -> SGR button 64.
    await dispatchTouchDrag(page, [
      { x, y: top },
      { x, y: (top + bottom) / 2 },
      { x, y: bottom },
    ]);

    await expect.poll(async () => {
      const writes = (await hostRequests(page, 'remux/terminal/session/write')).slice(writeCount);
      return decodeWrites(writes).some((data) => /\x1b\[<64;\d+;\d+M/.test(data));
    }).toBe(true);
  });

  test('routes alternate-buffer touch scroll to cursor keys honoring DECCKM', async ({ page }) => {
    await page.goto('/?remuxLaunch=new-terminal');
    await waitForHostRequest(page, 'remux/terminal/session/start');

    await sendTerminalOutput(page, 1, 'ready\r\n');
    // Enter the alternate screen with application cursor keys (a full-screen pager, no mouse).
    await sendTerminalOutput(page, 2, '\x1b[?1049h\x1b[?1h');
    await page.waitForTimeout(150);

    const screenBox = await page.locator('.xterm-screen').boundingBox();
    expect(screenBox).not.toBeNull();
    const x = screenBox!.x + screenBox!.width / 2;
    const top = screenBox!.y + screenBox!.height * 0.25;
    const bottom = screenBox!.y + screenBox!.height * 0.85;

    const writeCount = await hostRequestCount(page, 'remux/terminal/session/write');
    await dispatchTouchDrag(page, [
      { x, y: top },
      { x, y: (top + bottom) / 2 },
      { x, y: bottom },
    ]);

    await expect.poll(async () => {
      const decoded = decodeWrites(
        (await hostRequests(page, 'remux/terminal/session/write')).slice(writeCount),
      );
      return {
        appCursorUp: decoded.some((data) => data.includes('\x1bOA')),
        csiUp: decoded.some((data) => data.includes('\x1b[A')),
      };
    }).toEqual({ appCursorUp: true, csiUp: false });
  });

  test('onscreen arrows honor application cursor mode', async ({ page }) => {
    await page.goto('/?remuxLaunch=new-terminal');
    await waitForHostRequest(page, 'remux/terminal/session/start');
    await sendTerminalOutput(page, 1, '\x1b[?1h');
    await page.waitForTimeout(100);

    const writeCount = await hostRequestCount(page, 'remux/terminal/session/write');
    await page.getByLabel('Arrow up').click();

    await expect.poll(async () => (
      decodeWrites((await hostRequests(page, 'remux/terminal/session/write')).slice(writeCount))
    )).toContain('\x1bOA');
  });

  test('keeps the keyboard up on a single tap and dismisses on a double tap', async ({ page }) => {
    await page.goto('/?remuxLaunch=new-terminal');
    await waitForHostRequest(page, 'remux/terminal/session/start');

    const container = page.locator('.remux-terminal-container');
    const keyboardFocused = () => page.evaluate(() =>
      document.activeElement?.classList.contains('xterm-helper-textarea') ?? false);

    // Single tap brings the keyboard up.
    await container.click({ position: { x: 24, y: 24 } });
    await expect.poll(keyboardFocused).toBe(true);

    // A lone tap while the keyboard is up must not dismiss it.
    const dismissBefore = await hostRequestCount(page, 'host/keyboard/dismiss');
    await page.waitForTimeout(400);
    await container.click({ position: { x: 24, y: 24 } });
    await page.waitForTimeout(80);
    expect(await keyboardFocused()).toBe(true);
    expect(await hostRequestCount(page, 'host/keyboard/dismiss')).toBe(dismissBefore);

    // A deliberate double tap dismisses it.
    await page.waitForTimeout(400);
    await container.click({ position: { x: 24, y: 24 } });
    await page.waitForTimeout(150);
    await container.click({ position: { x: 24, y: 24 } });
    await waitForHostRequest(page, 'host/keyboard/dismiss', dismissBefore + 1);
    await expect.poll(keyboardFocused).toBe(false);
  });
});

async function installMockRemuxHost(page: Page) {
  await page.addInitScript(() => {
    const state = {
      attachCount: 0,
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
      if (!request) {
        return;
      }

      // Notifications (e.g. session writes) carry no id and expect no response,
      // but tests still assert on them via the recorded request log.
      if (request.type === 'remux/notify') {
        state.requests.push(request);
        return;
      }

      if (request.type !== 'remux/request') {
        return;
      }

      state.requests.push(request);
      const params = paramsOf(request);

      switch (request.method) {
        case 'host/file/open':
          // Paths named "unopenable" reject, covering hosts without the
          // handler (or a dropped connection) where the RPC promise rejects.
          if (String(params.path ?? '').includes('unopenable')) {
            postError(request, 'File open failed in test host');
            return;
          }
          postResult(request, { ok: true });
          return;

        case 'host/keyboard/dismiss':
        case 'host/link/open':
        case 'host/overview/open':
        case 'host/tab/update':
        case 'host/view/reload':
        case 'remux/terminal/session/kill':
        case 'remux/terminal/session/resize':
          postResult(request, { ok: true });
          return;

        case 'remux/terminal/session/write':
          if (window.__remuxTerminalFailNextWrite) {
            window.__remuxTerminalFailNextWrite = false;
            postError(request, 'operationId was already admitted with different parameters');
            return;
          }
          postResult(request, {
            acceptedInputSeq: params.inputSeq,
            duplicate: false,
            nextInputSeq: Number(params.inputSeq) + 1,
            ok: true,
            sessionGeneration: 1,
          });
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
          state.attachCount += 1;
          if ((window.__remuxTerminalFailNextAttachCount ?? 0) > 0) {
            window.__remuxTerminalFailNextAttachCount =
              (window.__remuxTerminalFailNextAttachCount ?? 0) - 1;
            postError(request, 'Injected transient attach failure');
            return;
          }
          if (window.__remuxTerminalFailAttachAfterFirst && state.attachCount > 1) {
            postError(request, 'Injected attach failure');
            return;
          }
          const sessionId = typeof params.sessionId === 'string' ? params.sessionId : state.sessionId;
          const replay = window.__remuxTerminalAttachReplay ?? [];
          const restore = window.__remuxTerminalAttachRestoreSequence?.length
            ? window.__remuxTerminalAttachRestoreSequence.shift()
            : window.__remuxTerminalAttachRestore;
          const throughSeq = Math.max(
            isRecord(restore) && typeof restore.throughSeq === 'number' ? restore.throughSeq : 0,
            ...replay.map((frame) => frame.seq),
          );
          const catchupEndSeq = throughSeq + 1;
          state.sessionId = sessionId;
          if (window.__remuxTerminalEventDuringAttach) {
            dispatch({
              message: window.__remuxTerminalEventDuringAttach,
              type: 'remux/event',
            });
            window.__remuxTerminalEventDuringAttach = undefined;
          }
          const replacementInputStreamId = window.__remuxTerminalReplacementInputStreamId;
          window.__remuxTerminalReplacementInputStreamId = undefined;
          postResult(request, {
            catchupEndSeq,
            exitCode: null,
            exitSignal: null,
            nextSeq: 1,
            nextOutputSeq: 1,
            firstAvailableSeq: 1,
            nextInputSeq: typeof params.inputSeq === 'number' ? params.inputSeq : 1,
            inputStreamId: replacementInputStreamId ?? (typeof params.inputStreamId === 'string'
              ? params.inputStreamId
              : 'mock-input-stream'),
            replay,
            replayComplete: true,
            replayNextSeq: catchupEndSeq,
            replayTruncated: false,
            restore,
            sessionId,
            sessionGeneration: 1,
            status: 'running',
            subscriptionToken: 'mock-subscription',
          });
          return;
        }

        case 'remux/terminal/session/ready': {
          const readyFailure = window.__remuxTerminalReadyFailures?.shift();
          if (readyFailure) {
            postResult(request, { ok: false, reason: readyFailure });
            return;
          }
          postResult(request, {
            nextOutputSeq: typeof params.throughSeq === 'number' ? params.throughSeq + 1 : 1,
            ok: true,
          });
          return;
        }

        case 'remux/terminal/session/start': {
          const sessionId = typeof params.sessionId === 'string' ? params.sessionId : state.sessionId;
          state.sessionId = sessionId;
          postResult(request, {
            catchupEndSeq: 1,
            cols: typeof params.cols === 'number' ? params.cols : 80,
            cwd: typeof params.cwd === 'string' ? params.cwd : '/workspace/remux',
            pid: 12345,
            rows: typeof params.rows === 'number' ? params.rows : 24,
            sessionId,
            sessionGeneration: 1,
            shell: '/bin/sh',
            inputStreamId: 'mock-input-stream',
            nextInputSeq: 1,
            firstAvailableSeq: 1,
            nextOutputSeq: 1,
            subscriptionToken: 'mock-subscription',
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

// Keys ignore taps that land within the fling-stop window after the row
// scrolls, so bring the key into view and let the row settle before tapping.
async function settledTerminalKey(page: Page, label: string) {
  const key = page.getByLabel(label);
  await key.scrollIntoViewIfNeeded();
  await page.waitForTimeout(250);
  return key;
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
        sessionGeneration: 1,
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

async function dispatchTouchDrag(
  page: Page,
  points: Array<{ x: number; y: number }>,
  stepDelayMs = 0,
) {
  await page.evaluate(async ({ points, stepDelayMs }) => {
    const container = document.querySelector('.remux-terminal-container');
    if (!container) {
      throw new Error('missing terminal container');
    }
    const terminalContainer = container;

    function dispatchTouch(type: string, point: { x: number; y: number }, ended = false) {
      const event = new Event(type, { bubbles: true, cancelable: true });
      const touch = { clientX: point.x, clientY: point.y };
      Object.defineProperty(event, 'touches', { value: ended ? [] : [touch] });
      Object.defineProperty(event, 'changedTouches', { value: [touch] });
      terminalContainer.dispatchEvent(event);
    }

    dispatchTouch('touchstart', points[0]!);
    for (let index = 1; index < points.length; index += 1) {
      if (stepDelayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, stepDelayMs));
      }
      dispatchTouch('touchmove', points[index]!);
    }
    dispatchTouch('touchend', points[points.length - 1]!, true);
  }, { points, stepDelayMs });
}

// A motionless touch hold, driven through the touch handlers (touchScroll's
// long-press path — synthetic touch events produce no pointer events).
async function dispatchTouchHold(page: Page, point: { x: number; y: number }) {
  await page.evaluate(async ({ point }) => {
    const container = document.querySelector('.remux-terminal-container');
    if (!container) {
      throw new Error('missing terminal container');
    }
    const terminalContainer = container;

    function dispatchTouch(type: string, ended = false) {
      const event = new Event(type, { bubbles: true, cancelable: true });
      const touch = { clientX: point.x, clientY: point.y };
      Object.defineProperty(event, 'touches', { value: ended ? [] : [touch] });
      Object.defineProperty(event, 'changedTouches', { value: [touch] });
      terminalContainer.dispatchEvent(event);
    }

    dispatchTouch('touchstart');
    await new Promise((resolve) => setTimeout(resolve, 650));
    dispatchTouch('touchend', true);
  }, { point });
}

// A motionless touch hold, driven through the pointer handlers (the path real
// devices take when a selection-mode drag claims the gesture).
async function dispatchPointerHold(page: Page, point: { x: number; y: number }) {
  await page.evaluate(async ({ point }) => {
    const container = document.querySelector('.remux-terminal-container');
    if (!container) {
      throw new Error('missing terminal container');
    }

    const init = {
      bubbles: true,
      cancelable: true,
      clientX: point.x,
      clientY: point.y,
      pointerId: 7,
      pointerType: 'touch',
    };
    container.dispatchEvent(new PointerEvent('pointerdown', init));
    await new Promise((resolve) => setTimeout(resolve, 650));
    container.dispatchEvent(new PointerEvent('pointerup', init));
  }, { point });
}

function decodeWrites(writes: HostRequest[]) {
  return writes.map((request) =>
    Buffer.from(String(recordParams(request).dataBase64), 'base64').toString('latin1'));
}

function replayFrame(seq: number, data: string) {
  return {
    dataBase64: Buffer.from(data, 'utf8').toString('base64'),
    sessionGeneration: 1,
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
