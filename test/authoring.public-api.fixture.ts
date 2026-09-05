import {
  compileAuthoringPlan,
  compileRegisteredBlock,
  type AuthoringPlan,
  type GeneratedAuthoringPlan,
} from '../src/index.js';

// This is compiled by `npm run typecheck` as an unchanged-import consumer fixture.
const semanticPlan: AuthoringPlan = {
  name: 'acme/notice',
  title: 'Notice',
  root: { role: 'wrapper', path: 'notice', children: [{ role: 'paragraph', path: 'notice/message', content: 'Hello' }] },
};
compileAuthoringPlan(semanticPlan);

// The confirmation lifecycle has its own canonical public name in this compatibility line.
const generatedPlan: GeneratedAuthoringPlan = {
  version: 1,
  generatorVersion: '0.9.0',
  target: { name: 'acme/notice', title: 'Notice' },
  structure: [{ block: 'core/paragraph', attributes: { content: 'Hello' } }],
  fields: [],
  locking: { mode: 'none' },
  styles: { strategy: 'native', outcomes: [] },
  pattern: { ready: false, overrides: [] },
  assets: [],
  files: [],
  warnings: [],
};
compileRegisteredBlock(generatedPlan);
