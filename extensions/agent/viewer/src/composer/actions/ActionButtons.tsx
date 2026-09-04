import { ArrowDown, ArrowLeft, ArrowUp, Check, History, Loader2, PanelRightOpen, Send, Square } from 'lucide-react';
import { openHostOverview } from '@remux/viewer-kit/host';

import type { AgentProvidersResource, AgentRuntimeResource } from '../../../../shared/native-agent-protocol.ts';
import type { ProviderAccess } from '../../../../shared/provider-runtime.ts';
import type { ReasoningLevel } from '../../../../shared/protocol.ts';
import { parentDirectory } from '../../conversation/format.ts';
import { useAgentSidebarStore } from '../../conversation/sidebarStore.ts';
import { useConversationStore } from '../../conversation/store.ts';
import { useComposerStore } from '../store.ts';
import { useTranscriptViewportControls } from '../../transcript/index.ts';
import { ComposerAttachmentButton } from '../attachments/AttachmentButton.tsx';
import { ComposerConfigButton } from '../config/ConfigButton.tsx';
import { ComposerActionKey, type ComposerAction } from './ActionKey.tsx';
import { useComposerTurnAction, type TurnSubmissionInput } from './turnAction.ts';
import type { ComposerEditTarget, ComposerForkTarget } from '../store.ts';

export function ComposerActionButtons({
  canStart,
  conversationExists,
  isWorking,
  onInterrupt,
  onCompact,
  onEdit,
  onFork,
  onSend,
  onProviderLogin,
  onProviderLogout,
  onPreferenceChange,
  onAccessChange,
  providers,
  runtime,
}: {
  canStart: boolean;
  conversationExists: boolean;
  isWorking: boolean;
  onInterrupt: () => Promise<void>;
  onCompact: () => Promise<void>;
  onEdit: ComposerBranchCallback<ComposerEditTarget>;
  onFork: ComposerBranchCallback<ComposerForkTarget>;
  onSend: (
    input: TurnSubmissionInput,
    setPhase: (phase: 'sending' | 'updating-transcript') => void,
  ) => Promise<void>;
  onProviderLogin: (providerInstanceId: string, mode: 'device-code' | 'browser') => void;
  onProviderLogout: (providerInstanceId: string) => void;
  onPreferenceChange: (input: {
    providerInstanceId: string;
    modelId: string;
    reasoning: ReasoningLevel;
  }) => Promise<void>;
  onAccessChange: (access: ProviderAccess) => Promise<void>;
  providers: AgentProvidersResource | null;
  runtime: AgentRuntimeResource | null;
}) {
  const { canScrollDown, canScrollUp, scrollDown, scrollUp } = useTranscriptViewportControls();
  const openMobileSidebar = useAgentSidebarStore((state) => state.openMobile);
  const pickerOpen = useConversationStore((state) => state.directoryPickerOpen);
  const pickerPath = useConversationStore((state) => state.directoryPickerPath);
  const setPickerPath = useConversationStore((state) => state.setDirectoryPickerPath);
  const selectPickerPath = useConversationStore((state) => state.selectDirectoryPickerPath);
  const selectedProviderInstanceId = useComposerStore((state) => state.providerInstanceId);
  const providerCapabilities = runtime?.capabilities
    ?? providers?.providers.find(({ providerInstanceId }) =>
      providerInstanceId === selectedProviderInstanceId)?.capabilities;
  const canSubmitAtCurrentBoundary = !isWorking || Boolean(runtime);
  const turn = useComposerTurnAction({
    canStart: canStart && canSubmitAtCurrentBoundary,
    conversationExists,
    isWorking,
    onEdit,
    onFork,
    onInterrupt,
    onSend,
    runtime,
    imagesEnabled: providerCapabilities?.content.images === true,
    fileReferencesEnabled: providerCapabilities?.content.fileReferences === true,
    branchEnabled: runtime?.capabilities.session.forkNative === true,
  });
  const parent = parentDirectory(pickerPath);

  const left: ComposerAction[] = [{
    className: 'remux-composer-overview-button',
    icon: <PanelRightOpen className="size-4" />,
    label: 'Open tabs',
    onClick: () => void openHostOverview({ section: 'tabs' }),
  }, {
    className: 'remux-composer-sidebar-button',
    icon: <History className="size-4" />,
    label: 'Open history',
    onClick: openMobileSidebar,
  }];
  const navigation: ComposerAction[] = pickerOpen ? [
    { disabled: !parent, icon: <ArrowLeft className="size-4" />, label: 'Parent directory', onClick: () => parent && setPickerPath(parent), preserveFocus: true },
    { disabled: !pickerPath, icon: <Check className="size-4" />, label: 'Select directory', onClick: selectPickerPath, preserveFocus: true, tone: 'send' },
  ] : [
    { disabled: !canScrollUp, icon: <ArrowUp className="size-4" />, label: 'Previous turn', onClick: scrollUp },
    { disabled: !canScrollDown, icon: <ArrowDown className="size-4" />, label: 'Next turn or bottom', onClick: scrollDown },
  ];

  return (
    <div className="remux-composer-actions">
      <div className="remux-composer-action-group">
        {left.map((action) => <ComposerActionKey action={action} key={action.label} />)}
        <ComposerConfigButton
          disabled={pickerOpen}
          onProviderLogin={onProviderLogin}
          onProviderLogout={onProviderLogout}
          onCompact={onCompact}
          onPreferenceChange={onPreferenceChange}
          onAccessChange={onAccessChange}
          conversationExists={conversationExists}
          providers={providers}
          runtime={runtime}
        />
      </div>
      <div className="remux-composer-action-group remux-composer-action-group-right">
        {navigation.map((action) => <ComposerActionKey action={action} key={action.label} />)}
        {!pickerOpen ? <ComposerAttachmentButton
          imagesEnabled={providerCapabilities?.content.images === true}
        /> : null}
        {!pickerOpen && isWorking && runtime?.capabilities.turns.interrupt ? <ComposerActionKey action={{
          busy: turn.isStopping,
          disabled: turn.isStopping,
          icon: turn.isStopping ? <Loader2 className="size-4 animate-spin" /> : <Square className="size-4 fill-current" />,
          label: turn.isStopping ? 'Stopping turn' : 'Stop turn',
          onClick: turn.handleInterrupt,
        }} /> : null}
        {!pickerOpen && (!isWorking || (turn.hasSendableContent && !turn.isStopping)) ? <ComposerActionKey action={{
          busy: turn.isSubmitting,
          disabled: turn.sendDisabled,
          icon: turn.isSubmitting ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />,
          label: turn.isSubmitting
            ? 'Sending message'
            : turn.editTarget
              ? 'Save edited message'
              : turn.forkTarget
                ? 'Send forked message'
              : isWorking ? 'Queue message' : 'Send message',
          onClick: turn.handleSend,
          tone: 'send',
        }} /> : null}
      </div>
    </div>
  );
}

type ComposerBranchCallback<T> = (
  target: T,
  input: TurnSubmissionInput,
  setPhase: (phase: 'sending' | 'updating-transcript') => void,
) => Promise<void>;
