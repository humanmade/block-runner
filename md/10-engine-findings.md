# Block Runner — engine findings (deterministic vs LLM translators)

First head-to-head of five conversion **engines** over the same 30-fixture suite
(`suiteHash 4f99b2aad212`): the deterministic rules, plus Codex (gpt-5.5 and gpt-5.4) and
Claude Code (opus and sonnet), all at high effort — frontier *and* workhorse tiers. The LLM
engines are "Engine B" (LLM translate → Block Runner's gate validates). Data: the five
`engine=` records in `benchmarks/results.jsonl` (2026-06-24).

## Headline

| | corpus | invalid | fallbacks (`core/html`) | tier |
|---|---|---|---|---|
| **local** (rules) | 36 | 1 | **50** | baseline |
| **codex** gpt-5.5/high | **40** | 6 | 0 | frontier |
| **claude-code** opus/high | 37 | 5 | 0 | frontier |
| **codex** gpt-5.4/high | 20 | 13 | 0 | workhorse |
| **claude-code** sonnet/high | 22 | **22** | 0 | workhorse |

Two stories: only **frontier** LLMs beat the rules (40/37 vs 36); the **workhorse** models
land *well below* the rules (20/22). And the close frontier-vs-rules corpus is itself an
artifact of the suite mixing clean and messy inputs — the real picture is the matrix.

## The matrix (producer input × engine converter)

| input ↓ / engine → | rules | codex 5.5 | opus | codex 5.4 | sonnet |
|---|---|---|---|---|---|
| **impeccable** (clean semantic) | **68** | 42 | 46 | 31 | 27 |
| **claude** (semantic-ish) | 33 | 30 | **38** | 14 | 24 |
| **codex** (Tailwind utility soup) | 7 | **49** | 25 | 16 | 16 |
| **corpus** | 36 | 40 | 37 | 20 | 22 |

*Columns 2–3 are frontier (gpt-5.5, opus); 4–5 are workhorse (gpt-5.4, sonnet).*

## Findings

1. **Rules vs LLM is a clean trade governed by INPUT QUALITY.** The rules *dominate*
   clean semantic input (impeccable 68) and *collapse* on messy input (Tailwind soup 7).
   The LLM engines are the mirror image: roughly flat across input quality (codex 42–49,
   claude 25–46) — codex even converts Tailwind soup *better* (49) than it does clean
   impeccable (42). **The LLM's value is precisely where the rules fail: arbitrary,
   non-semantic producer output.**

2. **Two opposite failure modes, quantified.** Rules emit **valid but spaghetti** markup
   (1 invalid, **50** Custom-HTML fallbacks). LLMs emit **clean but sometimes invalid**
   markup (**0** fallbacks, 5–6 invalid). They fail in complementary ways — which is the
   entire case for **Engine C**: let the LLM decide structure (no spaghetti), assemble
   valid-by-construction markup (no invalidity), gate backstops. Engine C should beat all
   three.

3. **Validity is the LLM ceiling, not structure.** Both LLMs reconstructed several trees
   perfectly but emitted invalid save-markup → the gate halved them to exactly 50
   (codex 2 fixtures @50, claude 3). The classic example: impeccable hero — perfect tree,
   invalid markup, halved to 50, while the rules score 100 purely on validity.

4. **Model biases differ — an ensemble would beat either.**
   - **codex** reliably honours "image-beside-text → `core/media-text`" (94–100 everywhere);
     **claude** *never* does (0 everywhere — it keeps choosing `core/columns`).
   - **claude** nails FAQ → `core/details` and feature/stats on its own input;
     **codex** is more consistent overall (only 3 zeros vs claude's 11) and higher corpus.
   - Per fixture, the LLMs beat the rules on **13/30**, tie 8, lose 6 (the losses are all
     clean-impeccable layouts where the rules are tuned + valid).

5. **Reasoning effort matters.** On the 4-layout probe, codex low→high lifted 28→55
   (media-text 0→100). More thinking → better structural reconstruction.

6. **Harness gotcha (benchmarking hygiene).** Output extraction nearly sank Claude
   (looked like 13 until extraction tolerated missing markers / code fences → 47). Fair
   LLM benchmarking needs forgiving parsing; see `extractBlocks()` in
   `scripts/engines/prompt.js`.

## Frontier vs workhorse (the cost question)

The cheaper "code workhorse" models — the ones users would actually run for cost — are **not
viable as a raw LLM translator**: corpus **20** (gpt-5.4) / **22** (sonnet), *below the
deterministic rules' 36*, and roughly **half** their frontier siblings (40 / 37).

The collapse is overwhelmingly **validity, not structure**: invalid blocks jump from 5–6
(frontier) to **13** (gpt-5.4) and **22 of 30** (sonnet) — most of sonnet's conversions are
right-tree-but-invalid, then halved. The biggest frontier→workhorse drops (media-text
100→0, faq, stats) are layouts where the frontier model emitted a valid bespoke block and
the workhorse emitted an invalid one.

Two consequences:
- **The "LLM handles messy input" win is frontier-only.** On Tailwind soup the rules get 7
  and frontier codex 49 — but the workhorses get 16/16, barely above the rules. Robustness
  on non-semantic input needs a frontier model.
- **Strongest case yet for Engine C.** Because the workhorses fail on *validity*, not
  structure, assembling valid-by-construction markup from their structural decisions would
  rescue them most. Engine C is what could make a *cheap* model viable (cheap structural
  intuition + deterministic valid assembly). So "can we just use a cheaper model?" → not as
  raw Engine B, but plausibly under Engine C.

## Implications

- **Build Engine C next.** Validity is the proven bottleneck; assembling valid-by-
  construction markup from the LLM's structural decision captures the LLM's wins (media-text,
  details, Tailwind-soup robustness) without the halving — and without the rules' spaghetti.
- **Route by input quality (interim).** Clean semantic input → rules (cheap, valid, 68);
  messy/unknown input → LLM (robust, 49 vs 7). The producer-detection idea (`03` #9) is the
  router.
- **Ensemble the models.** codex (media-text, consistency) + claude (details) have
  complementary strengths; a vote or best-of-two would exceed 40.
- **The benchmark must report per-input + validity-confidence, not just corpus.** A single
  corpus number (36/40/37) hides the decisive input×engine story.

## Provenance

`benchmarks/results.jsonl`, five records (rules + gpt-5.5/opus frontier + gpt-5.4/sonnet workhorse), same `suiteHash` (suite constant, engine
varied — the backtesting discipline from `08`). Engines: `scripts/engines/{codex,claude}.ts`
(+ shared `prompt.ts`). Runs recorded with `engine` / `model` / `effort`. LLM scores are
non-deterministic; treat ±a few points as noise, the matrix shape as the signal.
