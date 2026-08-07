import { useCallback, useEffect, useMemo } from 'react';
import { LexicalComposer } from '@lexical/react/LexicalComposer';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import { ContentEditable } from '@lexical/react/LexicalContentEditable';
import { LexicalErrorBoundary } from '@lexical/react/LexicalErrorBoundary';
import { HistoryPlugin } from '@lexical/react/LexicalHistoryPlugin';
import { OnChangePlugin } from '@lexical/react/LexicalOnChangePlugin';
import { PlainTextPlugin } from '@lexical/react/LexicalPlainTextPlugin';
import {
  $addUpdateTag,
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  COMMAND_PRIORITY_CRITICAL,
  INSERT_LINE_BREAK_COMMAND,
  KEY_ENTER_COMMAND,
  SKIP_DOM_SELECTION_TAG,
  SKIP_SELECTION_FOCUS_TAG,
  type EditorState,
  type LexicalEditor,
} from 'lexical';

export function ComposerEditor({
  onEditor,
  onTextChange,
  placeholder,
  readOnly,
}: {
  onEditor: (editor: LexicalEditor | null) => void;
  onTextChange: (text: string) => void;
  placeholder: string;
  readOnly: boolean;
}) {
  const initialConfig = useMemo(() => ({
    editable: !readOnly,
    namespace: 'RemuxAgentComposer',
    onError(error: Error) {
      throw error;
    },
    theme: {},
  }), []);

  return (
    <LexicalComposer initialConfig={initialConfig}>
      <div className="remux-composer-input-shell">
        <PlainTextPlugin
          contentEditable={(
            <ContentEditable
              aria-label="Message"
              autoCapitalize="sentences"
              autoComplete="off"
              autoCorrect="on"
              className="remux-composer-contenteditable"
              enterKeyHint="enter"
              spellCheck
            />
          )}
          placeholder={<div className="remux-composer-placeholder">{placeholder}</div>}
          ErrorBoundary={LexicalErrorBoundary}
        />
      </div>
      <HistoryPlugin />
      <OnChangePlugin
        ignoreSelectionChange
        onChange={useCallback((state: EditorState) => {
          onTextChange(state.read(() => $getRoot().getTextContent()));
        }, [onTextChange])}
      />
      <MultilineEnterPlugin />
      <EditorRefPlugin onEditor={onEditor} />
      <ReadOnlyPlugin readOnly={readOnly} />
    </LexicalComposer>
  );
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

export function setComposerEditorText(editor: LexicalEditor, text: string) {
  editor.update(() => {
    const root = $getRoot();
    const paragraph = $createParagraphNode();
    if (text) paragraph.append($createTextNode(text));
    root.clear();
    root.append(paragraph);
    root.selectEnd();
  });
}

export function focusComposerEditor(editor: LexicalEditor) {
  editor.focus(() => {
    editor.update(() => $getRoot().selectEnd());
  }, { defaultSelection: 'rootEnd' });
}

function MultilineEnterPlugin() {
  const [editor] = useLexicalComposerContext();
  useEffect(() => editor.registerCommand(
    KEY_ENTER_COMMAND,
    (event) => {
      event?.preventDefault();
      event?.stopPropagation();
      editor.dispatchCommand(INSERT_LINE_BREAK_COMMAND, false);
      return true;
    },
    COMMAND_PRIORITY_CRITICAL,
  ), [editor]);
  return null;
}

function EditorRefPlugin({ onEditor }: { onEditor: (editor: LexicalEditor | null) => void }) {
  const [editor] = useLexicalComposerContext();
  useEffect(() => {
    onEditor(editor);
    return () => onEditor(null);
  }, [editor, onEditor]);
  return null;
}

function ReadOnlyPlugin({ readOnly }: { readOnly: boolean }) {
  const [editor] = useLexicalComposerContext();
  useEffect(() => editor.setEditable(!readOnly), [editor, readOnly]);
  return null;
}
