import { TranscriptViewport } from './components/TranscriptViewport';
import { useTranscriptRenderSnapshot } from './controller/useTranscriptRenderSnapshot';
import { useTranscriptViewportController } from './viewport/useTranscriptViewportController';

export function VirtualizedTranscript({ conversationId }: { conversationId: string }) {
  const snapshot = useTranscriptRenderSnapshot();
  const viewport = useTranscriptViewportController(conversationId, snapshot);
  return <TranscriptViewport {...viewport} />;
}

export { VirtualizedTranscript as AgentTranscript };
export default VirtualizedTranscript;
