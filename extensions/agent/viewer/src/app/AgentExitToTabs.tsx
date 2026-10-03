import { openHostOverview } from '@remux/viewer-kit/host';

export function AgentExitToTabs() {
  return (
    <button
      className="agent-secondary whitespace-nowrap"
      onClick={() => void openHostOverview({ section: 'tabs' })}
      type="button"
    >
      Exit to Tabs
    </button>
  );
}
