# Narration streaming/G2P R&D harness

These scripts exercise Codex app-server agent-message deltas with three experimental contracts:

- `run_app_server_experiment.py`: grouped transcript plus phonemes for every speech token;
- `run_sparse_experiment.py`: grouped transcript plus sparse pronunciation overrides;
- `run_phoneme_audit.py`: phoneme-only second stage over an immutable sparse transcript.

The follow-up contract-reliability tools exercise real assistant responses from a Codex session:

- `run_contract_benchmark.py`: compares the production v4 association/phoneme-array contract with
  a split association plus single-token scalar-pronunciation contract;
- `legacy-baseline/`: reproduces the previous full Misaki G2P frontend on focused technical and
  contextual cases;
- `audit_corpus_vocab.py`: audits simple Misaki gold/silver entries against the installed Kokoro
  vocabulary.
- `run_production_v5_benchmark.py`: replays a real assistant response through the implemented
  server-owned-group, token-local complete-phoneme contract without synthesizing audio.
- `run_baseline_patch_v6_experiment.py`: builds a complete local Misaki/eSpeak baseline, gives the
  model only server-owned pronunciation risks and summary ids, applies sparse plain-text patches,
  and locally phonemizes and validates the result.
- `baseline-patch-v6-instructions.txt` and `baseline-patch-v6-schema.json`: candidate prompt and
  structured-output contract for the deterministic-baseline plus sparse-patch experiment.

The measured follow-up and its architectural conclusions are recorded in
`docs/specs/narrate-streaming-g2p-contract-rd.md`.
The later sparse-patch experiment and recommended successor direction are recorded in
`docs/specs/narrate-baseline-patch-rd.md`.
The implemented native-Misaki v6 contract is specified in
`docs/specs/narrate-local-g2p-sparse-patches.md`.

Run model inference through the Remux `research` workload. Results are intentionally written to an
explicit path, normally below `/tmp/narration-rd`, and are not committed. See
`docs/specs/narrate-streaming-g2p-rd.md` for the measured matrix, limitations, and recommendation.

The harness reads the exact `misaki-rs` 0.3.0 US gold/silver corpus installed in Cargo's registry and
validates output symbols against the installed Kokoro vocabulary. It does not modify production
Narrate or Codex behavior.
