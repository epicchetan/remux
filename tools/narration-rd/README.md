# Narration streaming/G2P R&D harness

These scripts exercise Codex app-server agent-message deltas with three experimental contracts:

- `run_app_server_experiment.py`: grouped transcript plus phonemes for every speech token;
- `run_sparse_experiment.py`: grouped transcript plus sparse pronunciation overrides;
- `run_phoneme_audit.py`: phoneme-only second stage over an immutable sparse transcript.

Run model inference through the Remux `research` workload. Results are intentionally written to an
explicit path, normally below `/tmp/narration-rd`, and are not committed. See
`docs/specs/narrate-streaming-g2p-rd.md` for the measured matrix, limitations, and recommendation.

The harness reads the exact `misaki-rs` 0.3.0 US gold/silver corpus installed in Cargo's registry and
validates output symbols against the installed Kokoro vocabulary. It does not modify production
Narrate or Codex behavior.
