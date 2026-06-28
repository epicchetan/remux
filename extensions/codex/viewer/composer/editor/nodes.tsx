import {
  $applyNodeReplacement,
  TextNode,
  type EditorConfig,
  type LexicalNode,
  type NodeKey,
  type SerializedTextNode,
} from 'lexical';

import { fileTypeIconDataUri } from '../../transcript/components/file/fileTypeIcons';

export type SerializedAttachmentNode = SerializedTextNode & {
  id: string;
  mimeType: string | null;
  name: string;
  type: 'remux-attachment';
};

export type SerializedMentionNode = SerializedTextNode & {
  id: string;
  kind?: 'directory' | 'file';
  name: string;
  path: string;
  type: 'remux-mention';
};

export class MentionNode extends TextNode {
  __id: string;
  __kind: 'directory' | 'file';
  __name: string;
  __path: string;

  static getType() {
    return 'remux-mention';
  }

  static clone(node: MentionNode) {
    return new MentionNode(node.__id, node.__name, node.__path, node.__kind, node.__key);
  }

  static importJSON(serializedNode: SerializedMentionNode) {
    return $createMentionNode({
      id: serializedNode.id,
      kind: serializedNode.kind ?? 'file',
      name: serializedNode.name,
      path: serializedNode.path,
    });
  }

  constructor(id: string, name: string, path: string, kind: 'directory' | 'file', key?: NodeKey) {
    super(compactComposerReferenceLabel(name), key);
    this.__id = id;
    this.__kind = kind;
    this.__name = name;
    this.__path = path;
  }

  createDOM(config: EditorConfig) {
    const element = super.createDOM(config);
    applyReferenceElement(element, {
      kind: 'mention',
      media: this.__kind === 'directory' ? 'folder' : 'file',
      name: this.__name,
      path: this.__path,
      title: this.__path,
    });
    return element;
  }

  updateDOM(prevNode: this, dom: HTMLElement, config: EditorConfig) {
    const didReplace = super.updateDOM(prevNode, dom, config);
    applyReferenceElement(dom, {
      kind: 'mention',
      media: this.__kind === 'directory' ? 'folder' : 'file',
      name: this.__name,
      path: this.__path,
      title: this.__path,
    });
    return didReplace;
  }

  exportJSON(): SerializedMentionNode {
    return {
      ...super.exportJSON(),
      id: this.__id,
      kind: this.__kind,
      name: this.__name,
      path: this.__path,
      type: 'remux-mention',
      version: 1,
    };
  }

  getId() {
    return this.__id;
  }

  getKind() {
    return this.__kind;
  }

  getName() {
    return this.__name;
  }

  getPath() {
    return this.__path;
  }

  canInsertTextBefore() {
    return false;
  }

  canInsertTextAfter() {
    return false;
  }

  isTextEntity() {
    return true;
  }
}

export class AttachmentNode extends TextNode {
  __id: string;
  __mimeType: string | null;
  __name: string;

  static getType() {
    return 'remux-attachment';
  }

  static clone(node: AttachmentNode) {
    return new AttachmentNode(node.__id, node.__name, node.__mimeType, node.__key);
  }

  static importJSON(serializedNode: SerializedAttachmentNode) {
    return $createAttachmentNode({
      id: serializedNode.id,
      mimeType: serializedNode.mimeType,
      name: serializedNode.name,
    });
  }

  constructor(id: string, name: string, mimeType: string | null, key?: NodeKey) {
    super(compactComposerReferenceLabel(name), key);
    this.__id = id;
    this.__name = name;
    this.__mimeType = mimeType;
  }

  createDOM(config: EditorConfig) {
    const element = super.createDOM(config);
    applyReferenceElement(element, {
      kind: 'attachment',
      media: this.__mimeType?.startsWith('image/') ? 'image' : 'file',
      name: this.__name,
      title: this.__mimeType ? `${this.__name} (${this.__mimeType})` : this.__name,
    });
    return element;
  }

