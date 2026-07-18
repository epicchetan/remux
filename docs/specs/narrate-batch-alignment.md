# Narrate batch source alignment v1

Status: Implemented — v1 contract
Last verified: 2026-07-17
Extended by: docs/specs/narrate-pronunciation-audit.md and
docs/specs/narrate-structural-transcripts.md (implemented)
Target code: `extensions/codex/viewer/transcript/components/markdown/markdownModel.ts`,
`extensions/codex/viewer/narration/`, `extensions/codex/shared/narration.ts`,
`extensions/narrate/server/`, and `crates/remux-tts/`
Replaces: the alignment, grouping, timing, and progressive-segment portions of
`docs/specs/narrate-local-g2p-sparse-patches.md`

## Outcome

Codex sends Narrate an ordered document of exact rendered block text. Narrate owns every later
decision: contextual Misaki G2P, word association, sentence segmentation, prosody normalization,
acoustic grouping, Kokoro inference, duration projection, and construction of one final WAV.

The completed artifact contains direct word and sentence ranges against the original block text and
integer sample ranges against the final WAV. Acoustic chunks are private implementation details.
They may combine several sentences or split one oversized sentence without changing highlighting.

```text
assistant Markdown
  -> Codex Markdown AST
  -> exact block text + stable block ids
  -> NarrationDocumentV1
  -> source words + source sentences + anchored Misaki tokens
  -> source-owned Kokoro phoneme-symbol ledger
  -> private acoustic chunks (at most 450 symbols each)
  -> Kokoro waveform + native duration output
  -> global word and sentence sample ranges
  -> one WAV + NarrationArtifactV1
  -> Codex-owned playback and painting
```

Misaki is authoritative for pronunciation and POS-aware G2P. It is not an aligner: `misaki-rs`
`MToken` values do not contain source offsets, and the crate does not populate their timestamp
fields. Remux therefore owns the deterministic mapping from Misaki tokens back to the exact source
block and from Kokoro duration values forward to final-WAV samples.

## Decision

1. The exact `text` of each input block is the only public source coordinate space.
2. Public text offsets are zero-based, half-open UTF-16 code-unit offsets relative to one block.
3. Codex does not precompute words, sentences, target ids, or acoustic groups.
4. Narrate creates versioned source-word ranges from exact block text before normalization or G2P.
   Foreground highlighting is exactly one source word: never a subword and never a multi-word
   phrase.
5. Narrate runs Misaki before acoustic chunking so chunk boundaries cannot change pronunciation or
   source association.
6. One or more contextually generated Misaki tokens may contribute phones to one source word. Misaki
   is never invoked independently for each word.
7. Source sentences and acoustic chunks are separate entities. A sentence never crosses a source
   block; an acoustic chunk may cross blocks. A sentence may span several acoustic chunks.
8. Every Unicode scalar sent to Kokoro is emitted through an internal ownership ledger. The server
   never builds a phoneme string and later tries to recover its word association.
9. Oversized-sentence planning uses Unicode sentence boundaries, exact punctuation, Misaki POS tags,
   grammatical no-split rules, and global scored packing over exact phoneme counts.
10. Kokoro's duration output from the same inference that generated the audio is the timing source.
   There is no ASR pass, checker model, forced aligner, or repair inference.
11. Narrate publishes no partial audio or partial alignment. Only one completely validated WAV and
   manifest become visible.
12. Codex owns the `HTMLAudioElement`, loading/error state, playback controls, cue resolution,
   highlighting, seeking, and virtualizer focus.
13. A mapping or timing inconsistency fails preparation with a precise diagnostic. There is no
    fuzzy alignment, isolated-word retry, block-level downgrade, or old-pipeline fallback.

## Scope

This specification defines:

- the source document fields needed for alignment;
- all internal coordinate systems and ownership records;
- deterministic source-word segmentation;
- strict Misaki-token-to-source association;
- sentence construction;
- internal acoustic planning under Kokoro's input limit;
- projection of native Kokoro durations into word and sentence timing;
- the public alignment artifact consumed by Codex;
- validation, failure behavior, and required fixtures.

This version does not define:

- Sol or any other model-generated pronunciation correction;
- a reviewed pronunciation lexicon;
- model-generated code, table, or diagram summaries;
- generation streaming or partial audio playback;
- extension-owned playback;
- cross-block source sentences;
- persistence of the active playback session across app restarts.

## Terminology

**Source block**
: One ordered leaf block produced by Codex's Markdown parser. Its `text` is exactly the logical text
  registered by the renderer for highlighting.

**Source range**
: A block id plus a half-open range in that block's exact text.

**Source sentence**
: A UI context range wholly contained in one source block. It is independent of Kokoro calls.

**Source word**
: The only foreground highlight unit: one exact displayed-word range constructed from original
  block text. One source word may own phones from several Misaki tokens or from a token whose
  pronunciation expands into several spoken words.

**Misaki token**
: One ordered token returned by contextual full-block G2P. It is private linguistic evidence, not a
  public highlight unit.

**Acoustic atom**
: An ordered string of final Kokoro symbols with immutable source-sentence ownership and optional
  source-word ownership.

**Acoustic chunk**
: A contiguous slice of acoustic atoms synthesized in one Kokoro invocation. Chunks are never
  exposed in the public artifact.

**Word cue**
: A foreground highlight cue for exactly one source word. It may cover the aggregate audio of
  several internal tokens or spoken-word expansions, but never less or more source text than that
  word.

**Sentence cue**
: The background/context highlight and seek range for one source sentence.

## Public source document

Codex continues to receive and store an assistant response as a Markdown string. The existing
Markdown parser remains in the viewer and is used once to derive both layout and this narration
document. Narrate never receives or parses Markdown.

