# Remux

CLI, Expo shell, and extension runtime for small embeddable Remux viewers. The first extension is Codex.

## Development

Install dependencies:

```bash
npm install
```

Build the extension viewers:

```bash
npm run viewers:build
```

Start the Remux runtime and extension servers:

```bash
npm run dev
```

The CLI owns the public Remux websocket at `/ws` and serves built extension viewers under `/viewers/*`. Extensions are discovered from `extensions/*/remux-extension.json` by default. During viewer development, run `npm run viewers:watch` in a separate terminal to keep `viewer/dist/` updated, then use the app reload button to load the latest built files. Start Expo manually from `app/` when changing the native app shell.

Extension manifests use only Node's built-in JSON support. The server side is a command launched by Remux, currently over newline-delimited JSON-RPC on stdio. The Codex extension server is implemented in Rust and exposes a batch read API over that transport:

```json
{
  "id": "codex",
  "server": {
    "transport": "stdio",
    "command": "cargo",
    "args": [
      "run",
      "--manifest-path",
      "server/Cargo.toml",
      "--offline",
      "--quiet",
      "--"
    ],
    "cwd": "."
  },
  "views": {
    "main": {
      "route": "/viewers/codex",
      "entry": "viewer/dist/index.html"
    }
  }
}
```

## Structure

- `app/` contains the Expo app shell.
- `bin/` contains the root Remux CLI entrypoint.
- `cli/` contains CLI tests and root CLI support code as it is extracted.
- `extensions/codex/` contains the DOM Codex viewer, transcript renderer, Codex state provider, Codex server adapter, generated protocol bindings, and JSON schemas.

## Testing

```bash
npm run typecheck
npm run test:cli
npm run test:codex-server
npm run test:codex
```

## Codex Protocol

- TypeScript bindings live in `extensions/codex/shared/protocol/`.
- JSON Schema output lives in `extensions/codex/shared/schema/`.
- The bundled v2 schema is `extensions/codex/shared/schema/codex_app_server_protocol.v2.schemas.json`.
