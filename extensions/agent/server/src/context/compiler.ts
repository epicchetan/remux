import { createHash } from 'node:crypto';

import { canonicalJson, canonicalJsonHash, type CanonicalJsonValue } from '../storage/canonical-json.ts';
import { logicalMessageSemanticValue, type LogicalContextMessage } from '../logical-context.ts';
import type { PrimaryAuthority, BindingMode } from '../project-state/model.ts';
import type { WorkingMemorySnapshotRecord } from './working-memory.ts';
import {
  CONTEXT_COMPILER_VERSION,
  type ContextBlockKind,
  type ContextCandidateBlock,
  type ContextDecision,
  type ContextOmission,
  type ShadowContextCandidate,
} from './manifest.ts';
import { contextPolicyForModel, type ContextPolicyOverrides } from './policy.ts';

export type ContextAuthorityEntry = {
  primaryId: string;
  key: string;
  kind: string;
  authority: PrimaryAuthority;
  mode: Exclude<BindingMode, 'masked'>;
  descriptor: CanonicalJsonValue;
  body: CanonicalJsonValue;
  sourceSpaceIds: readonly string[];
  version: number;
};

export type ShadowContextSource = {
  basisSequence: number;
  projectId: string;
  projectRevision: number;
  conversationId: string;
  strandId: string;
  turnId: string;
  scopeId: string;
  epochId: string;
  targetContextSpaceId: string;
  workspaceRoot: string;
  reasoning: string;
  messages: readonly LogicalContextMessage[];
  workingMemory?: WorkingMemorySnapshotRecord | null;
  authority: readonly ContextAuthorityEntry[];
  turnAnchor: {
    currentUser: { ref: string; body: string };
    precedingAssistantRef: string | null;
    acceptedProposalRef: string | null;
    steeringRefs: readonly string[];
  };
  observedRuntime: CanonicalJsonValue;
  executionScope: {
    kind: 'turn' | 'work_unit';
    parentScopeId: string | null;
    objective: CanonicalJsonValue;
    capsuleRef: string | null;
  };
};

export type ShadowContextProfile = {
  modelId: string;
  contextWindow: number;
  fixedContractsHash: string;
  activeEstimatedInputTokens: number;
  policy?: ContextPolicyOverrides;
  pressureNoticeSent?: boolean;
};

type TailChunk = {
  order: number;
  source: string;
  messages: readonly LogicalContextMessage[];
  kind: 'current-exchange' | 'prior-turn';
};

type PreparedTailChunk = TailChunk & {
  compacted: readonly CanonicalJsonValue[];
  omissions: readonly ContextOmission[];
  estimatedTokens: number;
};

