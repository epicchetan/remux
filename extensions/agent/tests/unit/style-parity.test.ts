import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from '@playwright/test';
import postcss, { type AtRule, type Node, type Rule } from 'postcss';

const repositoryRoot = new URL('../../../../', import.meta.url);
const codexAppCss = readFileSync(new URL('extensions/codex/viewer/app.css', repositoryRoot), 'utf8');
const agentAppCss = readFileSync(new URL('extensions/agent/viewer/app.css', repositoryRoot), 'utf8');
const codexStyles = readFileSync(new URL('extensions/codex/viewer/styles.css', repositoryRoot), 'utf8');
const agentStyles = readFileSync(new URL('extensions/agent/viewer/src/styles.css', repositoryRoot), 'utf8');

test('keeps the Agent base theme identical to Codex apart from its source root', () => {
  assert.equal(agentAppCss.replace('@source "./src/**/*.{ts,tsx}";', '@source "./**/*.{ts,tsx}";'), codexAppCss);
});

test('contains every provider-neutral Codex component style unchanged', () => {
  assert.doesNotMatch(agentStyles, /(?:narration|compaction)/u);
  const expected = ruleSignatures(codexStyles, true);
  const actual = ruleSignatures(agentStyles, false);

  for (const [key, signatures] of expected) {
    const candidates = actual.get(key) ?? [];
    for (const signature of signatures) {
      assert.ok(candidates.includes(signature), `Agent CSS drifted from Codex at ${key}.`);
    }
  }
});

function ruleSignatures(source: string, excludeCodexOnly: boolean) {
  const signatures = new Map<string, string[]>();
  postcss.parse(source).walkRules((rule) => {
    if (excludeCodexOnly && /(?:narration|compaction)/u.test(rule.selector)) return;
    const declarations = rule.nodes
      .filter((node) => node.type === 'decl')
      .filter((node) => !excludeCodexOnly || (
        !/(?:narration|compaction)/u.test(node.prop) &&
        !/(?:narration|compaction)/u.test(node.value)
      ))
      .map((node) => `${node.prop}:${node.value}${node.important ? '!important' : ''}`);
    if (declarations.length === 0) return;

    const key = `${atRulePath(rule)} ${rule.selector}`;
    const current = signatures.get(key) ?? [];
    current.push(declarations.join(';'));
    signatures.set(key, current);
  });
  return signatures;
}

function atRulePath(rule: Rule) {
  const path: string[] = [];
  let parent: Node['parent'] = rule.parent;
  while (parent) {
    if (parent.type === 'atrule') {
      const atRule = parent as AtRule;
      path.unshift(`@${atRule.name} ${atRule.params}`);
    }
    parent = parent.parent;
  }
  return path.join(' > ');
}
