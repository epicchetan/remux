import { create } from 'zustand';

import type { CodexComposerConfig, CodexComposerConfigWriteParams } from '../../shared/composerConfig';
import { readComposerConfig, writeComposerConfig } from '../ipc/composerConfig';
import {
  createEmptyComposerSnapshot,
  type ComposerAttachmentResource,
  type ComposerDocument,
  type ComposerSnapshot,
} from './model/composerModel';
import type { ComposerMentionSession } from './mentions/mentionSession';
import { composerResourcesFromSnapshot } from './model/userInputInterop';
import type { ComposerIntelligence, ComposerReviewMode, ComposerSpeed } from './config/types';

export type { ComposerIntelligence, ComposerReviewMode, ComposerSpeed } from './config/types';
export type ComposerAttachmentPickerKind = 'photo-library' | 'files';

export type ComposerEditTarget = {
  threadId: string;
  turnId: string;
  userMessageId: string;
};

export type ComposerForkTarget = {
  assistantMessageId: string;
  threadId: string;
  turnId: string;
};

export type ComposerPresentationReason = 'edit' | 'fork';

export type ComposerPresentationRequest = {
  id: number;
  reason: ComposerPresentationReason;
};

export type ComposerSubmissionKind = 'edit' | 'fork' | 'new-chat' | 'send';

export type ComposerSubmissionPhase = 'awaiting-transcript' | 'starting-thread' | 'starting-turn';

export type ComposerSubmission = {
  id: number;
  kind: ComposerSubmissionKind;
  phase: ComposerSubmissionPhase;
  snapshot: ComposerSnapshot;
  threadId: string | null;
  turnId: string | null;
};

export type ComposerConfigStatus = 'failed' | 'idle' | 'loading' | 'ready';

type ComposerStoreState = {
  applyServerConfig: (config: CodexComposerConfig) => void;
  beginSubmission: (input: {
    kind: ComposerSubmissionKind;
    phase: ComposerSubmissionPhase;
    snapshot: ComposerSnapshot;
    threadId?: string | null;
    turnId?: string | null;
  }) => ComposerSubmission;
  blurComposer: () => void;
  cancelEdit: () => void;
  cancelFork: () => void;
  clearComposer: () => void;
  clearEditTarget: () => void;
  clearForkTarget: () => void;
  clearMode: () => void;
  clearSubmission: (id?: number) => void;
  configRevision: string | null;
  configStatus: ComposerConfigStatus;
  composerPresentationRequest: ComposerPresentationRequest;
  editTarget: ComposerEditTarget | null;
  focusComposer: () => void;
  forkTarget: ComposerForkTarget | null;
  intelligence: ComposerIntelligence;
  isSubmitting: boolean;
  failSubmission: (id: number, message: string) => void;
  loadServerConfig: () => Promise<void>;
  mentionSession: ComposerMentionSession | null;
  openAttachmentPicker: (kind?: ComposerAttachmentPickerKind) => void;
  preEditSnapshot: ComposerSnapshot | null;
  reviewMode: ComposerReviewMode;
  snapshot: ComposerSnapshot;
  speed: ComposerSpeed;
  startEdit: (target: ComposerEditTarget, document: ComposerDocument, resources?: ComposerAttachmentResource[]) => void;
  startFork: (target: ComposerForkTarget) => void;
  setEditorController: (controller: ComposerEditorController | null) => void;
  setComposerDocument: (document: ComposerDocument, resources?: ComposerAttachmentResource[]) => void;
  setIntelligence: (intelligence: ComposerIntelligence, threadId?: string | null) => void;
  setMentionSession: (session: ComposerMentionSession | null) => void;
  setReviewMode: (reviewMode: ComposerReviewMode, threadId?: string | null) => void;
  setSubmitting: (isSubmitting: boolean) => void;
  setSubmissionPhase: (id: number, phase: ComposerSubmissionPhase) => void;
  setSubmissionThread: (id: number, threadId: string) => void;
  setSubmissionTurn: (id: number, input: { phase?: ComposerSubmissionPhase; threadId: string; turnId: string }) => void;
  setSnapshot: (snapshot: ComposerSnapshot) => void;
  setSpeed: (speed: ComposerSpeed, threadId?: string | null) => void;
  submission: ComposerSubmission | null;
  submissionError: string | null;
};

