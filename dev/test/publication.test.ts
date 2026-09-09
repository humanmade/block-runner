import { lstat, mkdir, mkdtemp, readFile, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { publicationHash, publishPublicationEntries, publishStagedFile, readStableRegularFile, reconcilePublicationCompletion, replacePublicationJournal, stagePublicationBytes, validatePublicationRetry, verifyPublicationTargets, verifyStagedPublicationBytes } from '../../src/publication.js';

it('stages verified bytes, publishes creates exclusively, and replaces journals atomically', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'block-runner-publication-'));
  const staged = path.join(directory, '.one.tmp');
  const target = path.join(directory, 'one.txt');
  expect(await stagePublicationBytes(staged, Buffer.from('one'))).toBe(publicationHash(Buffer.from('one')));
  await publishStagedFile(staged, target, false);
  await expect(publishStagedFile(staged, target, false)).rejects.toThrow();
  expect((await readStableRegularFile(target, 'not regular')).content.toString()).toBe('one');
  const journal = path.join(directory, 'recovery.json');
  await replacePublicationJournal(journal, { version: 1, completed: ['one.txt'] });
  expect(JSON.parse(await readFile(journal, 'utf8'))).toMatchObject({ version: 1, completed: ['one.txt'] });
});

it('classifies every unreadable, missing, linked, or changed final target as its adapter conflict', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'block-runner-publication-'));
  const first = path.join(directory, 'first.txt');
  const second = path.join(directory, 'second.txt');
  await writeFile(first, 'first');
  await writeFile(second, 'second');
  const entries = [first, second];
  const hashes = new Map([[first, publicationHash(Buffer.from('first'))], [second, publicationHash(Buffer.from('second'))]]);
  await expect(verifyPublicationTargets(entries, (entry) => entry, (entry) => hashes.get(entry)!,
    (entry) => new Error(`conflict ${entry}`), async (entry) => { if (entry === second) await writeFile(first, 'changed'); }))
    .rejects.toThrow(`conflict ${first}`);
  await symlink(first, path.join(directory, 'linked'));
  await expect(readStableRegularFile(path.join(directory, 'linked'), 'not regular')).rejects.toThrow('not regular');
  await writeFile(first, 'first');
  await unlink(second);
  await expect(verifyPublicationTargets(entries, (entry) => entry, (entry) => hashes.get(entry)!,
    (entry) => new Error(`conflict ${entry}`))).rejects.toThrow(`conflict ${second}`);
  await expect(verifyPublicationTargets([first], (entry) => entry, (entry) => hashes.get(entry)!,
    () => new Error('conflict'), async () => { throw new Error('callback failure'); }))
    .rejects.toThrow('callback failure');
});

type LifecycleEntry = { name: string; target: string; temporary: string; afterHash: string; replace: boolean; before?: string };
type LifecycleJournal = { version: 1; entries: LifecycleEntry[]; completed: string[] };

async function lifecycle(directory: string): Promise<LifecycleEntry[]> {
  const entries = await Promise.all(['create.txt', 'replace.txt', 'later.txt'].map(async (name) => {
    const target = path.join(directory, name);
    const temporary = path.join(directory, `.${name}.tmp`);
    const afterHash = await stagePublicationBytes(temporary, Buffer.from(`after-${name}`));
    return { name, target, temporary, afterHash, replace: name === 'replace.txt', ...(name === 'replace.txt' ? { before: 'before-replace' } : {}) };
  }));
  await writeFile(entries[1]!.target, entries[1]!.before!);
  return entries;
}

// Version 1 stays adapter-owned. This tiny codec deliberately gives recovery a new object graph.
function encodeJournal(entries: LifecycleEntry[], completed: Set<LifecycleEntry>): LifecycleJournal {
  return { version: 1, entries, completed: entries.filter((entry) => completed.has(entry)).map((entry) => entry.name) };
}

async function decodeJournal(journal: string): Promise<{ entries: LifecycleEntry[]; completed: Set<LifecycleEntry> }> {
  const parsed = JSON.parse(await readFile(journal, 'utf8')) as LifecycleJournal;
  expect(parsed.version).toBe(1);
  const entries = parsed.entries.map((entry) => ({ ...entry }));
  return { entries, completed: new Set(entries.filter((entry) => parsed.completed.includes(entry.name))) };
}

async function published(entry: LifecycleEntry): Promise<boolean> {
  try { return publicationHash((await readStableRegularFile(entry.target, 'published target changed')).content) === entry.afterHash; } catch { return false; }
}

async function validatePending(entry: LifecycleEntry): Promise<void> {
  if (entry.replace) {
    if (await readFile(entry.target, 'utf8') !== entry.before) throw new Error('pending replacement changed');
  } else {
    try { await lstat(entry.target); } catch { await verifyStagedPublicationBytes(entry, 'unsafe staged publication bytes'); return; }
    throw new Error('pending create appeared');
  }
  await verifyStagedPublicationBytes(entry, 'unsafe staged publication bytes');
}

