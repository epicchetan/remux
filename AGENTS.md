# Remux Agent Notes

- This repository is maintained by a single contributor. Work directly on `main` unless the user explicitly asks for a feature branch, pull request, or a different branch workflow.
- Commit and push completed Remux work to `main` when explicitly requested or when the user moves on to a different task/topic. Leave implementation changes uncommitted during follow-up discussion and validation; finishing an implementation alone is not a signal to push.
- Do not open pull requests unless the user explicitly asks for one.
- If work has already happened on a temporary branch, fast-forward or otherwise land it on `main` and push `main`.
- After implementation changes, leave Remux ready for the user to validate: build affected components, restart them as needed while preserving sessions, and verify the running version and affected behavior. Which restart applies depends on what changed:
  - Runtime worker (`crates/remux/`): `npm run build:runtime`, then restart the worker (the app's **Restart runtime** action). The supervisor re-executes the freshly built binary through `~/.local/bin/remux`.
  - Supervisor or guardian (`crates/remux/src/{supervise,guardian}.rs`, `main.rs`) or unit templates: `remux restart`, and re-run `remux install` when units or the managed skill changed.
  - Extension servers: rebuild and restart the extension (`remux/extensions/restart` RPC, or **Rebuild & Restart** from the extension's detail sheet). Restarting an extension does not rebuild or restart the runtime, and restarting the runtime does not update external hosts such as `ledgerd`.
  - Extension viewers: `npm run viewers:build`, or rely on the extension's watch process if one is running; confirm the served asset hash changed. Open views do not reload themselves.
  - Never run `remux restart` or `systemctl --user restart remux` from inside a Remux terminal or agent session; it kills that session. Likewise never rebuild-and-restart the agent extension from inside an agent conversation, including as a federated child of one; that kills the conversation you are running under. Do it from tmux/SSH or leave it to the user. If readiness is blocked, explain why.
- Run the checks that cover what changed before reporting: `npm run typecheck`, `npm run test:runtime`, and the extension's own tests (for example `npm run test:agent`, `npm run test:codex-server`, `npm run test:terminal-server`).
  - Visual validation of an extension viewer runs headless against the live runtime via `npm run view:open -- agent --shot /tmp/x.png` (never through the app); browsers are disposable one-shot scripts, and nothing should assume a browser survives a turn.
- Single contributor, direct pushes to `main`: do not keep backward-compatibility layers. When changing an interface, update every caller and delete the old path; no deprecated aliases, dual-format readers, or legacy fallbacks.
- Challenge proposals when evidence or a concrete tradeoff warrants it, explain the concern before implementation, and suggest an alternative that preserves the user's intent.
