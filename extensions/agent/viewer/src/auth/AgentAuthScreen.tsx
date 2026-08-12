import { openHostLink } from '@remux/viewer-kit';

import type { AuthValue } from '../../../shared/protocol.ts';
import { agentCommands } from '../ipc/agentCommands.ts';

type AgentAuthScreenProps = {
  auth: AuthValue;
  busy: boolean;
  error: string | null;
  run: (action: () => Promise<unknown>) => void;
};

export function AgentAuthScreen({ auth, busy, error, run }: AgentAuthScreenProps) {
  return (
    <main className="agent-app agent-center">
      <section className="agent-auth-card">
        <div className="agent-auth-kicker">Remux Agent</div>
        <h1>Connect your OpenAI subscription</h1>
        <p>This runtime reads Pi’s OpenAI Codex OAuth credential store. Tokens never enter the viewer.</p>
        {auth.userCode ? <code className="agent-device-code">{auth.userCode}</code> : null}
        {auth.progress ? <p className="agent-muted">{auth.progress}</p> : null}
        {auth.error || error ? <p className="agent-error" role="alert">{auth.error ?? error}</p> : null}
        <div className="agent-auth-actions">
          {auth.verificationUri ? (
            <button
              type="button"
              onClick={() => void openHostLink({ url: auth.verificationUri! })}
            >
              Open verification page
            </button>
          ) : null}
          {auth.state === 'signing-in' ? (
            <button
              type="button"
              className="agent-secondary"
              onClick={() => {
                if (auth.operationId) {
                  run(() => agentCommands.cancelLogin(auth.operationId!));
                }
              }}
            >
              Cancel
            </button>
          ) : (
            <button
              type="button"
              onClick={() => run(() => agentCommands.login())}
              disabled={busy}
            >
              Sign in with device code
            </button>
          )}
        </div>
      </section>
    </main>
  );
}
