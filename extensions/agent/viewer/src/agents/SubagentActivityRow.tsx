import { AlertCircle, Bot, ChevronRight, Loader2 } from 'lucide-react';

import type { AgentRuntimeResource } from '../../../shared/native-agent-protocol.ts';

export function SubagentActivityRow({
  connected,
  lifecycle,
  onOpen,
}: {
  connected: boolean;
  lifecycle: AgentRuntimeResource['lifecycle'] | null;
  onOpen: () => void;
}) {
  if (!lifecycle) return null;
  const unresolved = lifecycle.runningCount + lifecycle.checkingCount + lifecycle.stoppingCount;
  if (unresolved === 0 && lifecycle.stopErrorCount === 0) return null;
  const disconnectedChecking = !connected && unresolved > 0;
  const unavailable = connected && lifecycle.state === 'unavailable' && lifecycle.stopErrorCount === 0;
  const parts = [
    unavailable ? 'Subagent status unavailable' : '',
    !unavailable && (disconnectedChecking || (lifecycle.checkingCount > 0 && lifecycle.runningCount === 0 && lifecycle.stoppingCount === 0))
      ? 'Checking subagents…' : '',
    !unavailable && !disconnectedChecking && lifecycle.runningCount
      ? `${lifecycle.runningCount} ${lifecycle.runningCount === 1 ? 'subagent' : 'subagents'} running` : '',
    !unavailable && !disconnectedChecking && lifecycle.checkingCount && (lifecycle.runningCount > 0 || lifecycle.stoppingCount > 0)
      ? `${lifecycle.checkingCount} checking` : '',
    !unavailable && !disconnectedChecking && lifecycle.stoppingCount
      ? `Stopping ${lifecycle.stoppingCount} ${lifecycle.stoppingCount === 1 ? 'subagent' : 'subagents'}…` : '',
    lifecycle.stopErrorCount ? `Couldn’t stop ${lifecycle.stopErrorCount} ${lifecycle.stopErrorCount === 1 ? 'subagent' : 'subagents'}` : '',
  ].filter(Boolean);
  const hasError = lifecycle.stopErrorCount > 0;
  return (
    <button className="remux-subagent-activity" data-state={lifecycle.state} onClick={onOpen} type="button">
      {hasError ? <AlertCircle className="size-4" />
        : disconnectedChecking || lifecycle.state === 'running' || lifecycle.state === 'checking' || lifecycle.state === 'stopping'
          ? <Loader2 className="size-4 animate-spin" /> : <Bot className="size-4" />}
      <span>{parts.join(' · ')}</span>
      <ChevronRight className="size-4" />
    </button>
  );
}
