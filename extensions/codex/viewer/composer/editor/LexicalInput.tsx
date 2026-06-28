import { useCallback, useEffect, useRef } from 'react';
import type { LexicalEditor } from 'lexical';

import { ComposerAttachmentRail } from '../attachments/AttachmentRail';
import { clearComposerEditor, ComposerEditor, focusComposerEditor, setComposerEditorDocument } from './ComposerEditor';
import { INSERT_COMPOSER_ATTACHMENT_COMMAND, REMOVE_COMPOSER_ATTACHMENT_COMMAND } from './commands';
import {
  isAllowedDataImageUrl,
  maxComposerImageAttachments,
  maxComposerImageBytes,
  validateComposerImages,
} from '../attachments/imageAttachments';
import {
  createComposerAttachmentResource,
  createComposerAttachmentResourceFromDataUrl,
  type ComposerDocument,
  createEmptyComposerSnapshot,
  createComposerSnapshot,
  type ComposerAttachmentResource,
  type ComposerSnapshot,
  revokeComposerAttachmentResource,
} from '../model/composerModel';
import { readComposerDocument } from './ComposerEditor';
import { digestDataUrl, readFileAsDataUrl } from '../attachments/readFileAsDataUrl';
import { pickHostAttachments, type HostAttachmentPickResult } from '../../ipc/host';
import { type ComposerAttachmentPickerKind, useComposerStore } from '../store';

