#!/usr/bin/env node
import { createInterface } from 'node:readline';

const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
let pendingClientRequest = null;

input.on('line', (line) => {
  const message = JSON.parse(line);
  if (message.method === 'test/roundtrip') {
    pendingClientRequest = message.id;
    process.stdout.write(`${JSON.stringify({
      id: 'server-request-1',
      method: 'item/tool/requestUserInput',
      params: { questions: [] },
    })}\n`);
    return;
  }
  if (message.id === 'server-request-1') {
    process.stdout.write(`${JSON.stringify({
      method: 'test/notification',
      params: { accepted: message.result?.answers !== undefined },
    })}\n`);
    process.stdout.write(`${JSON.stringify({
      id: pendingClientRequest,
      result: { ok: true },
    })}\n`);
    pendingClientRequest = null;
    return;
  }
  if (message.method === 'test/failure') {
    process.stdout.write(`${JSON.stringify({
      id: message.id,
      error: { code: -32001, message: 'fixture failure' },
    })}\n`);
  }
});
