import { createAgentTurnNotification } from './app-notifications.ts';
import { JsonRpcOutput, serveStdio } from './json-rpc.ts';
import { NativeAgentServer } from './native-agent-server.ts';
import { NativeFixtureAdapter } from './native-fixture-adapter.ts';
import { NativeAgentArtifacts } from './native-runtime/native-artifacts.ts';
import {
  openNativeAgentJournal,
  resolveNativeAgentDataRoot,
} from './native-runtime/native-journal.ts';
import { CodexNativeAdapter } from './providers/codex/codex-adapter.ts';
import { ClaudeNativeAdapter } from './providers/claude/claude-adapter.ts';
import { agentDataPaths } from './storage/data-root.ts';
import { FederationCredentialRegistry } from './federation/credential-registry.ts';
import { RemuxFederationServer } from './federation/mcp-server.ts';
import { NativeSessionOwnershipRegistry } from './native-runtime/native-session-ownership.ts';

const output = new JsonRpcOutput();
const dataRoot = resolveNativeAgentDataRoot();
const journal = await openNativeAgentJournal({ dataRoot });
const artifacts = new NativeAgentArtifacts({ journal, paths: agentDataPaths(dataRoot) });
const fixtureMode = process.env.REMUX_AGENT_FIXTURE === '1';
const sessionOwnership = new NativeSessionOwnershipRegistry();
const providers = fixtureMode
  ? [{
      providerInstanceId: 'fixture-local',
      provider: 'fixture' as const,
      label: 'Fixture',
      adapter: new NativeFixtureAdapter(),
    }]
  : [{
      providerInstanceId: 'codex-local',
      provider: 'codex' as const,
      label: 'Codex',
      adapter: new CodexNativeAdapter({
        providerInstanceId: 'codex-local',
        ownership: sessionOwnership,
        resolveImageArtifact: async (scope, artifactId, mimeType) => ({
          type: 'localImage',
          path: artifacts.resolveLocalImage(scope, artifactId, mimeType),
        }),
        importHistoricalImage: (scope, dataUrl) => artifacts.importImageDataUrl(scope, dataUrl),
      }),
    }, {
      providerInstanceId: 'claude-local',
      provider: 'claude-code' as const,
      label: 'Claude',
      adapter: new ClaudeNativeAdapter({
        providerInstanceId: 'claude-local',
        ownership: sessionOwnership,
        resolveImageArtifact: async (scope, artifactId, mimeType) => ({
          path: artifacts.resolveLocalImage(scope, artifactId, mimeType),
        }),
      }),
    }];
const credentials = new FederationCredentialRegistry();
let nativeServer: NativeAgentServer;
const federation = new RemuxFederationServer({
  journal,
  credentials,
  coordinator: () => nativeServer.coordinator,
  generation: () => nativeServer.coordinator.projector.serverGeneration,
  readTextArtifact: (scope, artifactId, turnId) =>
    artifacts.readTextArtifactForScope(scope, artifactId, turnId),
});
nativeServer = new NativeAgentServer({
  journal,
  artifacts,
  providers,
  federationForSession: (input) => Promise.resolve(federation.issueForSession(input)),
  notify: (method, params) => output.notify(method, params),
  onDiagnostic: (event) => {
    process.stderr.write(`[agent-runtime] ${JSON.stringify(event)}\n`);
  },
  onTerminalTurn: ({ conversationId, turnId, outcome }) => {
    const notification = createAgentTurnNotification({
      conversationId,
      turnId,
      terminalSequence: journal.latestSequence(),
      status: outcome === 'completed'
        ? 'completed'
        : outcome === 'interrupted' ? 'interrupted' : 'failed',
      error: outcome === 'completed' || outcome === 'interrupted'
        ? null
        : journal.turn(turnId)?.error?.message ?? 'Native provider turn failed.',
    });
    if (notification) output.notify(notification.method, notification.params);
  },
});

try {
  await federation.start();
  const initialization = nativeServer.initialize().catch((error) => {
    process.stderr.write(`[agent-runtime] initialization failed: ${errorMessage(error)}\n`);
  });
  await serveStdio(
    (method, params, context) => nativeServer.handle(method, params, context),
    output,
  );
  await initialization;
} finally {
  await nativeServer.close();
  await federation.close();
  journal.close();
  await output.flush();
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
