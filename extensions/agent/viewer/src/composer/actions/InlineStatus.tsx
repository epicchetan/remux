import type { ConversationValue } from '../../../../shared/protocol.ts';
import { reasoningLabel, resolveModel } from '../config/modelSelection.ts';
import { useComposerStore } from '../store.ts';

export function ComposerInlineStatus({ conversation }: { conversation: ConversationValue | null }) {
  const configuredModel = useComposerStore((state) => state.modelId);
  const models = useComposerStore((state) => state.models);
  const configuredReasoning = useComposerStore((state) => state.reasoning);
  const modelId = conversation?.modelId ?? configuredModel;
  const reasoning = conversation?.reasoning ?? configuredReasoning;
  const model = resolveModel(models, modelId);

  return (
    <div className="remux-composer-inline-status" data-remux-no-composer-focus>
      <div className="remux-composer-status-group">
        <span className="truncate">{model?.name ?? (modelId || 'Loading models')}</span>
        <span className="remux-composer-status-separator" aria-hidden="true">/</span>
        <span className="truncate">{reasoningLabel(reasoning)} reasoning</span>
      </div>
    </div>
  );
}
