import { useCallback, useEffect, useMemo, useRef } from 'react';
import { LexicalComposer } from '@lexical/react/LexicalComposer';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import { ContentEditable } from '@lexical/react/LexicalContentEditable';
import { LexicalErrorBoundary } from '@lexical/react/LexicalErrorBoundary';
import { HistoryPlugin } from '@lexical/react/LexicalHistoryPlugin';
import { OnChangePlugin } from '@lexical/react/LexicalOnChangePlugin';
import { PlainTextPlugin } from '@lexical/react/LexicalPlainTextPlugin';
import {
  $addUpdateTag,
  $createTextNode,
  $createParagraphNode,
  $getNodeByKey,
  $getRoot,
  $getSelection,
  $insertNodes,
  $isRangeSelection,
  $isTextNode,
  $nodesOfType,
  COMMAND_PRIORITY_CRITICAL,
  COMMAND_PRIORITY_EDITOR,
  INSERT_LINE_BREAK_COMMAND,
  KEY_ENTER_COMMAND,
  SKIP_DOM_SELECTION_TAG,
  SKIP_SELECTION_FOCUS_TAG,
  type EditorState,
  type LexicalEditor,
  type LexicalNode,
} from 'lexical';

import {
  INSERT_COMPOSER_ATTACHMENT_COMMAND,
  REMOVE_COMPOSER_ATTACHMENT_COMMAND,
} from './commands';
import {
  type ComposerAttachmentResource,
  type ComposerDocument,
  composerDocumentPlainText,
  createComposerSnapshot,
  type ComposerSnapshot,
} from '../model/composerModel';
import {
  $createAttachmentNode,
  $createMentionNode,
  $isAttachmentNode,
  $isMentionNode,
  AttachmentNode,
  MentionNode,
} from './nodes';
import { detectComposerMentionTrigger, type ComposerMentionTrigger } from '../mentions/mentionTrigger';
import type { ComposerMentionItem } from '../mentions/mentionSearch';
import type { ComposerMentionSession } from '../mentions/mentionSession';

export function ComposerEditor({
  getResources,
  onEditor,
  onSnapshotChange,
  onMentionSessionChange,
  placeholder,
  readOnly,
}: {
  getResources: () => ReadonlyMap<string, ComposerAttachmentResource>;
  onEditor: (editor: LexicalEditor | null) => void;
  onMentionSessionChange: (session: ComposerMentionSession | null) => void;
  onSnapshotChange: (snapshot: ComposerSnapshot) => void;
  placeholder: string;
  readOnly: boolean;
}) {
  const initialConfig = useMemo(
    () => ({
      editable: !readOnly,
      namespace: 'RemuxCodexComposer',
      nodes: [MentionNode, AttachmentNode],
      onError(error: Error) {
        throw error;
      },
      theme: {},
    }),
    [],
  );

  return (
    <LexicalComposer initialConfig={initialConfig}>
      <div className="remux-composer-input-shell">
        <PlainTextPlugin
          contentEditable={
            <ContentEditable
              aria-label="Message Codex"
              autoCapitalize="sentences"
              autoComplete="off"
              autoCorrect="on"
              className="remux-composer-contenteditable"
              enterKeyHint="enter"
              spellCheck
            />
          }
          placeholder={<div className="remux-composer-placeholder">{placeholder}</div>}
          ErrorBoundary={LexicalErrorBoundary}
        />
      </div>
      <HistoryPlugin />
      <ComposerChangePlugin getResources={getResources} onSnapshotChange={onSnapshotChange} />
      <ComposerCommandsPlugin />
      <ComposerMentionPlugin onMentionSessionChange={onMentionSessionChange} />
      <ComposerEditorRefPlugin onEditor={onEditor} />
      <ComposerReadOnlyPlugin readOnly={readOnly} />
    </LexicalComposer>
  );
}

export function readComposerPlainText(editorState: EditorState) {
  return editorState.read(() => composerDocumentPlainText(readComposerDocument()));
}

export function clearComposerEditor(editor: LexicalEditor) {
  editor.update(() => {
    $addUpdateTag(SKIP_DOM_SELECTION_TAG);
    $addUpdateTag(SKIP_SELECTION_FOCUS_TAG);

    const root = $getRoot();
    root.clear();
    root.append($createParagraphNode());
  });
}