```json
{
  "schemaVersion": 1,
  "offsetEncoding": "utf16CodeUnit",
  "blocks": [
    {
      "id": "md:0",
      "kind": "heading",
      "text": "Alignment and acoustic chunking",
      "highlightMode": "text"
    },
    {
      "id": "md:1",
      "kind": "paragraph",
      "text": "Misaki produces phonemes. Kokoro produces audio and durations.",
      "highlightMode": "text"
    },
    {
      "id": "md:2",
      "kind": "code",
      "text": "startNarration(document)",
      "highlightMode": "block"
    }
  ]
}
```

The schema is strict and uses `additionalProperties: false` at every object. All declared fields are
required.

### Block rules

- `id` is a nonempty stable renderer id and is unique within the document.
- Input array order is source and playback order.
- `kind` is one of `paragraph`, `heading`, `listItem`, `blockquote`, `code`, `table`, or `diagram`.
- `text` is exact logical display text, not Markdown source. Empty/whitespace-only blocks are absent.
- `highlightMode: "text"` permits returned word and sentence ranges.
- `highlightMode: "block"` permits only the full trimmed block range and emits no word cues.
- Prose, headings, list items, and blockquotes use `text` highlighting.
- Code, tables, and diagrams use `block` highlighting in v1.
- Rules and non-text media are omitted.

The input does not include the raw Markdown, thread id, turn id, assistant-message id, message
revision, words, sentences, inline ranges, target ids, or pronunciation hints. Codex retains its
message identity locally as the playback target. Narrate computes a SHA-256 document hash from the
canonical validated block document.

## Coordinate systems

The implementation uses four distinct coordinate systems. They must have separate Rust newtypes or
equivalent wrappers; plain `usize` values must not cross module boundaries without an explicit
conversion.

| Coordinate | Owner | Use |
| --- | --- | --- |
| source UTF-8 byte | Narrate | Safe slicing of the original Rust block string |
| display UTF-16 code unit | Wire/Codex | DOM text-range resolution |
| Kokoro symbol index | TTS worker | Exact model input and duration ownership |
| PCM sample index | Artifact/Codex | Playback timing in the final WAV |

All ranges are zero-based and half-open: `[start, end)`. Public offsets are never Markdown offsets,
Unicode code-point counts, normalized-text offsets, phoneme offsets, milliseconds, or floating-point
seconds.

Narrate validates that every public UTF-16 boundary corresponds to a valid source Unicode-scalar
boundary. The renderer may split one range across multiple DOM leaves; that does not alter the
source range.

## Immutable source ledger

Narrate first validates the document and creates an immutable source ledger before normalization or
G2P:

```rust
struct SourceBlock {
    index: BlockIndex,
    id: String,
    kind: BlockKind,
    text: String,
    highlight_mode: HighlightMode,
    utf16_len: DisplayUtf16,
}

struct SourceRange {
    block: BlockIndex,
    byte_start: SourceByte,
    byte_end: SourceByte,
    utf16_start: DisplayUtf16,
    utf16_end: DisplayUtf16,
}

struct SourceWord {
    index: WordIndex,
    range: SourceRange,
    text: String,
}
```

Every later source association refers to one of these blocks and ranges. Word and sentence
segmentation, Misaki tokenization, token grouping, acoustic packing, and timing projection may add
records but may not mutate a block's text or an established source range.

### Source-word segmentation

Narrate constructs source words from each exact original block before G2P normalization. The
segmenter is deterministic and versioned. It starts from Unicode letter/number word boundaries and
coalesces connected expressions that users perceive as one displayed word:

- apostrophes and possessives, such as `don't` and `Codex's`;
- hyphenated, underscored, and dotted alphanumeric forms, such as `state-of-the-art`, `foo_bar`,
  `live_transcript.rs`, `v2.1`, and `A.B`;
- formatted numeric expressions, including a unary ASCII plus, ASCII hyphen-minus, or Unicode
  minus sign; a directly attached currency symbol on either side of that sign; grouping and decimal
  separators; and a directly attached percent sign, such as `-32000`, `+42`, `−3.14`,
  `-$10,000.50`, `$-10,000.50`, and `42%`. A sign immediately following an alphanumeric operand,
  percent sign, closing bracket, or another sign remains a separator, so `10-20` produces the two
  source words `10` and `20` rather than `10` and `-20`;
- recognized URL and email forms that contain no source whitespace.

A source word never crosses whitespace. Sentence punctuation, surrounding quotes/brackets, and
unconnected decoration are excluded from its range. Every range is recorded in source UTF-8 bytes
and display UTF-16 code units, is nonempty, and is disjoint from every other source word.

The segmenter operates identically for every highlight mode. `highlightMode: "block"` suppresses
public word cues but does not change contextual G2P or internal word ownership. If a text-highlight
block contains alphanumeric source text that cannot be segmented into valid ordered words,
preparation fails rather than weakening the foreground highlight contract.

## Anchored Misaki frontend

Remux currently pins `misaki-rs` 0.3.0 with `default-features = false`. This is MicheleYin's native
Rust port, not Hexgrad's Python Misaki. Its optional eSpeak fallback is disabled; its lexicon,
English rules, POS tagger, numeric expansion, and built-in unknown-word behavior form the complete
phonemization provider for this version.

The exact crate version and feature set participate in artifact identity.

### Why an adapter is required

`MToken` contains token text, a POS tag, a synthetic whitespace string, optional phonemes, and
optional timestamps. It has no source offset. `G2P::g2p` does not populate timestamps. Its tokenizer
also creates every subtoken with one trailing ASCII space, regardless of the original whitespace.

Therefore:

