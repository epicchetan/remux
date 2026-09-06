import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium, webkit } from 'playwright';
import { prepareHtmlPreviewDocument } from '../../../packages/viewer-kit/src/htmlPreview.ts';

// Executable proof for the web shell's navigation boundary. Keep the parent
// policy separate from the report policy: a sandbox alone allows self-navigation.
const engine = process.env.VIEWER_TEST_ENGINE === 'webkit' ? webkit : chromium;
const browser = await engine.launch();
const htmlPreviewSource = await readFile(new URL('../viewer/src/html/HtmlPreview.tsx', import.meta.url), 'utf8');
for (const marker of [
  'getHostCapabilities().protectedHtmlPreviewTransport',
  'sandbox="allow-scripts"',
  "new Blob([preparation.document.html], { type: 'text/html' })",
  'URL.revokeObjectURL',
  'if (!active)',
]) {
  assert.ok(htmlPreviewSource.includes(marker), `HTML component boundary is missing: ${marker}`);
}
let actualReport = null;
try {
  actualReport = await readFile('/home/ubuntu/ledger/research/runs/move-discovery-v2/review.html', 'utf8');
} catch {
  // The private acceptance report is read-only local evidence and is not copied into the repository.
}
try {
  const page = await browser.newPage();
  const requests = [];
  await page.route('**/*', route => {
    const url = route.request().url();
    if (url === 'https://viewer.test/') return route.fulfill({
      contentType: 'text/html',
      body: '<!doctype html><meta http-equiv="Content-Security-Policy" content="frame-src blob:; object-src \'none\'"><body><iframe sandbox="allow-scripts" title="Preview"></iframe>',
    });
    requests.push(url);
    return route.abort();
  });
  const probe = prepareHtmlPreviewDocument('<!doctype html><h1>Report</h1><script>window.ran=true</script>');
  for (const target of ['https://escape.test/', 'https://viewer.test/host', 'data:text/html,<h1>escape</h1>']) {
    await page.goto('https://viewer.test/');
    await page.evaluate(html => {
      document.querySelector('iframe').src = URL.createObjectURL(new Blob([html], { type: 'text/html' }));
    }, probe.html);
    const child = page.frames().find(frame => frame.parentFrame());
    await child.waitForFunction(() => window.ran === true);
    assert.equal(await child.evaluate(() => {
      try { return parent.document.body.innerHTML; } catch { return 'blocked'; }
    }), 'blocked');
    await child.evaluate(target => { location.href = target; }, target).catch(() => undefined);
    await page.waitForTimeout(100);
    assert.deepEqual(requests, [], 'parent frame-src must deny remote/host navigation before requests');
    assert.equal(await page.locator('iframe').count(), 1);
    assert.equal(await child.locator('h1').filter({ hasText: 'escape' }).count(), 0);
  }
  for (const action of ['meta', 'nested', 'blob']) {
    await page.goto('https://viewer.test/');
    await page.evaluate(html => {
      document.querySelector('iframe').src = URL.createObjectURL(new Blob([html], { type: 'text/html' }));
    }, probe.html);
    const child = page.frames().find(frame => frame.parentFrame());
    await child.waitForFunction(() => window.ran === true);
    await child.evaluate(action => {
      if (action === 'meta') {
        const meta = document.createElement('meta');
        meta.httpEquiv = 'refresh';
        meta.content = '0;url=https://escape.test/meta';
        document.head.append(meta);
      } else if (action === 'nested') {
        const frame = document.createElement('iframe');
        frame.src = 'https://escape.test/nested';
        document.body.append(frame);
      } else {
        location.href = URL.createObjectURL(new Blob([
          '<h1>Nested blob</h1><script>fetch("https://escape.test/blob").catch(()=>{});<\/script>',
        ], { type: 'text/html' }));
      }
    }, action).catch(() => undefined);
    await page.waitForTimeout(100);
    assert.deepEqual(requests, [], `${action} must not shed network restrictions`);
  }
  if (actualReport !== null) {
    const preparedReport = prepareHtmlPreviewDocument(actualReport);
    await page.setViewportSize({ width: 390, height: 760 });
    await page.goto('https://viewer.test/');
    await page.evaluate(html => {
      const frame = document.querySelector('iframe');
      frame.style.cssText = 'position:fixed;inset:0;width:100%;height:100%;border:0';
      frame.src = URL.createObjectURL(new Blob([html], { type: 'text/html' }));
    }, preparedReport.html);
    const child = page.frames().find(frame => frame.parentFrame());
    await child.locator('#cards option').first().waitFor({ state: 'attached' });
    for (const viewport of [{ width: 390, height: 760 }, { width: 1280, height: 800 }]) {
      await page.setViewportSize(viewport);
      const originalCard = await child.locator('#cards').inputValue();
      await child.locator('#next').click();
      assert.notEqual(await child.locator('#cards').inputValue(), originalCard);
      await child.locator('#resolution').selectOption('ten_second_bars');
      assert.equal(await child.locator('#chart svg').count(), 1);
      await child.locator('#prefix').click();
      assert.notEqual(await child.locator('#reveal').inputValue(), '100');
      assert.equal(await child.locator('#continuous svg').count(), 1);
      assert.deepEqual(requests, []);
    }
  }
  console.log(JSON.stringify({ actualReport: actualReport !== null, engine: engine.name(), ok: true, phoneAndDesktop: actualReport !== null, scriptsRun: true, parentDomBlocked: true, selfNavigationBlocked: true, nativeIsolationVerified: false }));
} finally {
  await browser.close();
}
