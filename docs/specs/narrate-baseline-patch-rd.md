# Narrate deterministic-baseline plus sparse-patch R&D

Status: R&D evidence — implemented by Narrate v6
Last verified: 2026-07-13
Canonical harness: `tools/narration-rd/run_baseline_patch_v6_experiment.py`
Related implementation spec: `docs/specs/narrate-local-g2p-sparse-patches.md`

Production note: the experiment used Python Misaki 0.9.4 with eSpeak-ng. The implemented extension
uses the already pinned native `misaki-rs` 0.3.0 frontend and exposes its contextual, tagged, OOV,
and technical uncertainty to the same sparse Sol contract. Reviewed recurring names are handled by
a versioned local alias lexicon. This avoids adding a Python runtime or machine-level eSpeak build
dependency while preserving local ownership of every final phoneme and association.

## Decision

Replace the complete model-generated phoneme contract with a deterministic local speech baseline
plus sparse spoken-text corrections from Sol.

Misaki 0.9.4 with its eSpeak-ng fallback must own tokenization, word-level phonemes, and source
alignment. Sol must never return phonemes, offsets, source strings, occurrences, word arrays,
separators, or grouping ranges. The server gives Sol immutable ids for only the pronunciation risks
and summary blocks that it has already identified. Sol may return:

- an audio alias for a risk, such as `lead` in `lead pipe` -> `led`;
- a spoken transcript replacement for a risk, such as `nginx` -> `engine x`;
- natural spoken text for a server-designated code or structure summary block.

This is not a fallback to the pre-v5 Narrate implementation. It is a new authoritative pipeline.
An omitted pronunciation patch deliberately retains the new local baseline. A malformed model
record is rejected through its risk or summary id; it cannot corrupt token counts or source
alignment. A required summary that is absent or invalid fails that group with a precise diagnostic.
There is no checker model, repair turn, prompt retry, or legacy runtime path.

## Why this contract is simpler

The v5 contract asks the model to reproduce the entire spoken document as token records containing
phonemes and provenance. That makes correctness relational: every word, phoneme, separator, block,
and association must agree with every other field. The live failures were consequences of that
surface area, not evidence that another model should check Sol.

The proposed contract makes almost all of the result server-owned:

1. The server extracts Markdown blocks and groups short neighboring blocks.
2. Misaki plus eSpeak builds the complete baseline transcript and phonemes.
3. The server assigns stable word ids and identifies a bounded set of pronunciation risks.
4. Sol receives the original document for context, but it can address only predeclared risk ids and
   predeclared summary block ids.
5. The server applies accepted plain-text aliases or replacements.
6. Misaki plus eSpeak phonemizes replacement text locally.
7. Kokoro synthesizes the resulting server-owned groups.

The model cannot create an invalid phoneme alphabet, split a phoneme array incorrectly, target the
wrong substring occurrence, duplicate punctuation, move a source range, or invent a group. Those
fields are no longer in its output.

## Alignment

Alignment remains available and is stronger than the model-generated version:

- unchanged baseline words keep their exact server word and source ids;
- a risk id owns an ordered source-word range before inference begins;
- every token produced by an alias or transcript replacement inherits that risk's source range;
- generated explanations for code or structure inherit the designated summary block's semantic
  source range.

The final local G2P pass may expand one source span into several spoken tokens, but that is an
explicit many-to-one association owned by the server. The model does not calculate alignment.

## Experimental contract

The input contains the complete ordered document plus server-owned hard groups. Each risk includes
an immutable risk id, its block and source-word ids, source spelling, baseline pronunciation, local
part-of-speech tag, and reason labels. Connected technical expressions such as
`@scope/my_package`, `serde_json::from_value`, and an IP address plus port are a single risk. This
prevents partial replacements from duplicating or verbalizing their punctuation.

The complete model output has this shape:

```json
{
  "v": 6,
  "g": [
    {
      "i": 0,
      "s": [{ "i": 9, "x": "Natural spoken summary." }],
      "p": [{ "i": 15, "k": "a", "x": "led" }]
    }
  ]
}
```

`a` means an audio alias: display/source text remains unchanged and only its locally generated
audio pronunciation changes. `r` means the replacement text is the intended spoken transcript for
the risk. An empty `p` array means the deterministic baseline is already acceptable.

## Local baseline findings

The installed Narrate environment already includes Misaki 0.9.4 and eSpeak-ng through
`espeakng_loader`; no additional runtime was installed for this experiment. The combined baseline
correctly distinguished:

- verb and noun in `Record the record`;
- verb and adjective in `close the close handler`;
- present and past uses of `read`;
- the verb pronunciation of `use`.

It pronounced metal `lead` like the verb and produced merely approximate pronunciations for some
technical and product names. These misses are a much smaller and more suitable model task than
regenerating every phoneme in the response.

