const textEncoder = new TextEncoder();

export const terminalModifierAutoClearMs = 3000;

export const terminalKeySequences = {
  enter: '\r',
  escape: '\x1b',
  shiftEnter: '\x1b[13;2u',
  shiftTab: '\x1b[Z',
  tab: '\t',
} as const;

export type TerminalArrowCode = 'A' | 'B' | 'C' | 'D';

export type TerminalKeyModifiers = {
  alt: boolean;
  ctrl: boolean;
  shift?: boolean;
};

export type TerminalKeyboardEvent = {
  key: string;
};

export function terminalControlCBytes() {
  return new Uint8Array([3]);
}

export function encodeTerminalArrow(
  code: TerminalArrowCode,
  modifiers: TerminalKeyModifiers = { alt: false, ctrl: false },
) {
  const modifier = terminalModifierParam(modifiers);
  if (modifier !== null) {
    return textEncoder.encode(`\x1b[1;${modifier}${code}`);
  }

  return textEncoder.encode(`\x1b[${code}`);
}

export function encodeTerminalEnter(modifiers: TerminalKeyModifiers = { alt: false, ctrl: false }) {
  const modifier = terminalModifierParam(modifiers);
  if (modifier !== null) {
    return textEncoder.encode(`\x1b[13;${modifier}u`);
  }

  return textEncoder.encode(terminalKeySequences.enter);
}

export function encodeTerminalTab(modifiers: TerminalKeyModifiers = { alt: false, ctrl: false }) {
  if (modifiers.shift) {
    return textEncoder.encode(terminalKeySequences.shiftTab);
  }

  return textEncoder.encode(terminalKeySequences.tab);
}

export function encodeModifiedKey(
  event: TerminalKeyboardEvent,
  modifiers: TerminalKeyModifiers,
) {
  if (isModifierKey(event.key)) {
    return null;
  }

  const bytes: number[] = [];

  if (isArrowKey(event.key)) {
    return encodeTerminalArrow(arrowCode(event.key), modifiers);
  }

  if (event.key === 'Enter') {
    return encodeTerminalEnter(modifiers);
  }

  if (event.key === 'Tab') {
    return encodeTerminalTab(modifiers);
  }

  if (modifiers.ctrl) {
    const byte = ctrlByte(event.key);
    if (byte !== null) {
      if (modifiers.alt) {
        bytes.push(0x1b);
      }
      bytes.push(byte);
      return new Uint8Array(bytes);
    }
  }

  if (modifiers.alt && event.key.length === 1) {
    bytes.push(0x1b, ...textEncoder.encode(event.key));
    return new Uint8Array(bytes);
  }

  return null;
}

export function ctrlByte(key: string) {
  const code = key.toLowerCase().charCodeAt(0);
  if (code >= 97 && code <= 122) {
    return code - 96;
  }

  if (key === '[') {
    return 27;
  }

  if (key === '\\') {
    return 28;
  }

  if (key === ']') {
    return 29;
  }

  return null;
}

export function isModifierKey(key: string) {
  return key === 'Alt' || key === 'Control' || key === 'Meta' || key === 'Shift';
}

function isArrowKey(key: string) {
  return key === 'ArrowUp' || key === 'ArrowDown' || key === 'ArrowRight' || key === 'ArrowLeft';
}

function arrowCode(key: string): TerminalArrowCode {
  switch (key) {
    case 'ArrowUp':
      return 'A';
    case 'ArrowDown':
      return 'B';
    case 'ArrowRight':
      return 'C';
    case 'ArrowLeft':
    default:
      return 'D';
  }
}

function terminalModifierParam(modifiers: TerminalKeyModifiers) {
  const modifier = (modifiers.shift ? 1 : 0) + (modifiers.alt ? 2 : 0) + (modifiers.ctrl ? 4 : 0);
  return modifier > 0 ? modifier + 1 : null;
}
