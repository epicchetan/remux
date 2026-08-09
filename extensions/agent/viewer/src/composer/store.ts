import { create } from 'zustand';

import type { ModelsValue, ReasoningLevel } from '../../../shared/protocol.ts';
import { preferredReasoning, resolveModel } from './config/modelSelection.ts';
import {
  createEmptyComposerSnapshot,
  type ComposerAttachmentResource,
  type ComposerDocument,
  type ComposerSnapshot,
} from './model/composerModel.ts';
import { composerResourcesFromSnapshot } from './model/userInputInterop.ts';
import type { ComposerMentionSession } from './mentions/mentionSession.ts';

export type ComposerAttachmentPickerKind = 'photo-library' | 'files';

export type ComposerEditTarget = {
  conversationId: string;
  turnId: string;
  userMessageId: string;
};

export type ComposerForkTarget = {
  assistantMessageId: string;
  conversationId: string;
  turnId: string;
};

export type ComposerSubmissionKind = 'edit' | 'fork' | 'new-chat' | 'send';
export type ComposerSubmissionPhase =
  | 'starting-conversation'
  | 'sending'
  | 'updating-transcript'
  | 'waiting-for-connection';

export type ComposerSubmission = {
  conversationId: string | null;
  id: number;
  kind: ComposerSubmissionKind;
  phase: ComposerSubmissionPhase;
  snapshot: ComposerSnapshot;
  turnId: string | null;
};

type ComposerPresentationRequest = {
  id: number;
  reason: 'edit' | 'fork';
};

type ComposerEditorController = {
  blurComposer: () => void;
  clearComposer: () => void;
  focusComposer: () => void;
  openAttachmentPicker: (kind?: ComposerAttachmentPickerKind) => void;
  setComposerDocument: (document: ComposerDocument, resources?: ComposerAttachmentResource[]) => void;
};

type ComposerStoreState = {
  beginSubmission: (input: {
    conversationId?: string | null;
    kind: ComposerSubmissionKind;
    phase: ComposerSubmissionPhase;
    snapshot?: ComposerSnapshot;
    turnId?: string | null;
  }) => ComposerSubmission;
  blurComposer: () => void;
  cancelEdit: () => void;
  cancelFork: () => void;
  clearComposer: () => void;
  clearMode: () => void;
  clearSubmission: (id?: number) => void;
  composerPresentationRequest: ComposerPresentationRequest;
  editTarget: ComposerEditTarget | null;
  failSubmission: (id: number, message: string) => void;
  focusComposer: () => void;
  forkTarget: ComposerForkTarget | null;
  isSubmitting: boolean;
  mentionSession: ComposerMentionSession | null;
  modelId: string;
  models: ModelsValue | null;
  openAttachmentPicker: (kind?: ComposerAttachmentPickerKind) => void;
  preEditSnapshot: ComposerSnapshot | null;
  reasoning: ReasoningLevel;
  setComposerDocument: (document: ComposerDocument, resources?: ComposerAttachmentResource[]) => void;
  setDocument: (document: ComposerDocument, resources?: ComposerAttachmentResource[]) => void;
  setEditorController: (controller: ComposerEditorController | null) => void;
  setMentionSession: (session: ComposerMentionSession | null) => void;
  setModelId: (modelId: string) => void;
  setModels: (models: ModelsValue) => void;
  setReasoning: (reasoning: ReasoningLevel) => void;
  setSnapshot: (snapshot: ComposerSnapshot) => void;
  setSubmissionConversation: (id: number, conversationId: string) => void;
  setSubmissionPhase: (id: number, phase: ComposerSubmissionPhase) => void;
  setSubmissionTurn: (id: number, turnId: string) => void;
  snapshot: ComposerSnapshot;
  startEdit: (target: ComposerEditTarget, document: ComposerDocument, resources?: ComposerAttachmentResource[]) => void;
  startFork: (target: ComposerForkTarget) => void;
  submission: ComposerSubmission | null;
  submissionError: string | null;
};

