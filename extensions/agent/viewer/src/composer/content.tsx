import { useEffect, useState } from 'react';
import type {
  AgentPendingQueueValue,
  ConversationValue,
} from '../../../shared/protocol.ts';
import type { AgentProvidersResource, AgentRuntimeResource } from '../../../shared/native-agent-protocol.ts';
import type { ProviderAccess } from '../../../shared/provider-runtime.ts';
import type { ReasoningEffort } from '../../../shared/protocol.ts';
import { useConversationStore } from '../conversation/store.ts';
import { ComposerActionButtons } from './actions/ActionButtons.tsx';
import type { TurnSubmissionInput } from './actions/turnAction.ts';
import { ComposerInlineStatus } from './actions/InlineStatus.tsx';
import { ComposerStatusMessageRow } from './actions/StatusMessageRow.tsx';
import { ComposerLexicalInput } from './editor/LexicalInput.tsx';
import { ComposerEditBar } from './edit/EditBar.tsx';
import { NewChatBar } from './newChat/NewChatBar.tsx';
import { OperationQueueTray } from './queue/OperationQueueTray.tsx';
import { ComposerUsageTray } from './usage/UsageTray.tsx';
import { canManuallyCompact } from './usage/compactEligibility.ts';
import { useComposerStore } from './store.ts';
import type { ComposerEditTarget, ComposerForkTarget } from './store.ts';

export function ComposerContent({
  conversation,
  conversationSelected,
  childExecutionCount,
  onInterrupt,
  onOpenAgents,
  onCompact,
  onEdit,
  onFork,
  onQueueChanged,
  onRetryHistory,
  onSend,
  onProviderLogin,
  onProviderLogout,
  onPreferenceChange,
  onAccessChange,
  providers,
  runtime,
  runtimeError,
  queue,
}: {
  conversation: ConversationValue | null;
  conversationSelected: boolean;
  childExecutionCount: number;
  onInterrupt: () => Promise<void>;
  onOpenAgents: () => void;
  onCompact: () => Promise<void>;
  onEdit: ComposerBranchCallback<ComposerEditTarget>;
  onFork: ComposerBranchCallback<ComposerForkTarget>;
  onQueueChanged: () => Promise<void>;
  onRetryHistory: () => Promise<void>;
  onSend: (
    input: TurnSubmissionInput,
    setPhase: (phase: 'sending' | 'updating-transcript') => void,
  ) => Promise<void>;
  onProviderLogin: (providerInstanceId: string, mode: 'device-code' | 'browser') => void;
  onProviderLogout: (providerInstanceId: string) => void;
  onPreferenceChange: (input: {
    providerInstanceId: string;
    modelId: string;
    reasoning: ReasoningEffort;
    serviceTier: string | null;
  }) => Promise<void>;
  onAccessChange: (access: ProviderAccess) => Promise<void>;
  providers: AgentProvidersResource | null;
  runtime: AgentRuntimeResource | null;
  queue: AgentPendingQueueValue | null;
  runtimeError: string | null;
}) {
  const cwd = useConversationStore((state) => state.cwd);
  const pickerOpen = useConversationStore((state) => state.directoryPickerOpen);
  const openPicker = useConversationStore((state) => state.openDirectoryPicker);
  const modelId = useComposerStore((state) => state.modelId);
  const providerInstanceId = useComposerStore((state) => state.providerInstanceId);
  const working = conversation?.status === 'running' || conversation?.status === 'interrupting';
  const interruptible = working || Boolean(runtime?.lifecycle && (
    runtime.lifecycle.runningCount > 0 || runtime.lifecycle.checkingCount > 0 ||
    runtime.lifecycle.stoppingCount > 0 || runtime.lifecycle.stopRequested
  ));
  const loading = conversation?.status === 'loading';
  const historyReady = !conversation || runtime?.history?.state === 'ready';
  const [usageExpanded, setUsageExpanded] = useState(false);

  useEffect(() => setUsageExpanded(false), [conversation?.id, pickerOpen, providerInstanceId]);

  useEffect(() => {
    if (!usageExpanded) return;
    const pointer = (event: PointerEvent) => {
      if (!(event.target instanceof Element) || !event.target.closest('[data-remux-usage-surface]')) {
        setUsageExpanded(false);
      }
    };
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setUsageExpanded(false);
    };
    document.addEventListener('pointerdown', pointer);
    document.addEventListener('keydown', key);
    return () => {
      document.removeEventListener('pointerdown', pointer);
      document.removeEventListener('keydown', key);
    };
  }, [usageExpanded]);

  return (
    <div className="remux-bottom-bar border-t border-border" data-remux-composer-root>
      {!pickerOpen ? (
        <div className="remux-composer-context-strip">
          {usageExpanded ? (
            <ComposerUsageTray conversation={conversation} onCompact={onCompact} providers={providers} queue={queue} runtime={runtime} />
          ) : null}
          <ComposerEditBar />
          <OperationQueueTray onChanged={onQueueChanged} queue={queue} />
        </div>
      ) : null}
      <div className="remux-composer-panel">
        {!pickerOpen && !conversationSelected ? (
          <NewChatBar cwd={cwd} onOpenDirectory={openPicker} />
        ) : null}
        <ComposerLexicalInput hidden={pickerOpen} />
        <ComposerActionButtons
          canStart={Boolean((conversation
            ? runtime?.conversationId === conversation.id
            : !conversationSelected && cwd && modelId && providerInstanceId) && !loading && historyReady)}
          conversationExists={conversationSelected}
          childExecutionCount={childExecutionCount}
          isWorking={working}
          interruptible={interruptible}
          onEdit={onEdit}
          onFork={onFork}
          onInterrupt={onInterrupt}
          onOpenAgents={onOpenAgents}
          onCompact={onCompact}
          compactEnabled={canManuallyCompact(conversation, runtime, queue)}
          onSend={(input, setPhase) => {
            setUsageExpanded(false);
            return onSend(input, setPhase);
          }}
          onProviderLogin={onProviderLogin}
          onProviderLogout={onProviderLogout}
          onPreferenceChange={onPreferenceChange}
          onAccessChange={onAccessChange}
          providers={providers}
          runtime={runtime}
        />
      </div>
      {!pickerOpen ? (
        <ComposerStatusMessageRow
          history={conversation ? runtime?.history ?? null : null}
          onRetryHistory={onRetryHistory}
          runtimeError={runtimeError}
        />
      ) : null}
      {!pickerOpen ? (
        <ComposerInlineStatus
          expanded={usageExpanded}
          onToggle={() => setUsageExpanded((value) => !value)}
          providers={providers}
          runtime={runtime}
        />
      ) : null}
    </div>
  );
}

type ComposerBranchCallback<T> = (
  target: T,
  input: TurnSubmissionInput,
  setPhase: (phase: 'sending' | 'updating-transcript') => void,
) => Promise<void>;
