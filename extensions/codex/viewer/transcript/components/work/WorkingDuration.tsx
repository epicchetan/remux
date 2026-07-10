import { memo, useEffect, useState } from 'react';

import { useThreadRuntimeStore } from '../../../threads/runtimeStore';
import {
  formatRunningWorkDuration,
  nextRunningWorkDurationUpdateMs,
} from './workDuration';

export const WorkingDuration = memo(function WorkingDuration({ turnId }: { turnId: string }) {
  const elapsedAnchorMs = useThreadRuntimeStore((state) =>
    state.activeTurnId === turnId && (state.status === 'running' || state.status === 'stopping')
      ? state.activeTurnElapsedMs
      : null);
  const [elapsedMs, setElapsedMs] = useState(elapsedAnchorMs ?? 0);

  useEffect(() => {
    if (elapsedAnchorMs === null) {
      setElapsedMs(0);
      return;
    }

    const receivedAt = performance.now();
    let timer: number | null = null;
    const update = () => {
      const nextElapsedMs = elapsedAnchorMs + performance.now() - receivedAt;
      setElapsedMs(nextElapsedMs);
      timer = window.setTimeout(update, nextRunningWorkDurationUpdateMs(nextElapsedMs));
    };
    update();

    return () => {
      if (timer !== null) {
        window.clearTimeout(timer);
      }
    };
  }, [elapsedAnchorMs]);

  const duration = formatRunningWorkDuration(elapsedMs);
  return duration ? (
    <span>
      Working for <span className="tabular-nums">{duration}</span>
    </span>
  ) : (
    <span>Working</span>
  );
});
