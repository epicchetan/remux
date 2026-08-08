import { canonicalJson } from '../storage/canonical-json.ts';
import type {
  BindingMode,
  ContextBinding,
  ContextSpace,
  ProjectPrimary,
  ProjectState,
} from './model.ts';
import { ProjectStateError } from './kernel.ts';

export type CompiledPlacement = {
  primary: ProjectPrimary;
  binding: ContextBinding;
};

export type CompiledContextLayer = {
  space: ContextSpace;
  placements: readonly CompiledPlacement[];
  inline: readonly CompiledPlacement[];
  index: readonly CompiledPlacement[];
  available: readonly CompiledPlacement[];
  masked: readonly CompiledPlacement[];
};

export type EffectiveContextEntry = {
  primaryId: string;
  mode: Exclude<BindingMode, 'masked'>;
  sourceSpaceIds: readonly string[];
};

export type CompiledProjectContext = {
  projectId: string;
  revision: number;
  targetSpaceId: string;
  chain: readonly ContextSpace[];
  layers: readonly CompiledContextLayer[];
  effective: readonly EffectiveContextEntry[];
};

export function resolveContextSpaceChain(state: ProjectState, targetSpaceId: string) {
  const target = state.spaces.get(targetSpaceId);
  if (!target) {
    throw new ProjectStateError('missing_entity', `Space ${targetSpaceId} does not exist.`);
  }
  const reverse: ContextSpace[] = [];
  const visited = new Set<string>();
  let current: ContextSpace | undefined = target;
  while (current) {
    if (visited.has(current.id)) {
      throw new ProjectStateError('invalid_transaction', `Space ancestry contains a cycle at ${current.id}.`);
    }
    visited.add(current.id);
    reverse.push(current);
    if (current.parentSpaceId === null) break;
    current = state.spaces.get(current.parentSpaceId);
    if (!current) {
      throw new ProjectStateError('missing_entity', 'Space ancestry contains a missing parent.');
    }
  }
  const chain = reverse.reverse();
  if (chain[0]?.id !== state.rootSpaceId || chain[0].parentSpaceId !== null) {
    throw new ProjectStateError(
      'invalid_transaction',
      `Space ${targetSpaceId} is not descended from root ${state.rootSpaceId}.`,
    );
  }
  return chain;
}

export function compileProjectContext(
  state: ProjectState,
  targetSpaceId: string,
): CompiledProjectContext {
  const chain = resolveContextSpaceChain(state, targetSpaceId);
  const depth = new Map(chain.map((space, index) => [space.id, index]));
  const localBindings = [...state.bindings.values()]
    .filter((binding) => depth.has(binding.spaceId))
    .toSorted((left, right) => {
      const depthOrder = (depth.get(left.spaceId) ?? 0) - (depth.get(right.spaceId) ?? 0);
      if (depthOrder !== 0) return depthOrder;
      const revisionOrder = left.createdRevision - right.createdRevision;
      if (revisionOrder !== 0) return revisionOrder;
      return compareText(left.primaryId, right.primaryId);
    });

  const placements = new Map<string, ContextBinding[]>();
  for (const binding of localBindings) {
    const primary = state.primaries.get(binding.primaryId);
    if (!primary || primary.lifecycle !== 'active') continue;
    const current = placements.get(primary.id) ?? [];
    if (binding.mode === 'masked') {
      placements.set(primary.id, [binding]);
      continue;
    }
    if (current.at(-1)?.mode === 'masked') placements.set(primary.id, [binding]);
    else placements.set(primary.id, [...current, binding]);
  }

  const visibleBindingKeys = new Set<string>();
  for (const bindings of placements.values()) {
    for (const binding of bindings) visibleBindingKeys.add(bindingIdentity(binding));
  }
  const layers = chain.map((space): CompiledContextLayer => {
    const local = localBindings
      .filter((binding) => binding.spaceId === space.id && visibleBindingKeys.has(bindingIdentity(binding)))
      .map((binding) => ({
        binding,
        primary: state.primaries.get(binding.primaryId) as ProjectPrimary,
      }));
    return {
      space,
      placements: local,
      inline: local.filter(({ binding }) => binding.mode === 'inline'),
      index: local.filter(({ binding }) => binding.mode === 'index'),
      available: local.filter(({ binding }) => binding.mode === 'available'),
      masked: local.filter(({ binding }) => binding.mode === 'masked'),
    };
  });

  const effective = [...placements.entries()].flatMap(([primaryId, bindings]): EffectiveContextEntry[] => {
    const modes = bindings.map(({ mode }) => mode);
    const mode = strongestMode(modes);
    if (!mode) return [];
    return [{
      primaryId,
      mode,
      sourceSpaceIds: bindings.map(({ spaceId }) => spaceId),
    }];
  }).toSorted((left, right) => {
    const leftPrimary = state.primaries.get(left.primaryId);
    const rightPrimary = state.primaries.get(right.primaryId);
    return comparePrimary(leftPrimary, rightPrimary);
  });

  return {
    projectId: state.projectId,
    revision: state.revision,
    targetSpaceId,
    chain,
    layers,
    effective,
  };
}

