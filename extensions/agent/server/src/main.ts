import { AgentServer } from './agent-server.ts';
import { FixtureProvider } from './fixture-provider.ts';
import { JsonRpcOutput, serveStdio } from './json-rpc.ts';
import { AgentStateStore } from './storage/agent-state-store.ts';

const output = new JsonRpcOutput();
const store = await AgentStateStore.open();
let server: AgentServer | null = null;
try {
  const provider = process.env.REMUX_AGENT_FIXTURE === '1'
    ? new FixtureProvider()
    : await import('./providers/openai-codex/openai-codex-provider.ts')
      .then(({ OpenAICodexProvider }) => OpenAICodexProvider.create());
  const activeServer = new AgentServer({
    provider,
    store,
    notify: (method, params) => output.notify(method, params),
  });
  server = activeServer;
  await activeServer.initialize();
  await serveStdio((method, params) => activeServer.handle(method, params), output);
} finally {
  await server?.close();
  await store.close();
  await output.flush();
}
