# Unsupported interaction — expected negative

The source requires pointer drag reordering, per-user persistence, and live-sort announcements. Those behaviors have no native mapping in the 0.9 testing release. Do not emit a fake sortable script, custom persistence, or a raw HTML escape hatch. Fail closed with warning code `BR_UNSUPPORTED_INTERACTION` and status `unsupported`.