export function renderCompiledProjectContext(compiled: CompiledProjectContext) {
  const lines = [
    `<project-context project=${JSON.stringify(compiled.projectId)}>`,
  ];
  for (const layer of compiled.layers) {
    const hasContent = layer.inline.length
      + layer.index.length
      + layer.available.length
      + layer.masked.length > 0;
    if (!hasContent) continue;
    lines.push(`<space key=${JSON.stringify(layer.space.key)} id=${JSON.stringify(layer.space.id)}>`);
    for (const placement of layer.placements) {
      if (placement.binding.mode === 'inline') {
        lines.push(
          `  <primary mode="inline" key=${JSON.stringify(placement.primary.key)} kind=${JSON.stringify(placement.primary.kind)}>`,
          indent(canonicalJson(placement.primary.body), 4),
          '  </primary>',
        );
      } else if (placement.binding.mode === 'index') {
        lines.push(
          `  <primary mode="index" key=${JSON.stringify(placement.primary.key)} kind=${JSON.stringify(placement.primary.kind)}>`,
          indent(canonicalJson(placement.primary.descriptor), 4),
          '  </primary>',
        );
      } else if (placement.binding.mode === 'available') {
        lines.push(
          `  <primary mode="available" id=${JSON.stringify(placement.primary.id)} key=${JSON.stringify(placement.primary.key)} kind=${JSON.stringify(placement.primary.kind)} />`,
        );
      } else {
        lines.push(`  <primary mode="masked" id=${JSON.stringify(placement.primary.id)} />`);
      }
    }
    lines.push('</space>');
  }
  lines.push('</project-context>');
  return `${lines.join('\n')}\n`;
}

function strongestMode(modes: BindingMode[]): Exclude<BindingMode, 'masked'> | undefined {
  if (modes.includes('inline')) return 'inline';
  if (modes.includes('index')) return 'index';
  if (modes.includes('available')) return 'available';
  return undefined;
}

function comparePrimary(left: ProjectPrimary | undefined, right: ProjectPrimary | undefined) {
  if (!left || !right) return compareText(left?.id ?? '', right?.id ?? '');
  return compareText(left.key, right.key) || compareText(left.id, right.id);
}

function bindingIdentity(binding: ContextBinding) {
  return `${JSON.stringify([binding.spaceId, binding.primaryId])}:${binding.version}`;
}

function indent(value: string, spaces: number) {
  const prefix = ' '.repeat(spaces);
  return value.split('\n').map((line) => `${prefix}${line}`).join('\n');
}

function compareText(left: string, right: string) {
  return left < right ? -1 : left > right ? 1 : 0;
}
