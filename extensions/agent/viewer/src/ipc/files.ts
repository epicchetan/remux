import type { AgentFileSearchResult } from '../../../shared/protocol.ts';
import { rpc } from '@remux/viewer-kit';

import { NATIVE_AGENT_METHODS } from '../../../shared/native-agent-protocol.ts';
import type { ComposerMentionItem } from '../composer/mentions/mentionSearch.ts';
import { parseComposerMentionQuery } from '../composer/mentions/mentionSearch.ts';

export async function searchComposerMentionFiles(
  query: string,
  cwd?: string,
): Promise<ComposerMentionItem[]> {
  const parsed = parseComposerMentionQuery(query);
  if (!parsed.normalizedQuery || !cwd) return [];
  const response = await rpc.query<{ results: AgentFileSearchResult[] }>(
    NATIVE_AGENT_METHODS.filesSearch,
    { cwd, limit: 80, query: parsed.normalizedQuery },
  );
  return response.results;
}
