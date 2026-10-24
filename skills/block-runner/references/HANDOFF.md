# A handoff when requested

Use this only when the user explicitly requests a formal handoff, reproduction package
or transferable run record. Do not generate one for every conversion or visual review.
Ordinary delivery still needs a concise result and honest limits; it does not require
this template, extra files or a separate approval step.

Keep original reports, receipts and journals authoritative. Link to them instead of
copying their full contents or translating their statuses. Use the parts of this
template that the run needs; omit irrelevant detail rather than inventing it.

```markdown
# <Artifact or task> handoff

## Outcome and next action
<Delivered or blocked; exact next action and any outstanding decision.>

## Run identity
<Date, Block Runner/Node versions, route and source revision/hash.
Relevant observed WordPress/theme/plugin versions, or unknown.>

## Inputs and reproduction
<Relative input/config/context/media paths, working directory, exact command/options,
required environment-variable names and expected exit/result. No credential values.>

## Outputs and evidence
<Links to existing output, companion CSS/assets, complete reports, receipts,
journals and captures. Reuse their hashes where available.>

## Checks and limits
| Claim | Check and observed result | Evidence |
| --- | --- | --- |
| <Validity, visual, save, interaction or production> | <Actual result or unverified> | <Link> |

## Failure or continuation
<Exact diagnostic code/location or observed failing stage, suspected cause labelled
as such, retained reproduction and remaining action.>
```

For a portable failure, explicitly select the smallest sanitised input and dependencies.
Keep normal filenames and relative paths. Test the recorded command in a fresh directory
with the pinned package and without the original checkout or ambient configuration.
Record an expected failing exit code. If the result needs inaccessible site state or
private files, name that dependency and do not call the package self-contained.

Preserve warnings, source locations and partial/unknown journal outcomes. A valid
report is not proof of appearance, editor persistence or production behaviour. Missing
evidence stays unverified. A screenshot needs a recorded observation to support a
visual claim. Include editorial TODOs only where relevant.

Review selected files for sensitive content before sharing. No automatic collection,
redaction, upload or support submission is implied. Referenced receipt evidence must
remain accessible; a link to an unavailable local file is not a portable reproduction.

See the [worked success and failure examples](../../../examples/handoff/README.md).
They use existing CLI reports and plain Markdown, with no new executable or schema.
