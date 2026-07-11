import { ComposerActionButtons } from './actions/ActionButtons';
import { ComposerInlineStatus } from './actions/InlineStatus';
import { ComposerStatusMessageRow } from './actions/StatusMessageRow';
import { ComposerEditBar } from './edit/EditBar';
import { ComposerLexicalInput } from './editor/LexicalInput';
import { NewChatBar } from './newChat/NewChatBar';
import { useThreadsStore } from '../threads/store';
import { OperationQueueTray } from './queue/OperationQueueTray';
import { NarrationBar } from '../narration/NarrationBar';

export function ComposerContent() {
  const pickingDirectory = useThreadsStore((state) =>
    Boolean(state.activeDraftId && state.draft?.id === state.activeDraftId && state.directoryPickerOpen));

  return (
    <div className="remux-bottom-bar border-t border-border" data-remux-composer-root>
      {pickingDirectory ? null : (
        <div className="remux-composer-context-strip">
          <ComposerEditBar />
          <NarrationBar />
          <OperationQueueTray />
        </div>
      )}
      <div className="remux-composer-panel">
        {pickingDirectory ? null : (
          <NewChatBar />
        )}
        <ComposerLexicalInput hidden={pickingDirectory} />
        <ComposerActionButtons />
      </div>
      {pickingDirectory ? null : <ComposerStatusMessageRow />}
      {pickingDirectory ? null : <ComposerInlineStatus />}
    </div>
  );
}