it('runs the shared version-1 publication lifecycle matrix across interruption, restart, reconciliation, and pending failures', async () => {
  for (const interruptedAfter of [1, 2, 3]) {
    const directory = await mkdtemp(path.join(tmpdir(), 'block-runner-publication-'));
    const entries = await lifecycle(directory);
    const journal = path.join(directory, 'recovery.json');
    const completed = new Set<LifecycleEntry>();
    await replacePublicationJournal(journal, encodeJournal(entries, completed)); // durable before target one
    await expect(publishPublicationEntries(entries, (entry) => completed.has(entry),
      (entry) => publishStagedFile(entry.temporary, entry.target, entry.replace),
      (entry) => completed.add(entry), () => replacePublicationJournal(journal, encodeJournal(entries, completed)),
      async () => { if (completed.size === interruptedAfter) throw new Error(`interrupt ${interruptedAfter}`); }))
      .rejects.toThrow(`interrupt ${interruptedAfter}`);

    const restarted = await decodeJournal(journal);
    expect(restarted.entries.filter((entry) => restarted.completed.has(entry)).map((entry) => entry.name))
      .toEqual(entries.slice(0, interruptedAfter).map((entry) => entry.name));
    expect(restarted.entries.filter((entry) => !restarted.completed.has(entry)).map((entry) => entry.name))
      .toEqual(entries.slice(interruptedAfter).map((entry) => entry.name));
    expect(restarted.entries[1]!.before).toBe('before-replace');
    const reconciled = await reconcilePublicationCompletion(restarted.entries, () => 'invalid target');
    expect([...reconciled].map((entry) => entry.name)).toEqual(entries.slice(0, interruptedAfter).map((entry) => entry.name));
    const retryCompleted = await validatePublicationRetry(restarted.entries, (entry) => restarted.completed.has(entry), published,
      async () => { throw new Error('completed target changed'); }, validatePending);
    await publishPublicationEntries(restarted.entries, (entry) => retryCompleted.has(entry),
      (entry) => publishStagedFile(entry.temporary, entry.target, entry.replace), (entry) => retryCompleted.add(entry),
      () => replacePublicationJournal(journal, encodeJournal(restarted.entries, retryCompleted)), async () => undefined);
    await verifyPublicationTargets(restarted.entries, (entry) => entry.target, (entry) => entry.afterHash, () => new Error('final target changed'));
    for (const entry of restarted.entries) expect(await readFile(entry.target, 'utf8')).toBe(`after-${entry.name}`);
  }

  { // A crash after publication but before journal progression is reconciled without overwriting entry one.
    const directory = await mkdtemp(path.join(tmpdir(), 'block-runner-publication-'));
    const entries = await lifecycle(directory);
    const journal = path.join(directory, 'recovery.json');
    await replacePublicationJournal(journal, encodeJournal(entries, new Set()));
    await publishStagedFile(entries[0]!.temporary, entries[0]!.target, false);
    const restarted = await decodeJournal(journal);
    const reconciled = await reconcilePublicationCompletion(restarted.entries, () => 'invalid target');
    expect([...reconciled].map((entry) => entry.name)).toEqual(['create.txt']);
    await publishPublicationEntries(restarted.entries, (entry) => reconciled.has(entry),
      (entry) => publishStagedFile(entry.temporary, entry.target, entry.replace), (entry) => reconciled.add(entry),
      () => replacePublicationJournal(journal, encodeJournal(restarted.entries, reconciled)), async () => undefined);
    expect(await readFile(entries[0]!.target, 'utf8')).toBe('after-create.txt');
  }

  const negativeCases: Array<{ name: string; mutate: (entries: LifecycleEntry[]) => Promise<void>; error: string; unchanged: (entries: LifecycleEntry[]) => Promise<void> }> = [
    { name: 'appeared pending create', mutate: async ([, , entry]) => { await writeFile(entry!.target, 'raced-create'); }, error: 'pending create appeared', unchanged: async ([, , entry]) => { expect(await readFile(entry!.target, 'utf8')).toBe('raced-create'); } },
    { name: 'changed pending replacement', mutate: async ([, entry]) => { await writeFile(entry!.target, 'raced-replacement'); }, error: 'pending replacement changed', unchanged: async ([, entry]) => { expect(await readFile(entry!.target, 'utf8')).toBe('raced-replacement'); } },
    { name: 'missing staging', mutate: async ([, , entry]) => { await unlink(entry!.temporary); }, error: 'ENOENT', unchanged: async () => undefined },
    { name: 'hash-corrupt staging', mutate: async ([, , entry]) => { await writeFile(entry!.temporary, 'corrupt'); }, error: 'unsafe staged publication bytes', unchanged: async () => undefined },
    { name: 'symlinked staging', mutate: async ([, , entry]) => { await unlink(entry!.temporary); await symlink(entry!.target, entry!.temporary); }, error: 'unsafe staged publication bytes', unchanged: async () => undefined },
    { name: 'directory staging', mutate: async ([, , entry]) => { await unlink(entry!.temporary); await mkdir(entry!.temporary); }, error: 'unsafe staged publication bytes', unchanged: async () => undefined },
  ];
  for (const scenario of negativeCases) {
    const directory = await mkdtemp(path.join(tmpdir(), 'block-runner-publication-'));
    const entries = await lifecycle(directory);
    const journal = path.join(directory, 'recovery.json');
    const completed = new Set<LifecycleEntry>();
    await replacePublicationJournal(journal, encodeJournal(entries, completed));
    await expect(publishPublicationEntries(entries, (entry) => completed.has(entry),
      (entry) => publishStagedFile(entry.temporary, entry.target, entry.replace),
      (entry) => completed.add(entry), () => replacePublicationJournal(journal, encodeJournal(entries, completed)),
      async () => { throw new Error('interrupt with pending work'); })).rejects.toThrow('interrupt with pending work');
    await scenario.mutate(entries);
    const restarted = await decodeJournal(journal);
    await expect(validatePublicationRetry(restarted.entries, (entry) => restarted.completed.has(entry), published,
      async () => { throw new Error('completed target changed'); }, validatePending)).rejects.toThrow(scenario.error);
    expect(await readFile(entries[0]!.target, 'utf8')).toBe('after-create.txt');
    if (scenario.name !== 'changed pending replacement') expect(await readFile(entries[1]!.target, 'utf8')).toBe('before-replace');
    if (scenario.name !== 'appeared pending create') await expect(lstat(entries[2]!.target)).rejects.toThrow();
    await scenario.unchanged(entries);
  }
});
