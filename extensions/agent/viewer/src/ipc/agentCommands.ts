import { rpc } from '@remux/viewer-kit';

import {
  NATIVE_AGENT_METHODS,
  type AgentRuntimeResource,
  type NativeArtifactPutResult,
  type NativeAgentResourceReadResult,
} from '../../../shared/native-agent-protocol.ts';
import type {
  AgentComposerMessagePart,
  MessageBranchResult,
  MessageSendResult,
  ReasoningLevel,
} from '../../../shared/protocol.ts';
import type { UserContentPart } from '../../../shared/provider-runtime.ts';
import type { ProviderAccess } from '../../../shared/provider-runtime.ts';
import { createViewerUuid } from '../identity.ts';

export const agentCommands = {
  cancelLogin(providerInstanceId: string) {
    return rpc.command(NATIVE_AGENT_METHODS.providerLoginCancel, {
      commandId: createViewerUuid(),
      providerInstanceId,
    });
  },
  createConversation(input: {
    operationId: string;
    providerInstanceId: string;
    cwd: string;
    nativeModelId: string;
    reasoning: ReasoningLevel;
    access: ProviderAccess;
  }) {
    return rpc.command<{ accepted: true; conversationId: string }>(
      NATIVE_AGENT_METHODS.conversationCreate,
      {
        commandId: input.operationId,
        providerInstanceId: input.providerInstanceId,
        cwd: input.cwd,
        model: input.nativeModelId,
        ...(input.reasoning === 'off' ? {} : { effort: input.reasoning }),
        access: input.access,
      },
    );
  },
  async readRuntime(conversationId: string) {
    const key = `agent/runtime:${conversationId}` as const;
    const result = await rpc.query<NativeAgentResourceReadResult>(NATIVE_AGENT_METHODS.resourcesRead, {
      focusedConversationId: conversationId,
      visibility: 'foreground',
      requests: [{ key }],
    });
    const resource = result.resources.find((candidate) => candidate.key === key);
    if (!resource || resource.status !== 'ok') {
      throw new Error('Conversation runtime is not ready yet.');
    }
    return resource.value as AgentRuntimeResource;
  },
  interrupt(conversationId: string, turnId: string) {
    return rpc.command(NATIVE_AGENT_METHODS.turnInterrupt, {
      commandId: createViewerUuid(),
      conversationId,
      turnId,
    });
  },
  interruptExecution(conversationId: string, executionId: string) {
    return rpc.command(NATIVE_AGENT_METHODS.executionInterrupt, {
      commandId: createViewerUuid(),
      conversationId,
      executionId,
    });
  },
  renameConversation(conversationId: string, expectedMetadataRevision: number, title: string) {
    return rpc.command<{ accepted: true; metadataRevision: number }>(
      NATIVE_AGENT_METHODS.conversationRename,
      { commandId: createViewerUuid(), conversationId, expectedMetadataRevision, title },
    );
  },
  archiveConversation(
    conversationId: string,
    expectedMetadataRevision: number,
    archived = true,
  ) {
    return rpc.command<{ accepted: true }>(NATIVE_AGENT_METHODS.conversationArchiveSet, {
      commandId: createViewerUuid(),
      conversationId,
      expectedMetadataRevision,
      archived,
    });
  },
  activateConversationStrand(
    conversationId: string,
    strandId: string,
    expectedHeadRevision: number,
  ) {
    return rpc.command<{ accepted: true; strandId: string; headRevision: number }>(
      NATIVE_AGENT_METHODS.conversationStrandActivate,
      { commandId: createViewerUuid(), conversationId, strandId, expectedHeadRevision },
    );
  },
  async sendMessage(input: {
    operationId: string;
    conversationId: string;
    clientMessageId: string;
    parts: AgentComposerMessagePart[];
    nativeModelId: string;
    reasoning: ReasoningLevel;
    providerInstanceId: string;
    access: ProviderAccess;
    configurationRevision: string;
    delivery: 'auto' | 'queue' | 'steer';
  }): Promise<MessageSendResult> {
    const content = await nativeContent(input.operationId, input.parts);
    const result = await rpc.command<{
      accepted: true;
      commandId: string;
      turnId: string;
      delivery: 'sent' | 'queued' | 'steered';
    }>(NATIVE_AGENT_METHODS.messageSend, {
      commandId: input.operationId,
      conversationId: input.conversationId,
      clientMessageId: input.clientMessageId,
      content,
      providerInstanceId: input.providerInstanceId,
      model: input.nativeModelId,
      effort: input.reasoning === 'off' ? null : input.reasoning,
      access: input.access,
      configurationRevision: input.configurationRevision,
      delivery: input.delivery,
    });
    return {
      accepted: true,
      operationId: input.operationId,
      turnId: result.turnId,
      delivery: result.delivery,
    } as MessageSendResult;
  },
  async branchMessage(input: {
    mode: 'edit' | 'fork';
    operationId: string;
    clientMessageId: string;
    parts: AgentComposerMessagePart[];
    sourceConversationId: string;
    sourceStrandId: string;
    sourcePathEntryId: string;
    expectedHeadRevision: number;
    providerInstanceId: string;
    nativeModelId: string;
    reasoning: ReasoningLevel;
    access: ProviderAccess;
    configurationRevision: string;
  }): Promise<MessageBranchResult> {
    const content = await nativeContent(input.operationId, input.parts);
    const result = await rpc.command<{
      accepted: true;
      conversationId: string;
      strandId: string;
      headRevision: number;
      turnId: string;
    }>(input.mode === 'edit' ? NATIVE_AGENT_METHODS.messageEdit : NATIVE_AGENT_METHODS.messageFork, {
      commandId: input.operationId,
      clientMessageId: input.clientMessageId,
      sourceConversationId: input.sourceConversationId,
      sourceStrandId: input.sourceStrandId,
      sourcePathEntryId: input.sourcePathEntryId,
      expectedHeadRevision: input.expectedHeadRevision,
      content,
      providerInstanceId: input.providerInstanceId,
      model: input.nativeModelId,
      effort: input.reasoning === 'off' ? null : input.reasoning,
      access: input.access,
      configurationRevision: input.configurationRevision,
    });
    return {
      conversationId: result.conversationId,
      strandId: result.strandId,
      headRevision: result.headRevision,
      turnId: result.turnId,
      transcriptFence: { basisSequence: 0, serverGeneration: '', turnId: result.turnId },
    };
  },
  login(providerInstanceId: string, mode: 'device-code' | 'browser') {
    return rpc.command(NATIVE_AGENT_METHODS.providerLoginStart, {
      commandId: createViewerUuid(),
      providerInstanceId,
      mode,
    });
  },
  logout(providerInstanceId: string) {
    return rpc.command(NATIVE_AGENT_METHODS.providerLogout, {
      commandId: createViewerUuid(),
      providerInstanceId,
    });
  },
  removeQueued(conversationId: string, turnId: string) {
    return rpc.command(NATIVE_AGENT_METHODS.queuedMessageRemove, {
      commandId: createViewerUuid(),
      conversationId,
      turnId,
    });
  },
  compact(conversationId: string) {
    return rpc.command<{
      accepted: true;
      operationId: string;
      delivery: 'sent' | 'queued';
    }>(NATIVE_AGENT_METHODS.conversationCompact, {
      commandId: createViewerUuid(),
      conversationId,
    });
  },
  setConversationPreference(input: {
    conversationId: string;
    expectedRevision: string;
    nativeModelId: string;
    reasoning: ReasoningLevel;
  }) {
    return rpc.command<{ accepted: true; revision: string }>(
      NATIVE_AGENT_METHODS.conversationPreferenceSet,
      {
        commandId: createViewerUuid(),
        conversationId: input.conversationId,
        expectedRevision: input.expectedRevision,
        model: input.nativeModelId,
        effort: input.reasoning === 'off' ? null : input.reasoning,
      },
    );
  },
  setConversationAccess(input: {
    conversationId: string;
    expectedRevision: string;
    access: ProviderAccess;
  }) {
    return rpc.command<{ accepted: true; revision: string }>(
      NATIVE_AGENT_METHODS.conversationAccessSet,
      {
        commandId: createViewerUuid(),
        conversationId: input.conversationId,
        expectedRevision: input.expectedRevision,
        access: input.access,
      },
    );
  },
  setProviderPreference(input: {
    providerInstanceId: string;
    expectedProvidersRevision: string;
    nativeModelId: string;
    reasoning: ReasoningLevel;
  }) {
    return rpc.command<{ accepted: true; revision: string }>(
      NATIVE_AGENT_METHODS.providerPreferenceSet,
      {
        commandId: createViewerUuid(),
        providerInstanceId: input.providerInstanceId,
        expectedProvidersRevision: input.expectedProvidersRevision,
        model: input.nativeModelId,
        effort: input.reasoning === 'off' ? null : input.reasoning,
        makeDefaultProvider: true,
      },
    );
  },
};

async function nativeContent(operationId: string, parts: AgentComposerMessagePart[]) {
  const content: UserContentPart[] = [];
  for (const [index, part] of parts.entries()) {
    if (part.type === 'text') {
      content.push({ type: 'text', text: part.text });
    } else if (part.type === 'mention') {
      content.push({ type: 'file-reference', path: part.path });
    } else {
      const artifact = await rpc.command<NativeArtifactPutResult>(NATIVE_AGENT_METHODS.artifactPut, {
        commandId: `${operationId}:image:${index}`,
        dataUrl: part.dataUrl,
        ...(part.name ? { name: part.name } : {}),
      });
      content.push({
        type: 'image-artifact',
        artifactId: artifact.artifactId,
        mimeType: artifact.mimeType,
        ...(artifact.name ? { name: artifact.name } : {}),
        byteLength: artifact.byteLength,
      });
    }
  }
  return content;
}
