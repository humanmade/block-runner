import { author, collectSourceEvidence } from 'block-runner';

// From a project with the candidate installed:
// node node_modules/block-runner/examples/authoring-plan.mjs > notice.plan.json
// Preview and confirm the source write, then separately preview and confirm a standalone plugin:
// npx --no-install block-runner author preview notice.plan.json --output-dir generated/notice
// npx --no-install block-runner author write notice.plan.json --confirm <author-confirmation> --output-dir generated/notice
// npx --no-install block-runner plugin preview generated/notice --standalone plugins/acme-notice
// npx --no-install block-runner plugin write generated/notice --standalone plugins/acme-notice --confirm <plugin-fingerprint>
const html = '<section><h2>A native notice</h2><p>Review this message before publishing.</p><a href="/details">Read more</a></section>';
const evidence = collectSourceEvidence(html);
const ref = (tag) => {
  const sourceRef = evidence.structure.find((entry) => entry.tag === tag)?.sourceRef;
  if (!sourceRef) throw new Error(`Missing source reference for ${tag}`);
  return sourceRef;
};

const report = await author(html, {
  author: { name: 'acme/notice', title: 'Notice' },
  proposal: {
    structure: [{ id: 'notice', block: 'core/group', sourceRef: ref('section'), children: [
      { id: 'title', block: 'core/heading', sourceRef: ref('h2') },
      { id: 'message', block: 'core/paragraph', sourceRef: ref('p') },
      { id: 'actions', block: 'core/buttons', children: [
        { id: 'link', block: 'core/button', sourceRef: ref('a') },
      ] },
    ] }],
    fields: [
      { id: 'title-content', label: 'Title', mode: 'editable', node: 'title', attribute: 'content' },
      { id: 'message-content', label: 'Message', mode: 'editable', node: 'message', attribute: 'content' },
      { id: 'link-text', label: 'Link text', mode: 'editable', node: 'link', attribute: 'text' },
      { id: 'link-url', label: 'Link URL', mode: 'editable', node: 'link', attribute: 'url' },
    ],
    locking: { mode: 'contentOnly' },
  },
});
if (!report.ok || !report.package?.canonicalPlan) {
  throw new Error(report.items.map((item) => item.reason).join('\n') || 'Authoring proposal was rejected.');
}
process.stdout.write(`${JSON.stringify(report.package.canonicalPlan, null, 2)}\n`);
