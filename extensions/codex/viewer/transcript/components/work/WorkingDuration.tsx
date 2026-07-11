import { memo, useEffect, useState } from 'react';

import { useThreadRuntimeStore } from '../../../threads/runtimeStore';
import {
  formatRunningWorkDuration,
  nextRunningWorkDurationUpdateMs,
} from './workDuration';

export const WorkingDuration = memo(function WorkingDuration({
  completed = false,
  turnId,
}: {
  completed?: boolean;
  turnId: string;
}) {
  const elapsedAnchorMs = useThreadRuntimeStore((state) =>
    state.activeTurnId === turnId && (state.status === 'running' || state.status === 'stopping')
      ? state.activeTurnElapsedMs
      : null);
  const [elapsedMs, setElapsedMs] = useState(elapsedAnchorMs ?? 0);

  useEffect(() => {
    if (elapsedAnchorMs === null) {
      // Runtime completion can be published just before the transcript's
      // authoritative duration. Keep the last provisional value for that gap.
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
  const label = completed ? 'Worked' : 'Working';
  return duration ? (
    <span>
      {label} for <span className="tabular-nums">{duration}</span>
    </span>
  ) : (
    <span>{label}</span>
  );
});
