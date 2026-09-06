import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { createProtectedViewerBootstrapScript } from '../src/surfaces/viewer/protectedViewerTransport.ts';

const server = await createServer({
  configFile: false,
  root: new URL('../../', import.meta.url).pathname,
  server: { host: '127.0.0.1', port: 0 },
  plugins: [{ name: 'transport-harness', configureServer(server) {
    server.middlewares.use('/__transport-test', (_req, res) => {
      res.setHeader('Content-Type', 'text/html');
      res.end(`<script type="module">
        import { initializeIpc, rpc } from '/packages/viewer-kit/src/ipc.ts';
        initializeIpc({requireProtectedTransport:true});
        const abort = new AbortController();
        rpc.query('cancelled-read', {}, {signal:abort.signal}).catch(()=>{});
        abort.abort();
        rpc.query('test-read', {}).then(value => window.readResult=value);
      </script>`);
    });
  } }],
});
await server.listen();
const browser = await chromium.launch();
try {
  for (const protectedHost of [false, true]) {
    const page = await browser.newPage();
    const token = 'a'.repeat(64);
    await page.addInitScript(({ protectedHost, token }) => {
      window.acceptedRequests = [];
      window.setTimeout(() => {
        window.ReactNativeWebView = { postMessage(raw) {
          let message = JSON.parse(raw);
          if (protectedHost) {
            if (message.token !== token) return;
            message = JSON.parse(message.payload);
          }
          let reply;
          if (message.type === 'remux/ready') reply = {type:'remux/status',status:{type:'connected'},error:null};
          else if (message.type === 'remux/request') {
            window.acceptedRequests.push(message.method);
            reply = {type:'remux/response',id:message.id,result:'ok'};
          }
          if (reply) window.setTimeout(() => window.dispatchEvent(new MessageEvent('message', {data:JSON.stringify(reply)})), 0);
        } };
      }, 300);
    }, { protectedHost, token });
    if (protectedHost) await page.addInitScript({ content: createProtectedViewerBootstrapScript(token) });
    await page.goto(`${server.resolvedUrls.local[0]}__transport-test`);
    await page.waitForFunction(() => window.readResult === 'ok');
    assert.deepEqual(await page.evaluate(() => window.acceptedRequests), ['test-read']);
    await page.close();
  }
  console.log(JSON.stringify({ok:true,delayedProtectedHost:true,delayedLegacyHost:true,cancelledQueuedReadNotSent:true}));
} finally {
  await browser.close();
  await server.close();
}
