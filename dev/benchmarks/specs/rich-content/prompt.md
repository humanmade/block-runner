# Rich content (article block)

A "How it works" content section, with this exact content in order:

1. An H2 "How it works".
2. A paragraph: "It takes three steps to go from design to native blocks."
3. A numbered (ordered) list of three steps:
   1. "Paste your design HTML"
   2. "Run the converter"
   3. "Get clean native blocks"
4. A pull quote (a visually emphasised standout quote): "Every output is valid by
   construction." — attributed to "The gate".
5. A thematic divider (horizontal rule) separating the quote from the code.
6. A code snippet: `npx block-runner convert page.html`.

Use the most semantic HTML element for each (an ordered list, a blockquote for the pull
quote, an `<hr>`, a `<pre><code>`). Output one self-contained HTML `<section>`; use your own
CSS/classes.
