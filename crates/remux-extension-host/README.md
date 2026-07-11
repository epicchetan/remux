# remux-extension-host

Rust process-launch helpers for trusted Remux extensions.

`remux-extension-host` lets an Extension Server launch an optional child
process as a named, Remux-managed workload without assembling the
`remux workload exec` command by hand. It is a thin launch adapter: Remux owns
workload validation and placement, while the extension continues to own the
child's application protocol and lifecycle.

The crate is private to this repository today and is not published to
crates.io.

## Where it fits

Remux exposes different SDK layers for different jobs:

| Layer | Responsibility |
| --- | --- |
| `@remux/viewer-kit` | WebView RPC, host actions, routes, and viewer UI |
| Extension Supervisor | Starts the extension's declared server, build, and watch processes |
| `remux-extension-host` | Launches optional extension-owned child workloads |
| `remux workload` CLI | Validates ownership and creates the managed systemd scope |

This crate does not implement viewer RPC, register an Extension Server, or
grant an extension additional CPU weight.

## Add the dependency

Use a path dependency while the crate remains private:

```toml
[dependencies]
remux-extension-host = { path = "<path-to-remux>/crates/remux-extension-host" }
```

The library is imported with its Rust crate name:

```rust
use remux_extension_host::WorkloadCommand;
```

## Declare the workload

The owning extension must use manifest version 2 and declare the workload in
`remux-extension.json`:

```json
{
  "version": 2,
  "id": "ledger",
  "resources": {
    "workloads": {
      "runtime": {
        "class": "interactive",
        "lifetime": "extension",
        "threads": "auto"
      },
      "catch-up": {
        "class": "background",
        "lifetime": "operation",
        "threads": 6
      }
    }
  }
}
```

The manifest, not extension code, selects the resource class and lifetime.
Extensions cannot use this API to choose arbitrary systemd units, CPU weights,
CPU sets, or core membership.

## Launch a child

`WorkloadCommand` follows the useful parts of `std::process::Command` and
returns a normal `std::process::Child`:

```rust,no_run
use std::process::Stdio;

use remux_extension_host::WorkloadCommand;

fn start_runtime(session_id: &str) -> std::io::Result<std::process::Child> {
    WorkloadCommand::new("runtime", "ledger-runtime-worker")
        .operation(format!("session:{session_id}"))
        .threads(6)
        .args(["--session", session_id])
        .env("RUST_LOG", "info")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
}
```

This is equivalent to launching:

```text
remux workload exec \
  --workload runtime \
  --operation session:abc \
  --threads 6 \
  -- ledger-runtime-worker --session abc
```

## Runtime flow

When Remux starts an Extension Server, it supplies:

```text
REMUX_EXTENSION_ID
REMUX_EXTENSION_ROOT
REMUX_RESOURCE_PROTECTED
REMUX_WORKLOAD_EXEC
```

`WorkloadCommand` uses `REMUX_WORKLOAD_EXEC` as the wrapper executable and
falls back to `remux` on `PATH` for development. The CLI then:

1. Loads the manifest at `REMUX_EXTENSION_ROOT`.
2. Verifies that its ID matches `REMUX_EXTENSION_ID`.
3. Verifies that the requested workload is declared.
4. Resolves the manifest-owned class, lifetime, and thread default.
5. Clamps an explicit thread request to available machine capacity.
6. Creates a scope below the owning extension's equal-weight parent slice.
7. Replaces the wrapper with the real program.

The resulting process tree is conceptually:

```text
remux-extensions-ledger-<root>.slice
├── Ledger Extension Server
└── runtime workload scope
    └── ledger-runtime-worker
```

Child workloads divide their extension's existing allocation. Creating more
workloads never creates additional top-level extension weight.

## Thread environment

The workload CLI publishes the granted thread count through:

```text
REMUX_WORKLOAD_THREADS
OMP_NUM_THREADS
OPENBLAS_NUM_THREADS
MKL_NUM_THREADS
NUMEXPR_NUM_THREADS
RAYON_NUM_THREADS
ORT_NUM_THREADS
```

Programs should still configure libraries that ignore these variables. The
thread value is a concurrency ceiling, not a promise that every thread will
run simultaneously.

## Current API

`WorkloadCommand` supports:

- a declared workload name;
- a semantic operation ID;
- an optional requested thread count;
- program arguments;
- environment overrides;
- current working directory; and
- stdin, stdout, and stderr configuration.

The returned `Child` retains the usual wait, signal, and output behavior. The
crate does not currently provide a separate cancellation or status client;
extensions use the child handle or the `remux workload` controls.

## Trust and lifecycle boundaries

This is mistake-resistant placement for extensions trusted by the Remux user,
not a hostile same-UID sandbox. The CLI validates manifest ownership and
refuses undeclared background or research work when protected resource mode is
unavailable.

Workload lifetime values are validated today. Stable reusable scopes for every
`extension` and `persistent` lifetime are still part of the broader resource
governance hardening work; callers should not treat the generated systemd unit
name as durable application identity.

## Development

Run the crate checks from the Remux workspace root:

```bash
cargo test -p remux-extension-host
cargo doc -p remux-extension-host --no-deps
```

The platform design and remaining live validation gates are documented in
[`docs/specs/resource-governance-and-l0-5.md`](../../docs/specs/resource-governance-and-l0-5.md).