type ComposerEditorController = {
  blurComposer: () => void;
  clearComposer: () => void;
  focusComposer: () => void;
  openAttachmentPicker: (kind?: ComposerAttachmentPickerKind) => void;
  setComposerDocument: (document: ComposerDocument, resources?: ComposerAttachmentResource[]) => void;
};

const noopBlurComposer = () => undefined;
const noopClearComposer = () => undefined;
const noopFocusComposer = () => undefined;
const noopOpenAttachmentPicker = () => undefined;
const noopSetComposerDocument = () => undefined;

const nullConfigRevision = '0';

const defaultComposerConfig: CodexComposerConfig = {
  intelligence: 'high',
  reviewMode: 'auto-review',
  revision: nullConfigRevision,
  speed: 'default',
};

let latestConfigRequestId = 0;
type ComposerStoreSet = (
  partial:
    | Partial<ComposerStoreState>
    | ((state: ComposerStoreState) => Partial<ComposerStoreState>),
) => void;

export const useComposerStore = create<ComposerStoreState>((set, get) => ({
  applyServerConfig: (config) => {
    latestConfigRequestId += 1;
    set(composerConfigState(config, 'ready'));
  },
  beginSubmission: ({ kind, phase, snapshot, threadId = null, turnId = null }) => {
    const submission: ComposerSubmission = {
      id: (get().submission?.id ?? 0) + 1,
      kind,
      phase,
      snapshot,
      threadId,
      turnId,
    };
    set({
      isSubmitting: true,
      submission,
      submissionError: null,
    });
    return submission;
  },
  blurComposer: noopBlurComposer,
  cancelEdit: () => {
    const state = get();
    const previous = state.preEditSnapshot;

    set({
      editTarget: null,
      mentionSession: null,
      preEditSnapshot: null,
      submissionError: null,
    });

    if (previous) {
      state.setComposerDocument(previous.document, composerResourcesFromSnapshot(previous));
    } else {
      state.clearComposer();
    }
    state.blurComposer();
  },
  cancelFork: () => set({
    forkTarget: null,
    mentionSession: null,
    submissionError: null,
  }),
  clearComposer: noopClearComposer,
  clearEditTarget: () => set({ editTarget: null, preEditSnapshot: null }),
  clearForkTarget: () => set({ forkTarget: null }),
  clearMode: () => set({
    editTarget: null,
    forkTarget: null,
    mentionSession: null,
    preEditSnapshot: null,
    submissionError: null,
  }),
  clearSubmission: (id) => set((state) => {
    if (id !== undefined && state.submission?.id !== id) {
      return {};
    }

    return {
      isSubmitting: false,
      submission: null,
    };
  }),
  configRevision: defaultComposerConfig.revision,
  configStatus: 'idle',
  composerPresentationRequest: { id: 0, reason: 'edit' },
  editTarget: null,
  failSubmission: (id, message) => set((state) => {
    if (state.submission?.id !== id) {
      return {};
    }

    return {
      isSubmitting: false,
      submission: null,
      submissionError: message.trim() || 'Codex request failed',
    };
  }),
  focusComposer: noopFocusComposer,
  forkTarget: null,
  intelligence: defaultComposerConfig.intelligence,
  isSubmitting: false,
  loadServerConfig: async () => {
    const requestId = ++latestConfigRequestId;
    set({ configStatus: 'loading' });

    try {
      const response = await readComposerConfig();
      if (requestId === latestConfigRequestId) {
        set(composerConfigState(response.config, 'ready'));
      }
    } catch {
      if (requestId === latestConfigRequestId) {
        set({ configStatus: 'failed' });
      }
    }
  },
  mentionSession: null,
  openAttachmentPicker: noopOpenAttachmentPicker,
  preEditSnapshot: null,
  reviewMode: defaultComposerConfig.reviewMode,
  snapshot: createEmptyComposerSnapshot(),
  speed: defaultComposerConfig.speed,
  submission: null,
  submissionError: null,
  startEdit: (target, document, resources = []) => {
    const state = get();
    set((current) => ({
      editTarget: target,
      forkTarget: null,
      mentionSession: null,
      composerPresentationRequest: nextComposerPresentationRequest(current, 'edit'),
      preEditSnapshot: state.editTarget ? state.preEditSnapshot : state.snapshot,
      submissionError: null,
    }));
    state.setComposerDocument(document, resources);
    state.focusComposer();
  },
  startFork: (target) => {
    const state = get();
    set((current) => ({
      editTarget: null,
      forkTarget: target,
      mentionSession: null,
      composerPresentationRequest: nextComposerPresentationRequest(current, 'fork'),
      preEditSnapshot: null,
      submissionError: null,
    }));
    state.focusComposer();
  },
  setEditorController: (controller) => set({
    blurComposer: controller?.blurComposer ?? noopBlurComposer,
    clearComposer: controller?.clearComposer ?? noopClearComposer,
    focusComposer: controller?.focusComposer ?? noopFocusComposer,
    openAttachmentPicker: controller?.openAttachmentPicker ?? noopOpenAttachmentPicker,
    setComposerDocument: controller?.setComposerDocument ?? noopSetComposerDocument,
  }),
  setComposerDocument: noopSetComposerDocument,
  setIntelligence: (intelligence, threadId = null) => updateServerConfig(set, { intelligence, threadId }),
  setMentionSession: (mentionSession) => set({ mentionSession }),
  setReviewMode: (reviewMode, threadId = null) => updateServerConfig(set, { reviewMode, threadId }),
  setSubmitting: (isSubmitting) => set((state) => ({
    isSubmitting,
    submission: isSubmitting
      ? (state.submission ?? {
          id: 1,
          kind: 'send',
          phase: 'starting-turn',
          snapshot: state.snapshot,
          threadId: null,
          turnId: null,
        })
      : null,
  })),
  setSubmissionPhase: (id, phase) => set((state) => (
    state.submission?.id === id
      ? { submission: { ...state.submission, phase } }
      : {}
  )),
  setSubmissionThread: (id, threadId) => set((state) => (
    state.submission?.id === id
      ? { submission: { ...state.submission, threadId } }
      : {}
  )),
  setSubmissionTurn: (id, { phase = 'awaiting-transcript', threadId, turnId }) => set((state) => (
    state.submission?.id === id
      ? {
          submission: {
            ...state.submission,
            phase,
            threadId,
            turnId,
          },
        }
      : {}
  )),
  setSnapshot: (snapshot) => set({ snapshot, submissionError: null }),
  setSpeed: (speed, threadId = null) => updateServerConfig(set, { speed, threadId }),
}));