- `MToken.whitespace` is never used as source or prosody truth;
- `MToken.start_ts` and `MToken.end_ts` are never read;
- returned token text is associated before tokens with empty phonemes are removed;
- source whitespace and punctuation are reconstructed from the exact block text;
- alignment is not inferred from a later global search for token spelling.

### Normalization map

The G2P wrapper currently converts smart apostrophes to ASCII, applies NFKD, and drops combining
marks. This can change UTF-8 byte length, Unicode-scalar count, and UTF-16 length. The new adapter
must build a reversible association while applying the same normalization.

1. Iterate the original block by extended grapheme cluster.
2. Record each cluster's original UTF-8 byte and UTF-16 range.
3. Apply the exact versioned G2P normalization to that cluster.
4. For every emitted normalized scalar, record the original cluster range that produced it.
5. If a cluster emits no scalar, attach it to the adjacent surviving source boundary so public
   ranges still expand to complete grapheme-cluster boundaries.

The result is a normalized string plus a monotonic map from each normalized scalar boundary back to
the original source block.

### Strict token walk

Narrate calls Misaki on a complete normalized prose block, not on individual words and not on
already-planned acoustic chunks. This retains the largest available POS and heteronym context.

The full ordered `MToken` stream is then anchored as follows:

1. Start a cursor at normalized byte zero.
2. For each returned token, consume only normalized whitespace before the token.
3. Require `token.text` to match exactly at the cursor. A token may not skip non-whitespace input.
4. Record the token's normalized byte range and advance the cursor.
5. After the final token, require the unconsumed suffix to contain only whitespace.
6. Project the normalized token range through the normalization map to an original source range.
7. Expand that range to full original grapheme-cluster boundaries.

Repeated words are safe because the walk is ordered. No `find` from the beginning, case-folded
lexical key, occurrence index, fuzzy match, candidate skipping, or isolated-word G2P is permitted.
Any drift between Misaki's token stream and the normalized block fails with block id, token index,
cursor, and a bounded source excerpt.

### Token-to-word ownership

After every raw token is anchored, Narrate classifies it and assigns lexical phone-bearing tokens to
the already-established source words:

1. A token with no phones remains available for source punctuation and separator reconstruction but
   owns no foreground cue.
2. A punctuation-only token may contribute a supported prosody symbol but has sentence ownership
   only, even when its range is inside a connected source word such as a URL.
3. The original source range of each lexical phone-bearing token must be contained by exactly one
   source word. A token may cover all or only part of that word.
4. Several adjacent Misaki tokens may map to the same source word. Their phones retain returned
   order and all receive that word's ownership.
5. A token whose pronunciation expands into several spoken words, such as an integer, still belongs
   to its one displayed source word. That word stays highlighted for the aggregate pronunciation.
6. A lexical phone-bearing token that intersects zero source words or crosses a boundary between
   source words fails preparation. Narrate does not create a broader cue, split phones heuristically,
   or rerun G2P on isolated text.
7. Every alphanumeric source word must own at least one final lexical phone-bearing token. An
   unvoiced source word is a hard diagnostic rather than a missing highlight.

The source word retains the ordered POS tags of its contributing Misaki tokens. Those tags are
private planning features. They never alter the source range and are never exposed to Codex.

## Sentence construction

Source sentences are created against original block text and anchored source words. They are UI context
units, not synthesis groups.

### Boundary rules

1. A source sentence is wholly contained in one block.
2. Unicode sentence-boundary detection supplies candidate boundaries.
3. False period boundaries are suppressed for a versioned set of abbreviations, dotted initials,
   decimals, semantic versions, URLs, and lowercase continuations.
4. A heading, list fragment, or paragraph fragment without terminal punctuation is one sentence.
5. Leading and trailing whitespace is excluded.
6. Terminal punctuation and adjacent closing quotes/brackets are included.
7. A sentence must contain at least one phone-bearing source word or a block-level speech association.
8. Punctuation-only and emoji-only text produces no sentence. Such a block is absent from the
   timeline; a document with no speech fails as `documentHasNoSpeech`.
9. A `block` highlight-mode block has one sentence spanning its full trimmed text and no word cues in
   the public artifact.

Sentence ids are artifact-local, stable by source order, and have the form
`<block-id>/sentence/<block-local-index>`.

### Sentence timing policy

Every acoustic atom has one sentence owner, including supported punctuation, normalized separators,
and planner-inserted prosody markers. Phone-bearing lexical atoms additionally have a source-word
owner.

After all chunks are rebased into the final WAV:

- a sentence begins at its first owned audible symbol;
- it remains active through its punctuation and any chunk boundary inside that same sentence;
- its public end extends to the next sentence's start when the intervening pause belongs to it;
- the final sentence ends at its last owned sample plus its terminal pause;
- sentence sample intervals are monotonic and non-overlapping;
- a word cue may disappear during punctuation or silence while its sentence stays highlighted.

This yields the intended two-layer UI: a persistent sentence/context paint with a narrower active
word paint on top.

## Acoustic ownership ledger

Narrate constructs the exact Kokoro input through an ownership ledger:

```rust
enum AcousticRole {
    Lexical,
    SourcePunctuation,
    Separator,
    SyntheticProsody,
}

struct AcousticAtom {
    phones: String,
    sentence: SentenceIndex,
    word: Option<WordIndex>,
    role: AcousticRole,
}

struct AcousticSymbol {
    symbol: char,
    sentence: SentenceIndex,
    word: Option<WordIndex>,
    role: AcousticRole,
}
```

Each atom expands into one `AcousticSymbol` per Rust Unicode scalar. Concatenating `symbol` across
the ledger is the only way to build the Kokoro input string. Consequently:

```text
symbol ledger length == final phoneme scalar count == Kokoro content token count
```

Lexical atoms use normalized Misaki phonemes. The separator adapter examines exact original text
between anchored tokens:

