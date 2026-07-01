import { css } from '@codemirror/lang-css';
import { html } from '@codemirror/lang-html';
import { javascript } from '@codemirror/lang-javascript';
import { json } from '@codemirror/lang-json';
import { markdown } from '@codemirror/lang-markdown';
import { python } from '@codemirror/lang-python';
import {
  getHostTheme,
  subscribeHostTheme,
  type RemuxHostTheme,
} from '@remux/viewer-kit/host';
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { Chunk, unifiedMergeView } from '@codemirror/merge';
import {
  Compartment,
  EditorState,
  RangeSetBuilder,
  Text,
  type Extension,
} from '@codemirror/state';
import {
  EditorView,
  GutterMarker,
  lineNumberMarkers,
  lineNumbers,
} from '@codemirror/view';
import { tags } from '@lezer/highlight';
import { minimalSetup } from 'codemirror';
import { useEffect, useMemo, useRef } from 'react';

type CodeMirrorViewerProps = {
  baseContent?: string | null;
  content: string;
  fileName: string;
  focusLine?: number | null;
  showDiff?: boolean;
};

type LineMarkerType = 'added' | 'deleted';

const codeMirrorDiffConfig = {
  scanLimit: 1000,
  timeout: 500,
} as const;

const remuxCodeMirrorThemeDark = EditorView.theme({}, { dark: true });
const remuxCodeMirrorThemeLight = EditorView.theme({}, { dark: false });

const remuxHighlightStyle = HighlightStyle.define([
  { tag: tags.comment, color: 'var(--remux-editor-syntax-comment)', fontStyle: 'italic' },
  { tag: tags.keyword, color: 'var(--remux-editor-syntax-keyword)' },
  { tag: [tags.atom, tags.bool, tags.null], color: 'var(--remux-editor-syntax-atom)' },
  { tag: [tags.number, tags.integer, tags.float], color: 'var(--remux-editor-syntax-number)' },
  { tag: [tags.string, tags.special(tags.string)], color: 'var(--remux-editor-syntax-string)' },
  { tag: tags.regexp, color: 'var(--remux-editor-syntax-regexp)' },
  { tag: [tags.name, tags.variableName], color: 'var(--remux-editor-syntax-name)' },
  { tag: [tags.definition(tags.variableName), tags.function(tags.variableName)], color: 'var(--remux-editor-syntax-function)' },
  { tag: [tags.typeName, tags.className], color: 'var(--remux-editor-syntax-type)' },
  { tag: [tags.propertyName, tags.attributeName], color: 'var(--remux-editor-syntax-property)' },
  { tag: tags.operator, color: 'var(--remux-editor-syntax-operator)' },
  { tag: [tags.tagName, tags.heading], color: 'var(--remux-editor-syntax-tag)' },
  { tag: tags.link, color: 'var(--remux-editor-syntax-link)' },
  { tag: tags.emphasis, fontStyle: 'italic' },
  { tag: tags.strong, fontWeight: '700' },
]);

export function CodeMirrorViewer({
  baseContent = null,
  content,
  fileName,
  focusLine = null,
  showDiff = false,
}: CodeMirrorViewerProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const lineNumbersCompartmentRef = useRef(new Compartment());
  const mergeCompartmentRef = useRef(new Compartment());
  const themeCompartmentRef = useRef(new Compartment());
  const viewRef = useRef<EditorView | null>(null);
  const language = useMemo(() => languageForFileName(fileName), [fileName]);
  const mergeEnabled = showDiff && baseContent != null;
  const lineNumbersExtension = useMemo(
    () => remuxLineNumbers(markersFromMergeContent(baseContent, content)),
    [baseContent, content],
  );
  const mergeExtension = useMemo(
    () => mergeEnabled
      ? unifiedMergeView({
          allowInlineDiffs: true,
          diffConfig: codeMirrorDiffConfig,
          gutter: false,
          mergeControls: false,
          original: baseContent,
          syntaxHighlightDeletions: true,
        })
      : [],
    [baseContent, mergeEnabled],
  );

  useEffect(() => {
    const parent = containerRef.current;
    if (!parent) {
      return undefined;
    }

    const state = EditorState.create({
      doc: content,
      extensions: [
        lineNumbersCompartmentRef.current.of(lineNumbersExtension),
        minimalSetup,
        EditorState.readOnly.of(true),
        EditorView.editable.of(false),
        themeCompartmentRef.current.of(codeMirrorThemeExtension(getHostTheme())),
        syntaxHighlighting(remuxHighlightStyle),
        mergeCompartmentRef.current.of(mergeExtension),
        language,
      ].filter(Boolean) as Extension[],
    });

    const view = new EditorView({
      parent,
      state,
    });
    viewRef.current = view;

    return () => {
      viewRef.current = null;
      view.destroy();
    };
  }, [content, language]);

  useEffect(() => subscribeHostTheme((theme) => {
    viewRef.current?.dispatch({
      effects: themeCompartmentRef.current.reconfigure(codeMirrorThemeExtension(theme)),
    });
  }), []);

  useEffect(() => {
    viewRef.current?.dispatch({
      effects: [
        lineNumbersCompartmentRef.current.reconfigure(lineNumbersExtension),
        mergeCompartmentRef.current.reconfigure(mergeExtension),
      ],
    });
  }, [lineNumbersExtension, mergeExtension]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view || !focusLine) {
      return;
    }

    const line = Math.min(Math.max(1, focusLine), view.state.doc.lines);
    const position = view.state.doc.line(line).from;
    view.dispatch({
      effects: EditorView.scrollIntoView(position, { y: 'center' }),
      selection: { anchor: position },
    });
  }, [content, focusLine]);

  return <div className="remux-editor-codemirror" ref={containerRef} />;
}

