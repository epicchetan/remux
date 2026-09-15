---
name: remux-workloads
description: Run deliberately heavy, sustained multi-core compute (local model inference, benchmarks, bulk data generation, media conversion) through Remux-managed workload scopes. Rarely needed. Never use for project test suites, typecheck, builds, npm scripts, or anything under a few minutes of ordinary CPU.
---

# Remux Workloads

Keep ordinary lightweight shell commands unchanged. Place deliberate heavy
compute in the Codex `research` workload so it cannot starve the Remux app or
other extensions.

## Run heavy work

1. Inspect capacity with `remux workload capacity` when available.
2. Choose a thread count no larger than the reported capacity. Use fewer cores
   for benchmarks that need stable measurements.
3. Give the operation a short, unique semantic name.
4. Execute the real command after `--`:

```bash
remux workload exec \
  --workload research \
  --operation codex-rd:<task-name> \
  --threads <n> \
  -- <program> <args...>
```

Do not wrap interactive editors, filesystem commands, `npm run` scripts,
project test suites (node --test, Playwright, cargo test), typecheck, or builds.
Those run directly, unwrapped, always. Do wrap Python/ONNX inference, benchmark
fan-out, model conversion, media generation, and multi-process analysis that
would otherwise saturate every core for minutes.

## Interpret execution

- Treat `REMUX_WORKLOAD_THREADS` as the granted concurrency ceiling.
- Configure provider-specific worker counts explicitly when the program ignores
  `OMP_NUM_THREADS`, `RAYON_NUM_THREADS`, or related environment variables.
- Do not run competing benchmark workloads concurrently.
- Report compute time separately from wall time when the workload may have been
  frozen under Remux pressure.
- Use Remux workload status, pause, and cancel controls when available. Do not
  kill unrelated extension processes to stop one operation.

If workload admission fails (for example `Failed to connect to bus`), report
the reason once. For anything that is not genuinely heavy compute, just run the
command directly; do not treat a wrapper failure as a reason to skip
verification.
