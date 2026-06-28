import { expect, test } from '@playwright/test';

import {
  ctrlByte,
  encodeModifiedKey,
  encodeTerminalArrow,
  encodeTerminalEnter,
  encodeTerminalTab,
  terminalControlCBytes,
  terminalKeySequences,
  terminalModifierAutoClearMs,
} from '../viewer/src/terminal/keyEncoding';

const textEncoder = new TextEncoder();

test.describe('terminal key encoding', () => {
  test('encodes direct action keys', () => {
    expect(textBytes(terminalKeySequences.escape)).toEqual([27]);
    expect(textBytes(terminalKeySequences.tab)).toEqual([9]);
    expect(textBytes(terminalKeySequences.enter)).toEqual([13]);
    expect(textBytes(terminalKeySequences.shiftEnter)).toEqual(bytes('\x1b[13;2u'));
    expect(textBytes(terminalKeySequences.shiftTab)).toEqual(bytes('\x1b[Z'));
    expect([...terminalControlCBytes()]).toEqual([3]);
  });

  test('encodes arrows with terminal modifiers', () => {
    expect([...encodeTerminalArrow('A')]).toEqual(bytes('\x1b[A'));
    expect([...encodeTerminalArrow('B')]).toEqual(bytes('\x1b[B'));
    expect([...encodeTerminalArrow('C')]).toEqual(bytes('\x1b[C'));
    expect([...encodeTerminalArrow('D')]).toEqual(bytes('\x1b[D'));
    expect([...encodeTerminalArrow('A', { alt: true, ctrl: false })]).toEqual(bytes('\x1b[1;3A'));
    expect([...encodeTerminalArrow('A', { alt: false, ctrl: true })]).toEqual(bytes('\x1b[1;5A'));
    expect([...encodeTerminalArrow('A', { alt: true, ctrl: true })]).toEqual(bytes('\x1b[1;7A'));
    expect([...encodeTerminalArrow('A', { alt: false, ctrl: false, shift: true })]).toEqual(bytes('\x1b[1;2A'));
    expect([...encodeTerminalArrow('A', { alt: true, ctrl: true, shift: true })]).toEqual(bytes('\x1b[1;8A'));
  });

  test('encodes Enter and Tab with terminal modifiers', () => {
    expect([...encodeTerminalEnter()]).toEqual([13]);
    expect([...encodeTerminalEnter({ alt: false, ctrl: false, shift: true })]).toEqual(bytes('\x1b[13;2u'));
    expect([...encodeTerminalEnter({ alt: true, ctrl: true, shift: true })]).toEqual(bytes('\x1b[13;8u'));
    expect([...encodeTerminalTab()]).toEqual([9]);
    expect([...encodeTerminalTab({ alt: false, ctrl: false, shift: true })]).toEqual(bytes('\x1b[Z'));
  });

  test('encodes control characters', () => {
    expect(ctrlByte('a')).toBe(1);
    expect(ctrlByte('A')).toBe(1);
    expect(ctrlByte('z')).toBe(26);
    expect(ctrlByte('[')).toBe(27);
    expect(ctrlByte('\\')).toBe(28);
    expect(ctrlByte(']')).toBe(29);
    expect(ctrlByte('1')).toBeNull();
  });

  test('encodes sticky modifier hardware keys', () => {
    expect(encodedKey('c', { alt: false, ctrl: true })).toEqual([3]);
    expect(encodedKey('[', { alt: false, ctrl: true })).toEqual([27]);
    expect(encodedKey('x', { alt: true, ctrl: false })).toEqual(bytes('\x1bx'));
    expect(encodedKey('x', { alt: true, ctrl: true })).toEqual([27, 24]);
    expect(encodedKey('Enter', { alt: false, ctrl: false, shift: true })).toEqual(bytes('\x1b[13;2u'));
    expect(encodedKey('Tab', { alt: false, ctrl: false, shift: true })).toEqual(bytes('\x1b[Z'));
    expect(encodedKey('ArrowLeft', { alt: false, ctrl: true })).toEqual(bytes('\x1b[1;5D'));
    expect(encodedKey('ArrowLeft', { alt: false, ctrl: false, shift: true })).toEqual(bytes('\x1b[1;2D'));
    expect(encodedKey('ArrowRight', { alt: true, ctrl: true })).toEqual(bytes('\x1b[1;7C'));
    expect(encodeModifiedKey({ key: 'Shift' }, { alt: true, ctrl: true })).toBeNull();
  });

  test('keeps sticky modifier timeout explicit', () => {
    expect(terminalModifierAutoClearMs).toBe(3000);
  });
});

function encodedKey(key: string, modifiers: { alt: boolean; ctrl: boolean; shift?: boolean }) {
  const encoded = encodeModifiedKey({ key }, modifiers);
  return encoded ? [...encoded] : null;
}

function textBytes(value: string) {
  return [...textEncoder.encode(value)];
}

function bytes(value: string) {
  return [...textEncoder.encode(value)];
}
