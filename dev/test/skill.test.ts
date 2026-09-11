import { readFile } from 'node:fs/promises';
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

    const skill = await readFile(new URL('../../skills/block-runner/SKILL.md', import.meta.url), 'utf8');
    expect(skill.startsWith('---\n')).toBe(true);
    expect(skill).toContain('name: block-runner');
    expect(skill).toContain('license: GPL-2.0-or-later');
    expect(skill).toContain('compatibility: Requires Node.js ^20.19.0 || ^22.13.0 || >=24.0.0');
    expect(skill).toContain('references/GUIDE.md');
    const guide = await readCanonicalSkillGuide();
    expect(guide).toContain('# Block Runner — agent guide');
    expect(guide).toContain('Primary HTML workflow: complete proposal → canonical plan');
    expect(guide).toContain('authoring-proposal-example:start');
    expect(guide).toContain('Continue project-owned development when static generation does not fit');
    expect(guide).toContain('<!-- references/AUTHORING.md -->');
    expect(guide).toContain('<!-- references/ASSEMBLE.md -->');
    expect(guide).toMatch(/custom PHP renderer or custom editor\s+behaviour/);
  });

  it('keeps activation coverage and explicit artifact routes', async () => {
    const fixture = JSON.parse(
      await readFile(new URL('./fixtures/skill-activation.json', import.meta.url), 'utf8'),
    ) as {
      shouldTrigger: string[];
      shouldNotTrigger: string[];
      routes: Array<{
        prompt: string;
        route: 'assemble' | 'convert' | 'author' | 'project-owned' | 'validate-fix-validate' | 'exclude' | 'clarify-artifact';
        firstReference: string | null;
        artifact: string;
      }>;
    };

    expect(fixture.shouldTrigger.length).toBeGreaterThan(0);
    expect(fixture.shouldNotTrigger.length).toBeGreaterThan(0);
    expect(new Set([...fixture.shouldTrigger, ...fixture.shouldNotTrigger]).size).toBe(
      fixture.shouldTrigger.length + fixture.shouldNotTrigger.length,
    );
    expect(fixture.shouldTrigger.every((prompt) => /WordPress|Gutenberg|block/i.test(prompt))).toBe(true);
    expect(fixture.shouldNotTrigger.some((prompt) => /non-WordPress|not use WordPress/i.test(prompt))).toBe(true);
    expect(fixture.shouldTrigger).toContain('Create a reusable named Gutenberg block in my existing WordPress plugin.');

    const routeNames = new Set(fixture.routes.map((entry) => entry.route));
    expect(routeNames).toEqual(
      new Set(['assemble', 'convert', 'author', 'project-owned', 'validate-fix-validate', 'exclude', 'clarify-artifact']),
    );
    expect(fixture.routes.every((entry) => entry.prompt.length > 0 && entry.artifact.length > 0)).toBe(true);
    expect(
      fixture.routes
        .filter((entry) => entry.route !== 'exclude')
        .every((entry) => entry.firstReference?.startsWith('references/')),
    ).toBe(true);
    expect(fixture.routes.filter((entry) => entry.route === 'exclude').every((entry) => entry.firstReference === null)).toBe(true);
    expect(fixture.routes.find((entry) => entry.route === 'clarify-artifact')?.artifact).toContain('before writing');

    const skill = await readFile(new URL('../../skills/block-runner/SKILL.md', import.meta.url), 'utf8');
    for (const reference of fixture.routes.flatMap((entry) => (entry.firstReference ? [entry.firstReference] : []))) {
      expect(skill).toContain(reference.split('#', 1)[0]!);
    }
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

  it('surfaces a missing selected page reference', async () => {
    const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
    vi.resetModules();
    vi.doMock('node:fs', () => ({
      ...actual,
      readFileSync(file: string, encoding: string) {
        if (file.endsWith('/GUIDE.md')) return 'guide\n';
        if (file.endsWith('/ASSEMBLE.md')) throw new Error('ENOENT: no such file or directory');
        return actual.readFileSync(file, encoding as BufferEncoding);
      },
    }));
    const { readPageIntentSkillGuideSync } = await import('../../src/skill.js');

    expect(() => readPageIntentSkillGuideSync()).toThrow('ENOENT: no such file or directory');
  });
});
