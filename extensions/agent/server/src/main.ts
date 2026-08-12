import { AgentServer } from './agent-server.ts';
import { FixtureEngine } from './fixture-engine.ts';
import { JsonRpcOutput, serveStdio } from './json-rpc.ts';
import { AgentStateStore } from './storage/agent-state-store.ts';

const output = new JsonRpcOutput();
const store = await AgentStateStore.open();
let server: AgentServer | null = null;
try {
  const engine = process.env.REMUX_AGENT_FIXTURE === '1'
    ? new FixtureEngine()
    : await import('./pi-runtime.ts').then(({ PiEngine }) => PiEngine.create());
  const activeServer = new AgentServer({
    engine,
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