export function compileShadowContext(
  source: ShadowContextSource,
  profile: ShadowContextProfile,
): ShadowContextCandidate {
  const policy = contextPolicyForModel(profile.contextWindow, profile.policy);
  const turnUri = contextTurnUri(source, source.turnId);
  const current = source.messages.filter((message) => message.turnId === source.turnId);
  const prior = source.messages.filter((message) => message.turnId !== source.turnId);
  const currentUser = current.find((message) => message.role === 'user');
  if (!currentUser) throw new Error(`Context source has no user message for active turn ${source.turnId}.`);

  const currentExchanges = assistantExchanges(current);
  const latestExchange = currentExchanges.at(-1) ?? [];
  const olderCurrentExchanges = currentExchanges.slice(0, -1);
  const priorTurns = groupByTurn(prior);
  const compactedOmissions: ContextOmission[] = [];
  const continuationValue = {
    request: source.turnAnchor.currentUser,
    turnAnchor: {
      ...source.turnAnchor,
      steeringRefs: [...source.turnAnchor.steeringRefs],
    },
    latestExchange: compactMessages(latestExchange, policy.oversizedValueBytes, turnUri, compactedOmissions),
    turnId: source.turnId,
  } satisfies CanonicalJsonValue;

  const authorityOmissions: ContextOmission[] = [];
  const orderedAuthority = [...source.authority].sort((left, right) =>
    compareText(left.key, right.key) || compareText(left.primaryId, right.primaryId));
  const authorityValue = orderedAuthority.map((entry) => authorityProjection(
    source,
    entry,
    policy.oversizedValueBytes,
    authorityOmissions,
  ));
  const runtimeValue = {
    epochId: source.epochId,
    fixedContractsHash: profile.fixedContractsHash,
    modelId: profile.modelId,
    reasoning: source.reasoning,
    scopeId: source.scopeId,
    scopeKind: source.executionScope.kind,
  } satisfies CanonicalJsonValue;
  const workspaceValue = {
    projectId: source.projectId,
    root: source.workspaceRoot,
    strandId: source.strandId,
  } satisfies CanonicalJsonValue;
  const contextHudValue = {
    basisSequence: source.basisSequence,
    cwd: source.workspaceRoot,
    ephemeral: source.workingMemory
      ? 'Journal retrieval and tool results remain exact in the hot tail; the background snapshot is a disposable cache and explicit state remains protected.'
      : 'Journal retrieval and ordinary tool results remain hot only in this frame unless explicitly set or pinned.',
    frame: 'Stable append-only prefix; rebuilt only under input pressure or runtime restart.',
    projectId: source.projectId,
    revision: source.projectRevision,
    stateSemantics: 'Model-authored entries are fallible working memory and never override user, spec, or observed source authority.',
    semanticKeys: orderedAuthority
      .filter((entry) => entry.kind !== 'working-resource')
      .map((entry) => entry.key),
    strandId: source.strandId,
    pinned: orderedAuthority
      .filter((entry) => entry.kind === 'working-resource')
      .map((entry) => ({
        key: entry.key,
        mode: entry.mode,
        descriptor: entry.descriptor,
      })),
  } satisfies CanonicalJsonValue;

  const mandatory = [
    createBlock('context_hud', canonicalJson(contextHudValue), []),
    ...(source.workingMemory ? [createBlock('working_memory', canonicalJson({
      cacheSemantics: 'Fallible derived working memory. Re-open cited truth when precision or freshness matters.',
      coveredThroughSequence: source.workingMemory.snapshot.coveredThroughSequence,
      orientation: source.workingMemory.snapshot.orientation,
      entries: source.workingMemory.snapshot.entries,
      snapshotSequence: source.workingMemory.sequence,
    }), [`journal://event/${source.workingMemory.sequence}`])] : []),
    createBlock(
      'working_state',
      canonicalJson(authorityValue),
      orderedAuthority.map((entry) => contextPrimaryUri(source, entry.primaryId)),
    ),
    createBlock('open_work', canonicalJson({
      runtime: source.observedRuntime,
      scope: source.executionScope,
    }), [
      `journal://scope/${encodeURIComponent(source.scopeId)}`,
      ...(source.executionScope.capsuleRef ? [source.executionScope.capsuleRef] : []),
    ]),
    createBlock('workspace', canonicalJson(workspaceValue), [`agent://project/${encodeURIComponent(source.projectId)}`]),
    createBlock('runtime', canonicalJson(runtimeValue), [`agent://epoch/${encodeURIComponent(source.epochId)}`]),
    createBlock('continuation', canonicalJson(continuationValue), [turnUri]),
  ] as ContextCandidateBlock[];

  const chunks: TailChunk[] = [
    ...olderCurrentExchanges.map((messages, index) => ({
      order: index,
      source: `${turnUri}#exchange=${index}`,
      messages,
      kind: 'current-exchange' as const,
    })),
    ...priorTurns.map(({ turnId, messages }, index) => ({
      order: olderCurrentExchanges.length + index,
      source: contextTurnUri(source, turnId),
      messages,
      kind: 'prior-turn' as const,
    })),
  ];
  const preparedChunks = chunks.map((chunk) => prepareTailChunk(chunk, policy.oversizedValueBytes));
  const fixedOmissions = [...compactedOmissions, ...authorityOmissions];
  const selected = selectTailChunks(
    mandatory,
    preparedChunks,
    source,
    fixedOmissions,
    policy.version,
    policy.snapshotTargetTokens,
  );
  let blocks = finalizeBlocks(mandatory, preparedChunks, selected, source, fixedOmissions);
  while (
    selected.size > 0 &&
    estimateBootstrapTokens(renderBootstrap(source, policy.version, blocks)) > policy.snapshotTargetTokens
  ) {
    const oldest = Math.min(...selected);
    selected.delete(oldest);
    blocks = finalizeBlocks(mandatory, preparedChunks, selected, source, fixedOmissions);
  }
  const bootstrap = renderBootstrap(source, policy.version, blocks);
  const estimatedInputTokens = estimateBootstrapTokens(bootstrap);
  const omissions = blockOmissions(blocks);
  const pressurePermille = pressurePermilleValue(
    profile.activeEstimatedInputTokens / Math.max(1, policy.rollThresholdTokens),
  );
  const decision: ContextDecision = estimatedInputTokens > policy.snapshotHardMaxTokens
    ? {
        kind: 'block',
        pressurePermille,
        reason: 'Mandatory context cannot fit within the snapshot hard maximum.',
      }
    : profile.activeEstimatedInputTokens >= policy.admissionLimitTokens
      ? { kind: 'roll', pressurePermille, reason: 'The next request requires emergency rollover before admission.' }
      : profile.activeEstimatedInputTokens >= policy.rollThresholdTokens && profile.pressureNoticeSent
      ? { kind: 'roll', pressurePermille, reason: 'The active full replay reached the rollover threshold.' }
      : { kind: 'append', pressurePermille };
  const bootstrapHash = sha256(bootstrap);
  const semanticHash = canonicalJsonHash({
    activeEstimatedInputTokens: profile.activeEstimatedInputTokens,
    basisSequence: source.basisSequence,
    blocks: blocks.map(({ kind, hash, estimatedTokens, sources }) => ({
      estimatedTokens,
      hash,
      kind,
      sources,
    })),
    compilerVersion: CONTEXT_COMPILER_VERSION,
    decision,
    omissions,
    policyVersion: policy.version,
    projectRevision: source.projectRevision,
    targetContextSpaceId: source.targetContextSpaceId,
  });
  return {
    compilerVersion: CONTEXT_COMPILER_VERSION,
    policyVersion: policy.version,
    basisSequence: source.basisSequence,
    projectRevision: source.projectRevision,
    targetContextSpaceId: source.targetContextSpaceId,
    decision,
    blocks,
    omissions,
    bootstrap,
    bootstrapHash,
    semanticHash,
    estimatedInputTokens,
    activeEstimatedInputTokens: profile.activeEstimatedInputTokens,
  };
}

