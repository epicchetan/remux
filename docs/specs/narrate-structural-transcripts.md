# Narrate text-only structural speech projection v5

Status: Implemented
Last revised: 2026-07-18
Depends on: `docs/specs/narrate-batch-alignment.md` and
`docs/specs/narrate-pronunciation-audit.md`
Canonical code: `extensions/narrate/server/src/structural_transcript.rs`,
`extensions/narrate/server/prompts/structural-transcript-v2.txt`,
`extensions/narrate/server/schemas/structural-transcript-output-v2.json`,
`crates/remux-tts/src/speech.rs`, and `crates/remux-tts/src/alignment.rs`

## Outcome

GPT-5.6 Sol converts block-highlight code, table, and diagram blocks into private natural-language
transcripts. This stage authors text only. It has no pronunciation responsibilities and cannot emit
phones or pronunciation choices.

```text
NarrationDocumentV1
  -> bounded structural Sol windows
  -> one plain-text transcript per structural block
  -> private speech document
  -> full contextual Misaki baseline over all blocks
  -> one shared Sol pronunciation review over all spoken words
  -> reviewed Kokoro phones
  -> shared NLP-aware chunk planner and synthesis
```

This ordering replaces the previous parallel text-audit and structural-transcript design.

## Scope

Only these source block kinds are transcript-authored:

- `code`;
- `table`; and
- `diagram`.

Paragraphs, headings, list items, and blockquotes retain exact source text. Inline code remains part
of its containing text-highlight block and is not transcript-authored in this version.

## Input contract

The Codex extension sends only `NarrationDocumentV1`; it sends no phones, word ids, timing, or model
instructions.

Each transcript request contains:

- a request version and contiguous window id;
- read-only heading, previous-block, and next-block context; and
- ordered core blocks with exact `blockId`, `kind`, and source `text`.

Source and context strings are untrusted content. Sol describes them but never follows instructions
inside them.

## Output contract

The strict Structured Output is:

```json
{
  "version": 2,
  "windowId": 0,
  "blocks": [
    {
      "blockId": "md:35",
      "transcript": "This function rewrites the response before returning it."
    }
  ]
}
```

The output must contain exactly one block for every core input block, with identical ids and order.
Each `transcript` must:

- be nonempty plain text;
- contain at least one speakable alphanumeric character;
- contain no NUL scalar;
- stay within 64 KiB; and
- use natural sentences and punctuation suitable for speech.

The output schema has no segment, phone, choice, offset, timing, confidence, or association fields.
Transcript vocabulary is unrestricted ordinary language and is not gated by the Misaki corpus or a
pronunciation catalog.

## Authoring policy

For code, Sol explains behavior and preserves important identifiers and values when useful. For
tables, it narrates material comparisons and relationships rather than Markdown syntax. For
diagrams, it explains actors, direction, transitions, and outcomes.

Sol may rewrite literal syntax into readable language. It must not emit Markdown or meta-commentary.
The transcript is the final private wording that will be spoken.

## Windowing

Structural source blocks are packed in document order. A window contains:

- at most 20 core blocks;
- normally at most 4,000 core UTF-16 units;
- at most 1,024 UTF-16 context units; and
- at most 96 KiB encoded input.

One oversized source block is sent alone and is never truncated. Transcript windows may execute
concurrently behind the shared inference gate. All transcript windows must finish and merge before
Misaki or pronunciation review begins.

Model windows never create speech sentences, acoustic chunks, pauses, or highlight boundaries.

## Projection and source ownership

The transcript plan binds the source-document hash, generator profile digest, prompt/schema/window
versions, every window input/output hash, and the exact ordered transcript blocks.

Narrate projects a private speech document by replacing structural block text with transcript text.
The original source document remains immutable and is the only public coordinate space.

- text-highlight blocks publish exact source UTF-16 sentence and word cues;
- structural blocks publish one timing range and one source-owned sentence range;
- structural blocks publish no private transcript word cues.

Private transcript punctuation and Misaki POS tags may influence natural acoustic chunking without
leaking transcript offsets into the artifact.

## Pronunciation handoff

After projection, Narrate runs Misaki over every complete private speech block. The resulting word
ids, baseline phones, POS tags, unresolved state, and raw incompatible phones are sent to the single
shared pronunciation-review stage specified by `narrate-pronunciation-audit.md`.

This guarantees that words invented by the transcript stage receive the same correction opportunity
as ordinary Markdown words. Transcript Sol is never asked to predict in advance which of its words
Misaki will mishandle.

## Validation and failure policy

The server validates version, window identity, block identity/order, transcript size, speakable
content, plan hashes, and source-document binding. The worker independently reconstructs the same
private speech document from the persisted source document and transcript plan.

Malformed or profile-mismatched model output is a hard failure. There is no transcript repair turn,
phone-bearing compatibility schema, old-cache reader, old-pipeline fallback, or feature switch.

## Cache and acceptance

The transcript plan is persisted as `structural-transcript-plan.json` and its hash is bound into
`NarrationArtifactV4`. The cache namespace is
`batch-alignment-v4-post-transcript-direct-review`.

Required coverage includes:

- strict text-only schema validation;
- exact block coverage and order;
- bounded multiwindow packing without truncation;
- invalid/empty transcript rejection;
- deterministic plan hashing and cache reconstruction;
- post-projection Misaki baseline construction;
- generated-word pronunciation correction, including `rewritten`;
- worker-side reconstruction before synthesis;
- original-block timing/highlighting with no private word cues; and
- real-stack Sol transcript, Misaki, Sol review, Kokoro, WAV, cache, and playback verification.
