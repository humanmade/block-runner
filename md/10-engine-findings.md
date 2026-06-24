# Block Runner — engine findings (deterministic vs LLM translators)

First head-to-head of three conversion **engines** over the same 30-fixture suite
(`suiteHash 4f99b2aad212`): the deterministic rules, Codex (gpt-5.5, high), and Claude
Code (opus, high). Both LLM engines are "Engine B" (LLM translate → Block Runner's gate
validates). Data: the three `engine=` records in `benchmarks/results.jsonl` (2026-06-24).

## Headline

| | corpus | invalid | fallbacks (`core/html`) |
|---|---|---|---|
| **local** (rules) | 36 | 1 | **50** |
| **codex** gpt-5.5/high | **40** | 6 | **0** |
| **claude-code** opus/high | 37 | 5 | **0** |

Corpus is close — but that's an artifact of the suite mixing clean and messy inputs.
The real story is in the **input × engine** matrix.

## The matrix (producer input × engine converter)

| input ↓ / engine → | local | codex | claude |
|---|---|---|---|
| **impeccable** (clean semantic) | **68** | 42 | 46 |
| **claude** (semantic-ish) | 33 | 30 | **38** |
| **codex** (Tailwind utility soup) | **7** | **49** | 25 |
| **corpus** | 36 | 40 | 37 |

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

`benchmarks/results.jsonl`, three records, same `suiteHash` (suite constant, engine
varied — the backtesting discipline from `08`). Engines: `scripts/engines/{codex,claude}.ts`
(+ shared `prompt.ts`). Runs recorded with `engine` / `model` / `effort`. LLM scores are
non-deterministic; treat ±a few points as noise, the matrix shape as the signal.