- any whitespace run becomes one Kokoro space;
- supported prosody punctuation (`; : , . ! ? — …`) is preserved when present in the active Kokoro
  vocabulary;
- discarded syntax between phone-bearing technical tokens becomes one space so identifiers do not
  collapse into a single accidental word;
- unsupported non-alphanumeric decoration is silent and remains only inside the sentence source
  range;
- an unresolved alphanumeric phoneme marker or unsupported final phoneme is a hard error.

Misaki's synthetic trailing whitespace is never copied into this ledger.

The private plan retains tokens, POS evidence, atoms, and source ownership for diagnostics, but the
public artifact never contains Misaki tokens, POS tags, phonemes, phoneme indices, acoustic atoms, or
chunk ids.

## Acoustic chunk planning

Phonemization and source association finish before chunk planning begins. Planning operates only on
ordered acoustic atoms and immutable boundary metadata.

### Limits and goals

- Kokoro's absolute content limit is 510 Unicode phoneme scalars for the current model wrapper.
- The Narrate operating maximum is 450 final symbols, including lexical phones, spaces,
  punctuation, and synthetic prosody.
- The preferred target is 360 symbols.
- There is no smaller first-chunk target because v1 publishes no streaming prefix.
- Every chunk contains a contiguous, nonempty source-order slice.
- Every acoustic atom appears in exactly one chunk; no atom is duplicated, omitted, or reordered.
- A chunk boundary may occur only between source words. Atoms owned by the same source word are
  indivisible as a group even when that word contains several Misaki tokens.
- A single source word whose complete final symbol group exceeds 450 fails with its block and source
  range unless a future version explicitly defines a spoken form for that technical token.

### Linguistic boundary analysis

The planner may combine adjacent short sentences and compatible blocks in one Kokoro call. It may
split an oversized sentence across several calls while preserving the same sentence id.

It first creates a boundary record between every adjacent pair of source words. The record includes
exact source punctuation and whitespace, block/sentence membership, the ordered Misaki POS tags on
both words, and exact final-symbol counts. Boundary classes, strongest first, are:

1. source sentence boundary;
2. source block boundary;
3. semicolon or colon;
4. comma or em dash;
5. POS-confirmed coordinating, subordinate, relative, or parenthetical clause boundary;
6. emergency inter-word whitespace.

Unicode sentence segmentation and the versioned false-boundary suppression rules establish the
first class. Existing source punctuation establishes classes three and four. Class five uses the
pinned Misaki tag set rather than a spelling-only conjunction list. A boundary before a coordinator,
subordinator, or relative marker is promoted only when bounded POS windows provide clause evidence,
such as a verb-like or modal tag on the applicable side. The POS-family mapping and window rules are
versioned planner data.

The planner rejects normal candidates that separate tightly bound constructions, including:

- two atoms owned by the same source word;
- a determiner from its adjective/noun phrase;
- an adjective from its following noun;
- a modal, auxiliary, negation, or infinitive `to` from its verb;
- a possessive marker from its noun or adjacent parts of one proper name;
- a number from an immediately following unit;
- a preposition from its immediate complement when no stronger punctuation intervenes.

These rules are shallow deterministic NLP, not a dependency parser. Misaki remains the only
linguistic model. If an oversized sentence has no feasible natural candidate, the planner activates
the emergency inter-word tier and scores every otherwise valid source-word boundary with large
penalties for the constructions above. It still never splits a source word.

### Global packing policy

A source sentence whose complete symbol ledger is at most 450 symbols is never split merely to
approach the preferred target. Oversized sentences are split first; the resulting units and intact
short sentences may then be packed together.

Code, table, and diagram blocks force a boundary from neighboring prose. A heading may share a chunk
with the immediately following prose block when the combined plan remains below the preferred
target. Other short prose blocks may be packed together.

The implementation uses bounded dynamic programming or an equivalent global shortest-path plan,
not first-fit or greedy farthest-boundary splitting. Each feasible edge represents one exact chunk
at or below 450 final symbols. Its score combines boundary class, a 300–400-symbol naturalness band,
avoidance of tiny orphan tails, preservation of intact sentences, and POS no-split penalties. Exact
symbol counts are recomputed after any synthetic prosody atom is added. Planner feature mappings,
score weights, and tie-breaking are deterministic and versioned in artifact identity.

### Acoustic seam policy

A chunk boundary is not itself a prosody instruction:

- source punctuation at a chosen boundary remains on the left and supplies the natural ending
  contour;
- sentence and punctuation boundaries receive no generic appended silence;
- an emergency split inside an unpunctuated oversized sentence may append one versioned,
  source-less comma-like prosody atom to the left chunk only after its behavior is validated against
  the pinned model;
- a synthetic atom has sentence ownership and no source-word ownership, participates in the exact
  450-symbol count, and derives its timing from the same Kokoro duration output;
- an internal split preserves the same sentence id on both sides, so the sentence highlight remains
  active while no word is highlighted during its generated pause;
- the concatenator trims only export padding established by the timing fixture and retains all
  duration-owned punctuation/prosody audio. It never inserts an unconditional inter-chunk pause.

Chunk boundaries do not appear in the public schema and may change in a later planner version
without changing the source-alignment model.

## Kokoro timing projection

The pinned ONNX export returns both a waveform and `pred_dur` from the same model invocation. The
upstream model predicts one duration for every input id, and Remux adds one BOS and one EOS id around
the exact phoneme-symbol sequence.

For each chunk the timing projector must validate:

1. every ledger symbol exists in the active Kokoro vocabulary;
2. `1 <= symbol_count <= 450`;
3. `duration.len() == symbol_count + 2` for BOS and EOS;
4. every duration value is positive for the pinned export;
5. the waveform is nonempty and finite;
6. duration-derived content bounds are monotonic and fit the waveform within the pinned export's
   measured padding tolerance.

