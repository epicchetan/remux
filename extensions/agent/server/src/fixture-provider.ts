import type { AuthValue, ModelInfo } from '../../shared/protocol.ts';
import type { ModelProvider, ModelSession } from './model-provider.ts';
import { canonicalJsonHash } from './storage/canonical-json.ts';

const FIXTURE_CONTRACTS_HASH = canonicalJsonHash({
  provider: 'fixture',
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

export class FixtureProvider implements ModelProvider {
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

  async createSession(options: Parameters<ModelProvider['createSession']>[0]): Promise<ModelSession> {
    let controller: AbortController | null = null;
    return {
      async prompt(input) {
        const text = input.text;
        controller = new AbortController();
        const signal = controller.signal;
        const context = await options.durability.compileContext(fixtureModels[0]!.contextWindow);
        const estimatedInputTokens = context.frame.estimatedInputTokens;
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
            frame: context.frame,
            frameBuildDurationMs: 0,
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
            options.onEvent({ type: 'assistant-text', delta, phase: 'final_answer' });
          }
          await options.durability.beforeAssistantMessageEnd({
            inferenceState: 'completed',
            text: response,
            textPhase: 'final_answer',
            reasoning: '',
            calls: [{
              callId: 'fixture-read',
              name: 'workspace.read',
              args: { path: 'README.md' },
            }],
            providerMessage: {
              role: 'assistant',
              content: [
                {
                  type: 'thinking',
                  thinking: 'Inspecting the fixture workspace.',
                  thinkingSignature: 'fixture-reasoning-signature',
                },
                {
                  type: 'text',
                  text: response,
                  textSignature: JSON.stringify({ v: 1, id: 'fixture-response', phase: 'final_answer' }),
                },
                {
                  type: 'toolCall',
                  id: 'fixture-read',
                  name: 'workspace.read',
                  arguments: { path: 'README.md' },
                },
              ],
              api: 'openai-responses',
              provider: 'openai-codex',
              model: options.modelId,
              usage: {
                input: estimatedInputTokens,
                output: Math.max(1, Math.ceil(response.length / 4)),
                cacheRead: 0,
                cacheWrite: 0,
                totalTokens: estimatedInputTokens + Math.max(1, Math.ceil(response.length / 4)),
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
              },
              stopReason: 'toolUse',
              timestamp: Date.now(),
            },
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
