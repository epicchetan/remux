import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from '@playwright/test';
import postcss, { type AtRule, type Node, type Rule } from 'postcss';

const repositoryRoot = new URL('../../../../', import.meta.url);
const codexAppCss = readFileSync(new URL('extensions/codex/viewer/app.css', repositoryRoot), 'utf8');
const agentAppCss = readFileSync(new URL('extensions/agent/viewer/app.css', repositoryRoot), 'utf8');
const codexStyles = readFileSync(new URL('extensions/codex/viewer/styles.css', repositoryRoot), 'utf8');
const agentStyles = readFileSync(new URL('extensions/agent/viewer/src/styles.css', repositoryRoot), 'utf8');
const agentTheme = readFileSync(
  new URL('extensions/agent/viewer/src/styles/agent-theme.css', repositoryRoot),
  'utf8',
);

test('keeps the Agent base theme identical to Codex apart from its source root', () => {
  assert.equal(agentAppCss.replace('@source "./src/**/*.{ts,tsx}";', '@source "./**/*.{ts,tsx}";'), codexAppCss);
});

test('contains every provider-neutral Codex component style unchanged', () => {
  assert.doesNotMatch(agentStyles, /compaction/u);
  const expected = ruleSignatures(codexStyles, true);
  const actual = ruleSignatures(agentStyles, false);

  for (const [key, signatures] of expected) {
    const candidates = actual.get(key) ?? [];
    for (const signature of signatures) {
      assert.ok(candidates.includes(signature), `Agent CSS drifted from Codex at ${key}.`);
    }
  }
});

test('uses orange for Agent actions and Remux blue for navigation and focus', () => {
  assert.match(agentTheme, /--agent-action:\s*var\(--rmx-orange-500\)/u);
  assert.match(agentTheme, /--agent-action-hover:\s*var\(--rmx-orange-700\)/u);
  assert.match(agentTheme, /--rmx-primary-border:\s*var\(--rmx-orange-800\)/u);
  assert.match(agentTheme, /--rmx-primary-shadow:\s*var\(--rmx-orange-950\)/u);
  assert.match(agentTheme, /--rmx-focus-ring:\s*var\(--rmx-blue-400\)/u);
  assert.match(agentTheme, /--rmx-focus-ring:\s*var\(--rmx-blue-600\)/u);
  assert.match(agentTheme, /--link:\s*var\(--rmx-focus-ring\)/u);
  assert.doesNotMatch(agentTheme, /#(?:346bf1|3061d9|173775|5b8cff|51a2ff|1b4ed8|3160db)\b/iu);
});

function ruleSignatures(source: string, excludeCodexOnly: boolean) {
  const signatures = new Map<string, string[]>();
  postcss.parse(source).walkRules((rule) => {
    // Math rendering is currently a separately gated Codex viewer feature. The
    // Agent inline status is intentionally interactive because it owns the
    // provider-neutral usage tray. Everything else shared by the chat renderer
    // stays byte-for-byte declaration compatible.
    if (excludeCodexOnly && /(?:compaction|math|remux-composer-inline-status)/u.test(rule.selector)) return;
    const declarations = rule.nodes
      .filter((node) => node.type === 'decl')
      .filter((node) => !excludeCodexOnly || (
        !/(?:compaction|math)/u.test(node.prop) &&
        !/(?:compaction|math)/u.test(node.value)
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
