# Two requested handoffs

These synthetic examples exercise the [optional handoff template](../../skills/block-runner/references/HANDOFF.md).
They are local validity/reproduction examples, not WordPress or visual acceptance.

Copy `config.json`, `success.json` and `failure.json` from this directory into an empty
directory. The explicit empty config prevents ambient configuration from changing the run.
Install the exact runtime used for these examples, then retain the normal CLI artifacts:

```sh
npm init -y
npm install --no-audit --no-fund block-runner@0.9.11
node --version
npx --no-install block-runner --version
npx --no-install block-runner assemble success.json --config config.json --out success.html --json > success.report.json
npx --no-install block-runner assemble failure.json --config config.json --json > failure.report.json
```

The success command exits 0. The failure command intentionally exits 1; run it separately
if your shell stops on errors. Keep its JSON report. Do not turn the expected failure
into a successful conversion or discard the source. For a candidate package, install
the reviewed tarball instead of the release and record its revision/hash.

## Success handoff

**Outcome and next action:** native markup is retained in `success.html`. Deliver it to
the agreed destination; no WordPress write has occurred in this example.

**Run identity:** Block Runner 0.9.11, route `assemble`; record your observed Node version
and run date. The selected input is `success.json`, with explicit `config.json`.

**Reproduction:** run the success command above from the directory containing those files.
Expected: exit 0, `ok: true`, two valid blocks, zero invalid blocks and zero warnings.

**Evidence:** `success.report.json` is the original complete report; `success.html` is
its output. There are no companion assets in this input. Inspect both retained files;
their paths refer to the reproduction directory, not this documentation directory.

**Checks and limits:** headless validity is observed in the report. Appearance, native
edit/save/reopen, interaction and production behaviour are unverified.

**Continuation:** use the normal delivery workflow when a destination is available.
Do not call the example a rendered or installed result.

## Failure handoff

**Outcome and next action:** assembly rejects the unregistered block. Correct the input
to an intended supported block, or investigate the required project-owned block route;
do not silently replace its content with an empty result.

**Run identity:** Block Runner 0.9.11, route `assemble`; record your Node version/date.
The selected input is `failure.json`, with explicit `config.json`.

**Reproduction:** run the failure command above in a fresh directory. Expected: exit 1,
`ok: false`, one invalid input, no output markup. The original diagnostic reason is:

```text
assembly failed: blocks[0]: block type "example/not-registered" is not registered
```

**Evidence:** `failure.report.json` retains the diagnostic at source path `failure.json`.
This result has no separate diagnostic `code` field; use the exact reason and stage.

**Checks and limits:** local input rejection is observed. No target-site operation was
attempted; target registration, appearance and save persistence are unverified.

**Continuation:** retain the original input/report alongside any corrected revision.
Only the selected JSON files and pinned package are needed to reproduce this failure;
no original checkout, browser, site state or credentials are required.
