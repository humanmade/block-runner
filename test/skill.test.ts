import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { readCanonicalSkillGuide, validateCanonicalSkill } from '../src/skill.js';

describe('canonical agent skill', () => {
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

    expect(fixture.shouldTrigger).toHaveLength(8);
    expect(fixture.shouldNotTrigger).toHaveLength(8);
    expect(new Set([...fixture.shouldTrigger, ...fixture.shouldNotTrigger]).size).toBe(16);
    expect(fixture.shouldTrigger.every((prompt) => /WordPress|Gutenberg|block/i.test(prompt))).toBe(true);
    expect(fixture.shouldNotTrigger.some((prompt) => /non-WordPress|not use WordPress/i.test(prompt))).toBe(true);
  });
});
