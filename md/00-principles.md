# Block Runner Design Principles

> **A block the editor can trust.**
>
> The measure of a conversion is not whether it ran. It is whether a person can open the result, recognise every block, and keep editing as if they had built it by hand. Anything less is debt dressed up as output.

---

Block Runner exists to make the handoff between machine-generated design and the human editor seamless.

Generation is getting cheap. Agents and pipelines can produce a hero, a pricing grid, a testimonial wall in seconds. But what they produce — a `<section>` with scoped CSS — lands in WordPress as a single opaque `wp:html` blob: uneditable, unrecognisable, a dead end for the person who has to take it further. Block Runner's job is to close that gap. To turn design intent into clean, native, correctly-nested block trees — `wp:cover > wp:columns > wp:buttons` — and to refuse, loudly, to pretend when it cannot. The product is not the conversion. It is the *trust* in the conversion.

---

## 1. Translate intent, don't parse syntax

*No mapping exists from arbitrary HTML to a native tree — only an interpretation of what the design means.*

A `<section>` with a background image and two text columns is not a tag pattern to match; it is an *intent* — a cover wrapping a two-column row. The structural signals are unreliable and the attributes (cover media id, column widths) can't be read out of ambiguous markup. This is precisely the work `rawHandler` refuses to do, which is why it produces spaghetti. Block Runner supplies the structural intelligence that refusal leaves missing. It reads intent from structure and CSS — never matches tags and hopes.

## 2. Build valid by construction, never by repair

*A tree assembled from verified primitives is canonical because of how it was made, not because something fixed it afterward.*

Block Runner composes output with `createBlock(name, attrs, innerBlocks)` and `serialize()` — never by concatenating markup strings. Every node is canonical the moment it exists, drawn from per-block primitives that are known-good. Repair is a fallback for markup that arrived broken, not a strategy for markup we author ourselves. If we are tempted to generate a string and then fix it, we have built the wrong thing.

## 3. The gate is not optional

*The translator decides which blocks and how they nest; the deterministic gate decides what is editor-valid. Neither is the product alone.*

Every conversion passes through headless Gutenberg — `parse()`, validate, canonicalize — unconditionally, every time. The translator owns the part a parser can't do (intelligent structure); the gate owns the part a model can't do reliably (exact editor-validity). The pairing *is* the product. A clever translator with no gate ships subtly-invalid markup. A gate with no translator only ever produces `wp:html`. The whole value lives in the seam between them.

## 4. Validity is not fidelity

*Markup that parses cleanly can still say the wrong thing — and the gate will happily make it valid.*

Canonical shape is not correct intent. If the translator emits wrong attributes, `serialize(parse())` produces wrong-but-valid output and reports success. This is the most dangerous failure mode the system has, because it looks like a win. Block Runner must never confuse "it round-trips" with "it's right." Design fidelity is a separate, explicit check — a rendered before/after, a human eye — and the system should keep that distinction sharp rather than let green checkmarks paper over it.

## 5. Nothing degrades in silence

*The worst output is the one that looks clean and lied about it.*

Every fallback to `core/html`, every unresolved media id, every stripped `<script>`, every guess — is a first-class warning, never swallowed. Warnings are output, not noise to suppress. A run that quietly drops to spaghetti and exits zero has done more damage than one that fails loudly, because it teaches the user to trust something that isn't trustworthy. Visibility of degradation is a feature with the same weight as the conversion itself.

## 6. Point at the input, not the output

*The fix belongs upstream, in the design — not in the markup we generated.*

Every warning carries a source location: the file, the selector, the line of HTML that caused it. The user should repair the *input* that produced a bad block, not hand-patch the generated tree. Done well, Block Runner teaches the generation pipeline to produce better HTML over time — each warning is a lesson aimed at the source, so the same class of problem stops arriving.

## 7. Be deterministic, be explainable

*An infrastructure tool earns trust by being predictable and inspectable, never by being clever in ways you can't trace.*

Same input, same output — always. Rules are an ordered list, first match wins, ties broken by position, overridable by id. When someone asks "why did this node become a cover?", `--explain` answers with the rule that claimed it and the near-misses it beat. Magic that can't be traced is a liability in infra. The system should be boring in the best way: legible, reproducible, debuggable.

## 8. Pin the world you stand on

*The gate's authority comes from matching the editor exactly — so the thing it depends on must not move under it.*

Headless Gutenberg is the gate's source of truth, and it is fragile to version skew (`registerCoreBlocks` breaking on a mismatched `@wordpress/*` set). Pinned dependencies, a committed lockfile, and a CI smoke canary across Node versions are not housekeeping — they are what makes "valid" *mean* the same thing Block Runner says it means. Stability of the foundation is a designed property, not an afterthought.

## 9. A generic core, conventions at the edge

*Built for many users first; the private use case is the first config, never a baked-in assumption.*

The core carries zero theme- or project-specific knowledge. Token slugs, preset mappings, rule overrides, media strategy — all arrive through config. The first real consumer's theme is an *example config*, not a hardcoded path. Built public-first means no committed file references a private project, and anyone can drop Block Runner onto their own conventions without forking it. What's specific lives at the edges; what's general lives at the centre.

## 10. Be the seam, not the author

*Block Runner converts and validates. It does not invent content or design — and the cleaner it works, the less anyone notices it.*

This is conversion and validation infrastructure, not creative generation. It does not decide what the hero should say or how the brand should look; it faithfully carries someone else's intent across the gap into native, editable blocks. Its ambition is to disappear — to make the handoff so clean that the person on the other side never thinks about the tool, only about the work they can now continue. The highest praise is that no one remembers it was there.
