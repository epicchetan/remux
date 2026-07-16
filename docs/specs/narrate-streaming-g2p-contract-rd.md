# Narrate streaming contract reliability R&D

Status: Historical R&D evidence — free-text sparse representation superseded inside v5
Last verified: 2026-07-13
Canonical harness: `tools/narration-rd/run_contract_benchmark.py`
Related implementation spec: `docs/specs/narrate-local-g2p-sparse-patches.md`

## Decision

Implementation status: the server-owned grouping, risk metadata, corpus compatibility, and
single-Sol/no-repair decisions below remain implemented in
`docs/specs/narrate-local-g2p-sparse-patches.md`.
The sparse free-text plus occurrence-targeted pronunciation representation did not survive later
live acceptance. On the 9,984-character thread fixture, generated summaries created whole-sentence
association strings and unpronounced technical/numeric words. Production v5 now represents every
spoken word once as a token carrying its phonemes, source provenance, and following separator. That
removes substring occurrences and makes transcript/phoneme alignment structural. Production v6
then returned to sparse *text* patches, but fixed this experiment's ambiguity by assigning every
risk a server-owned ID and running all accepted replacement text back through local Misaki. Sol no
longer emits any phonemes or alignment data.

Keep the one-primary-model, corpus-hinted architecture, but do not ship either the old v4 contract
or the experimental sparse split contract unchanged.

The split contract proved the important cardinality result: a phoneme string must belong to one
server-tokenized word. It removed every phoneme-array cardinality mismatch in this benchmark. The
final implementation takes the stronger form and gives every spoken token—not only sparse
overrides—one scalar phoneme string.

It did not make the complete pipeline reliable. Group/block coverage, strict source-association
completeness, contextual-risk discovery, productive possessives, and corpus/vocabulary compatibility
remain too dependent on unconstrained model output. The next contract must move those obligations
into deterministic or structurally pinned server-owned data. Do not add a checker model or a prompt
retry loop.

## Benchmark scope

The controlled matrix used two actual assistant finals from the active Narrate development thread:

- `core-failure`: the 5,624-character response whose narration exposed the v4 phoneme-count failure;
- `homograph-explanation`: the 9,984-character explanation containing contextual `record`, `lead`,
  `close`, `read`, and `use` examples plus technical names and notation.

Each response was run once through both contracts on GPT-5.6 Sol, GPT-5.6 Terra, and GPT-5.5 at low
effort on Priority service. Sol also had three bounded prompt-development iterations before the
candidate prompt was frozen. Inference commands ran sequentially in the Remux `research` workload.
The raw local artifacts are under `/tmp/narration-contract-bench-20260713`.

The validator reproduces the production Unicode word tokenizer, exact occurrence/boundary checks,
block-prefix coverage, association ownership, corpus resolution, Kokoro vocabulary validation, and
monotonic exact-word source mapping. The Markdown block extractor is an R&D approximation rather
than the production schema-3 renderer, so these results are architectural evidence, not a release
qualification.

## Results

`Struct`, `Align`, `OOV`, and `Phone` are diagnostic error observations. One root mistake can produce
more than one observation, so the counts are not independent defect counts.

| Fixture | Contract | Model | First group | Total | Bytes | Struct | Count mismatch | Align | OOV | Phone | Valid |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| core | v4 | GPT-5.6 Sol | 5.43s | 45.53s | 10,066 | 27 | 13 | 65 | 2 | 0 | no |
| core | v4 | GPT-5.6 Terra | 16.15s | 56.74s | 12,446 | 16 | 0 | 78 | 11 | 0 | no |
| core | v4 | GPT-5.5 | 4.24s | 50.42s | 11,332 | 21 | 0 | 2 | 0 | 0 | no |
| core | split | GPT-5.6 Sol | 5.61s | 37.38s | 9,264 | 4 | 0 | 2 | 2 | 0 | no |
| core | split | GPT-5.6 Terra | 9.59s | 36.43s | 8,765 | 3 | 0 | 9 | 4 | 0 | no |
| core | split | GPT-5.5 | 6.65s | 35.64s | 8,691 | 0 | 0 | 9 | 0 | 0 | no |
| homograph | v4 | GPT-5.6 Sol | 5.57s | 87.80s | 19,952 | 57 | 22 | 106 | 13 | 1 | no |
| homograph | v4 | GPT-5.6 Terra | 6.54s | 59.34s | 14,347 | 14 | 12 | 99 | 30 | 1 | no |
| homograph | v4 | GPT-5.5 | 4.18s | 91.24s | 20,721 | 27 | 3 | 43 | 9 | 1 | no |
| homograph | split | GPT-5.6 Sol | 8.74s | 72.39s | 17,748 | 2 | 0 | 64 | 0 | 1 | no |
| homograph | split | GPT-5.6 Terra | 17.91s | 68.95s | 16,982 | 3 | 0 | 0 | 5 | 1 | no |
| homograph | split | GPT-5.5 | 8.83s | 95.73s | 22,792 | 4 | 0 | 13 | 1 | 1 | no |

Across the six v4 runs there were 50 phoneme-array count mismatches. Across the six split runs there
were zero. The split contract also materially reduced structural and unresolved-word failures, and
Sol's output was smaller and about 18% faster end to end on both fixtures. However, zero of the six
split runs passed all production gates.

## Pronunciation observations