export function setComposerEditorDocument(editor: LexicalEditor, document: ComposerDocument) {
  editor.update(() => {
    const root = $getRoot();
    const paragraph = $createParagraphNode();

    root.clear();
    for (const part of document.parts) {
      switch (part.type) {
        case 'text':
          paragraph.append($createTextNode(part.text));
          break;
        case 'mention':
          paragraph.append($createMentionNode(part));
          break;
        case 'attachment':
          paragraph.append($createAttachmentNode(part));
          break;
      }
    }
    root.append(paragraph);
    root.selectEnd();
  });
}

export function focusComposerEditor(editor: LexicalEditor) {
  editor.focus(() => {
    editor.update(() => {
      $getRoot().selectEnd();
    });
  }, { defaultSelection: 'rootEnd' });
}

function ComposerChangePlugin({
  getResources,
  onSnapshotChange,
}: {
  getResources: () => ReadonlyMap<string, ComposerAttachmentResource>;
  onSnapshotChange: (snapshot: ComposerSnapshot) => void;
}) {
  const handleChange = useCallback(
    (editorState: EditorState) => {
      const snapshot = editorState.read(() => createComposerSnapshot(readComposerDocument(), getResources()));
      onSnapshotChange(snapshot);
    },
    [getResources, onSnapshotChange],
  );

  return <OnChangePlugin ignoreSelectionChange onChange={handleChange} />;
}

function ComposerCommandsPlugin() {
  const [editor] = useLexicalComposerContext();

  useEffect(
    () =>
      editor.registerCommand(
        KEY_ENTER_COMMAND,
        (event) => {
          event?.preventDefault();
          event?.stopPropagation();
          editor.dispatchCommand(INSERT_LINE_BREAK_COMMAND, false);
          return true;
        },
        COMMAND_PRIORITY_CRITICAL,
      ),
    [editor],
  );

  useEffect(
    () =>
      editor.registerCommand(
        INSERT_COMPOSER_ATTACHMENT_COMMAND,
        (payload) => {
          if (payload.preserveDomFocus) {
            $addUpdateTag(SKIP_DOM_SELECTION_TAG);
            $addUpdateTag(SKIP_SELECTION_FOCUS_TAG);
          }

          $insertNodes([
            $createAttachmentNode(payload),
            $createTextNode(' '),
          ]);
          return true;
        },
        COMMAND_PRIORITY_EDITOR,
      ),
    [editor],
  );

  useEffect(
    () =>
      editor.registerCommand(
        REMOVE_COMPOSER_ATTACHMENT_COMMAND,
        ({ id, preserveDomFocus }) => {
          if (preserveDomFocus) {
            $addUpdateTag(SKIP_DOM_SELECTION_TAG);
            $addUpdateTag(SKIP_SELECTION_FOCUS_TAG);
          }

          for (const node of $nodesOfType(AttachmentNode)) {
            if (node.getId() === id) {
              node.remove();
              return true;
            }
          }

          return false;
        },
        COMMAND_PRIORITY_EDITOR,
      ),
    [editor],
  );

  return null;
}

type ActiveMentionTrigger = ComposerMentionTrigger & {
  nodeKey: string;
};