The installed-model fixture verified the pinned export's model-specific convention across lexical,
whitespace, and punctuation inputs. Every duration unit contributes exactly 600 waveform samples at
24 kHz, and `waveform.len() == sum(pred_dur) * 600`. The content projection trims the first
`max(BOS - 3, 0) * 600` samples and trims from the start of EOS onward. The fixture's frame RMS
confirms that the first audible symbol onset is this three-frame-lookahead boundary, so the first
content symbol begins at retained sample zero rather than at the nominal end of BOS. Every content
symbol then owns exactly `pred_dur[symbol] * 600` samples in order; the retained lookahead tail after
the final symbol remains sentence-owned audio. This verified rule is
`kokoro-duration-projector-v1`; it never round-trips through floating-point seconds or mutates
`MToken` timestamp fields.

The installed-model fixture records:

- input ids and exact symbol owners;
- the complete duration vector;
- waveform sample count;
- predicted content start/end samples;
- leading/trailing padding difference.

The projector accepts no padding tolerance: duration cardinality, positive values, and exact
waveform equality are hard checks. A material mismatch fails timing; the server does not silently
rescale the duration vector or substitute equal word lengths.

The projector creates a local half-open sample interval for every acoustic symbol. A source word's
timing is the smallest continuous interval from the start of its first owned lexical symbol through
the end of its last owned lexical symbol. This deliberately groups multiple Misaki tokens or spoken
expansions under one displayed word. Separators and punctuation between source words have sentence
ownership but no word ownership. Thus word highlighting naturally disappears during an audible
separator while sentence highlighting remains.

## Final-WAV concatenation

Chunks are inferred in source order. Narrate appends each verified, model-padding-trimmed waveform
to a temporary PCM/WAV writer. It does not publish chunk files and does not append a generic
inter-chunk pause.

For every local symbol interval:

```text
global_start = completed_audio_samples + local_start
global_end   = completed_audio_samples + local_end
```

The completed-sample cursor then advances by the retained chunk waveform. A sentence that
spans a chunk boundary retains one sentence id and receives one aggregate public interval. Several
sentences sharing one chunk retain separate sentence ids and intervals.

At completion Narrate finalizes the WAV header and validates its payload sample count before
atomically publishing the artifact directory. Only one WAV exists per narration.

## Public alignment artifact

The final manifest exposes one source coordinate and one audio coordinate:

```json
{
  "schemaVersion": 1,
  "artifactKey": "sha256-...",
  "documentHash": "sha256-...",
  "offsetEncoding": "utf16CodeUnit",
  "audio": {
    "url": "/remux/media/sha256/0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    "mimeType": "audio/wav",
    "sampleRate": 24000,
    "channels": 1,
    "totalSamples": 1250000,
    "sizeBytes": 2500044,
    "sha256": "sha256-..."
  },
  "blocks": [
    {
      "blockId": "md:0",
      "startSample": 0,
      "endSample": 53760
    },
    {
      "blockId": "md:1",
      "startSample": 53760,
      "endSample": 1028880
    },
    {
      "blockId": "md:2",
      "startSample": 1028880,
      "endSample": 1250000
    }
  ],
  "sentences": [
    {
      "id": "md:0/sentence/0",
      "blockId": "md:0",
      "textStart": 0,
      "textEnd": 31,
      "startSample": 0,
      "endSample": 53760
    },
    {
      "id": "md:1/sentence/0",
      "blockId": "md:1",
      "textStart": 0,
      "textEnd": 25,
      "startSample": 53760,
      "endSample": 466080
    },
    {
      "id": "md:1/sentence/1",
      "blockId": "md:1",
      "textStart": 26,
      "textEnd": 62,
      "startSample": 466080,
      "endSample": 1028880
    },
    {
      "id": "md:2/sentence/0",
      "blockId": "md:2",
      "textStart": 0,
      "textEnd": 24,
      "startSample": 1028880,
      "endSample": 1250000
    }
  ],
  "wordCues": [
    {
      "sentenceId": "md:0/sentence/0",
      "blockId": "md:0",
      "textStart": 0,
      "textEnd": 9,
      "startSample": 0,
      "endSample": 16800
    },
    {
      "sentenceId": "md:0/sentence/0",
      "blockId": "md:0",
      "textStart": 10,
      "textEnd": 13,
      "startSample": 18000,
      "endSample": 24000
    },
    {
      "sentenceId": "md:0/sentence/0",
      "blockId": "md:0",
      "textStart": 14,
      "textEnd": 22,
      "startSample": 25200,
      "endSample": 38400
    },
    {
      "sentenceId": "md:0/sentence/0",
      "blockId": "md:0",
      "textStart": 23,
      "textEnd": 31,
      "startSample": 39600,
      "endSample": 51360
    },
    {
      "sentenceId": "md:1/sentence/0",
      "blockId": "md:1",
      "textStart": 0,
      "textEnd": 6,
      "startSample": 58560,
      "endSample": 129600
    },
    {
      "sentenceId": "md:1/sentence/0",
      "blockId": "md:1",
      "textStart": 7,
      "textEnd": 15,
      "startSample": 137000,
      "endSample": 250000
    },
    {
      "sentenceId": "md:1/sentence/0",
      "blockId": "md:1",
      "textStart": 16,
      "textEnd": 24,
      "startSample": 258000,
      "endSample": 430000
    },
    {
      "sentenceId": "md:1/sentence/1",
      "blockId": "md:1",
      "textStart": 26,
      "textEnd": 32,
      "startSample": 475000,
      "endSample": 590000
    },
    {
      "sentenceId": "md:1/sentence/1",
      "blockId": "md:1",
      "textStart": 33,
      "textEnd": 41,
      "startSample": 598000,
      "endSample": 730000
    },
    {
      "sentenceId": "md:1/sentence/1",
      "blockId": "md:1",
      "textStart": 42,
      "textEnd": 47,
      "startSample": 738000,
      "endSample": 820000
    },
    {
      "sentenceId": "md:1/sentence/1",
      "blockId": "md:1",
      "textStart": 48,
      "textEnd": 51,
      "startSample": 828000,
      "endSample": 875000
    },
    {
      "sentenceId": "md:1/sentence/1",
      "blockId": "md:1",
      "textStart": 52,
      "textEnd": 61,
      "startSample": 883000,
      "endSample": 990000
    }
  ],
  "profile": {
    "phonemizer": "misaki-rs-0.3.0-us-no-default-features",
    "sourceMapperVersion": 1,
    "wordSegmenterVersion": 2,
    "sentenceVersion": 1,
    "plannerVersion": 1,
    "timingVersion": 1,
    "synthesizerHash": "sha256-..."
  }
}
```

