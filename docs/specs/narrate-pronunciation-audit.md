# Narrate post-transcript Misaki review v4

Status: Implemented
Last revised: 2026-07-18
Depends on: `docs/specs/narrate-batch-alignment.md`
Companion: `docs/specs/narrate-structural-transcripts.md`
Canonical code: `crates/remux-tts/src/alignment.rs`,
`crates/remux-tts/src/pronunciation.rs`,
`extensions/narrate/server/src/pronunciation_audit.rs`,
`extensions/narrate/server/prompts/pronunciation-audit-v4.txt`, and
`extensions/narrate/server/schemas/pronunciation-audit-output-v4.json`

## Outcome

Narrate reviews pronunciation only after the complete private speech document exists.

```text
assistant Markdown
  -> Codex Markdown blocks (NarrationDocumentV1)
  -> text-only Sol transcripts for code, tables, and diagrams
  -> complete private speech document
  -> contextual Misaki baseline for every spoken word
  -> bounded Sol pronunciation-review windows
  -> sparse, Kokoro-vocabulary-safe corrections
  -> one reviewed pronunciation plan
  -> NLP-aware acoustic chunks
  -> Kokoro waveform and native durations
  -> source-owned NarrationArtifactV4 and one WAV
```

The ordering is strict. Transcript generation and pronunciation review are not independent and do
not run concurrently. A word authored by the transcript stage must pass through the same Misaki and
Sol review path as a word copied from an ordinary Markdown block.

## Documents and coordinate spaces

The source document is the immutable `NarrationDocumentV1` supplied by the Codex extension. Its
block ids, exact source text, block kinds, highlight modes, and UTF-16 offsets remain authoritative
for the public artifact and UI highlighting.

The private speech document is created by replacing only block-highlight `code`, `table`, and
`diagram` block text with their validated Sol transcripts. Paragraphs, headings, list items, and
blockquotes retain exact source text.

Private transcript offsets are never exposed to the UI:

- text-highlight blocks retain source word and sentence cues;
- structural blocks expose block timing and one source-owned sentence range;
- structural blocks expose no private transcript word cues.

## Misaki baseline

Narrate runs pinned `misaki-rs 0.3.0` over each complete private speech block. It does not phonemize
isolated source words or transcript fragments.

Before G2P, Narrate establishes deterministic word identities and grapheme-aware mappings. Misaki
tokens must anchor monotonically and associate with exactly one word. Token drift, cross-word token
ownership, missing word ownership, or invalid source ranges are immediate mechanical failures and
cannot be repaired by Sol.

Every baseline word contains:

- a global, source-ordered `wordId`;
- private block, sentence, byte, and UTF-16 ownership;
- exact spoken text;
- Misaki POS tags;
- baseline status;
- raw Misaki phone runs; and
- an unresolved reason when applicable.

Baseline states are:

- `resolved`: every lexical token has nonempty phones supported by the active Kokoro vocabulary;
- `unresolved/missingPhones`: Misaki emitted no usable phones;
- `unresolved/unresolvedMarker`: Misaki emitted its unknown marker;
- `unresolved/unsupportedSymbol`: Misaki emitted at least one scalar outside Kokoro's vocabulary.

Raw nonempty Misaki output is retained even when unsupported. This lets Sol see, for example,
`rewritten -> ɹᵻɹˈɪʔn̩ -> unsupportedSymbol` and repair the incompatible symbol instead of guessing
from an empty field.

## Review input

Each Sol request receives one bounded JSON audit window containing:

- `version` and `windowId`;
- `phoneAlphabetVersion`;
- `allowedPhoneSymbols`, the exact server-approved lexical subset of the Kokoro vocabulary;
- read-only heading, previous, and next context halos;
- exact private speech core text and block kind; and
- every editable word with id, block id, sentence id, spelling, tags, baseline status, raw baseline
  phones, and unresolved reason.

Sol receives every core word, not only words selected by heuristics. This is important for generated
transcripts: a normal-looking word may still expose a stale or incompatible Misaki lexicon entry.

Context text is untrusted content. It never changes the response schema or review instructions.

## Review output

The strict Structured Output is:

