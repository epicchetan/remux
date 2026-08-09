import { useState } from 'react';
import { Check, Copy, Loader2, X } from 'lucide-react';

import type { ContextInspectorArtifact } from '../../../../shared/protocol.ts';
import type { ArtifactReadRange } from '../../../../shared/protocol.ts';
import { readArtifactRange } from '../../ipc/artifacts.ts';

const CHUNK_BYTES = 64 * 1024;

export function ContextArtifactButton({
  artifact,
  label,
  title,
}: {
  artifact: ContextInspectorArtifact;
  label: string;
  title: string;
}) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const [nextRange, setNextRange] = useState<ArtifactReadRange | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  return (
    <>
      <button
        className="agent-context-artifact-open"
        onClick={() => {
          const first = utf8Range(0, artifact.byteLength);
          setOpen(true);
          setText('');
          setNextRange(first);
          setError(null);
          setCopied(false);
          if (first) void load(first, false);
        }}
        type="button"
      >
        {label} · {formatBytes(artifact.byteLength)}
      </button>
      {open ? (
        <div className="agent-exact-content-backdrop" role="presentation">
          <section
            aria-label={title}
            aria-modal="true"
            className="agent-exact-content-dialog"
            role="dialog"
          >
            <header>
              <strong>{title}</strong>
              <button aria-label={`Close ${title}`} onClick={() => setOpen(false)} type="button">
                <X className="size-4" />
              </button>
            </header>
            <pre>{loading && !text ? 'Loading…' : text}</pre>
            {error ? <div className="codex-work-error" role="alert">{error}</div> : null}
            <footer>
              <span>{formatBytes(new TextEncoder().encode(text).byteLength)} of {formatBytes(artifact.byteLength)}</span>
              <div>
                <button
                  disabled={loading || !text}
                  onClick={() => {
                    void writeClipboardText(text).then(() => {
                      setCopied(true);
                      window.setTimeout(() => setCopied(false), 1_100);
                    });
                  }}
                  type="button"
                >
                  {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
                  {copied ? 'Copied' : 'Copy loaded text'}
                </button>
                {nextRange ? (
                  <button disabled={loading} onClick={() => void load(nextRange, true)} type="button">
                    {loading ? <Loader2 className="size-3.5 animate-spin" /> : null}
                    Load next chunk
                  </button>
                ) : null}
              </div>
            </footer>
          </section>
        </div>
      ) : null}
    </>
  );

  async function load(range: ArtifactReadRange, append: boolean) {
    setLoading(true);
    setError(null);
    try {
      const result = await readArtifactRange({ hash: artifact.hash, range });
      if (result.encoding !== 'utf8' || result.range.kind !== 'utf8') {
        throw new Error('The Agent returned an incompatible context artifact range.');
      }
      setText((current) => append ? current + result.content : result.content);
      setNextRange(result.nextRange?.kind === 'utf8' ? result.nextRange : null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  }
}

function utf8Range(offset: number, byteLength: number): ArtifactReadRange | null {
  if (offset >= byteLength) return null;
  return { kind: 'utf8', offset, byteLength: Math.min(CHUNK_BYTES, byteLength - offset) };
}

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.ceil(bytes / 1024)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

async function writeClipboardText(text: string) {
  if (!navigator.clipboard?.writeText) throw new Error('Clipboard access is unavailable.');
  await navigator.clipboard.writeText(text);
}
