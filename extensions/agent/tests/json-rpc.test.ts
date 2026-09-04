import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import test from 'node:test';

import { JsonRpcOutput, serveStdio } from '../server/src/json-rpc.ts';

test('Agent JSON-RPC cancellation aborts the matching in-flight request and emits no stale response', async () => {
  const source = new PassThrough();
  const outputLines: string[] = [];
  const output = new JsonRpcOutput(async (line) => {
    outputLines.push(line);
  });
  let started!: () => void;
  const requestStarted = new Promise<void>((resolve) => { started = resolve; });
  const serving = serveStdio(async (_method, _params, context) => {
    started();
    await new Promise<never>((_resolve, reject) => {
      context.signal.addEventListener('abort', () => reject(context.signal.reason), { once: true });
    });
  }, output, source);

  source.write(`${JSON.stringify({ jsonrpc: '2.0', id: 41, method: 'slow/read', params: {} })}\n`);
  await requestStarted;
  source.write(`${JSON.stringify({
    jsonrpc: '2.0', method: '$/cancelRequest', params: { id: 41 },
  })}\n`);
  source.end();
  await serving;
  await output.flush();

  assert.deepEqual(outputLines, [], 'a cancelled request must not race a response into a newer viewer');
});
