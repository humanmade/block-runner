import { afterEach, describe, expect, it, vi } from 'vitest';
import { readCanonicalSkillGuide, validateCanonicalSkill } from '../../src/skill.js';
import { validateAuthoringPlan } from '../../src/authoring/schema.js';
import { compileRegisteredBlock } from '../../src/authoring/generate.js';

afterEach(() => {
  vi.doUnmock('node:fs');
  vi.resetModules();
});

describe('canonical agent skill', () => {
  it('compiles the complete registered-block plan taught to calling agents', async () => {
    const guide = await readCanonicalSkillGuide();
    const example = guide.match(/Here is a complete valid plan[\s\S]*?```json\n([\s\S]*?)\n```/);
    expect(example).not.toBeNull();
    const generated = compileRegisteredBlock(validateAuthoringPlan(JSON.parse(example![1]!)));
    expect(generated.files).toHaveLength(7);
    expect(generated.template[0]?.[2]?.[0]?.[1]).toMatchObject({
      content: 'Our features',
      metadata: { bindings: { __default: { source: 'core/pattern-overrides' } } },
    });
  });

  it('passes the portable Agent Skills invariants', async () => {
    await expect(validateCanonicalSkill()).resolves.toBeUndefined();
  });

  it('reads only the ordered page references with Unicode and trailing-newline normalization', async () => {
    const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
    const reads: string[] = [];
    vi.resetModules();
    vi.doMock('node:fs', () => ({
      ...actual,
      readFileSync(file: string, encoding: string) {
        reads.push(file);
        if (file.endsWith('/GUIDE.md')) return 'guide α';
        if (file.endsWith('/ASSEMBLE.md')) return 'assemble β\n';
        throw new Error(`unexpected page reference read: ${file}`);
      },
    }));
    const { readPageIntentSkillGuideSync } = await import('../../src/skill.js');

    expect(readPageIntentSkillGuideSync()).toBe(
      'guide α\n\n---\n\n<!-- references/ASSEMBLE.md -->\n\nassemble β\n',
    );
    expect(reads.map((file) => file.split('/').at(-1))).toEqual(['GUIDE.md', 'ASSEMBLE.md']);
  });
});
