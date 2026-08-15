import { existsSync, readFileSync } from 'node:fs';

export const REMUX_SYSTEM_PROMPT = readPrompt('system.md');

function readPrompt(fileName: string) {
  const candidates = [
    new URL(`../prompts/${fileName}`, import.meta.url),
    // Vite emits this module under dist/assets/ and copies public prompt files
    // to dist/. Keep the production layout explicit and inspectable.
    new URL(`../${fileName}`, import.meta.url),
    new URL(`./${fileName}`, import.meta.url),
  ];
  const path = candidates.find((candidate) => existsSync(candidate));
  if (!path) throw new Error(`Remux Agent prompt file is missing: ${fileName}`);
  const prompt = readFileSync(path, 'utf8').trim();
  if (!prompt) throw new Error(`Remux Agent prompt file is empty: ${fileName}`);
  return prompt;
}
