import { existsSync, readFileSync } from 'node:fs';

import type { WorkUnitResourceView } from './engine.ts';

export const REMUX_SYSTEM_PROMPT = readPrompt('system.md');
const WORK_UNIT_PROMPT = readPrompt('work-unit.md');

export function renderWorkUnitPrompt(input: {
  objective: string;
  doneWhen: readonly string[];
  resources: readonly MaterializedPromptResource[];
}) {
  const completionSection = input.doneWhen.length > 0
    ? [
        '## Done when',
        '',
        ...input.doneWhen.map((criterion) => `- ${criterion}`),
      ].join('\n')
    : '';
  return renderTemplate(WORK_UNIT_PROMPT, {
    objective: input.objective,
    completion_section: completionSection,
    resource_section: renderMaterializedResourceSection('Resources in context', input.resources),
  });
}

export type MaterializedPromptResource = WorkUnitResourceView & { content: string };

export function renderMaterializedResourceSection(
  heading: string,
  resources: readonly MaterializedPromptResource[],
) {
  if (resources.length === 0) return '';
  const sections = [`## ${heading}`];
  for (const resource of resources) {
    const description = resource.description ? ` — ${resource.description}` : '';
    sections.push(
      '',
      `### ${resource.role}: \`${escapeBackticks(resource.ref)}\`${description}`,
      '',
      `- Snapshot: \`${escapeBackticks(resource.snapshot.ref)}\``,
      `- SHA-256: \`${resource.snapshot.hash}\``,
      `- Bytes: ${resource.snapshot.byteLength}`,
      `- Source: ${resource.snapshot.source}`,
    );
    if (resource.inclusion === 'inherited') {
      sections.push(
        '- Context: the exact snapshot is already materialized earlier in the active parent context.',
        '- Freshness: re-read the source ref only if later work may have changed it.',
      );
      continue;
    }
    sections.push(
      '- Context: exact snapshot captured for this boundary and materialized below.',
      '- Freshness: this is exact at capture time; re-read a file source if later work may have changed it.',
      '',
      markdownFence(resource.content),
    );
  }
  return sections.join('\n');
}

function markdownFence(content: string) {
  const longest = Math.max(0, ...[...content.matchAll(/~+/gu)].map(([match]) => match.length));
  const fence = '~'.repeat(Math.max(3, longest + 1));
  return `${fence}text\n${content}\n${fence}`;
}

function escapeBackticks(value: string) {
  return value.replaceAll('`', '\\`');
}

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

function renderTemplate(template: string, values: Record<string, string>) {
  const rendered = template.replace(/\{\{([a-z_]+)\}\}/gu, (_match, key: string) => {
    if (!(key in values)) throw new Error(`Unknown Remux Agent prompt placeholder: ${key}`);
    return values[key]!;
  });
  if (/\{\{[^}]+\}\}/u.test(rendered)) {
    throw new Error('A Remux Agent prompt placeholder was not resolved.');
  }
  return rendered.replace(/\n{3,}/gu, '\n\n').trim();
}
