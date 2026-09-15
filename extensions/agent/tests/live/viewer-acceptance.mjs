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
let promptSent = false;
try {
  for (const target of [
    { name: 'desktop', viewport: { height: 900, width: 1280 } },
    { name: 'mobile', viewport: { height: 844, width: 390 } },
  ]) {
    const context = await browser.newContext({ colorScheme: 'dark', viewport: target.viewport });
    await context.addCookies([{
      url: options.httpBase,
      httpOnly: true,
      name: 'remux_auth',
      sameSite: 'Lax',
      secure: new URL(options.httpBase).protocol === 'https:',
      value: token,
    }]);
    const page = await context.newPage();
    const pageErrors = [];
    page.on('console', (message) => { if (message.type() === 'error') console.error(message.text()); });
    page.on('pageerror', (error) => pageErrors.push(error.message));
    const url = new URL('/viewers/agent/', options.httpBase);
    url.searchParams.set('remuxResourceKind', 'agentConversation');
    url.searchParams.set('remuxResourceId', options.conversationId);
    await page.goto(url.toString(), { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.__REMUX_DIRECT_HOST__?.status.type === 'connected', null, { timeout: 20_000 });
    const transcript = page.getByTestId('agent-transcript-content');
    if (options.generic) {
      await transcript.locator('[data-turn-id]').last().waitFor({ timeout: 20_000 });
      await transcript.locator('.codex-assistant-message').last().waitFor({ timeout: 20_000 });
    } else {
      await transcript.getByText('REMUX_CLEAN_FIRST_OK', { exact: true }).waitFor({ timeout: 20_000 });
      await transcript.getByText('REMUX_CONTEXT_8AUG26 REMUX_CLEAN_SECOND_OK', { exact: true })
        .waitFor({ timeout: 20_000 });
    }
    await page.getByRole('button', { name: 'Send message', exact: true }).waitFor();
    if (options.sendPrompt && !promptSent) {
      const textbox = page.getByRole('textbox', { name: 'Message', exact: true });
      await textbox.fill(options.sendPrompt);
      await page.getByRole('button', { name: 'Send message', exact: true }).click();
      if (options.expectText) {
        await transcript.locator('.codex-assistant-message')
          .getByText(options.expectText, { exact: true }).last().waitFor({ timeout: 120_000 });
      }
      promptSent = true;
    } else if (options.expectText) {
      await transcript.locator('.codex-assistant-message')
        .getByText(options.expectText, { exact: true }).last().waitFor({ timeout: 20_000 });
    }
    let composer = null;
    if (options.expectComposerContext) {
      const contextIndicator = page.locator('.remux-composer-context-percent');
      await contextIndicator.waitFor({ timeout: 20_000 });
      const usageRail = page.getByRole('button', { name: 'Show usage details' });
      assert.match(await usageRail.textContent(), /context\s*\/\s*[\d.]+[km]? tokens/iu,
        `${target.name} collapsed usage rail omitted its token count.`);
      await usageRail.click();
      const usageTray = page.getByRole('region', { name: 'Usage details' });
      await usageTray.waitFor({ timeout: 20_000 });
      await usageTray.locator('.remux-composer-plan-window').first().waitFor({ timeout: 20_000 });
      await usageTray.getByText(/^Live usage · updated/u).waitFor({ timeout: 20_000 });
      const usageScreenshot = resolve(options.outputDir, `${target.name}-usage.png`);
      await page.screenshot({ fullPage: true, path: usageScreenshot });
      const usage = {
        context: await usageTray.locator('.remux-composer-usage-section').first().innerText(),
        planWindows: await usageTray.locator('.remux-composer-plan-window').allInnerTexts(),
        source: await usageTray.locator('.remux-composer-usage-source').textContent(),
        screenshot: usageScreenshot,
      };
      await page.keyboard.press('Escape');
      await usageTray.waitFor({ state: 'detached' });
      await page.getByRole('button', { name: 'Preferences', exact: true }).click();
      const configPanel = page.locator('[data-remux-composer-config-panel]');
      await configPanel.waitFor();
      const rows = await configPanel.locator('.remux-composer-config-row').evaluateAll((elements) =>
        elements.map((element) => ({
          disabled: element instanceof HTMLButtonElement ? element.disabled : null,
          label: element.querySelector('.remux-composer-config-label')?.textContent?.trim() ?? '',
        })));
      const accessLabels = new Set(['Read only', 'Workspace write', 'Full access']);
      const nonModelLabels = new Set([
        'Reload', 'Compact context', 'Providers',
        'Off', 'Minimal', 'Low', 'Medium', 'High', 'Extra high',
        ...accessLabels,
      ]);
      const accessRow = rows.find(({ label }) => accessLabels.has(label));
      const modelRow = rows.find(({ label }) => !nonModelLabels.has(label));
      assert.equal(accessRow?.disabled, false, `${target.name} access control stayed locked.`);
      assert.equal(modelRow?.disabled, false, `${target.name} model control stayed locked.`);
      composer = {
        contextText: await contextIndicator.textContent(),
        contextTitle: await contextIndicator.getAttribute('title'),
        rows,
        usage,
      };
      await page.keyboard.press('Escape');
    }
    if (options.openWork) {
      const workHeader = transcript.locator('.codex-work-header').last();
      await workHeader.waitFor({ timeout: 20_000 });
      await workHeader.click();
      await transcript.locator('.agent-inference').last().waitFor({ timeout: 20_000 });
      const childExecution = transcript.locator('.agent-child-execution-header').last();
      if (await childExecution.count()) {
        await childExecution.click();
        await transcript.locator('.agent-child-execution-content').last().waitFor({ timeout: 20_000 });
        await transcript.locator('.agent-child-execution-content .agent-execution-scope').last()
          .waitFor({ timeout: 20_000 });
      }
      await page.waitForTimeout(100);
    }

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
      const rect = (selector) => {
        const element = document.querySelector(selector);
        if (!(element instanceof HTMLElement)) return null;
        const bounds = element.getBoundingClientRect();
        return { left: bounds.left, right: bounds.right, width: bounds.width };
      };
      const workOffenders = Array.from(document.querySelectorAll([
        '.agent-execution-scope',
        '.agent-inference',
        '.agent-child-execution',
        '.agent-child-execution-content',
        '.agent-reasoning-block',
        '.agent-commentary-block',
        '.agent-action-sequence',
        '.agent-tool-call',
        '.codex-markdown',
        '.codex-md-text-line',
      ].join(','))).flatMap((element) => {
        if (!(element instanceof HTMLElement)) return [];
        const bounds = element.getBoundingClientRect();
        const outside = bounds.left < contentRect.left - 1 || bounds.right > contentRect.right + 1;
        const intrinsic = element.scrollWidth > element.clientWidth + 1;
        return outside || intrinsic ? [{
          className: element.className,
          clientWidth: element.clientWidth,
          left: bounds.left,
          right: bounds.right,
          scrollWidth: element.scrollWidth,
          text: (element.textContent ?? '').replace(/\s+/gu, ' ').trim().slice(0, 160),
        }] : [];
      });
      return {
        contentLeft: contentRect.left,
        contentRight: contentRect.right,
        contentWidth: contentRect.width,
        documentOverflow: document.documentElement.scrollWidth - window.innerWidth,
        lastAssistant: rect('.codex-assistant-message:last-of-type'),
        lastMarkdown: rect('.codex-assistant-message:last-of-type .codex-markdown'),
        mainPane: rect('.remux-main-pane'),
        transcriptLane: rect('.codex-transcript-lane'),
        transcriptSlot: rect('.remux-transcript-slot'),
        transcriptOverflow: transcript.scrollWidth - transcript.clientWidth,
        viewportWidth: window.innerWidth,
        workOffenders,
      };
    });
    assert.ok(geometry.documentOverflow <= 1, `${target.name} document overflowed by ${geometry.documentOverflow}px.`);
    assert.ok(
      geometry.transcriptOverflow <= 1,
      `${target.name} transcript overflowed by ${geometry.transcriptOverflow}px: ${JSON.stringify(geometry.workOffenders)}.`,
    );
    assert.ok(geometry.contentLeft >= -1, `${target.name} transcript escaped the left edge.`);
    assert.ok(geometry.contentRight <= geometry.viewportWidth + 1, `${target.name} transcript escaped the right edge.`);
    assert.ok(
      geometry.contentWidth >= Math.min(96, geometry.viewportWidth * 0.5),
      `${target.name} transcript collapsed to ${geometry.contentWidth}px.`,
    );
    assert.ok(
      !geometry.lastMarkdown || geometry.lastMarkdown.width >= Math.min(96, geometry.viewportWidth * 0.5),
      `${target.name} Markdown collapsed to ${geometry.lastMarkdown?.width}px.`,
    );
    const visibleErrors = await page.getByRole('alert').allTextContents();
    assert.deepEqual(visibleErrors, [], `${target.name} viewer exposed an error status.`);
    assert.deepEqual(pageErrors, []);

    const screenshot = resolve(options.outputDir, `${target.name}.png`);
    await page.screenshot({ fullPage: true, path: screenshot });
    results.push({ composer, geometry, screenshot, target: target.name });
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
  const flags = new Set();
  for (let index = 0; index < args.length; index += 1) {
    const key = args[index];
    if (key === '--generic' || key === '--open-work' || key === '--expect-composer-context') {
      flags.add(key);
      continue;
    }
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
    generic: flags.has('--generic'),
    expectComposerContext: flags.has('--expect-composer-context'),
    openWork: flags.has('--open-work'),
    httpBase: values.get('--http-base') ?? 'http://127.0.0.1:48123',
    outputDir: resolve(values.get('--output-dir') ?? '/tmp/remux-agent-live-viewer'),
    sendPrompt: values.get('--send-prompt') ?? null,
    expectText: values.get('--expect-text') ?? null,
    tokenFile: resolve(values.get('--token-file') ?? resolve(repositoryRoot, '.remux/auth-token')),
  };
}