export function ComposerLexicalInput({ hidden = false }: { hidden?: boolean }) {
  const editTarget = useComposerStore((state) => state.editTarget);
  const isSubmitting = useComposerStore((state) => state.isSubmitting);
  const snapshot = useComposerStore((state) => state.snapshot);
  const setEditorController = useComposerStore((state) => state.setEditorController);
  const setMentionSession = useComposerStore((state) => state.setMentionSession);
  const setSnapshot = useComposerStore((state) => state.setSnapshot);
  const editorRef = useRef<LexicalEditor | null>(null);
  const resourcesRef = useRef(new Map<string, ComposerAttachmentResource>());
  const composerErrorRef = useRef<string | null>(null);
  const cleanupFrameRef = useRef(0);
  const latestSnapshotRef = useRef<ComposerSnapshot>(snapshot);

  const getResources = useCallback(() => resourcesRef.current, []);
  const scheduleDetachedResourceCleanup = useCallback((nextSnapshot: ComposerSnapshot) => {
    latestSnapshotRef.current = nextSnapshot;
    if (cleanupFrameRef.current !== 0) {
      return;
    }

    cleanupFrameRef.current = window.requestAnimationFrame(() => {
      cleanupFrameRef.current = 0;
      cleanupDetachedResources(latestSnapshotRef.current, resourcesRef.current);
    });
  }, []);
  const cancelDetachedResourceCleanup = useCallback(() => {
    if (cleanupFrameRef.current !== 0) {
      window.cancelAnimationFrame(cleanupFrameRef.current);
      cleanupFrameRef.current = 0;
    }
  }, []);
  const handleSnapshotChange = useCallback(
    (snapshot: ComposerSnapshot) => {
      scheduleDetachedResourceCleanup(snapshot);
      setSnapshot(snapshot);
    },
    [scheduleDetachedResourceCleanup, setSnapshot],
  );
  const publishSnapshot = useCallback(() => {
    const editor = editorRef.current;
    if (!editor) {
      const nextSnapshot = createEmptyComposerSnapshot();
      setSnapshot(nextSnapshot);
      return;
    }

    const nextSnapshot = editor.getEditorState().read(() =>
      createComposerSnapshot(readComposerDocument(), resourcesRef.current, undefined, composerErrorRef.current));
    scheduleDetachedResourceCleanup(nextSnapshot);
    setSnapshot(nextSnapshot);
  }, [scheduleDetachedResourceCleanup, setSnapshot]);
  const insertFiles = useCallback((files: File[], options: { preserveDomFocus?: boolean } = {}) => {
    const editor = editorRef.current;
    if (!editor || files.length === 0) {
      return;
    }

    const validation = validateComposerImages(files, resourcesRef.current.size);
    composerErrorRef.current = validation.message;

    for (const image of validation.images) {
      const resource = createComposerAttachmentResource(image.file, {
        mimeType: image.mimeType,
        name: image.name,
        sizeBytes: image.sizeBytes,
      });
      resourcesRef.current.set(resource.id, resource);
      editor.dispatchCommand(INSERT_COMPOSER_ATTACHMENT_COMMAND, {
        id: resource.id,
        mimeType: resource.mimeType,
        name: resource.name,
        preserveDomFocus: options.preserveDomFocus,
      });
      void readAttachmentResource(resource.id, image.file);
    }

    if (validation.images.length === 0) {
      publishSnapshot();
    }
  }, [publishSnapshot]);
  const blurComposer = useCallback(() => {
    editorRef.current?.blur();
    blurActiveComposerElement();
  }, []);
  const focusComposer = useCallback(() => {
    const editor = editorRef.current;
    if (editor?.isEditable()) {
      focusComposerEditor(editor);
    }
  }, []);
  const insertPickedAttachments = useCallback((attachments: HostAttachmentPickResult['assets']) => {
    const editor = editorRef.current;
    if (!editor || attachments.length === 0) {
      return;
    }

    const validation = validatePickedAttachments(attachments, resourcesRef.current.size);
    composerErrorRef.current = validation.message;

    for (const attachment of validation.attachments) {
      const resource = createComposerAttachmentResourceFromDataUrl({
        dataUrl: attachment.dataUrl,
        digest: digestDataUrl(attachment.dataUrl),
        mimeType: attachment.mimeType,
        name: attachment.name,
        sizeBytes: attachment.sizeBytes,
      });
      resourcesRef.current.set(resource.id, resource);
      editor.dispatchCommand(INSERT_COMPOSER_ATTACHMENT_COMMAND, {
        id: resource.id,
        mimeType: resource.mimeType,
        name: resource.name,
        preserveDomFocus: !isComposerFocused(),
      });
    }

    publishSnapshot();
  }, [publishSnapshot]);
  const openAttachmentPicker = useCallback((kind: ComposerAttachmentPickerKind = 'photo-library') => {
    if (useComposerStore.getState().isSubmitting) {
      return;
    }

    const shouldRefocus = isComposerFocused();

    void pickHostAttachments({
      multiple: true,
      picker: kind,
      type: 'image',
    }).then((result) => {
      if (!result.canceled) {
        insertPickedAttachments(result.assets);
        if (result.assets.length > 0 && shouldRefocus) {
          focusEditorAfterPickerDismissal(editorRef.current);
        }
      }
    }).catch(() => {
      composerErrorRef.current = 'Could not open attachment picker.';
      publishSnapshot();
    });
  }, [insertPickedAttachments, publishSnapshot]);
  const clearComposer = useCallback(() => {
    const editor = editorRef.current;
    composerErrorRef.current = null;
    cancelDetachedResourceCleanup();
    for (const resource of resourcesRef.current.values()) {
      revokeComposerAttachmentResource(resource);
    }
    resourcesRef.current.clear();

    if (editor) {
      clearComposerEditor(editor);
    }

    const nextSnapshot = createEmptyComposerSnapshot();
    latestSnapshotRef.current = nextSnapshot;
    setSnapshot(nextSnapshot);
  }, [cancelDetachedResourceCleanup, setSnapshot]);
  const setComposerDocument = useCallback((document: ComposerDocument, resources: ComposerAttachmentResource[] = []) => {
    const editor = editorRef.current;
    composerErrorRef.current = null;
    cancelDetachedResourceCleanup();

    for (const resource of resourcesRef.current.values()) {
      revokeComposerAttachmentResource(resource);
    }
    resourcesRef.current.clear();

    for (const resource of resources) {
      resourcesRef.current.set(resource.id, resource);
    }

    if (editor) {
      setComposerEditorDocument(editor, document);
    }

    const nextSnapshot = createComposerSnapshot(document, resourcesRef.current);
    latestSnapshotRef.current = nextSnapshot;
    setSnapshot(nextSnapshot);
  }, [cancelDetachedResourceCleanup, setSnapshot]);
  const removeAttachment = useCallback((id: string) => {
    if (useComposerStore.getState().isSubmitting) {
      return;
    }

    const shouldKeepFocus = isComposerFocused();
    editorRef.current?.dispatchCommand(REMOVE_COMPOSER_ATTACHMENT_COMMAND, {
      id,
      preserveDomFocus: !shouldKeepFocus,
    });
    window.requestAnimationFrame(publishSnapshot);
  }, [publishSnapshot]);

  useEffect(() => () => {
    editorRef.current = null;
    cancelDetachedResourceCleanup();
    for (const resource of resourcesRef.current.values()) {
      revokeComposerAttachmentResource(resource);
    }
    resourcesRef.current.clear();
    setMentionSession(null);
    const nextSnapshot = createEmptyComposerSnapshot();
    latestSnapshotRef.current = nextSnapshot;
    setSnapshot(nextSnapshot);
  }, [cancelDetachedResourceCleanup, setMentionSession, setSnapshot]);

  useEffect(() => {
    setEditorController({
      blurComposer,
      clearComposer,
      focusComposer,
      openAttachmentPicker,
      setComposerDocument,
    });
    return () => setEditorController(null);
  }, [blurComposer, clearComposer, focusComposer, openAttachmentPicker, setEditorController, setComposerDocument]);

  return (
    <div
      aria-hidden={hidden}
      className={`remux-composer-editor${hidden ? ' remux-composer-editor-hidden' : ''}`}
    >
      <ComposerAttachmentRail
        attachments={snapshot.attachments}
        disabled={isSubmitting}
        onRemoveAttachment={removeAttachment}
      />
      {snapshot.error ? <div className="remux-composer-attachment-error">{snapshot.error}</div> : null}
      <ComposerEditor
        getResources={getResources}
        onEditor={(editor) => {
          editorRef.current = editor;
        }}
        onMentionSessionChange={setMentionSession}
        onSnapshotChange={handleSnapshotChange}
        placeholder={editTarget ? 'Edit message...' : 'Message Codex'}
        readOnly={isSubmitting}
      />
    </div>
  );

  async function readAttachmentResource(id: string, file: File) {
    try {
      const dataUrl = await readFileAsDataUrl(file);
      const resource = resourcesRef.current.get(id);
      if (!resource) {
        return;
      }

      resource.dataUrl = dataUrl;
      resource.digest = digestDataUrl(dataUrl);
      resource.error = null;
      publishSnapshot();
    } catch {
      const resource = resourcesRef.current.get(id);
      if (!resource) {
        return;
      }

      resource.dataUrl = null;
      resource.digest = null;
      resource.error = 'Could not read image.';
      publishSnapshot();
    }
  }
}