The schema is strict. The public artifact has no raw Markdown, normalized text, spoken transcript,
Misaki tokens, POS tags, phonemes, target ids, phone offsets, groups, chunks, segments, units,
floating-point seconds, or partial availability fields.

### Artifact semantics

- `blocks` contains only blocks that produced speech, in source order.
- A block interval is the aggregate playback interval of all its sentences, including its terminal
  pause but excluding the next block's first audible symbol.
- `sentences` is source-ordered and audio-ordered. Intervals do not overlap.
- `wordCues` is audio-ordered and source-monotonic. Each entry's source range exactly equals one
  source word; there is no subword or multi-word cue shape.
- One text-highlight source word that produces speech has exactly one word cue, even when several
  Misaki tokens or several spoken words contribute to its audio interval.
- Word cues may have gaps between them during punctuation or pause.
- A block-highlight sentence covers the full trimmed source block and has no `wordCues`.
- All times use the original-speed WAV timeline. Playback-rate changes do not alter cue data.

### Media transport

`audio.url` is the same-origin content-addressed path
`/remux/media/sha256/<64-lowercase-hex>`. Its suffix is exactly `audio.sha256` without the
`sha256-` prefix. Narrate publishes the validated WAV and its metadata sidecar into
`REMUX_MEDIA_DIR` before exposing a ready manifest. A cached narration whose shared media blob was
evicted republishes that blob from its retained validated WAV before returning ready.

Remux serves the path behind its existing authentication middleware and WebView auth cookie. The
handler supports `GET`, `HEAD`, and single byte ranges with immutable private caching. Codex passes
the URL directly to one `HTMLAudioElement`; WAV bytes never enter JSON-RPC, extension stdio, the
React Native message relay, base64, or a JavaScript `Blob`. This is transport of one completed batch
artifact, not generation streaming or partial artifact publication.

## Codex playback and painting

Codex keeps the source document used for the request together with the active assistant-message id.
On each animation frame it computes:

```text
current_sample = floor(audio.currentTime * audio.sampleRate)
active_sentence = binary_search(sentences, current_sample)
active_word_cue = binary_search(wordCues, current_sample)
```

Time ranges are half-open. At an exact boundary the later interval wins. Seeking to a block or
sentence uses its first audible sample.

For a text-highlight block:

1. Resolve the sentence's block-relative UTF-16 range through `textLeafRegistry`.
2. Paint every resulting client rectangle as sentence/context background.
3. Resolve the active source-word range through the same registry.
4. Paint its rectangles as the foreground word layer.

The range may span emphasis, a link, inline code, several line fragments, or several DOM text
nodes. Those renderer splits are irrelevant because every leaf already registers the same logical
block offsets.

For a block-highlight block, Codex paints the existing block frame for the active sentence and does
not attempt a DOM text range.

If the block is virtualized out of the DOM, Codex focuses/materializes it by block id, waits for text
leaf registration, and then paints the same range. The artifact never stores DOM nodes or layout
coordinates.

During punctuation or pause, the sentence layer remains active and the foreground word layer may be
empty. User scrolling can suspend follow behavior without changing cue resolution.

Playback state follows the real media element rather than the last button intent. Codex listens for
`playing`, `pause`, `waiting`, `stalled`, `ended`, and `error`. When the host enters `background` or
`inactive`, Codex pauses the media element and remains paused after foregrounding so mobile autoplay
policy cannot produce a false playing state. Every host resume rereads the active narration resource
because suspended WebViews can miss notifications. A `missing` read caused by a Narrate restart
reissues the same deterministic start request, allowing an atomically cached artifact to rehydrate.
Transient read failures keep the last truthful state and retry; media metadata loading has a bounded
timeout.

## Validation and failure behavior

The complete artifact is accepted only if all invariants hold.

### Source validation

- document hash equals canonical input;
- block ids are unique and preserve input order;
- every source range references an existing block;
- every byte and UTF-16 range is ordered, in bounds, and on a valid boundary;
- source words are nonempty, disjoint, source-ordered, and match the exact segmenter output;
- token association consumes all normalized non-whitespace input exactly once;
- every lexical phone-bearing Misaki token is contained by exactly one source word;
- every alphanumeric source word owns at least one lexical phone-bearing token;
- source-word and sentence ranges are source ordered and non-overlapping within their respective
  collections;
- every word cue range exactly equals its source word and lies inside its parent sentence;
- a text-highlight sentence contains at least one word cue;
- a block-highlight sentence spans the block's full trimmed range and has no word cue.

### Acoustic validation

- every final symbol is supported by Kokoro;
- the symbol ledger and Kokoro content string have identical length and contents;
- every atom and symbol has exactly one sentence owner;
- every lexical symbol has exactly one source-word owner;
- acoustic chunks partition the ledger exactly once and in order;
- every chunk boundary falls between source words and satisfies the recorded linguistic boundary
  decision;