Context risk discovery must be conservative. Early prompts exposed all spellings that could be
heterographs, and Sol changed an already-correct `close`. Later input included the local POS tag and
exposed only noun-like `lead` cases, preventing changes to `lead developer` and the verb `lead`.
Production risk detection should therefore combine a small known ambiguity set with local POS and
baseline metadata rather than asking Sol to review every ordinary word.

## Measurements

All inference ran sequentially inside the Remux `research` workload. Raw artifacts are under
`/tmp/narration-baseline-patch-v6`. The Markdown extraction and risk detector are an R&D
approximation, so these numbers establish architectural feasibility rather than release readiness.

| Fixture | Model | Source | First group | Total | Output | Risks / patches | Strict and narratable | Context score |
| --- | --- | ---: | ---: | ---: | ---: | ---: | --- | ---: |
| focused, final prompt | GPT-5.6 Sol | 913 chars | 13.36s | 15.31s | 1,010 B | 41 / 17 | yes | 9/9 |
| core thread response | GPT-5.6 Sol | 5,624 chars | 11.64s | 16.45s | 1,530 B | 102 / 17 | yes | n/a |
| homograph thread response | GPT-5.6 Sol | 9,984 chars | 10.60s | 31.00s | 4,113 B | 201 / 22 | yes | n/a |
| short thread response | GPT-5.6 Sol | 1,555 chars | 11.25s | 12.52s | 683 B | 31 / 9 | yes | n/a |
| focused, connected spans | GPT-5.5 | 913 chars | 4.49s | 7.57s | 1,106 B | 41 / 21 | yes | 7/9 |

The core and homograph runs used the same sparse id-addressed output shape immediately before the
final connected-expression and natural-reading prompt refinements. Both had zero ignored patches,
unsupported phonemes, or structural failures. The final focused Sol run produced natural
replacements including `scope my package`, `sir dee JSON from value`, `engine x`, and `onyx`, while
leaving ordinary prose and already-correct contextual pronunciations untouched.

For directional comparison, the production-shaped complete-phoneme v5 replay returned 35,178 bytes
and took 217.38 seconds on the core response; the sparse run returned 1,530 bytes and took 16.45
seconds. On the homograph response the complete contract returned 67,587 bytes in 406.10 seconds;
the sparse run returned 4,113 bytes in 31.00 seconds. These are prompt-development runs rather than
a controlled listening trial, but the reduction follows directly from no longer asking the model to
restate the complete document and its phonemes.

## Model choice

Keep one model: GPT-5.6 Sol. GPT-5.5 was faster and obeyed the small schema, but it changed
`lead developer` to `led developer` and failed to change metal `lead`, scoring 7/9 where Sol scored
9/9. Earlier contract R&D also found that Terra and GPT-5.5 missed contextual pronunciations that
Sol handled. Chaining a transcript model and a phoneme model would reintroduce relational failure
modes without a measured quality benefit.

Text aliases are still judgment calls. Across prompt-development runs, ONNX received variants such
as `on ex`, `onnix`, and `onyx`; one spelling can also have an unintended dictionary meaning. A
small versioned pronunciation lexicon should therefore own recurring product and project names
whose desired reading is known. Sol handles unseen terms and context-sensitive cases. New aliases
must be promoted into that lexicon only through tests or human review, not automatically from one
generation.

## Streaming production shape

The pipeline should have two lanes over one ordered group stream:

- **Immediate groups:** ordinary prose with no unresolved risks or required summaries can move from
  local G2P to Kokoro immediately, without waiting for Sol.
- **Model-gated groups:** groups containing a designated summary block or unresolved risk wait for
  their small Sol group record, then apply text patches, run local G2P, validate, and synthesize.

Sol still receives the entire document context in one inference request so it can interpret local
terms consistently. Its response streams group records. The server buffers completed records by
group id and commits audio in document order. Later groups may finish while earlier audio plays.

The experiment's thread fixtures were technically dense, so every group happened to be model-gated.
Production should measure the immediate-lane hit rate on a broader response corpus. It should also
cache the versioned lexicon and risk analysis so common terms do not repeatedly require model work.

## Recommended implementation sequence

1. Put Misaki plus eSpeak behind the Narrate server's authoritative word/phoneme interface and add
   golden tests for contextual words, possessives, numbers, initialisms, and supported Kokoro phones.
2. Replace v5 complete-token inference with the v6 id-addressed schema and prompt from this harness.
3. Add deterministic group, risk, connected-expression, POS-gating, and source-range construction.
4. Apply aliases and replacements only by immutable risk id, then locally re-tokenize and phonemize
   the accepted replacement.
5. Add the immediate and model-gated streaming lanes, preserving group order at the audio commit
   boundary.
6. Seed a versioned reviewed lexicon for recurring Narrate/Codex terms and make its pronunciation
   decisions visible in diagnostics.
7. Run repeated real-thread validation and blinded Kokoro listening A/B before considering the new
   path release-qualified.

Acceptance should require zero schema, id, source-range, phone-vocabulary, and ordered-commit errors
on first pass. Pronunciation quality should be scored separately through an annotated challenge set
and listening tests. Structural success alone must not promote a model or alias.
