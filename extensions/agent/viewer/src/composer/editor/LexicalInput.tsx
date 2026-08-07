import { useCallback, useEffect, useRef } from 'react';
import type { LexicalEditor } from 'lexical';

import { createComposerNodeId, createComposerSnapshot, createTextComposerDocument } from '../model/composerModel.ts';
import { useComposerStore } from '../store.ts';
import {
  clearComposerEditor,
  ComposerEditor,
  focusComposerEditor,
  setComposerEditorText,
} from './ComposerEditor.tsx';

export function ComposerLexicalInput({ readOnly }: { readOnly: boolean }) {
  const setEditorController = useComposerStore((state) => state.setEditorController);
  const setSnapshot = useComposerStore((state) => state.setSnapshot);
  const editorRef = useRef<LexicalEditor | null>(null);
  const textPartIdRef = useRef(createComposerNodeId());

  const clear = useCallback(() => {
    textPartIdRef.current = createComposerNodeId();
    if (editorRef.current) clearComposerEditor(editorRef.current);
    setSnapshot(createComposerSnapshot({ parts: [] }));
  }, [setSnapshot]);

  const setDocument = useCallback((document: Parameters<typeof createComposerSnapshot>[0]) => {
    textPartIdRef.current = document.parts[0]?.id ?? createComposerNodeId();
    const text = document.parts.map((part) => part.text).join('');
    if (editorRef.current) setComposerEditorText(editorRef.current, text);
    setSnapshot(createComposerSnapshot(createTextComposerDocument(text, textPartIdRef.current)));
  }, [setSnapshot]);

  useEffect(() => {
    setEditorController({
      blur: () => editorRef.current?.blur(),
      clear,
      focus: () => {
        if (editorRef.current?.isEditable()) focusComposerEditor(editorRef.current);
      },
      setDocument,
    });
    return () => setEditorController(null);
  }, [clear, setDocument, setEditorController]);

  return (
    <div className="remux-composer-editor">
      <ComposerEditor
        onEditor={(editor) => {
          editorRef.current = editor;
        }}
        onTextChange={(text) => {
          setSnapshot(createComposerSnapshot(createTextComposerDocument(text, textPartIdRef.current)));
        }}
        placeholder="Message Agent"
        readOnly={readOnly}
      />
    </div>
  );
}