function ComposerMentionPlugin({
  onMentionSessionChange,
}: {
  onMentionSessionChange: (session: ComposerMentionSession | null) => void;
}) {
  const [editor] = useLexicalComposerContext();
  const triggerRef = useRef<ActiveMentionTrigger | null>(null);
  const suppressedTriggerKeyRef = useRef<string | null>(null);
  const onMentionSessionChangeRef = useRef(onMentionSessionChange);

  useEffect(() => {
    onMentionSessionChangeRef.current = onMentionSessionChange;
  }, [onMentionSessionChange]);

  const closeMentionSession = useCallback(() => {
    const currentTrigger = triggerRef.current;
    if (currentTrigger) {
      suppressedTriggerKeyRef.current = mentionTriggerKey(currentTrigger);
    }
    onMentionSessionChangeRef.current(null);
  }, []);

  const removeMentionTrigger = useCallback(() => {
    const currentTrigger = triggerRef.current;

    if (!currentTrigger) {
      onMentionSessionChangeRef.current(null);
      return;
    }

    suppressedTriggerKeyRef.current = null;
    editor.update(() => {
      const node = $getNodeByKey(currentTrigger.nodeKey);

      if (!$isTextNode(node)) {
        return;
      }

      node.select(currentTrigger.startOffset, currentTrigger.endOffset);
      node.spliceText(currentTrigger.startOffset, currentTrigger.endOffset - currentTrigger.startOffset, '', true);
    });
    onMentionSessionChangeRef.current(null);
  }, [editor]);

  const selectMention = useCallback(
    (result: ComposerMentionItem) => {
      const currentTrigger = triggerRef.current;

      if (!currentTrigger) {
        return;
      }

      editor.update(() => {
        const node = $getNodeByKey(currentTrigger.nodeKey);

        if (!$isTextNode(node)) {
          return;
        }

        node.select(currentTrigger.startOffset, currentTrigger.endOffset);
        $insertNodes([
          $createMentionNode({
            id: createComposerNodeId(),
            kind: result.kind,
            name: result.name,
            path: result.path,
          }),
          $createTextNode(' '),
        ]);
      });
      suppressedTriggerKeyRef.current = null;
      closeMentionSession();
    },
    [closeMentionSession, editor],
  );

  const publishMentionSession = useCallback(
    (nextTrigger: ActiveMentionTrigger | null) => {
      triggerRef.current = nextTrigger;

      if (!nextTrigger) {
        suppressedTriggerKeyRef.current = null;
        onMentionSessionChangeRef.current(null);
        return;
      }

      const triggerKey = mentionTriggerKey(nextTrigger);
      if (suppressedTriggerKeyRef.current === triggerKey) {
        onMentionSessionChangeRef.current(null);
        return;
      }

      if (suppressedTriggerKeyRef.current && suppressedTriggerKeyRef.current !== triggerKey) {
        suppressedTriggerKeyRef.current = null;
      }

      onMentionSessionChangeRef.current({
        close: closeMentionSession,
        query: nextTrigger.query,
        removeTrigger: removeMentionTrigger,
        selectFile: selectMention,
      });
    },
    [closeMentionSession, removeMentionTrigger, selectMention],
  );

  useEffect(
    () =>
      editor.registerUpdateListener(({ editorState }) => {
        const nextTrigger = editorState.read(readActiveMentionTrigger);
        publishMentionSession(nextTrigger);
      }),
    [editor, publishMentionSession],
  );

  useEffect(() => {
    return () => onMentionSessionChangeRef.current(null);
  }, []);

  return null;
}

function readActiveMentionTrigger(): ActiveMentionTrigger | null {
  const selection = $getSelection();

  if (!$isRangeSelection(selection) || !selection.isCollapsed()) {
    return null;
  }

  const node = selection.anchor.getNode();

  if (!$isTextNode(node) || $isMentionNode(node) || $isAttachmentNode(node)) {
    return null;
  }

  const trigger = detectComposerMentionTrigger(node.getTextContent(), selection.anchor.offset);

  return trigger ? { ...trigger, nodeKey: node.getKey() } : null;
}

function mentionTriggerKey(trigger: ActiveMentionTrigger) {
  return `${trigger.nodeKey}:${trigger.startOffset}:${trigger.endOffset}:${trigger.query}`;
}

function ComposerEditorRefPlugin({ onEditor }: { onEditor: (editor: LexicalEditor | null) => void }) {
  const [editor] = useLexicalComposerContext();

  useEffect(() => {
    onEditor(editor);
    return () => onEditor(null);
  }, [editor, onEditor]);

  return null;
}

function ComposerReadOnlyPlugin({ readOnly }: { readOnly: boolean }) {
  const [editor] = useLexicalComposerContext();

  useEffect(() => {
    editor.setEditable(!readOnly);
  }, [editor, readOnly]);

  return null;
}

export function readComposerDocument(): ComposerDocument {
  const parts: ComposerDocument['parts'] = [];

  for (const child of $getRoot().getChildren()) {
    const nestedChildren = typeof (child as { getChildren?: unknown }).getChildren === 'function'
      ? (child as unknown as { getChildren: () => LexicalNode[] }).getChildren()
      : [child as LexicalNode];

    for (const node of nestedChildren) {
      if ($isAttachmentNode(node)) {
        parts.push({
          id: node.getId(),
          mimeType: node.getMimeType(),
          name: node.getName(),
          type: 'attachment',
        });
        continue;
      }

      if ($isMentionNode(node)) {
        parts.push({
          id: node.getId(),
          kind: node.getKind(),
          name: node.getName(),
          path: node.getPath(),
          type: 'mention',
        });
        continue;
      }

      if (typeof (node as { getTextContent?: unknown }).getTextContent === 'function') {
        parts.push({
          text: (node as { getTextContent: () => string }).getTextContent(),
          type: 'text',
        });
      }
    }
  }

  return { parts };
}

function createComposerNodeId() {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID();
  }

  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}