function finalizeBlocks(
  mandatory: readonly ContextCandidateBlock[],
  chunks: readonly PreparedTailChunk[],
  selected: ReadonlySet<number>,
  source: ShadowContextSource,
  fixedOmissions: readonly ContextOmission[],
) {
  const selectedChunks = chunks.filter((chunk) => selected.has(chunk.order)).sort((a, b) => a.order - b.order);
  const tailOmissions: ContextOmission[] = [
    ...fixedOmissions,
    ...selectedChunks.flatMap((chunk) => chunk.omissions),
  ];
  const rawMessages = selectedChunks.flatMap((chunk) => chunk.compacted);
  const omittedCurrent = chunks.filter((chunk) => chunk.kind === 'current-exchange' && !selected.has(chunk.order));
  if (omittedCurrent.length > 0) {
    tailOmissions.push({
      source: contextTurnUri(source, source.turnId),
      reason: 'older-active-turn-work',
      retrieval: contextTurnUri(source, source.turnId),
      count: omittedCurrent.length,
    });
  }
  const omittedPrior = chunks.filter((chunk) => chunk.kind === 'prior-turn' && !selected.has(chunk.order));
  if (omittedPrior.length > 0) {
    tailOmissions.push({
      source: `agent://conversation/${encodeURIComponent(source.conversationId)}/turns`,
      reason: 'raw-tail-budget',
      retrieval: `agent://conversation/${encodeURIComponent(source.conversationId)}/turns?before=${encodeURIComponent(selectedChunks.find((chunk) => chunk.kind === 'prior-turn')?.source ?? 'latest')}`,
      count: omittedPrior.length,
    });
  }
  const normalizedOmissions = dedupeOmissions(tailOmissions);
  return [
    ...mandatory,
    createBlock('raw_tail', canonicalJson({ messages: rawMessages }), selectedChunks.map(({ source }) => source)),
    createBlock('retrieval_map', canonicalJson({ omissions: normalizedOmissions }), normalizedOmissions.map(({ retrieval }) => retrieval)),
  ];
}

