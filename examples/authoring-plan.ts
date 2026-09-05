import {
  compileRegisteredBlock,
  hashAuthoringPlan,
  planRegisteredBlockOutput,
  renderAuthoringPreview,
  validateAuthoringPlan,
  type GeneratedAuthoringPlan,
} from 'block-runner';

// This is the public confirmation-bound shape used by the CLI and installed skill as well.
const proposal: GeneratedAuthoringPlan = {
  version: 1,
  generatorVersion: '0.9.0',
  target: {
    name: 'acme/notice',
    title: 'Notice',
    metadata: { keywords: ['notice', 'callout'] },
  },
  structure: [{ id: 'message', block: 'core/paragraph', attributes: { content: 'A confirmed notice.' } }],
  fields: [{ id: 'message', label: 'Message', mode: 'editable', node: 'message', attribute: 'content' }],
  locking: { mode: 'none' },
  styles: { strategy: 'native', outcomes: [] },
  pattern: { ready: false, overrides: [] },
  assets: [],
  files: [], // The compiler derives its owned source set for preview and generation.
  warnings: [],
};

const plan = validateAuthoringPlan(proposal);
const planHash = hashAuthoringPlan(plan);
const output = planRegisteredBlockOutput(plan);
console.log(renderAuthoringPreview(plan, { hash: planHash }));

// After a caller has inspected the preview and obtained destination-bound confirmation, compile
// the same plan. Destination inspection/write is deliberately application-specific.
const generated = compileRegisteredBlock(plan);
console.log({ planHash, plannedFiles: output.files, generatedFiles: generated.files.map(({ path }) => path) });
