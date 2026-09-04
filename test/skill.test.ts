import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { readCanonicalSkillGuide, validateCanonicalSkill } from '../src/skill.js';
import { validateAuthoringPlan } from '../src/authoring/schema.js';
import { compileRegisteredBlock } from '../src/authoring/generate.js';

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

    const skill = await readFile(new URL('../skills/block-runner/SKILL.md', import.meta.url), 'utf8');
    expect(skill.startsWith('---\n')).toBe(true);
    expect(skill).toContain('name: block-runner');
    expect(skill).toContain('license: GPL-2.0-or-later');
    expect(skill).toContain('compatibility: Requires Node.js 20+');
    expect(skill).toContain('references/GUIDE.md');
    expect(await readCanonicalSkillGuide()).toContain('# Block Runner — agent guide');
  });

  it('keeps a balanced activation regression set', async () => {
    const fixture = JSON.parse(
      await readFile(new URL('./fixtures/skill-activation.json', import.meta.url), 'utf8'),
    ) as { shouldTrigger: string[]; shouldNotTrigger: string[] };

    expect(fixture.shouldTrigger).toHaveLength(9);
    expect(fixture.shouldNotTrigger).toHaveLength(8);
    expect(new Set([...fixture.shouldTrigger, ...fixture.shouldNotTrigger]).size).toBe(17);
    expect(fixture.shouldTrigger.every((prompt) => /WordPress|Gutenberg|block/i.test(prompt))).toBe(true);
    expect(fixture.shouldNotTrigger.some((prompt) => /non-WordPress|not use WordPress/i.test(prompt))).toBe(true);
    expect(fixture.shouldTrigger).toContain('Create a reusable named Gutenberg block in my existing WordPress plugin.');
  });
});