function codeMirrorThemeExtension(theme: RemuxHostTheme) {
  return theme === 'light' ? remuxCodeMirrorThemeLight : remuxCodeMirrorThemeDark;
}

class RemuxLineNumberMarker extends GutterMarker {
  override elementClass: string;

  constructor(private readonly type: LineMarkerType) {
    super();
    this.elementClass = `cm-remux-line-number-cell cm-remux-line-number-cell-${type}`;
  }

  override eq(other: RemuxLineNumberMarker) {
    return this.type === other.type;
  }
}

function remuxLineNumbers(markerByLine: Map<number, LineMarkerType>): Extension {
  return [
    lineNumbers(),
    lineNumberMarkers.compute(['doc'], (state) => {
      const builder = new RangeSetBuilder<GutterMarker>();
      const markers = Array.from(markerByLine).sort(([left], [right]) => left - right);
      for (const [lineNumber, type] of markers) {
        if (lineNumber < 1 || lineNumber > state.doc.lines) {
          continue;
        }
        const line = state.doc.line(lineNumber);
        builder.add(line.from, line.from, new RemuxLineNumberMarker(type));
      }
      return builder.finish();
    }),
  ];
}

function markersFromMergeContent(baseContent: string | null, content: string) {
  const markerByLine = new Map<number, LineMarkerType>();
  if (baseContent == null) {
    return markerByLine;
  }

  const baseDocument = Text.of(baseContent.split('\n'));
  const currentDocument = Text.of(content.split('\n'));
  for (const chunk of Chunk.build(baseDocument, currentDocument, codeMirrorDiffConfig)) {
    if (chunk.fromB === chunk.toB) {
      setLineMarker(markerByLine, deletionAnchorLine(currentDocument, chunk.fromB), 'deleted');
      continue;
    }

    const fromLine = lineAtPosition(currentDocument, chunk.fromB);
    const toLine = lineBeforePosition(currentDocument, chunk.endB);
    for (let lineNumber = fromLine; lineNumber <= toLine; lineNumber += 1) {
      setLineMarker(markerByLine, lineNumber, 'added');
    }
  }

  return markerByLine;
}

function deletionAnchorLine(document: Text, position: number) {
  if (document.lines <= 1) {
    return 1;
  }

  return document.lineAt(clampDocumentPosition(document, position)).number;
}

function lineAtPosition(document: Text, position: number) {
  return document.lineAt(clampDocumentPosition(document, position)).number;
}

function lineBeforePosition(document: Text, position: number) {
  return document.lineAt(clampDocumentPosition(document, Math.max(0, position - 1))).number;
}

function clampDocumentPosition(document: Text, position: number) {
  return Math.max(0, Math.min(position, document.length));
}

function setLineMarker(
  markerByLine: Map<number, LineMarkerType>,
  lineNumber: number,
  type: LineMarkerType,
) {
  const previous = markerByLine.get(lineNumber);
  if (!previous || lineMarkerRank(type) < lineMarkerRank(previous)) {
    markerByLine.set(lineNumber, type);
  }
}

function lineMarkerRank(type: LineMarkerType) {
  switch (type) {
    case 'deleted':
      return 0;
    case 'added':
      return 1;
    default:
      return 2;
  }
}

function languageForFileName(fileName: string): Extension | null {
  const extension = fileNameExtension(fileName);

  switch (extension) {
    case 'cjs':
    case 'js':
    case 'mjs':
      return javascript();
    case 'jsx':
      return javascript({ jsx: true });
    case 'ts':
      return javascript({ typescript: true });
    case 'tsx':
      return javascript({ jsx: true, typescript: true });
    case 'json':
    case 'jsonc':
    case 'jsonl':
      return json();
    case 'css':
    case 'scss':
    case 'sass':
    case 'less':
      return css();
    case 'htm':
    case 'html':
    case 'svg':
    case 'xml':
      return html();
    case 'md':
    case 'mdx':
    case 'markdown':
      return markdown();
    case 'py':
    case 'pyw':
      return python();
    default:
      return null;
  }
}

function fileNameExtension(fileName: string) {
  const extension = fileName.split('.').at(-1);
  if (!extension || extension === fileName) {
    return '';
  }

  return extension.toLowerCase();
}
