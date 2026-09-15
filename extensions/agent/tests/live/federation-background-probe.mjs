// Opt-in SDK-only probe: does Claude Code auto-background a long-running MCP
// tool call (Streamable HTTP, stateless per-request server like the
// remux-federation bridge) as an `mcp_task`, let the turn end, and continue the
// conversation on its own when the call later resolves? Exercises the
// CLAUDE_AUTO_BACKGROUND_TASKS + CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS levers.
// Disposable session only. From extensions/agent:
// remux workload exec --workload research --operation codex-rd:federation-bg-probe --threads 2 -- node --experimental-strip-types tests/live/federation-background-probe.mjs
import { mkdtemp } from 'node:fs/promises';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

const t0 = Date.now();
const log = (o) => console.log(JSON.stringify({ t: ((Date.now() - t0) / 1000).toFixed(1), ...o }));
const cwd = await mkdtemp('/tmp/remux-federation-task-probe-');
let release; let entered = false;
const gatePromise = new Promise((r) => { release = r; });
const finalAnswer = 'GATE_RELEASED: implemented widget in src/widget.ts; 3 tests pass.';

function createMcp() {
  const server = new McpServer({ name: 'gate', version: '1' });
  server.registerTool('wait', {
    description: 'Starts the child and blocks until the host releases it, then returns the child result.',
    inputSchema: {},
  }, async (_args, extra) => {
    entered = true; log({ server: 'wait entered', progressToken: extra._meta?.progressToken });
    const progress = setInterval(() => { if (extra._meta?.progressToken !== undefined) void extra.sendNotification({ method: 'notifications/progress', params: { progressToken: extra._meta.progressToken, progress: 1, message: 'child running' } }); }, 15_000);
    try { await gatePromise; } finally { clearInterval(progress); }
    log({ server: 'wait returning' });
    return { content: [{ type: 'text', text: JSON.stringify({ executionId: 'child-1', status: 'completed', finalAnswer }) }] };
  });
  return server;
}

const http = createServer(async (req, res) => {
  const chunks = []; for await (const c of req) chunks.push(c);
  let body; try { body = JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null'); } catch { body = null; }
  const methods = Array.isArray(body) ? body.map((m) => m.method) : [body?.method];
  log({ http: req.method, methods });
  const mcp = createMcp();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: false, keepAliveMs: 15_000 });
  try { await mcp.connect(transport); await transport.handleRequest(req, res, body); }
  catch (e) { log({ httpError: String(e) }); if (!res.headersSent) { res.statusCode = 500; res.end(); } }
  finally { await Promise.allSettled([transport.close(), mcp.close()]); }
});
http.timeout = 0;
await new Promise((r) => http.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${http.address().port}/mcp`;
log({ url });

const queue = []; let wake;
const push = (text) => { queue.push({ type: 'user', uuid: randomUUID(), parent_tool_use_id: null, message: { role: 'user', content: text } }); wake?.(); };
async function* prompt() { while (true) { while (queue.length) yield queue.shift(); await new Promise((r) => { wake = r; }); } }
const env = { ...process.env, CLAUDE_AGENT_SDK_CLIENT_APP: 'remux-agent/1', CLAUDE_AUTO_BACKGROUND_TASKS: '1', CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS: process.env.PROBE_AUTO_BACKGROUND_MS ?? '5000' };
delete env.ANTHROPIC_API_KEY; delete env.ANTHROPIC_AUTH_TOKEN;
const q = query({ prompt: prompt(), options: {
  cwd, model: 'sonnet', pathToClaudeCodeExecutable: '/home/ubuntu/.local/bin/claude', persistSession: false,
  settingSources: [], settings: { disableAllHooks: true, autoCompactEnabled: false, precomputeCompactionEnabled: false }, hooks: {},
  mcpServers: { gate: { type: 'http', url } }, strictMcpConfig: true, tools: { type: 'preset', preset: 'claude_code' },
  permissionMode: 'bypassPermissions', allowDangerouslySkipPermissions: true, sandbox: { enabled: false },
  includePartialMessages: false, extraArgs: { 'replay-user-messages': null }, perTaskStopAffordance: true, env,
  systemPrompt: { type: 'preset', preset: 'claude_code', append: 'Isolated runtime test. Use only the provided gate tool. Do not read or write files, use skills, or network.' },
} });

const summarize = (m) => {
  const out = { type: m.type, subtype: m.subtype, uuid: m.uuid?.slice(0, 8), parent: m.parent_tool_use_id ?? undefined, replay: m.isReplay, synthetic: m.isSynthetic };
  for (const k of ['task_id', 'tool_use_id', 'task_type', 'status', 'summary', 'description', 'is_backgrounded', 'result', 'user_message_uuid', 'resource_links']) if (m[k] !== undefined) out[k] = typeof m[k] === 'string' ? m[k].slice(0, 240) : m[k];
  if (m.subtype === 'background_tasks_changed') out.tasks = m.tasks;
  if (m.tool_use_result !== undefined) out.tool_use_result = JSON.stringify(m.tool_use_result).slice(0, 300);
  const c = m.message?.content;
  if (typeof c === 'string') out.text = c.slice(0, 240);
  else if (Array.isArray(c)) out.blocks = c.map((b) => b.type === 'tool_use' ? `tool_use:${b.name}:${b.id}` : b.type === 'tool_result' ? `tool_result:${b.tool_use_id}:${(typeof b.content === 'string' ? b.content : JSON.stringify(b.content)).slice(0, 400)}` : b.type === 'text' ? `text:${b.text.slice(0, 240)}` : b.type);
  return out;
};

let phase = 'spawn'; let results = 0; let notified = false;
const deadline = setTimeout(() => { log({ fatal: 'deadline' }); release(); q.close(); }, 300_000);
push('Call mcp__gate__wait exactly once. If the tool result is the final child result, reply with FINAL: followed by the finalAnswer text. If the tool reports it is running in the background, say WAITING and finish your turn; when a notification later tells you it completed, reply FINAL: with the finalAnswer text. If a user message arrives in between, answer it briefly and do not call any other tools.');
try {
  for await (const m of q) {
    log(summarize(m));
    if (m.type === 'result') {
      results += 1;
      if (phase === 'spawn') { phase = 'chat'; log({ phase: 'turn-1-ended', entered }); setTimeout(() => push('Quick check while we wait: reply CHAT_OK only.'), 1500); }
      else if (phase === 'chat') { phase = 'release'; log({ phase: 'turn-2-ended, releasing gate' }); setTimeout(release, 1500); }
      else if (phase === 'release') { phase = 'done'; log({ phase: 'autonomous-turn-ended' }); setTimeout(() => q.close(), 1500); }
    }
    if (m.type === 'system' && m.subtype === 'task_notification') { notified = true; log({ notification: true, phase }); }
  }
} catch (e) { log({ error: String(e) }); }
finally { clearTimeout(deadline); release(); http.close(); log({ done: true, phase, results, notified }); }