  updateDOM(prevNode: this, dom: HTMLElement, config: EditorConfig) {
    const didReplace = super.updateDOM(prevNode, dom, config);
    applyReferenceElement(dom, {
      kind: 'attachment',
      media: this.__mimeType?.startsWith('image/') ? 'image' : 'file',
      name: this.__name,
      title: this.__mimeType ? `${this.__name} (${this.__mimeType})` : this.__name,
    });
    return didReplace;
  }

  exportJSON(): SerializedAttachmentNode {
    return {
      ...super.exportJSON(),
      id: this.__id,
      mimeType: this.__mimeType,
      name: this.__name,
      type: 'remux-attachment',
      version: 1,
    };
  }

  getId() {
    return this.__id;
  }

  getMimeType() {
    return this.__mimeType;
  }

  getName() {
    return this.__name;
  }

  canInsertTextBefore() {
    return false;
  }

  canInsertTextAfter() {
    return false;
  }

  isTextEntity() {
    return true;
  }
}

export function $createAttachmentNode({
  id,
  mimeType,
  name,
}: {
  id: string;
  mimeType: string | null;
  name: string;
}) {
  return $applyNodeReplacement(new AttachmentNode(id, name, mimeType).setMode('token').toggleDirectionless());
}

export function $createMentionNode({
  id,
  kind,
  name,
  path,
}: {
  id: string;
  kind: 'directory' | 'file';
  name: string;
  path: string;
}) {
  return $applyNodeReplacement(new MentionNode(id, name, path, kind).setMode('token').toggleDirectionless());
}

export function $isAttachmentNode(node: LexicalNode | null | undefined): node is AttachmentNode {
  return node instanceof AttachmentNode;
}

export function $isMentionNode(node: LexicalNode | null | undefined): node is MentionNode {
  return node instanceof MentionNode;
}

function applyReferenceElement(
  element: HTMLElement,
  reference: {
    kind: 'attachment' | 'mention';
    media?: 'file' | 'folder' | 'image';
    name: string;
    path?: string;
    title: string;
  },
) {
  element.classList.add('remux-composer-token-chip', `remux-composer-${reference.kind}-chip`);
  element.dataset.fullName = reference.name;
  element.dataset.label = reference.name;
  element.dataset.path = reference.path ?? '';
  element.dataset.referenceKind = reference.kind;
  element.dataset.referenceMedia = reference.media ?? 'file';
  element.spellcheck = false;
  element.setAttribute('spellcheck', 'false');

  const icon = reference.media === 'folder'
    ? folderIconDataUri()
    : fileTypeIconDataUri({
        extension: fileExtensionFromName(reference.name),
        fileName: reference.name,
      });

  if (icon) {
    element.style.setProperty('--remux-composer-token-icon', icon);
  } else {
    element.style.removeProperty('--remux-composer-token-icon');
  }

  element.title = reference.title;
}

function folderIconDataUri() {
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="#a8b0bf" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M3.75 6.75A2.25 2.25 0 0 1 6 4.5h4.1c.55 0 1.06.25 1.4.68l1.03 1.32H18A2.25 2.25 0 0 1 20.25 8.75v8.5A2.25 2.25 0 0 1 18 19.5H6a2.25 2.25 0 0 1-2.25-2.25V6.75Z"/></svg>';
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
}

function compactComposerReferenceLabel(name: string) {
  const trimmed = name.trim();
  if (trimmed.length <= 28) {
    return trimmed;
  }

  return `${trimmed.slice(0, 18)}…${trimmed.slice(-7)}`;
}

function fileExtensionFromName(fileName: string) {
  const normalized = fileName.toLowerCase();
  const dotIndex = normalized.lastIndexOf('.');

  if (dotIndex <= 0 || dotIndex === normalized.length - 1) {
    return null;
  }

  return normalized.slice(dotIndex + 1);
}
