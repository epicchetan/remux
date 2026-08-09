import type { AuthValue, ModelInfo } from '../../shared/protocol.ts';
import type { AgentEngine, ConversationRuntime } from './engine.ts';
import { compileShadowContext } from './context/compiler.ts';
import { canonicalJsonHash } from './storage/canonical-json.ts';

const FIXTURE_CONTRACTS_HASH = canonicalJsonHash({
  engine: 'fixture',
  tools: ['workspace_read@1'],
});

const fixtureModels: ModelInfo[] = [
  {
    id: 'gpt-5.4-fixture',
    name: 'GPT-5.4 Fixture',
    provider: 'openai-codex',
    contextWindow: 400_000,
    supportedReasoning: ['low', 'medium', 'high', 'xhigh'],
  },
];

export class FixtureEngine implements AgentEngine {
  private signedIn = process.env.REMUX_AGENT_FIXTURE_SIGNED_OUT !== '1';

  async authStatus(): Promise<AuthValue> {
    return authValue(this.signedIn ? 'signed-in' : 'signed-out');
  }

  async login(operationId: string, signal: AbortSignal, onUpdate: (value: AuthValue) => void) {
    onUpdate({
      ...authValue('signing-in'),
      operationId,
      verificationUri: 'https://example.test/device',
      userCode: 'REMUX-CODE',
      progress: 'Waiting for fixture authorization.',
    });
    await delay(35, signal);
    this.signedIn = true;
  }

  async logout() {
    this.signedIn = false;
  }

  async listModels() {
    return this.signedIn ? fixtureModels : [];
  }

  async createConversation(options: Parameters<AgentEngine['createConversation']>[0]): Promise<ConversationRuntime> {
    let controller: AbortController | null = null;
    return {
      async prompt(input) {
        const text = input.text;
        controller = new AbortController();
        const signal = controller.signal;
        const context = await options.durability.compileContext();
        const estimatedInputTokens = Math.max(1, Math.ceil(context.estimatedBytes / 4));
        const compileStartedAt = performance.now();
        const shadow = compileShadowContext(context.shadowSource, {
          modelId: options.modelId,
          contextWindow: fixtureModels[0]!.contextWindow,
          fixedContractsHash: FIXTURE_CONTRACTS_HASH,
          activeEstimatedInputTokens: estimatedInputTokens,
        });
        await options.durability.beforeProviderCall({
          payload: { messages: [{ role: 'user', content: text }] },
          requestMode: 'full',
          estimatedInputTokens,
          context: {
            basisSequence: context.basisSequence,
            logicalHash: context.logicalHash,
            renderedHash: context.logicalHash,
            orderedMessageHashes: context.orderedMessageHashes,
            messageCount: context.messages.length,
            fixedContractsHash: FIXTURE_CONTRACTS_HASH,
            shadow,
            shadowBuildDurationMs: Math.max(0, Math.round(performance.now() - compileStartedAt)),
            activeMessages: context.messages,
          },
        });
        options.onEvent({
          type: 'context-probe',
          probe: {
            hookVersion: 'agent-durable-v1',
            modelCallCount: 1,
            messageCount: context.messages.length,
            messageHash: context.logicalHash,
            orderedMessageHashes: context.orderedMessageHashes,
            estimatedBytes: context.estimatedBytes,
            provider: 'openai-codex',
            modelId: options.modelId,
            providerRequestMode: 'full',
          },
        });
        options.onEvent({ type: 'assistant-start' });
        try {
          let response = '';
          for (const delta of ['Fixture ', 'response ', `for “${text}”.`]) {
            await delay(25, signal);
            response += delta;
            options.onEvent({ type: 'assistant-text', delta });
          }
          await options.durability.beforeAssistantMessageEnd({
            inferenceState: 'completed',
            text: response,
            reasoning: '',
            calls: [],
          });
          options.onEvent({ type: 'inference-end', state: 'completed' });
          await options.durability.beforeTool({
            callId: 'fixture-read',
            name: 'workspace.read',
            args: { path: 'README.md' },
          });
          await delay(20, signal);
          await options.durability.afterTool({
            callId: 'fixture-read',
            name: 'workspace.read',
            result: { path: 'README.md' },
            isError: false,
          });
          options.onEvent({ type: 'assistant-complete', interrupted: false });
        } catch (error) {
          if (signal.aborted) {
            options.onEvent({ type: 'assistant-complete', interrupted: true });
            return;
          }
          throw error;
        } finally {
          controller = null;
        }
      },
      async interrupt() {
        controller?.abort();
      },
      async dispose() {
        controller?.abort();
      },
    };
  }
}

function authValue(state: AuthValue['state']): AuthValue {
  return {
    state,
    operationId: null,
    displayLabel: state === 'signed-in' ? 'Fixture OpenAI subscription' : null,
    verificationUri: null,
    userCode: null,
    expiresAt: null,
    progress: null,
    error: null,
  };
}

function delay(milliseconds: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
      return;
    }
    const timeout = setTimeout(resolve, milliseconds);
    signal.addEventListener('abort', () => {
      clearTimeout(timeout);
      reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
    }, { once: true });
  });
}