function composerConfigState(config: CodexComposerConfig, status: ComposerConfigStatus) {
  return {
    configRevision: config.revision,
    configStatus: status,
    intelligence: config.intelligence,
    reviewMode: config.reviewMode,
    speed: config.speed,
  };
}

function optimisticConfigPatch(patch: CodexComposerConfigWriteParams) {
  const { threadId: _threadId, ...configPatch } = patch;
  return {
    configStatus: 'loading' as ComposerConfigStatus,
    ...configPatch,
  };
}

function updateServerConfig(
  set: ComposerStoreSet,
  patch: CodexComposerConfigWriteParams,
) {
  const requestId = ++latestConfigRequestId;
  set(optimisticConfigPatch(patch));

  void writeComposerConfig(patch)
    .then((response) => {
      if (requestId === latestConfigRequestId) {
        set(composerConfigState(response.config, 'ready'));
      }
    })
    .catch(() => {
      if (requestId === latestConfigRequestId) {
        set({ configStatus: 'failed' });
      }
    });
}

function nextComposerPresentationRequest(
  state: Pick<ComposerStoreState, 'composerPresentationRequest'>,
  reason: ComposerPresentationReason,
): ComposerPresentationRequest {
  return {
    id: state.composerPresentationRequest.id + 1,
    reason,
  };
}
