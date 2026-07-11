# Remux Documentation

Use this directory as the maintained map of the project. The root README should stay short; deeper setup, architecture, and design rationale belong here.

## Start Here

- [Development Guide](guides/development.md): install, run the runtime, run the mobile app, and know which folders are generated.
- [Runtime Architecture](architecture/remux-runtime.md): guardian, runtime, resource hierarchy, RPC, extension supervision, and app responsibilities.
- [Codex Extension Architecture](architecture/codex-extension.md): Codex viewer/server data flow, transcript resources, invalidations, and app-server integration.
- [Extension Authoring](guides/extension-authoring.md): manifest shape, viewer build contract, launchers, file handlers, and stdio servers.
- [Testing](guides/testing.md): root, mobile, runtime, extension-server, and Playwright test commands.

## Current References

| Document | Scope |
| --- | --- |
| [architecture/remux-runtime.md](architecture/remux-runtime.md) | Current Remux runtime and mobile app responsibilities. |
| [architecture/codex-extension.md](architecture/codex-extension.md) | Current Codex extension ownership and data flow. |
| [architecture/codex-streaming.md](architecture/codex-streaming.md) | Current Codex streaming/read-model walkthrough. |
| [guides/development.md](guides/development.md) | Local setup and runtime workflow. |
| [guides/extension-authoring.md](guides/extension-authoring.md) | Extension manifest and viewer/server contracts. |
| [guides/testing.md](guides/testing.md) | Test commands and caveats. |

## Specs

Specs are design records, not always current runtime truth. Each spec should have a status block directly under the title.

- [specs/README.md](specs/README.md): spec lifecycle definitions.
- [specs/codex/transcript-identity-reconciliation.md](specs/codex/transcript-identity-reconciliation.md): active Codex identity design reference.
- [specs/codex/transcript-store-scroll.md](specs/codex/transcript-store-scroll.md): implemented transcript store and scroll design reference.
- [specs/codex/archive/](specs/codex/archive/): implemented or superseded Codex phase specs kept for rationale.

Status meanings:

- `Current`: intended to describe the system as it works now.
- `Active Spec`: still useful for ongoing implementation decisions.
- `Implemented`: describes a completed pass and should not be treated as the only current source.
- `Archived`: historical context; verify against code before using it for new work.
