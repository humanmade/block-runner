import { describe, expect, it } from 'vitest';
import { generatedMarkupItems } from '../../src/gate/provenance.js';
import { formatTextReport } from '../../src/report/text.js';
import type { BlockRunnerReport } from '../../src/types.js';

function report(items: BlockRunnerReport['items']): BlockRunnerReport {
  return { ok: false, command: 'author', summary: { blocks: 1, valid: 0, invalid: 1, warnings: 1 }, items };
}

describe('text reports', () => {
  it('keeps authored locations for direct validation and labels serialized-output locations separately', () => {
    const generated = generatedMarkupItems([{
      block: 'core/paragraph', status: 'invalid', reason: 'invalid block markup',
      source: { path: 'design.html', htmlLine: 3, htmlColumn: 1, offset: 42 },
    }], 'design.html')[0]!;

    expect(generated).toMatchObject({
      source: { htmlLine: 3, htmlColumn: 1, offset: 42 },
      details: { locationKind: 'generated-markup', inputPath: 'design.html' },
    });
    expect(generated.source).not.toHaveProperty('path');
    expect(formatTextReport(report([generated]))).toContain('(generated markup; line 3; input design.html)');
    expect(formatTextReport(report([{
      status: 'invalid', reason: 'invalid block markup', source: { path: 'design.html', htmlLine: 1 },
    }]))).toContain('(design.html line 1)');
  });

  it('renders bounded structured context without dumping malformed details', () => {
    const text = formatTextReport(report([
      {
        status: 'warning', reason: 'source reference is stale', code: 'stale-proposal-source-ref', rule: 'source-ref',
        details: { action: 'refresh-source-analysis', stage: 'intermediate', phase: 'source-analysis', total: 15, truncated: 3, categories: ['coverage-missing-declaration'] },
      },
      { status: 'warning', reason: 'same coverage group', details: { total: 15, truncated: 3, categories: ['coverage-missing-declaration'] } },
      { status: 'warning', reason: 'ordinary warning', details: ['not', 'a', 'record'] },
    ]));

    expect(text).toContain('code: stale-proposal-source-ref');
    expect(text).toContain('rule: source-ref');
    expect(text).toContain('stage: intermediate');
    expect(text).toContain('phase: source-analysis');
    expect(text).toContain('action: refresh-source-analysis');
    expect(text).toContain('coverage: 15 total; 3 omitted');
    expect(text.match(/coverage: 15 total; 3 omitted/g)).toHaveLength(1);
    expect(text).not.toContain('not,a,record');
  });
});
