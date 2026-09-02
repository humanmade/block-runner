import { createHash } from 'node:crypto';

// Shared conversion brief for the LLM translator engines, so codex and claude
// (and any future engine) are compared on the identical instruction.
export const CONVERT_PROMPT = `Convert the HTML below into valid WordPress Gutenberg block markup using CORE blocks only:
core/cover, core/columns, core/column, core/media-text, core/group, core/heading,
core/paragraph, core/list, core/list-item, core/buttons, core/button, core/image,
core/quote, core/pullquote, core/details, core/accordion, core/accordion-item,
core/accordion-heading, core/accordion-panel, core/gallery, core/table, core/code,
core/separator, core/social-links, core/social-link, core/video, core/audio,
core/embed, core/file.

Reconstruct the design's intent as a clean, correctly-nested native block tree — e.g. a
hero with a background image is a core/cover; image-beside-text is a core/media-text; an
FAQ set is one core/accordion containing accordion-items (use core/details only for one
standalone disclosure); a logo row is images in a group. Preserve every visibly bordered,
shadowed, or filled card as its own core/group, but do not invent groups for unstyled wrappers.
Preserve semantic attributes, not just block names: ordered lists stay ordered; media keeps
its src/caption/poster/controls; embeds keep their URL/caption/responsiveness; social links keep
service + URL; accordion-heading text uses its title attribute. A core/file with a visible
download button must carry href, fileName, showDownloadButton=true, and a non-empty
downloadButtonText matching the visible source label. Avoid core/html.

Output ONLY the block markup (the <!-- wp:... --> delimiters and their HTML), nothing
else, wrapped exactly between a line ===BLOCKS_START=== and a line ===BLOCKS_END===.
Do not run any commands or write any files.

HTML:
`;

export const CONVERT_PROMPT_HASH = `markup-${createHash('sha256').update(CONVERT_PROMPT).digest('hex').slice(0, 10)}`;

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