function blurActiveComposerElement() {
  const activeElement = document.activeElement;
  if (activeElement instanceof HTMLElement && activeElement.classList.contains('remux-composer-contenteditable')) {
    activeElement.blur();
  }
}

function focusEditorAfterPickerDismissal(editor: LexicalEditor | null) {
  void focusEditorAfterLayout(editor);
}

function focusEditorAfterLayout(editor: LexicalEditor | null) {
  let firstFrame = 0;
  let secondFrame = 0;
  firstFrame = window.requestAnimationFrame(() => {
    secondFrame = window.requestAnimationFrame(() => {
      if (editor?.isEditable()) {
        focusComposerEditor(editor);
      }
    });
  });

  return () => {
    if (firstFrame !== 0) {
      window.cancelAnimationFrame(firstFrame);
    }
    if (secondFrame !== 0) {
      window.cancelAnimationFrame(secondFrame);
    }
  };
}

function isComposerFocused() {
  return document.activeElement?.classList.contains('remux-composer-contenteditable') ?? false;
}

function validatePickedAttachments(
  attachments: HostAttachmentPickResult['assets'],
  existingCount: number,
): {
  attachments: HostAttachmentPickResult['assets'];
  message: string | null;
} {
  const validAttachments: HostAttachmentPickResult['assets'] = [];

  for (const attachment of attachments) {
    if (existingCount + validAttachments.length >= maxComposerImageAttachments) {
      return {
        attachments: validAttachments,
        message: 'You can attach up to 4 images.',
      };
    }

    if (!attachment.mimeType.startsWith('image/') || !isAllowedDataImageUrl(attachment.dataUrl)) {
      return {
        attachments: validAttachments,
        message: 'Only images can be attached.',
      };
    }

    if (attachment.sizeBytes > maxComposerImageBytes) {
      return {
        attachments: validAttachments,
        message: 'Image is larger than 6 MB.',
      };
    }

    validAttachments.push(attachment);
  }

  return {
    attachments: validAttachments,
    message: null,
  };
}

function cleanupDetachedResources(
  snapshot: ComposerSnapshot,
  resources: Map<string, ComposerAttachmentResource>,
) {
  const attachedIds = new Set(snapshot.attachments.map((attachment) => attachment.id));

  for (const [id, resource] of resources) {
    if (!attachedIds.has(id)) {
      revokeComposerAttachmentResource(resource);
      resources.delete(id);
    }
  }
}
