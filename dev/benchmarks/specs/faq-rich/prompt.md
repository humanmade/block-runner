# FAQ with rich answers

An FAQ section: an H2 "Questions, answered", then three collapsible items. Each answer
contains MORE than one block:

1. **"How does it convert?"** — a paragraph "It walks your markup with a deterministic
   rule-walker, then assembles native blocks." followed by a bullet list: "No LLM required",
   "Fully offline".
2. **"Can I self-host?"** — a paragraph "Yes — it runs entirely offline as a CLI." followed
   by a button "Read the guide".
3. **"What about support?"** — a paragraph "Community support on GitHub, with priority plans
   available."

Each Q/A is a native collapsible (`<details><summary>`). Output one self-contained HTML
`<section>`; semantic HTML, your own CSS/classes.
