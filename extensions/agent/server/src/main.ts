import { AgentServer } from './agent-server.ts';
import { FixtureEngine } from './fixture-engine.ts';
import { JsonRpcOutput, serveStdio } from './json-rpc.ts';

const output = new JsonRpcOutput();
const engine = process.env.REMUX_AGENT_FIXTURE === '1'
  ? new FixtureEngine()
  : await import('./pi-runtime.ts').then(({ PiEngine }) => PiEngine.create());
const server = new AgentServer(engine, (method, params) => output.notify(method, params));
await server.initialize();
serveStdio((method, params) => server.handle(method, params), output);
