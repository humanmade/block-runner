// Copy this file into the packed consumer project before running it, so this import
// resolves the installed candidate rather than source from the repository.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { author, collectSourceEvidence } from 'block-runner';

const [journey, sourceRoot, ...extra] = process.argv.slice(2);
if (!sourceRoot || extra.length || !['local-asset-feature', 'responsive-panel-grid'].includes(journey)) {
  throw new Error('Usage: node author-input.mjs <local-asset-feature|responsive-panel-grid> <staged-sources-directory>');
}

const localAsset = journey === 'local-asset-feature';
const sourcePath = path.resolve(sourceRoot, localAsset ? 'semantic/local-assets.html' : 'utility/tailwind-responsive.html');
const html = await readFile(sourcePath, 'utf8');
const evidence = collectSourceEvidence(html);
const ref = (tag, occurrence = 0) => {
  const value = evidence.structure.filter((entry) => entry.tag === tag)[occurrence]?.sourceRef;
  if (!value) throw new Error(`Missing ${tag}[${occurrence}] in the staged acceptance input`);
  return value;
};
const field = (node, attribute, label) => ({ id: `${node}-${attribute}`, label, mode: 'editable', node, attribute });

// These are explicit proposals for the two repository-authored acceptance inputs,
// not a general HTML mapper or model benchmark. Content and style ledgers are derived.
const proposal = localAsset ? {
  structure: [{ id: 'feature', block: 'core/group', sourceRef: ref('section'), children: [
    { id: 'copy', block: 'core/group', sourceRef: ref('div'), children: [
      { id: 'eyebrow', block: 'core/paragraph', sourceRef: ref('p', 0) },
      { id: 'title', block: 'core/heading', sourceRef: ref('h2') },
      { id: 'body', block: 'core/paragraph', sourceRef: ref('p', 1) },
      { id: 'actions', block: 'core/buttons', children: [
        { id: 'cta', block: 'core/button', sourceRef: ref('a') },
      ] },
    ] },
    { id: 'image', block: 'core/image', sourceRef: ref('figure') },
  ] }],
  fields: [
    field('eyebrow', 'content', 'Eyebrow'), field('title', 'content', 'Title'),
    field('body', 'content', 'Body'), field('cta', 'text', 'Link text'),
    field('cta', 'url', 'Link URL'), field('image', 'alt', 'Image alternative text'),
    field('image', 'caption', 'Image caption'),
  ],
  locking: { mode: 'contentOnly' },
} : {
  structure: [{ id: 'shell', block: 'core/group', sourceRef: ref('section'), children: [
    { id: 'grid', block: 'core/group', sourceRef: ref('div'), children: [
      { id: 'intro', block: 'core/group', sourceRef: ref('header'), children: [
        { id: 'eyebrow', block: 'core/paragraph', sourceRef: ref('p', 0) },
        { id: 'title', block: 'core/heading', sourceRef: ref('h2') },
        { id: 'body', block: 'core/paragraph', sourceRef: ref('p', 1) },
      ] },
      ...['mobile', 'tablet', 'desktop', 'motion'].map((id, index) => ({
        id, block: 'core/group', sourceRef: ref('article', index), children: [
          { id: `${id}-title`, block: 'core/heading', sourceRef: ref('h3', index) },
          { id: `${id}-body`, block: 'core/paragraph', sourceRef: ref('p', index + 2) },
        ],
      })),
    ] },
  ] }],
  fields: [
    field('eyebrow', 'content', 'Eyebrow'), field('title', 'content', 'Title'), field('body', 'content', 'Body'),
    ...['mobile', 'tablet', 'desktop', 'motion'].flatMap((id) => [
      field(`${id}-title`, 'content', `${id} title`), field(`${id}-body`, 'content', `${id} body`),
    ]),
  ],
  locking: { mode: 'contentOnly' },
};

const report = await author(html, {
  sourcePath,
  // The supplied SVG is a sibling of semantic/, still inside this staged input.
  assetRoot: path.resolve(sourceRoot),
  author: {
    name: localAsset ? 'block-runner/asset-feature' : 'block-runner/responsive-panel-grid',
    title: localAsset ? 'Local asset feature' : 'Responsive panel grid',
    ...(!localAsset ? { styles: {
      mode: 'css',
      css: await readFile(path.resolve(sourceRoot, 'utility/tailwind-responsive.css'), 'utf8'),
      // Reviewable containment decision: the universal reduced-motion rule applies
      // inside this block, not to the whole WordPress page. Its warning is retained.
      foundation: 'component',
    } } : {}),
  },
  proposal,
});
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
if (!report.ok || !report.package?.canonicalPlan) process.exitCode = 1;