- every chunk has 1–450 symbols;
- duration cardinality and values match the pinned model contract;
- local and global symbol intervals are monotonic and in bounds.

### Artifact validation

- block, sentence, and word-cue sample ranges are ordered and within `audio.totalSamples`;
- word sample ranges lie inside their parent sentence;
- sentence sample ranges do not overlap and preserve source order;
- block ranges aggregate their sentences and preserve block order;
- the WAV is mono PCM at 24 kHz for this profile;
- `audio.totalSamples` exactly matches the WAV payload;
- WAV size and SHA-256 match the manifest;
- the media URL is `/remux/media/sha256/<audio-sha256>` and its hash exactly matches the manifest;
- no manifest or media URL becomes visible before validation and atomic promotion.

Failures use stable codes and include bounded structured context. Initial codes include:

- `sourceSchemaInvalid`
- `documentHasNoSpeech`
- `sourceWordSegmentationInvalid`
- `normalizationMapInvalid`
- `misakiTokenDrift`
- `misakiTokenCrossesWords`
- `sourceWordUnvoiced`
- `unsupportedPhoneme`
- `sourceWordTooLarge`
- `acousticPlanInvalid`
- `durationCardinalityMismatch`
- `durationProjectionInvalid`
- `wavSampleCountMismatch`
- `artifactAlignmentInvalid`

There is no fuzzy recovery after any of these failures. A retry reruns the same versioned pipeline
and should deterministically produce the same result or error.

## Cache and version identity

The artifact key includes the canonical document hash and every behavior that can change audio or
alignment:

- source schema version;
- exact `misaki-rs` crate version and enabled feature set;
- source-word segmentation version;
- G2P normalization version;
- raw-token association and token-to-word ownership version;
- sentence-boundary version;
- source punctuation/separator version;
- POS-family, linguistic-boundary, acoustic-planner, and score versions;
- synthetic prosody and acoustic-seam version;
- Kokoro model, voice, vocabulary, and options hashes;
- timing projector version;
- WAV encoding version.

Thread, turn, assistant-message, and playback-session identities do not participate. Identical block
documents may reuse one artifact while Codex associates it with different rendered messages.

This implementation uses the fresh `batch-alignment-v1-media` cache namespace and reads no v6 or
pre-media v1 manifest. Git history is the only rollback path.

## Required tests

### Markdown/source projection

- the same Markdown produces identical block ids/text across viewport widths and themes;
- emphasis, strong text, links, file links, and inline code preserve logical offsets;
- nested lists and blockquotes produce stable ordered leaf ids;
- tables and code use block highlighting;
- the source document contains no Markdown delimiters that are absent from display text.

### Normalization and Misaki association

- source-word segmentation keeps `don't`, `Codex's`, `state-of-the-art`, `foo_bar`,
  `live_transcript.rs`, `v2.1`, `A.B`, `$10,000.50`, `42%`, signed integers, signed decimals,
  signed currency, URLs, and emails as their expected one displayed word;
- signed-number segmentation distinguishes unary signs from range separators in `10-20`, excludes
  repeated decoration in `--32000`, and covers ASCII plus, ASCII hyphen-minus, and Unicode minus;
- repeated identical words map to distinct ordered occurrences;
- smart and ASCII apostrophes;
- composed and decomposed accents;
- ligatures and graphemes that normalize to several scalars;
- combining-only and zero-output normalization clusters;
- emoji and astral characters before and between words;
- tabs, multiple spaces, soft line breaks, and newlines;
- camel case, percentages, decimals, dates, and integer expansion;
- multiple Misaki tokens inside one contraction or connected expression produce one exact word cue;
- a number that expands into several spoken words produces one exact source-word cue;
- a lexical phone-bearing token spanning two source words fails as `misakiTokenCrossesWords`;
- an alphanumeric source word with no lexical phone-bearing token fails as `sourceWordUnvoiced`;
- punctuation-only and emoji-only blocks;
- injected token-order drift fails rather than aligning approximately.

### Sentences and planning

- `Dr. Smith`, `e.g.`, `v2.1`, decimals, dotted initials, URLs, and lowercase continuation;
- headings and short list fragments without terminal punctuation;
- closing quotes/brackets remain in the sentence source range;
- several short blocks share one acoustic chunk without merging sentence identity;
- a sentence at or below 450 exact symbols is never split to satisfy a preferred target;
- one sentence above 450 symbols spans several chunks but emits one sentence cue;
- clause splitting prefers punctuation and POS-confirmed clause boundaries over emergency whitespace;
- a conjunction without surrounding clause evidence is not automatically promoted;
- determiner/noun, adjective/noun, auxiliary/verb, infinitive/verb, possessive/name, number/unit, and
  preposition/complement fixtures do not split at the prohibited boundary;
- global planning avoids an orphan tail that greedy farthest-boundary packing would create;
- an emergency split adds only its versioned source-less prosody atom and preserves sentence
  identity;
- a pathological source word above 450 returns `sourceWordTooLarge`;
- every planned chunk independently recomputes to at most 450 exact symbols;
- structural blocks are isolated from neighboring prose.

### Timing and artifact

- installed-model duration cardinality equals exact symbols plus BOS/EOS;
- spaces, punctuation, and BOS/EOS padding have golden integer-sample projections;
- source punctuation has sentence but no word ownership;
- several Misaki token intervals aggregate to one continuous source-word interval;
- an emergency synthetic-prosody interval keeps sentence continuity without extending a word cue;
- an ordinary chunk seam appends no generic silence and retains source punctuation on the left;
- several sentences in one chunk retain separate intervals;
- every spoken text-highlight source word produces exactly one cue with the identical UTF-16 range;
- all word cues stay inside their sentence after global rebasing;
- final WAV sample count, byte size, and hash validate;
- corrupted duration, cue, or WAV fixtures fail with the intended stable code.

