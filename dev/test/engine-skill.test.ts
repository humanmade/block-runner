import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cacheKey } from '../../scripts/tuner/cache.js';

const TASK = `
---

Your task: convert the HTML below into an intent tree, following the guide above.

Output ONLY the intent JSON, between a line ===INTENT_START=== and a line ===INTENT_END===.
Do not run any commands, write any files, or output block markup.

HTML:
`;

function pageGuide(guide: string, assemble: string): string {
  return `${guide.endsWith('\n') ? guide : `${guide}\n`}\n---\n\n<!-- references/ASSEMBLE.md -->\n\n${assemble.endsWith('\n') ? assemble : `${assemble}\n`}`;
}

interface SourceReferences {
  guide: string;
  assemble: string | Error;
  authoring: string;
}

async function loadEngine(references: SourceReferences) {
  const execFileSync = vi.fn((_command: string, _args: string[], _options: { input?: string }) => '{"blocks":[]}');
  const actualFs = await vi.importActual<typeof import('node:fs')>('node:fs');
  vi.resetModules();
  vi.doMock('node:child_process', async (importOriginal) => ({
    ...(await importOriginal<typeof import('node:child_process')>()),
    execFileSync,
  }));
  vi.doMock('node:fs', () => ({
    ...actualFs,
    readFileSync(file: string, encoding: string) {
      const name = file.split('/').at(-1);
      const source = name === 'GUIDE.md'
        ? references.guide
        : name === 'ASSEMBLE.md'
          ? references.assemble
          : name === 'AUTHORING.md'
            ? references.authoring
            : undefined;
      if (source instanceof Error) throw source;
      if (source !== undefined) return source;
      return actualFs.readFileSync(file, encoding as BufferEncoding);
    },
  }));
  const engine = await import('../../scripts/engines/engine-skill.js');
  return { engine, execFileSync };
}

afterEach(() => {
  vi.doUnmock('node:child_process');
  vi.doUnmock('node:fs');
  vi.resetModules();
});

function identity(promptHash: string, instructionProvenance: { guideHash: string }): string {
  return cacheKey({
    engineLabel: 'engine-skill',
    model: 'test-model',
    effort: 'low',
    inputHtml: '<p>same input</p>',
    promptHash,
    instructionProvenance,
  });
}

describe('skill benchmark engine', () => {
  it('passes the selected page references, task framing, and HTML to a mocked subprocess', async () => {
    const references = { guide: 'GUIDE α', assemble: 'ASSEMBLE β\n', authoring: 'AUTHORING excluded' };
    const { engine, execFileSync } = await loadEngine(references);
    const selected = pageGuide(references.guide, references.assemble);

    await engine.propose('<main>input</main>');

    expect(execFileSync).toHaveBeenCalledOnce();
    expect(execFileSync.mock.calls[0]?.[2]).toMatchObject({ input: `${selected}${TASK}<main>input</main>` });
  });

  it('changes page identity for selected references but not an excluded authoring reference', async () => {
    const baseReferences = { guide: 'GUIDE', assemble: 'ASSEMBLE', authoring: 'AUTHORING original' };
    const authoringOnlyChange = { ...baseReferences, authoring: 'AUTHORING changed' };
    const selectedChange = { ...baseReferences, guide: 'GUIDE changed' };
    const baseRun = await loadEngine(baseReferences);
    await baseRun.engine.propose('<p>same input</p>');
    const base = baseRun.engine;
    const basePromptHash = base.promptHash;
    const baseProvenance = base.agentSkillProvenance;
    const authoringRun = await loadEngine(authoringOnlyChange);
    await authoringRun.engine.propose('<p>same input</p>');
    const authoring = authoringRun.engine;
    const changedRun = await loadEngine(selectedChange);
    await changedRun.engine.propose('<p>same input</p>');
    const changed = changedRun.engine;
    const changedPromptHash = changed.promptHash;
    const changedProvenance = changed.agentSkillProvenance;

    expect(baseRun.execFileSync.mock.calls[0]?.[2]).toMatchObject({ input: expect.not.stringContaining('AUTHORING original') });
    expect(authoringRun.execFileSync.mock.calls[0]?.[2]).toMatchObject({ input: expect.not.stringContaining('AUTHORING changed') });
    expect(authoringRun.execFileSync.mock.calls[0]?.[2]).toMatchObject({ input: baseRun.execFileSync.mock.calls[0]?.[2]?.input });
    expect(basePromptHash).not.toBe(changedPromptHash);
    expect(baseProvenance).not.toEqual(changedProvenance);
    expect(identity(basePromptHash, baseProvenance)).not.toBe(identity(changedPromptHash, changedProvenance));
    expect(authoring.promptHash).toBe(basePromptHash);
    expect(authoring.agentSkillProvenance).toEqual(baseProvenance);
    expect(identity(authoring.promptHash, authoring.agentSkillProvenance)).toBe(identity(basePromptHash, baseProvenance));
  });

  it('hashes the exact selected reference text', async () => {
    const source = { guide: 'GUIDE', assemble: 'ASSEMBLE', authoring: 'AUTHORING excluded' };
    const { engine } = await loadEngine(source);
    const expected = `sha256:${createHash('sha256').update(pageGuide(source.guide, source.assemble)).digest('hex')}`;

    expect(engine.agentSkillProvenance).toEqual({ guideHash: expected });
  });
});
