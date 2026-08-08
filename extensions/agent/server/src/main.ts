import { AgentServer } from './agent-server.ts';
import { FixtureEngine } from './fixture-engine.ts';
import { JsonRpcOutput, serveStdio } from './json-rpc.ts';
import { AgentJournalRepository } from './storage/repository.ts';

const output = new JsonRpcOutput();
const journal = await AgentJournalRepository.open();
let server: AgentServer | null = null;
try {
  const engine = process.env.REMUX_AGENT_FIXTURE === '1'
    ? new FixtureEngine()
    : await import('./pi-runtime.ts').then(({ PiEngine }) => PiEngine.create());
  const activeServer = new AgentServer({
    engine,
    journal,
    notify: (method, params) => output.notify(method, params),
  });
  server = activeServer;
  await activeServer.initialize();
  await serveStdio((method, params) => activeServer.handle(method, params), output);
} finally {
  await server?.close();
  await journal.close();
  await output.flush();
}
