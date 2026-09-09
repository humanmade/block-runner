# Feature rows (alternating media + text)

A "Built for the handoff" section: an H2 "Built for the handoff", then three feature rows
that alternate the image side (left, right, left). Each row pairs an image with a rich text
side:

1. Image **left**. Text: H3 "Paste anything", paragraph "Figma exports, Tailwind, hand-written
   HTML — it all converts.", and a bullet list: "Figma", "Tailwind", "Plain HTML".
2. Image **right**. Text: H3 "Real nesting", paragraph "A hero becomes a cover, columns stay
   columns — real structure.", and a button "See an example".
3. Image **left**. Text: H3 "Always valid", paragraph "Every output passes the editor's own
   validator.", and a bullet list: "Editor-valid", "Round-trips".

Each row is an image beside text (a media-text pattern), not a generic two-column grid.
Output one self-contained HTML `<section>`; semantic HTML, your own CSS/classes; placeholder
images ok.