function prepareTailChunk(chunk: TailChunk, oversizedValueBytes: number): PreparedTailChunk {
  const omissions: ContextOmission[] = [];
  const prepared = prepareCompactedMessages(
    chunk.messages,
    oversizedValueBytes,
    chunk.source,
    omissions,
  );
  return {
    ...chunk,
    compacted: prepared.values,
    omissions,
    estimatedTokens: prepared.estimatedTokens,
  };
}

function selectTailChunks(
  mandatory: readonly ContextCandidateBlock[],
  chunks: readonly PreparedTailChunk[],
  source: ShadowContextSource,
  fixedOmissions: readonly ContextOmission[],
  policyVersion: string,
  targetTokens: number,
) {
  const selected = new Set<number>();
  const baseline = finalizeBlocks(mandatory, chunks, selected, source, fixedOmissions);
  let projectedTokens = estimateBootstrapTokens(renderBootstrap(source, policyVersion, baseline));
  const emptyRawTokens = estimateTextTokens(canonicalJson({ messages: [] }));
  for (const chunk of [...chunks].sort((left, right) => right.order - left.order)) {
    const contribution = Math.max(1, chunk.estimatedTokens - emptyRawTokens + 1);
    if (projectedTokens + contribution > targetTokens) break;
    selected.add(chunk.order);
    projectedTokens += contribution;
  }
  return selected;
}

function blockOmissions(blocks: readonly ContextCandidateBlock[]) {
  const retrieval = blocks.find((block) => block.kind === 'retrieval_map');
  if (!retrieval) return [];
  const parsed = JSON.parse(retrieval.text) as { omissions?: ContextOmission[] };
  return parsed.omissions ?? [];
}

function renderBootstrap(
  source: ShadowContextSource,
  policyVersion: string,
  blocks: readonly ContextCandidateBlock[],
) {
  const lines = [
    `<remux_epoch version="1" basis_sequence="${source.basisSequence}" policy=${JSON.stringify(policyVersion)}>`,
  ];
  for (const block of blocks) {
    lines.push(`<${block.kind}>`, block.text, `</${block.kind}>`);
  }
  lines.push('</remux_epoch>');
  return `${lines.join('\n')}\n`;
}

function createBlock(
  kind: ContextBlockKind,
  text: string,
  sources: readonly string[],
): ContextCandidateBlock {
  return {
    kind,
    hash: sha256(text),
    estimatedTokens: estimateTextTokens(text),
    text,
    sources: [...new Set(sources)].sort(compareText),
  };
}

function authorityProjection(
  source: ShadowContextSource,
  entry: ContextAuthorityEntry,
  maxBytes: number,
  omissions: ContextOmission[],
): CanonicalJsonValue {
  const uri = contextPrimaryUri(source, entry.primaryId);
  const common = {
    authority: entry.authority,
    id: entry.primaryId,
    key: entry.key,
    kind: entry.kind,
    mode: entry.mode,
    sourceSpaceIds: entry.sourceSpaceIds,
    version: entry.version,
  };
  if (entry.mode === 'available') return { ...common, retrieval: uri } as unknown as CanonicalJsonValue;
  if (entry.mode === 'index') {
    omissions.push({ source: uri, reason: 'indexed-primary-body', retrieval: uri, count: 1 });
    return { ...common, descriptor: entry.descriptor, retrieval: uri } as unknown as CanonicalJsonValue;
  }
  const descriptor = entry.descriptor && typeof entry.descriptor === 'object' && !Array.isArray(entry.descriptor)
    ? entry.descriptor as Record<string, CanonicalJsonValue>
    : {};
  const inlineLimit = entry.kind === 'working-resource' && descriptor.view === 'exact'
    ? Math.max(maxBytes, 64 * 1024)
    : maxBytes;
  const encoded = canonicalJson(entry.body);
  if (Buffer.byteLength(encoded, 'utf8') <= inlineLimit) {
    return { ...common, body: entry.body } as unknown as CanonicalJsonValue;
  }
  omissions.push({ source: uri, reason: 'oversized-primary-body', retrieval: uri, count: 1 });
  return {
    ...common,
    body: externalizedValue(encoded, uri, inlineLimit),
  } as unknown as CanonicalJsonValue;
}

function compactMessages(
  messages: readonly LogicalContextMessage[],
  maxBytes: number,
  source: string,
  omissions: ContextOmission[],
): CanonicalJsonValue[] {
  return prepareCompactedMessages(messages, maxBytes, source, omissions).values;
}

