import type { AccountInfo as ClaudeAccountInfo, SDKMessage } from '@anthropic-ai/claude-agent-sdk';

export class FakeClaudeQuery implements AsyncIterable<SDKMessage> {
  mcpServers: unknown;
  async setMcpServers(servers: unknown) {
    this.mcpServers = servers;
    return { added: ['remux-federation'], removed: [], errors: {} };
  }
  async mcpServerStatus() { return [{ name: 'remux-federation', status: 'connected' }]; }
  private readonly values: SDKMessage[] = [];
  private readonly waiters: Array<(result: IteratorResult<SDKMessage>) => void> = [];
  private closed = false;
  readonly usageResult: unknown;
  readonly modelChanges: string[] = [];
  readonly flags: unknown[] = [];
  readonly stoppedTasks: string[] = [];
  readonly backgroundedTools: string[] = [];
  async backgroundTasks(toolUseId: string) { this.backgroundedTools.push(toolUseId); return true; }
  readonly account: ClaudeAccountInfo;
  interrupts = 0;
  nextModelError: Error | undefined;
  nextFlagError: Error | undefined;

  constructor(
    usageResult: unknown = { rate_limits_available: true, rate_limits: {} },
    account: ClaudeAccountInfo = {
      apiProvider: 'firstParty',
      apiKeySource: 'none',
      subscriptionType: 'max',
      tokenSource: 'oauth',
    },
  ) {
    this.usageResult = usageResult;
    this.account = account;
  }

  emit(value: unknown) {
    const record = value as Record<string, unknown>;
    const message = (record.type === 'system' && record.subtype === 'init' &&
        !Object.hasOwn(record, 'apiKeySource')
      ? { ...record, apiKeySource: 'none' }
      : record) as SDKMessage;
    const waiter = this.waiters.shift();
    if (waiter) waiter({ done: false, value: message });
    else this.values.push(message);
  }

  async supportedModels() {
    return [];
  }

  async accountInfo() {
    return this.account;
  }

  async supportedCommands() {
    return [{ name: 'compact', description: 'Compact context', argumentHint: '' }];
  }

  async usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET() {
    return this.usageResult;
  }

  get isClosed() {
    return this.closed;
  }

  async setModel(model: string) {
    this.modelChanges.push(model);
    const error = this.nextModelError;
    this.nextModelError = undefined;
    if (error) throw error;
  }

  async applyFlagSettings(flags: unknown) {
    this.flags.push(flags);
    const error = this.nextFlagError;
    this.nextFlagError = undefined;
    if (error) throw error;
  }

  async interrupt() {
    this.interrupts += 1;
  }

  async stopTask(taskId: string) {
    this.stoppedTasks.push(taskId);
  }

  close() {
    this.closed = true;
    for (const waiter of this.waiters.splice(0)) waiter({ done: true, value: undefined });
  }

  [Symbol.asyncIterator](): AsyncIterator<SDKMessage> {
    return {
      next: async () => {
        const value = this.values.shift();
        if (value) return { done: false, value };
        if (this.closed) return { done: true, value: undefined };
        return new Promise((resolve) => this.waiters.push(resolve));
      },
    };
  }
}

