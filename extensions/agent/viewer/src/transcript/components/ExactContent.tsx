import { useEffect, useState } from 'react';
import { Check, Copy, Loader2, X } from 'lucide-react';

import type { AgentTextContentReference } from '../../../../shared/transcript';
import { readArtifactRange } from '../../ipc/artifacts';

export function ExactContent({
  content,
  preview,
  title,
}: {
  content: AgentTextContentReference | undefined;
  preview: string;
  title: string;
}) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState(preview);
  const [nextRange, setNextRange] = useState(content?.nextRange ?? null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    setOpen(false);
    setText(preview);
    setNextRange(content?.nextRange ?? null);
    setLoading(false);
    setError(null);
    setCopied(false);
  }, [content?.sha256, content?.returnedBytes, preview]);

  if (!content) return null;
  const available = Boolean(content.artifactHash && content.nextRange);
  return (
    <>
      <button
        className="agent-exact-content-open"
        disabled={!available}
        onClick={() => setOpen(true)}
        type="button"
      >
        {available
          ? `Open exact ${title} · ${formatBytes(content.byteLength)}`
          : `Exact ${title} is available after the turn completes`}
      </button>
      {open ? (
        <div className="agent-exact-content-backdrop" role="presentation">
          <section
            aria-label={`Exact ${title}`}
            aria-modal="true"
            className="agent-exact-content-dialog"
            role="dialog"
          >
            <header>
              <strong>Exact {title}</strong>
              <button aria-label="Close exact content" onClick={() => setOpen(false)} type="button">
                <X className="size-4" />
              </button>
            </header>
            <pre>{text}</pre>
            {error ? <div className="codex-work-error" role="alert">{error}</div> : null}
            <footer>
              <span>{formatBytes(new TextEncoder().encode(text).byteLength)} of {formatBytes(content.byteLength)}</span>
              <div>
                <button
                  disabled={loading}
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
                  <button
                    disabled={loading}
                    onClick={() => void loadNext()}
                    type="button"
                  >
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

  async function loadNext() {
    const artifactHash = content?.artifactHash;
    if (!artifactHash || !nextRange || loading) return;
    setLoading(true);
    setError(null);
    try {
      const result = await readArtifactRange({ hash: artifactHash, range: nextRange });
      if (result.encoding !== 'utf8' || result.range.kind !== 'utf8') {
        throw new Error('The Agent returned an incompatible exact-content range.');
      }
      setText((current) => current + result.content);
      setNextRange(result.nextRange?.kind === 'utf8' ? result.nextRange : null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  }
}

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.ceil(bytes / 1024)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

async function writeClipboardText(text: string) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  throw new Error('Clipboard access is unavailable.');
}
