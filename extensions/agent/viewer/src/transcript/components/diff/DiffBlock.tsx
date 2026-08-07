export function DiffBlock({ diff }: { diff: string }) {
  return (
    <pre className="codex-diff-block">
      {diff.split('\n').map((line, index) => (
        <div className={diffLineClass(line)} key={`${index}:${line}`}>
          {line || ' '}
        </div>
      ))}
    </pre>
  );
}

function diffLineClass(line: string) {
  if (line.startsWith('+') && !line.startsWith('+++')) {
    return 'codex-diff-line codex-diff-line-added';
  }

  if (line.startsWith('-') && !line.startsWith('---')) {
    return 'codex-diff-line codex-diff-line-removed';
  }

  if (line.startsWith('@@')) {
    return 'codex-diff-line codex-diff-line-hunk';
  }

  return 'codex-diff-line';
}
