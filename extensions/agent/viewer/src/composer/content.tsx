import type {
  AgentComposerMessagePart,
  AgentPendingQueueValue,
  ContextInspectorValue,
  ConversationValue,
} from '../../../shared/protocol.ts';
import { useConversationStore } from '../conversation/store.ts';
import { ComposerActionButtons } from './actions/ActionButtons.tsx';
import { ComposerInlineStatus } from './actions/InlineStatus.tsx';
import { ComposerStatusMessageRow } from './actions/StatusMessageRow.tsx';
import { ComposerLexicalInput } from './editor/LexicalInput.tsx';
import { ComposerEditBar } from './edit/EditBar.tsx';
import { NewChatBar } from './newChat/NewChatBar.tsx';
import { OperationQueueTray } from './queue/OperationQueueTray.tsx';
import { useComposerStore } from './store.ts';
import type { ComposerEditTarget, ComposerForkTarget } from './store.ts';

export function ComposerContent({
  conversation,
  contextInspector,
  conversationSelected,
  onInterrupt,
  onEdit,
  onFork,
  onQueueChanged,
  onSend,
  onSignOut,
  runtimeError,
  queue,
}: {
  conversation: ConversationValue | null;
  contextInspector: ContextInspectorValue | null;
  conversationSelected: boolean;
  onInterrupt: () => Promise<void>;
  onEdit: ComposerBranchCallback<ComposerEditTarget>;
  onFork: ComposerBranchCallback<ComposerForkTarget>;
  onQueueChanged: () => Promise<void>;
  onSend: (
    input: { displayText: string; parts: AgentComposerMessagePart[] },
    setPhase: (phase: 'sending' | 'updating-transcript') => void,
  ) => Promise<void>;
  onSignOut: () => void;
  queue: AgentPendingQueueValue | null;
  runtimeError: string | null;
}) {
  const cwd = useConversationStore((state) => state.cwd);
  const pickerOpen = useConversationStore((state) => state.directoryPickerOpen);
  const openPicker = useConversationStore((state) => state.openDirectoryPicker);
  const modelId = useComposerStore((state) => state.modelId);
  const working = conversation?.status === 'running' || conversation?.status === 'interrupting';
  const loading = conversation?.status === 'loading';

  return (
    <div className="remux-bottom-bar border-t border-border" data-remux-composer-root>
      {!pickerOpen ? (
        <div className="remux-composer-context-strip">
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
          canStart={Boolean((conversation || (!conversationSelected && cwd && modelId)) && !loading)}
          conversationExists={conversationSelected}
          isWorking={working}
          onEdit={onEdit}
          onFork={onFork}
          onInterrupt={onInterrupt}
          onSend={onSend}
          onSignOut={onSignOut}
        />
      </div>
      {!pickerOpen ? <ComposerStatusMessageRow runtimeError={runtimeError} /> : null}
      {!pickerOpen ? (
        <ComposerInlineStatus conversation={conversation} contextInspector={contextInspector} />
      ) : null}
    </div>
  );
}

type ComposerBranchCallback<T> = (
  target: T,
  input: { displayText: string; parts: AgentComposerMessagePart[] },
  setPhase: (phase: 'sending' | 'updating-transcript') => void,
) => Promise<void>;
