---
name: remux-workloads
description: Run CPU-intensive local inference, benchmarks, data generation, parallel research, and other sustained shell computation through Remux-managed workload scopes. Use when a command may consume multiple cores, create native worker pools, run for more than a few seconds at high CPU, or materially affect Remux responsiveness.
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

Do not wrap interactive editors, tiny filesystem commands, or commands whose
cost is already negligible. Do wrap Python/ONNX inference, Cargo benchmark or
test fan-out, model conversion, media generation, and multi-process analysis.

## Interpret execution

- Treat `REMUX_WORKLOAD_THREADS` as the granted concurrency ceiling.
- Configure provider-specific worker counts explicitly when the program ignores
  `OMP_NUM_THREADS`, `RAYON_NUM_THREADS`, or related environment variables.
- Do not run competing benchmark workloads concurrently.
- Report compute time separately from wall time when the workload may have been
  frozen under Remux pressure.
- Use Remux workload status, pause, and cancel controls when available. Do not
  kill unrelated extension processes to stop one operation.

If workload admission fails, surface the reason. Do not silently fall back to
unmanaged heavy execution.