```json
{
  "version": 4,
  "windowId": 0,
  "phonemePatches": [
    { "wordId": 37, "phones": "ɹiɹˈɪʔn" }
  ]
}
```

Output is sparse:

- omitting a resolved word accepts Misaki;
- every unresolved word must receive a direct patch;
- a direct patch replaces the entire word pronunciation;
- patch ids must be unique, ascending, and inside the current window.

Sol cannot return text replacements, offsets, timing, explanations, confidence, alignments,
acoustic boundaries, or a complete phone ledger.

## Kokoro safety boundary

The checked-in response schema restricts direct phone strings to the server-owned lexical alphabet.
The server independently validates every scalar against both that alphabet and the active Kokoro
vocabulary. It also enforces normalization, nonempty lexical content, and the per-word symbol limit.

Consequently, a semantically imperfect but alphabet-valid Sol pronunciation may sound imperfect,
but it cannot introduce an unknown Kokoro token. Kokoro safety is mechanical; pronunciation quality
is the model's review judgment.

The server does not run G2P over a Sol patch. A patch is already final phone input.

## Plan validation

The canonical reviewed-pronunciation plan binds:

- the private speech-document hash;
- the complete Misaki baseline hash;
- reviewer model/profile digest;
- prompt, output-schema, window-planner, alphabet, and validator versions;
- active Kokoro vocabulary hash;
- every audit-window input and canonical output hash; and
- every sparse correction with a word fingerprint and patch hash.

Before starting Kokoro work, the server applies the finished plan to a fresh clone of the baseline.
This proves that every unresolved word was corrected and every final phone run is legal. The compute
worker independently reconstructs the private speech document and Misaki baseline from the source
document plus transcript plan, validates the same pronunciation plan, and only then plans audio.

There is no trusted opaque phone ledger crossing the worker boundary.

## Long responses

Audit units follow private speech sentences and split only between words. Windows are bounded by:

- at most 500 editable words;
- normally at most 4,000 core UTF-16 units;
- at most 20 core blocks;
- at most 1,024 UTF-16 context units; and
- at most 96 KiB encoded input.

Natural punctuation and clause boundaries are preferred when a sentence must split. Structural
block transitions force audit-window boundaries but never create acoustic pauses or public
highlight boundaries.

At most three audit windows run concurrently. Every transcript window finishes before any audit
window starts. Every audit window finishes before acoustic planning or Kokoro model loading.

## Failure policy

The following are hard failures:

- failed, cancelled, refused, malformed, or profile-mismatched model output;
- changed window or block identity;
- duplicate, unordered, or out-of-window word ids;
- invalid or oversized phone strings;
- an omitted unresolved word;
- plan, baseline, vocabulary, profile, or hash drift; and
- any source/token alignment invariant violation.

An unchanged direct patch for a resolved word is harmless and is canonically omitted. It is counted
as redundant diagnostics rather than failing narration.

There is no repair model, checker model, automatic retry, old-pipeline fallback, compatibility
reader, or feature switch. Git history is the rollback mechanism.

## Cache and artifact

The artifact key includes both model-stage profiles and all model assets. The cache namespace is
`batch-alignment-v4-post-transcript-direct-review`; earlier experimental artifacts are not read.

An atomically published cache directory contains exactly:

- `audio.wav`;
- `manifest.json`;
- `pronunciation-plan.json`;
- `source-document.json`; and
- `structural-transcript-plan.json`.

`NarrationArtifactV4` binds both plan hashes while retaining source-document ownership for playback
and highlighting.

## Acceptance coverage

Required gates include:

- strict schemas with item definitions for every array;
- exact input alphabet exposure and output alphabet validation;
- complete word/window partitioning without truncation or duplication;
- raw unsupported Misaki phone retention;
- a generated structural `rewritten` regression that is repaired after Misaki;
- rejection of omitted unresolved words;
- canonical omission of unchanged resolved patches;
- cached-plan reconstruction against the projected speech document;
- worker-side reconstruction and validation;
- structural block-level source highlighting with no leaked transcript offsets;
- Rust unit tests, schema fixtures, Codex typecheck, route tests, and viewer cue tests; and
- real-stack transcript, Misaki, Sol, Kokoro, WAV, cache, playback, and highlight verification.
