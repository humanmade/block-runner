// Shared conversion brief for the LLM translator engines, so codex and claude
// (and any future engine) are compared on the identical instruction.
export const CONVERT_PROMPT = `Convert the HTML below into valid WordPress Gutenberg block markup using CORE blocks only:
core/cover, core/columns, core/column, core/media-text, core/group, core/heading,
core/paragraph, core/list, core/list-item, core/buttons, core/button, core/image,
core/quote, core/details, core/gallery, core/table.

Reconstruct the design's intent as a clean, correctly-nested native block tree — e.g. a
hero with a background image is a core/cover; image-beside-text is a core/media-text; an
FAQ is one core/details per question; a logo row is images in a group. Avoid core/html.

Output ONLY the block markup (the <!-- wp:... --> delimiters and their HTML), nothing
else, wrapped exactly between a line ===BLOCKS_START=== and a line ===BLOCKS_END===.
Do not run any commands or write any files.

HTML:
`;

// Robustly pull block markup out of an LLM response, however it wrapped it:
// the ===BLOCKS_START/END=== markers, a ```html code fence, or just the raw
// <!-- wp:… --> span amid prose.
export function extractBlocks(out: string): string {
  const marked = out.match(/===BLOCKS_START===([\s\S]*?)===BLOCKS_END===/);
  if (marked) return marked[1].trim();
  const fence = out.match(/```(?:html)?\s*([\s\S]*?)```/);
  const body = fence ? fence[1] : out;
  const first = body.indexOf('<!-- wp:');
  if (first === -1) return '';
  const last = body.lastIndexOf('-->');
  return last > first ? body.slice(first, last + 3).trim() : '';
}
