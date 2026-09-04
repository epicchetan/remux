import { useCallback, useEffect, useRef, useState } from 'react';
import { Loader2, RotateCcw } from 'lucide-react';

import type { ArtifactReadRange } from '../../../../../shared/protocol.ts';
import { readArtifactRange } from '../../../ipc/artifacts.ts';
import { DiffBlock } from './DiffBlock.tsx';

const DIFF_CHUNK_BYTES = 128 * 1024;

export function ArtifactDiff({ artifactId }: { artifactId: string }) {
  const [text, setText] = useState('');
  const [nextRange, setNextRange] = useState<ArtifactReadRange | null>({
    kind: 'utf8',
    offset: 0,
    byteLength: DIFF_CHUNK_BYTES,
  });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const artifactGeneration = useRef(0);

  useEffect(() => {
    artifactGeneration.current += 1;
    setText('');
    setNextRange({ kind: 'utf8', offset: 0, byteLength: DIFF_CHUNK_BYTES });
    setLoading(false);
    setError(null);
  }, [artifactId]);

  const load = useCallback(async (range: ArtifactReadRange) => {
    if (range.kind !== 'utf8') return;
    const generation = artifactGeneration.current;
    setLoading(true);
    setError(null);
    try {
      const result = await readArtifactRange({ hash: artifactId, range });
      if (result.encoding !== 'utf8' || result.range.kind !== 'utf8') {
        throw new Error('The Agent returned an incompatible diff artifact.');
      }
      if (generation !== artifactGeneration.current) return;
      setText((current) => current + result.content);
      setNextRange(result.nextRange?.kind === 'utf8' ? result.nextRange : null);
    } catch (cause) {
      if (generation === artifactGeneration.current) {
        setError(cause instanceof Error ? cause.message : String(cause));
      }
    } finally {
      if (generation === artifactGeneration.current) setLoading(false);
    }
  }, [artifactId]);

  useEffect(() => {
    if (!text && nextRange && !loading && !error) void load(nextRange);
  }, [error, load, loading, nextRange, text]);

  if (error) {
    return (
      <div className="codex-work-error" role="alert">
        <span>The recorded diff could not be loaded.</span>
        <button
          onClick={() => {
            setError(null);
            setNextRange({ kind: 'utf8', offset: 0, byteLength: DIFF_CHUNK_BYTES });
          }}
          type="button"
        >
          <RotateCcw className="size-3" /> Retry
        </button>
      </div>
    );
  }

  return (
    <div className="agent-artifact-diff">
      {text ? <DiffBlock diff={text} /> : null}
      {loading ? (
        <div className="codex-work-loading">
          <Loader2 className="size-3.5 animate-spin" /> Loading diff…
        </div>
      ) : null}
      {!loading && text && nextRange ? (
        <button
          className="agent-diff-load-more"
          onClick={() => void load(nextRange)}
          type="button"
        >
          Load more diff
        </button>
      ) : null}
    </div>
  );
}