The previous full Misaki frontend was reproduced on focused sentences. It used the noun pronunciation
for both words in `Record the record`, pronounced every `lead` as `leed`, every `close` with an
unvoiced ending, present and past `read` as `reed`, verb `use` as the noun `use`, uppercase `ID` as
`id`, and spelled unfamiliar technical names such as Kokoro letter by letter.

The split Sol run made real improvements. It correctly distinguished the concrete verb/noun sentence
`Record the record` and supplied plausible pronunciations for ONNX, nginx, serde, WKWebView, Misaki,
and other technical terms. Terra and GPT-5.5 did not distinguish the concrete `record` sentence under
the split prompt. Sol still missed `lead pipe` and verb `use`, demonstrating that a corpus hit is not
equivalent to a context-safe pronunciation.

These are phoneme inspections, not listening scores. No blinded Kokoro audio comparison was performed
in this follow-up. Human A/B listening remains required for stress, acronym style, group prosody, and
overall preference.

## Corpus audit

The pinned Misaki corpus is not automatically safe merely because an entry is simple-resolvable.
Auditing it against the installed Kokoro vocabulary found:

| Corpus | Entries | Simple-resolvable | Entries with unsupported symbols |
| --- | ---: | ---: | ---: |
| US gold | 90,201 | 90,162 | 142 |
| US silver | 299,704 | 299,704 | 486 |

There are 617 entries containing the unsupported syllabic-`n` combining mark and 11 containing `ɬ`.
`rewritten` was encountered in both real fixtures and failed Kokoro vocabulary validation. Corpus
loading must normalize only explicitly pinned safe cases and treat every other incompatible entry as
unsafe before inference begins.

## Required next contract

1. Predeclare acoustic groups and their source block membership deterministically. The model may
   rewrite and connect material inside a server-owned group, but it must not invent coverage ranges.
2. Give each source block or server-owned subunit structural provenance inside the group. Exact word
   mapping remains first priority; explicit associations refine changed technical spans; otherwise
   generated connector words inherit an honest block-level target instead of failing the artifact.
3. Keep association records separate from scalar, exactly-one-token pronunciation records. Bind
   pronunciation records through the production tokenizer, not arbitrary substring containment.
4. Mark risky source tokens explicitly. At minimum this includes uppercase initialisms, technical
   semantic ranges, corpus entries with unsupported phones, known heteronyms, and words whose casing
   changes corpus meaning. Require the one primary model to expand or pronounce every marked token.
5. Add deterministic handling for productive possessives when the base pronunciation is known.
6. Audit the complete corpus against the active Kokoro vocabulary at profile build time. Pin safe
   normalization such as the chosen syllabic-`n` representation; reject or mark other entries unsafe.
7. Remove the runtime repair-model path. A failed primary result must report the exact group, source
   unit, token, corpus decision, and rejected pronunciation.

The follow-up model choice remains GPT-5.6 Sol. Terra missed contextual overrides and exceeded the
12-second first-group target on the homograph response. GPT-5.5 was variable, slower on the long
response, and also missed contextual overrides under the split contract. There is no measured benefit
to chaining either model behind Sol.

## Token-local implementation acceptance

A later production-shaped replay exercised the 9,984-character `homograph-explanation` response
with server-owned groups and complete token-local phonemes. It streamed 40 groups, produced the
first complete group in 26.98 seconds, completed in 406.10 seconds, and returned 67,587 bytes. The
larger terminal time is compatible with progressive playback: later groups are generated while the
already committed audio plays.

The run eliminated the earlier phrase occurrence, association cardinality, override occurrence,
and output-introduced OOV failures. Contextual `Record the record` uses distinct verb and noun
phones, the lead summary distinguishes “leed” from metal “led,” and technical names such as ONNX,
nginx, SQLite, serde, WKWebView, Misaki, and Kokoro all received explicit phones.

Two remaining root mistakes were local to individual token fields:

- a plural suffix was placed in separator `z` as `"s, "`;
- one generated hyphenated word put two lexical phoneme strings in `p`, separated by whitespace.

The final schema closes both shapes directly: `z` is an enum of whitespace/prosody separators and
`p` has a non-whitespace/non-prosody pattern. The redundant source-risk decision map was also
removed. With mandatory `p` on every spoken token, risk labels can remain model guidance instead of
a parallel completeness contract. This reduces first-group output and removes another relational
model obligation. No checker, repair turn, prompt retry, or legacy fallback was added.

A final 5,650-character core replay used that exact no-decision-map schema. It streamed 19 groups,
completed its first group in 19.64 seconds, finished in 217.38 seconds, and returned 35,178 bytes.
The schema-level `p` pattern and `z` enum were accepted by structured output and the token stream had
no shape, pronunciation, provenance, grouping, or alignment errors. Sol naturally omitted two
trailing implementation filenames while preserving the complete spoken sentences. The final
validator therefore validates the speech Sol produced, rather than falsely requiring every risky
source token to be spoken.

## Release evidence still required

- repeat the structurally pinned contract on all real thread fixtures, with at least three repeats on
  the core failure and contextual challenge documents;
- require 100% first-pass validator success with no model repair;
- annotate acceptable pronunciations for the contextual and technical target set;
- synthesize the same selected groups through the production Kokoro model and voice;
- conduct blinded A/B listening for pronunciation, intelligibility, grouping, semantic fidelity, and
  overall preference;
- verify source highlighting and playback continuity in the real Narrate UI.
