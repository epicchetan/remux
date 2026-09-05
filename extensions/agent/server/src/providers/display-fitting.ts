import {
  PROVIDER_RUNTIME_LIMITS,
  type ProviderEvent,
  type TurnBlockSnapshot,
} from '../../../shared/provider-runtime.ts';

const encoder = new TextEncoder();

export const DISPLAY_TRUNCATION_MARKER = '\n… truncated …';

export function encodedJsonBytes(value: unknown) {
  return encoder.encode(JSON.stringify(value)).byteLength;
}

export function fitDisplayText<T>(options: {
  value: string;
  maxChars: number;
  maxBytes: number;
  build: (text: string, truncated: boolean) => T;
  marker?: string;
}): { value: T; text: string; truncated: boolean } {
  const marker = options.marker ?? DISPLAY_TRUNCATION_MARKER;
  const source = [...options.value];
  const markerChars = [...marker].slice(0, options.maxChars);
  const build = (count: number, truncated: boolean) => {
    const suffix = truncated ? markerChars : [];
    const text = [...source.slice(0, Math.max(0, count - suffix.length)), ...suffix].join('');
    return { value: options.build(text, truncated), text, truncated };
  };
  if (source.length <= options.maxChars) {
    const candidate = build(source.length, false);
    if (encodedJsonBytes(candidate.value) <= options.maxBytes) return candidate;
  }
  let low = Math.min(markerChars.length, options.maxChars);
  let high = options.maxChars;
  let best = build(low, true);
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const candidate = build(middle, true);
    if (encodedJsonBytes(candidate.value) <= options.maxBytes) {
      best = candidate;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  if (encodedJsonBytes(best.value) > options.maxBytes) {
    throw new Error('display field cannot fit within its structural JSON budget');
  }
  return best;
}

export function fitReasoningSummary(
  parts: readonly string[],
  options: {
    maxChars: number;
    maxBytes: number;
    alreadyTruncated?: boolean;
    build?: (payload: {
      kind: 'reasoning-summary'; text: string; parts?: readonly string[]; truncated: boolean;
    }) => unknown;
  },
) {
  const sourceParts = parts.slice(0, 256);
  const sourcePartCharacters = sourceParts.map((part) => [...part]);
  const omittedParts = sourceParts.length !== parts.length;
  const sourceText = sourceParts.join('\n');
  const fittingText = omittedParts ? `${sourceText}${DISPLAY_TRUNCATION_MARKER}` : sourceText;
  const makePayload = (text: string, truncated: boolean) => {
    const mustTruncate = truncated || omittedParts;
    if (!mustTruncate) return {
      kind: 'reasoning-summary' as const,
      text,
      ...(sourceParts.length > 0 ? { parts: sourceParts } : {}),
      truncated: options.alreadyTruncated === true,
    };
    const effectiveMarker = [...DISPLAY_TRUNCATION_MARKER].slice(0, options.maxChars).join('');
    const retained = [...text].slice(0, -[...effectiveMarker].length);
    const fittedParts: string[] = [];
    let remaining = retained.length;
    for (const characters of sourcePartCharacters) {
      if (remaining <= 0) break;
      const take = Math.min(characters.length, remaining);
      fittedParts.push(characters.slice(0, take).join(''));
      remaining -= take + 1;
      if (take < characters.length) break;
    }
    if (fittedParts.length === 0) fittedParts.push(effectiveMarker);
    else fittedParts[fittedParts.length - 1] = `${fittedParts.at(-1)}${effectiveMarker}`;
    return {
      kind: 'reasoning-summary' as const,
      text: fittedParts.join('\n'),
      parts: fittedParts,
      truncated: true,
    };
  };
  const fitted = fitDisplayText({
    value: fittingText,
    maxChars: options.maxChars,
    maxBytes: options.maxBytes,
    build: (text, truncated) => {
      const payload = makePayload(text, truncated);
      return options.build ? options.build(payload) : payload;
    },
  });
  return makePayload(fitted.text, fitted.truncated);
}

export function fitProviderEventDisplay(options: {
  event: ProviderEvent;
  maxBytes: number;
  buildEnvelope: (event: ProviderEvent) => unknown;
  hashJson: (value: unknown) => string;
}): ProviderEvent {
  const replaceBlock = (
    event: Extract<ProviderEvent, { type: `turn.block.${string}` }>,
    block: TurnBlockSnapshot,
    final = true,
  ): ProviderEvent => event.type === 'turn.block.started'
    ? { ...event, block }
    : { ...event, block, contentHash: final ? options.hashJson(block) : '0'.repeat(64) };
  const blockEvent = options.event.type.startsWith('turn.block.') && 'block' in options.event
    ? options.event as Extract<ProviderEvent, { type: `turn.block.${string}` }>
    : undefined;
  if (blockEvent?.block.payload.kind === 'reasoning-summary') {
    const payload = blockEvent.block.payload;
    const fitted = fitReasoningSummary(payload.parts ?? (payload.text ? [payload.text] : []), {
      maxChars: PROVIDER_RUNTIME_LIMITS.messageChars,
      maxBytes: options.maxBytes,
      alreadyTruncated: payload.truncated,
      build: (candidatePayload) => options.buildEnvelope(replaceBlock(blockEvent, {
        ...blockEvent.block,
        payload: candidatePayload,
      }, false)),
    });
    return replaceBlock(blockEvent, { ...blockEvent.block, payload: fitted });
  }
  const fitText = (
    text: string,
    maxChars: number,
    replace: (text: string) => ProviderEvent,
  ) => fitDisplayText({
    value: text,
    maxChars,
    maxBytes: options.maxBytes,
    build: (candidate) => options.buildEnvelope(replace(candidate)),
  });
  if (blockEvent?.block.payload.kind === 'tool' && blockEvent.block.payload.tool.title) {
    const payload = blockEvent.block.payload;
    const replace = (title: string, final = true) => replaceBlock(blockEvent, {
      ...blockEvent.block,
      payload: { ...payload, tool: { ...payload.tool, title } },
    }, final);
    const fitted = fitText(payload.tool.title!, PROVIDER_RUNTIME_LIMITS.stringChars, (text) => replace(text, false));
    return replace(fitted.text);
  }
  if (blockEvent &&
      (blockEvent.block.payload.kind === 'native-child' ||
       blockEvent.block.payload.kind === 'federated-child') &&
      blockEvent.block.payload.summary) {
    const payload = blockEvent.block.payload;
    const replace = (summary: string, final = true) => replaceBlock(blockEvent, {
      ...blockEvent.block,
      payload: { ...payload, summary },
    }, final);
    const fitted = fitText(payload.summary!, PROVIDER_RUNTIME_LIMITS.messageChars, (text) => replace(text, false));
    return replace(fitted.text);
  }
  if (options.event.type === 'turn.completed' && options.event.error) {
    const event = options.event;
    const replace = (message: string): ProviderEvent => ({
      ...event,
      error: { ...event.error!, message },
    });
    return replace(fitText(event.error!.message, PROVIDER_RUNTIME_LIMITS.stringChars, replace).text);
  }
  if (options.event.type === 'context.compaction.failed') {
    const event = options.event;
    const replace = (message: string): ProviderEvent => ({ ...event, error: { ...event.error, message } });
    return replace(fitText(event.error.message, PROVIDER_RUNTIME_LIMITS.stringChars, replace).text);
  }
  if (options.event.type === 'execution.summary') {
    const event = options.event;
    const replace = (summary: string): ProviderEvent => ({ ...event, summary });
    return replace(fitText(event.summary, PROVIDER_RUNTIME_LIMITS.messageChars, replace).text);
  }
  return options.event;
}
