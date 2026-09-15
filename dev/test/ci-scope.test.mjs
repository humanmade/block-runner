import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyChanges, classifyDiffResult, parseNameStatus } from '../../scripts/ci-scope.mjs';

const entry = (status, ...paths) => ({ status, paths });

test('selects the documentation route only for the explicit documentation and demo allowlists', () => {
  assert.deepEqual(
    classifyChanges([entry('M', 'README.md'), entry('A', 'CHANGELOG.md')]),
    { route: 'docs', docs: ['CHANGELOG.md', 'README.md'], reason: 'documentation-and-demo-only' },
  );
  assert.deepEqual(
    classifyChanges([entry('M', 'README.md'), entry('M', 'demo/demo.sh'), entry('M', 'demo/demo.gif')]),
    { route: 'docs', docs: ['README.md'], reason: 'documentation-and-demo-only' },
  );
});

test('selects the skill route for skills with optional root documentation', () => {
  assert.deepEqual(
    classifyChanges([
      entry('M', 'skills/block-runner/SKILL.md'),
      entry('M', 'skills/block-runner/references/GUIDE.md'),
      entry('M', 'README.md'),
    ]),
    {
      route: 'skill',
      docs: ['README.md', 'skills/block-runner/SKILL.md', 'skills/block-runner/references/GUIDE.md'],
      reason: 'skill-and-root-documentation-only',
    },
  );
});

test('keeps mixed documentation and runtime changes on the full route', () => {
  assert.equal(classifyChanges([entry('M', 'README.md'), entry('M', 'src/index.ts')]).route, 'full');
});

test('keeps unknown Markdown on the full route', () => {
  assert.equal(classifyChanges([entry('M', 'dev/benchmarks/README.md')]).route, 'full');
});

test('keeps renames and copies on the full route even when every path is allowlisted', () => {
  assert.equal(classifyChanges([entry('R100', 'README.md', 'src/README.md')]).route, 'full');
  assert.equal(classifyChanges([entry('R100', 'skills/block-runner/SKILL.md', 'README.md')]).route, 'full');
  assert.equal(classifyChanges([entry('C100', 'README.md', 'CHANGELOG.md')]).route, 'full');
});

test('keeps deletions on the full route even when the deleted path is allowlisted', () => {
  assert.equal(classifyChanges([entry('D', 'scripts/old-check.mjs')]).route, 'full');
  assert.equal(classifyChanges([entry('D', 'ERRORS.md')]).route, 'full');
});

test('keeps type changes and unmerged paths on the full route', () => {
  assert.equal(classifyChanges([entry('T', 'README.md')]).route, 'full');
  assert.equal(classifyChanges([entry('U', 'README.md')]).route, 'full');
});

test('keeps empty input and unavailable or malformed diffs on the full route', () => {
  assert.equal(classifyChanges([]).route, 'full');
  assert.deepEqual(classifyDiffResult({ ok: false }), {
    route: 'full', docs: [], reason: 'diff-unavailable', classifierFailed: true,
  });
  const malformed = classifyDiffResult({ ok: true, output: 'Q\tREADME.md\n' });
  assert.equal(malformed.route, 'full');
  assert.equal(malformed.classifierFailed, true);
});

test('parses git name-status output including renames and deletions', () => {
  assert.deepEqual(parseNameStatus('R100\tREADME.md\tskills/block-runner/README.md\nD\tERRORS.md\n'), [
    entry('R100', 'README.md', 'skills/block-runner/README.md'),
    entry('D', 'ERRORS.md'),
  ]);
});
