import { css } from '@codemirror/lang-css';
import { html } from '@codemirror/lang-html';
import { javascript } from '@codemirror/lang-javascript';
import { json } from '@codemirror/lang-json';
import { markdown } from '@codemirror/lang-markdown';
import { python } from '@codemirror/lang-python';
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
  showDiff?: boolean;
};

type LineMarkerType = 'added' | 'deleted';

const codeMirrorDiffConfig = {
  scanLimit: 1000,
  timeout: 500,
} as const;

const remuxCodeMirrorTheme = EditorView.theme({}, { dark: true });

const remuxHighlightStyle = HighlightStyle.define([
  { tag: tags.comment, color: '#71717a', fontStyle: 'italic' },
  { tag: tags.keyword, color: '#c084fc' },
  { tag: [tags.atom, tags.bool, tags.null], color: '#f97316' },
  { tag: [tags.number, tags.integer, tags.float], color: '#f59e0b' },
  { tag: [tags.string, tags.special(tags.string)], color: '#86efac' },
  { tag: tags.regexp, color: '#fca5a5' },
  { tag: [tags.name, tags.variableName], color: '#e4e4e7' },
  { tag: [tags.definition(tags.variableName), tags.function(tags.variableName)], color: '#7dd3fc' },
  { tag: [tags.typeName, tags.className], color: '#fbbf24' },
  { tag: [tags.propertyName, tags.attributeName], color: '#93c5fd' },
  { tag: tags.operator, color: '#a1a1aa' },
  { tag: [tags.tagName, tags.heading], color: '#fb7185' },
  { tag: tags.link, color: '#60a5fa' },
  { tag: tags.emphasis, fontStyle: 'italic' },
  { tag: tags.strong, fontWeight: '700' },
]);

export function CodeMirrorViewer({
  baseContent = null,
  content,
  fileName,
  showDiff = false,
}: CodeMirrorViewerProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const lineNumbersCompartmentRef = useRef(new Compartment());
  const mergeCompartmentRef = useRef(new Compartment());
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
        remuxCodeMirrorTheme,
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

  useEffect(() => {
    viewRef.current?.dispatch({
      effects: [
        lineNumbersCompartmentRef.current.reconfigure(lineNumbersExtension),
        mergeCompartmentRef.current.reconfigure(mergeExtension),
      ],
    });
  }, [lineNumbersExtension, mergeExtension]);

  return <div className="remux-editor-codemirror" ref={containerRef} />;
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
