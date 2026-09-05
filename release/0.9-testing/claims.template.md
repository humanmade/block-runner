# 0.9 product-preview claim record

**Status:** DRAFT — not current until the linked deterministic release matrix and
representative WordPress proof pass for the same release candidate. The optional
authoring benchmark remains a separate, explicitly scored claim.

This is the future-state product-preview brief for a completed 0.9 testing release.
It must not be presented as a statement about the current npm package until every
required release receipt is complete. Replace every bracketed value with a receipt
link before using this text in the README, website, release notes, or a demo.

## Approved claim shape

> Block Runner 0.9 is a testing release for turning one supplied design into one
> reusable registered WordPress block. On **[workload description]** across the
> **[suite size]**-fixture registered-block authoring suite, using **[model]** at
> **[effort]** effort, **[figure]**. The run recorded **[invalid count]** invalid
> measurements. Timing uses **[timing method]**. Evidence: **[receipt set]**.

Required fields for every numerical or percentage claim:

| Field | Must say |
| --- | --- |
| Workload | Exact fixture selection, repetitions, and whether it is fixture or real-project work. |
| Suite size | Number of fixtures and the corpus/revision identifier. |
| Model / effort | Exact model/tool identity and effort setting, or `deterministic` / `not applicable`. |
| Invalid count | Count of `engine_error` and invalid measurements; never recast them as zeros. |
| Timing method | Wall-clock boundary, repetitions/aggregation, hardware/CI environment, and timeout policy. |
| Receipt link | Candidate commit and retained receipt/artifact location. |

## Claims that remain prohibited

- Do not report a single combined score with the existing 63-fixture page-block
  benchmark.
- Do not call a browser, visual/fidelity, accessibility, editor, front-end, pattern,
  build, packaging, or activation gate a pass unless its receipt says `passed`.
- Do not hide `blocked` or `engine_error` runs behind a score; they are invalid
  measurements and must be explicitly counted.
- Do not imply unsupported interactions work. The expected-negative fixture must say
  that unsupported interaction is warned and fails closed.
- Do not describe 0.9 as 1.0-ready. 1.0 requires real-project feedback and resolved
  release-relevant failures.

## Current-state reconciliation checklist

Before marking this brief **CURRENT**, the release owner must attach receipts proving:

- [`npm run release:check`](./README.md#required-release-commands) passed, including
  `npm run verify`, package dry run, skill validation, installer smoke, and generated
  plugin ZIP activation from the candidate, with `acceptance.releaseOk: true`;
- if the optional registered-block authoring benchmark is mentioned, its own scored
  receipt must be linked; the deterministic release receipt must not be presented as
  that benchmark result;
- the raw WordPress proof receipt and the separate acceptance summary are both linked;
  any accepted native Heading or Paragraph finding links its WordPress 7.1 control
  evidence hash;
- each figure uses the approved claim shape above; and
- every README, website, release-note, and product-preview figure agrees with the
  linked workload and receipt data.

When current, replace the status line with:

```text
Status: CURRENT — measured against <candidate commit>; receipts: <immutable receipt index>.
```