### Codex integration

- sentence and word layers paint simultaneously;
- a multi-leaf sentence range paints all expected rectangles;
- punctuation/pause clears only the word layer;
- exact cue boundaries select the later cue;
- tap-to-seek uses block/sentence start samples;
- playback rate does not shift highlighting;
- virtualized blocks materialize and repaint without changing ranges;
- code/table/diagram use block-only highlighting;
- one completed media URL is loaded and no chunk audio API is called;
- native media pause/waiting events cannot leave the UI in a false playing state;
- backgrounding pauses playback and foregrounding requires explicit user resume;
- foregrounding rereads a resource that became ready without delivering a notification;
- a `missing` resource after a Narrate restart rehydrates through the deterministic start request;
- the opt-in real-stack suite runs the actual supervisor, Codex server, Narrate server, Misaki,
  Kokoro, final WAV decoding, playback clock, and highlight paint through the authenticated bridge.

## Implementation sequence

1. Add checked-in JSON Schemas and valid/invalid fixtures for `NarrationDocumentV1` and
   `NarrationArtifactV1`.
2. Refactor the Codex Markdown model so layout and narration projection share one parsed document.
3. Replace target-id generation with exact block text, `highlightMode`, and direct range resolution.
4. Add coordinate newtypes, immutable source blocks, the versioned source-word segmenter, and
   grapheme-aware normalization maps.
5. Replace `EnglishG2p::phonemize` with an anchored full-token API and strict ordered association.
6. Add strict token-to-source-word ownership and versioned source sentence construction.
7. Build the acoustic atom/symbol ledger and exact separator normalization.
8. Retain Misaki POS evidence and implement the non-streaming linguistic-boundary analyzer and
   globally scored planner.
9. Replace `join_timestamps` with the validated integer-sample duration projector.
10. Implement the measured padding and acoustic-seam policy, synthesize private chunks into one
    temporary WAV, and build the complete alignment artifact.
11. Simplify the Codex audio engine to one `HTMLAudioElement` and direct sentence/word cues.
12. Add artifact validation, media publication, cache identity, and all integration fixtures.
13. Cut over the viewer and Narrate server together, then delete the v6 streaming/model/target
    pipeline without a compatibility adapter or feature switch.

## Acceptance criteria

Implementation is complete only when:

1. Every lexical phone-bearing Misaki token is associated through the normalization map with exactly
   one pre-established source word; there are zero fuzzy, cross-word, or isolated-word associations.
2. Every Kokoro content symbol has immutable sentence ownership and every lexical symbol has exact
   source-word ownership before inference.
3. Sentence identity is unchanged when the planner combines or splits acoustic chunks.
4. Every chunk remains at or below 450 exact final symbols, the worker enforces the same bound, and
   no chunk boundary splits a source word.
5. Duration cardinality is exact; no timing loop silently truncates or supplies broad default times.
6. Every spoken text-highlight source word has exactly one word cue with its identical valid UTF-16
   range; the artifact supports neither subword nor multi-word foreground cues.
7. All word and sentence cues use integer final-WAV samples. Sentence highlighting remains visible
   through punctuation and artificial internal seams while word highlighting follows only its owned
   lexical audio.
8. One final WAV and one complete manifest are atomically published; no partial artifact is readable.
9. Long-sentence fixtures prove the planner uses POS-confirmed natural boundaries, preserves the
   prohibited constructions, avoids greedy orphan tails, and emits no unconditional seam pause.
10. The real-thread fixture suite produces zero schema, source-association, planning, duration,
    range, and artifact-validation failures on first pass.
11. The old streaming/model-generated alignment path is absent from the runtime and cache readers.

## Rejected alternatives

### Codex sends precomputed words and sentences

This duplicates the versioned displayed-word rules across processes and permits renderer/runtime
range drift. Exact block text already gives Narrate every source coordinate it needs, while returned
UTF-16 ranges remain directly paintable by Codex.

### Run Misaki independently for each source word

Word-at-a-time G2P loses the POS and neighboring context needed for heteronyms and prosody. Narrate
runs one contextual block request and groups the resulting ordered tokens underneath source words.

### Expose Misaki tokens or phrase cues to Codex

Misaki tokenization is an implementation detail and may split one displayed word or expand it into
several spoken words. Foreground painting stays stable by exposing exactly one cue per source word.
An association that crosses source words is an error, not permission to broaden the highlight.

### Acoustic chunks are the highlight units

Chunk boundaries exist for a model limit, not for reading comprehension. They may merge sentences
or split one sentence and therefore cannot be public semantic units.

### Use only punctuation and a conjunction list for long sentences

Those signals are useful but cannot distinguish a real clause boundary from a tightly bound phrase.
The deterministic planner also uses Misaki POS evidence, grammatical no-split rules, and a global
length plan. No additional model is required.

### Search the source for each returned token

Repeated text, normalization, punctuation, and technical expressions make global occurrence search
ambiguous. A strict cursor walk over a normalization map proves association or fails.

### Trust `MToken.whitespace` or timestamps

The pinned Rust port synthesizes whitespace and does not populate source/audio timestamps during
G2P. Exact source separators and Kokoro native duration output are authoritative instead.

### Infer equal word timing from text or phoneme counts

Kokoro already exposes the duration prediction used to generate its waveform. Equal division would
be less accurate and would conceal duration-vector integration errors.

### Forced alignment or a checker model

It adds another model and another failure surface while the generating model already exposes native
token duration. Structural validation is deterministic and sufficient for this contract.
