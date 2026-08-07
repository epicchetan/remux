import type { ConversationValue } from '../../../shared/protocol.ts';
import { useConversationStore } from '../conversation/store.ts';
import { ComposerActionButtons } from './actions/ActionButtons.tsx';
import { ComposerInlineStatus } from './actions/InlineStatus.tsx';
import { ComposerStatusMessageRow } from './actions/StatusMessageRow.tsx';
import { ComposerLexicalInput } from './editor/LexicalInput.tsx';
import { NewChatBar } from './newChat/NewChatBar.tsx';
import { useComposerStore } from './store.ts';

export function ComposerContent({
  conversation,
  onInterrupt,
  onNewChat,
  onSend,
  onSignOut,
  runtimeError,
}: {
  conversation: ConversationValue | null;
  onInterrupt: () => Promise<void>;
  onNewChat: () => void;
  onSend: (text: string, setPhase: (phase: 'sending' | 'updating-transcript') => void) => Promise<void>;
  onSignOut: () => void;
  runtimeError: string | null;
}) {
  const cwd = useConversationStore((state) => state.cwd);
  const pickerOpen = useConversationStore((state) => state.directoryPickerOpen);
  const openPicker = useConversationStore((state) => state.openDirectoryPicker);
  const modelId = useComposerStore((state) => state.modelId);
  const submission = useComposerStore((state) => state.submission);
  const working = conversation?.status === 'running' || conversation?.status === 'interrupting';

  return (
    <div className="remux-bottom-bar border-t border-border" data-remux-composer-root>
      <div className="remux-composer-panel">
        {!pickerOpen ? <NewChatBar cwd={conversation?.cwd ?? cwd} locked={Boolean(conversation)} onNewChat={onNewChat} onOpenDirectory={openPicker} /> : null}
        {!pickerOpen ? <ComposerLexicalInput readOnly={Boolean(submission || working)} /> : null}
        <ComposerActionButtons
          canStart={Boolean(cwd && modelId)}
          conversationExists={Boolean(conversation)}
          isWorking={working}
          onInterrupt={onInterrupt}
          onSend={onSend}
          onSignOut={onSignOut}
        />
      </div>
      {!pickerOpen ? <ComposerStatusMessageRow runtimeError={runtimeError} /> : null}
      {!pickerOpen ? <ComposerInlineStatus conversation={conversation} /> : null}
    </div>
  );
}
