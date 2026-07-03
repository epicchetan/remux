// OSC 52 is how TUI apps (Claude Code, neovim, tmux with set-clipboard) copy
// to the system clipboard: `ESC ] 52 ; Pc ; Pd BEL`, where Pc names the target
// selection(s) and Pd is the base64-encoded text.

const textDecoder = new TextDecoder();

/**
 * Extracts the text an OSC 52 sequence asks to place on the clipboard. The
 * handler receives everything after `52;`, i.e. `Pc;Pd`. Returns null for
 * read queries (`?`), clears, and malformed payloads — callers should leave
 * the clipboard untouched for those.
 */
export function parseOsc52ClipboardText(data: string): string | null {
  const separator = data.indexOf(';');
  if (separator === -1) {
    return null;
  }

  // Some emitters chunk long payloads with whitespace; base64 ignores it.
  const payload = data.slice(separator + 1).replace(/\s+/g, '');
  if (!payload || payload === '?') {
    return null;
  }

  let binary: string;
  try {
    binary = atob(payload);
  } catch {
    return null;
  }

  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }

  return textDecoder.decode(bytes);
}
