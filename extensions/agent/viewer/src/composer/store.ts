import { create } from 'zustand';

import type { ModelsValue, ReasoningLevel } from '../../../shared/protocol.ts';
import { preferredReasoning, resolveModel } from './config/modelSelection.ts';
import {
  createEmptyComposerSnapshot,
  type ComposerDocument,
  type ComposerSnapshot,
} from './model/composerModel.ts';

export type ComposerSubmissionPhase = 'starting-conversation' | 'sending' | 'updating-transcript';

export type ComposerSubmission = {
  id: number;
  phase: ComposerSubmissionPhase;
  snapshot: ComposerSnapshot;
};

export type ComposerEditorController = {
  blur: () => void;
  clear: () => void;
  focus: () => void;
  setDocument: (document: ComposerDocument) => void;
};

type ComposerStoreState = {
  beginSubmission: (phase: ComposerSubmissionPhase) => ComposerSubmission;
  clearComposer: () => void;
  clearSubmission: (id: number) => void;
  failSubmission: (id: number, message: string) => void;
  modelId: string;
  models: ModelsValue | null;
  reasoning: ReasoningLevel;
  setEditorController: (controller: ComposerEditorController | null) => void;
  setModelId: (modelId: string) => void;
  setModels: (models: ModelsValue) => void;
  setReasoning: (reasoning: ReasoningLevel) => void;
  setSnapshot: (snapshot: ComposerSnapshot) => void;
  setSubmissionPhase: (id: number, phase: ComposerSubmissionPhase) => void;
  snapshot: ComposerSnapshot;
  submission: ComposerSubmission | null;
  submissionError: string | null;
};

let controller: ComposerEditorController | null = null;
let submissionId = 0;

export const useComposerStore = create<ComposerStoreState>((set, get) => ({
  beginSubmission: (phase) => {
    const submission = { id: ++submissionId, phase, snapshot: get().snapshot };
    set({ submission, submissionError: null });
    return submission;
  },
  clearComposer: () => controller?.clear(),
  clearSubmission: (id) => set((state) => state.submission?.id === id
    ? { submission: null }
    : {}),
  failSubmission: (id, message) => set((state) => state.submission?.id === id
    ? { submission: null, submissionError: message.trim() || 'Agent turn failed' }
    : {}),
  modelId: '',
  models: null,
  reasoning: 'high',
  setEditorController: (next) => {
    controller = next;
  },
  setModelId: (modelId) => set((state) => {
    const selected = resolveModel(state.models, modelId);
    return {
      modelId,
      reasoning: selected?.supportedReasoning.includes(state.reasoning)
        ? state.reasoning
        : selected ? preferredReasoning(selected) : state.reasoning,
    };
  }),
  setModels: (models) => set((state) => {
    const selected = resolveModel(models, state.modelId);
    if (!selected) return { models };
    return {
      modelId: selected.id,
      models,
      reasoning: selected.supportedReasoning.includes(state.reasoning)
        ? state.reasoning
        : preferredReasoning(selected),
    };
  }),
  setReasoning: (reasoning) => set({ reasoning }),
  setSnapshot: (snapshot) => set({ snapshot, submissionError: null }),
  setSubmissionPhase: (id, phase) => set((state) => state.submission?.id === id
    ? { submission: { ...state.submission, phase } }
    : {}),
  snapshot: createEmptyComposerSnapshot(),
  submission: null,
  submissionError: null,
}));