function prepareCompactedMessages(
  messages: readonly LogicalContextMessage[],
  maxBytes: number,
  source: string,
  omissions: ContextOmission[],
) {
  let encodedBytes = Buffer.byteLength('{"messages":[]}', 'utf8');
  const values = messages.map((message) => {
    const value = logicalMessageSemanticValue(message);
    const encoded = canonicalJson(value);
    const byteLength = Buffer.byteLength(encoded, 'utf8');
    if (byteLength <= maxBytes) {
      encodedBytes += byteLength + 1;
      return value;
    }
    const retrieval = message.role === 'tool'
      ? `${source}#call=${encodeURIComponent(message.callId)}`
      : source;
    omissions.push({ source, reason: `oversized-${message.role}-message`, retrieval, count: 1 });
    const externalized = externalizedValue(encoded, retrieval, maxBytes);
    encodedBytes += Buffer.byteLength(canonicalJson(externalized), 'utf8') + 1;
    return externalized;
  });
  return {
    values,
    estimatedTokens: Math.max(1, Math.ceil(encodedBytes / 4)),
  };
}

function externalizedValue(encoded: string, retrieval: string, maxBytes: number): CanonicalJsonValue {
  const excerptBytes = Math.max(256, Math.floor(maxBytes / 2));
  return {
    byteLength: Buffer.byteLength(encoded, 'utf8'),
    excerpt: utf8Prefix(encoded, excerptBytes),
    externalized: true,
    retrieval,
    sha256: sha256(encoded),
  };
}

function assistantExchanges(messages: readonly LogicalContextMessage[]) {
  const exchanges: LogicalContextMessage[][] = [];
  let current: LogicalContextMessage[] | null = null;
  for (const message of messages) {
    if (message.role === 'user') continue;
    if (message.role === 'assistant') {
      current = [message];
      exchanges.push(current);
    } else if (current) {
      current.push(message);
    }
  }
  return exchanges;
}

function groupByTurn(messages: readonly LogicalContextMessage[]) {
  const order: string[] = [];
  const grouped = new Map<string, LogicalContextMessage[]>();
  for (const message of messages) {
    let group = grouped.get(message.turnId);
    if (!group) {
      group = [];
      grouped.set(message.turnId, group);
      order.push(message.turnId);
    }
    group.push(message);
  }
  return order.map((turnId) => ({ turnId, messages: grouped.get(turnId)! }));
}

function dedupeOmissions(omissions: readonly ContextOmission[]) {
  const values = new Map<string, ContextOmission>();
  for (const omission of omissions) {
    const key = canonicalJson([omission.source, omission.reason, omission.retrieval]);
    const prior = values.get(key);
    values.set(key, prior ? { ...prior, count: prior.count + omission.count } : omission);
  }
  return [...values.values()].sort((left, right) =>
    compareText(left.source, right.source) || compareText(left.reason, right.reason))
    .map((omission) => ({
      ...omission,
      ref: `journal://omission/${sha256(canonicalJson(omission as unknown as CanonicalJsonValue))}`,
    }));
}

function estimateBootstrapTokens(value: string) {
  return estimateTextTokens(value) + 1_000;
}

function estimateTextTokens(value: string) {
  return Math.max(1, Math.ceil(Buffer.byteLength(value, 'utf8') / 4));
}

function contextTurnUri(source: ShadowContextSource, turnId: string) {
  return `agent://conversation/${encodeURIComponent(source.conversationId)}/turn/${encodeURIComponent(turnId)}`;
}

function contextPrimaryUri(source: ShadowContextSource, primaryId: string) {
  return `agent://project/${encodeURIComponent(source.projectId)}/primary/${encodeURIComponent(primaryId)}?revision=${source.projectRevision}`;
}

function pressurePermilleValue(value: number) {
  return Math.round(value * 1_000);
}

function sha256(value: string) {
  return createHash('sha256').update(value).digest('hex');
}

function utf8Prefix(value: string, maxBytes: number) {
  const bytes = Buffer.from(value, 'utf8');
  if (bytes.byteLength <= maxBytes) return value;
  let end = maxBytes;
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end -= 1;
  return bytes.subarray(0, end).toString('utf8');
}

function compareText(left: string, right: string) {
  return left < right ? -1 : left > right ? 1 : 0;
}
