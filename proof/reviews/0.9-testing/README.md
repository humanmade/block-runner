# 0.9 testing accessibility review

This is the retained agent-assisted keyboard and screenshot review of the exact input
and generated plugin ZIP named in `manual-review.json`. It is not a human accessibility
certification or a screen-reader test. The observations and five screenshots are included;
the full browser trace is retained separately by the maintainer under its recorded hash.

The release checker rejects this record if its input or ZIP hashes differ from the newly
generated candidate. A changed artifact needs a new review; do not update the hashes alone.
Raw automated Axe findings and the narrow upstream exception are evaluated separately.

WordPress exposes an Edit pattern control in the content-only editor. This is native editor
policy, not a security boundary; the review does not claim that Block Runner removes it.