const noop = () => undefined;
const noopSetDocument = () => undefined;
let submissionId = 0;

export const useComposerStore = create<ComposerStoreState>((set, get) => ({
  beginSubmission: ({ conversationId = null, kind, phase, snapshot = get().snapshot, turnId = null }) => {
    const submission: ComposerSubmission = {
      conversationId,
      id: ++submissionId,
      kind,
      phase,
      snapshot,
      turnId,
    };
    set({ isSubmitting: true, submission, submissionError: null });
    return submission;
  },
  blurComposer: noop,
  cancelEdit: () => {
    const state = get();
    const previous = state.preEditSnapshot;
    set({ editTarget: null, mentionSession: null, preEditSnapshot: null, submissionError: null });
    if (previous) {
      state.setComposerDocument(previous.document, composerResourcesFromSnapshot(previous));
    } else {
      state.clearComposer();
    }
    state.blurComposer();
  },
  cancelFork: () => set({ forkTarget: null, mentionSession: null, submissionError: null }),
  clearComposer: noop,
  clearMode: () => set({
    editTarget: null,
    forkTarget: null,
    mentionSession: null,
    preEditSnapshot: null,
    submissionError: null,
  }),
  clearSubmission: (id) => set((state) => (
    id !== undefined && state.submission?.id !== id
      ? {}
      : { isSubmitting: false, submission: null }
  )),
  composerPresentationRequest: { id: 0, reason: 'edit' },
  editTarget: null,
  failSubmission: (id, message) => set((state) => state.submission?.id === id
    ? {
        isSubmitting: false,
        submission: null,
        submissionError: message.trim() || 'Agent request failed',
      }
    : {}),
  focusComposer: noop,
  forkTarget: null,
  isSubmitting: false,
  mentionSession: null,
  modelId: '',
  models: null,
  openAttachmentPicker: noop,
  preEditSnapshot: null,
  reasoning: 'high',
  setComposerDocument: noopSetDocument,
  setDocument: noopSetDocument,
  setEditorController: (controller) => set({
    blurComposer: controller?.blurComposer ?? noop,
    clearComposer: controller?.clearComposer ?? noop,
    focusComposer: controller?.focusComposer ?? noop,
    openAttachmentPicker: controller?.openAttachmentPicker ?? noop,
    setComposerDocument: controller?.setComposerDocument ?? noopSetDocument,
    setDocument: controller?.setComposerDocument ?? noopSetDocument,
  }),
  setMentionSession: (mentionSession) => set({ mentionSession }),
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
  setSubmissionConversation: (id, conversationId) => set((state) => state.submission?.id === id
    ? { submission: { ...state.submission, conversationId } }
    : {}),
  setSubmissionPhase: (id, phase) => set((state) => state.submission?.id === id
    ? { submission: { ...state.submission, phase } }
    : {}),
  setSubmissionTurn: (id, turnId) => set((state) => state.submission?.id === id
    ? { submission: { ...state.submission, turnId } }
    : {}),
  snapshot: createEmptyComposerSnapshot(),
  startEdit: (target, document, resources = []) => {
    const state = get();
    set((current) => ({
      composerPresentationRequest: {
        id: current.composerPresentationRequest.id + 1,
        reason: 'edit',
      },
      editTarget: target,
      forkTarget: null,
      mentionSession: null,
      preEditSnapshot: state.editTarget ? state.preEditSnapshot : state.snapshot,
      submissionError: null,
    }));
    state.setComposerDocument(document, resources);
    state.focusComposer();
  },
  startFork: (target) => {
    const state = get();
    set((current) => ({
      composerPresentationRequest: {
        id: current.composerPresentationRequest.id + 1,
        reason: 'fork',
      },
      editTarget: null,
      forkTarget: target,
      mentionSession: null,
      preEditSnapshot: null,
      submissionError: null,
    }));
    state.focusComposer();
  },
  submission: null,
  submissionError: null,
}));
