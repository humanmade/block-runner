import { lstat, mkdtemp, readFile, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { publicationHash, publishPublicationEntries, publishStagedFile, readStableRegularFile, reconcilePublicationCompletion, replacePublicationJournal, stagePublicationBytes, validatePublicationRetry, verifyPublicationTargets, verifyStagedPublicationBytes } from '../src/publication.js';

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

it('reconciles only stable completed bytes and validates staged retry inputs before adapter publication', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'block-runner-publication-'));
  const target = path.join(directory, 'target.txt');
  const temporary = path.join(directory, '.target.tmp');
  const afterHash = await stagePublicationBytes(temporary, Buffer.from('approved'));
  const entry = { target, temporary, afterHash };
  expect(await reconcilePublicationCompletion([entry], () => 'not regular')).toEqual(new Set());
  await writeFile(target, 'approved');
  expect(await reconcilePublicationCompletion([entry], () => 'not regular')).toEqual(new Set([entry]));
  await writeFile(temporary, 'changed');
  await expect(verifyStagedPublicationBytes(entry, 'staged bytes changed')).rejects.toThrow('staged bytes changed');
  await expect(validatePublicationRetry([entry], () => true, async () => false,
    async () => { throw new Error('completed target changed'); }, async () => undefined)).rejects.toThrow('completed target changed');
});

it('keeps the common interrupted lifecycle inventory ordered and durable across restart checks', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'block-runner-publication-'));
  const entries = await Promise.all(['create.txt', 'replace.txt', 'later.txt'].map(async (name) => {
    const target = path.join(directory, name);
    const temporary = path.join(directory, `.${name}.tmp`);
    const afterHash = await stagePublicationBytes(temporary, Buffer.from(`after-${name}`));
    return { target, temporary, afterHash, replace: name === 'replace.txt' };
  }));
  await writeFile(entries[1].target, 'before-replace');
  const completed = new Set<typeof entries[number]>();
  const journal = path.join(directory, 'recovery.json');
  const inventories: string[][] = [];
  await replacePublicationJournal(journal, { version: 1, completed: [] }); // durable before target one
  await expect(publishPublicationEntries(entries, (entry) => completed.has(entry),
    (entry) => publishStagedFile(entry.temporary, entry.target, entry.replace),
    (entry) => completed.add(entry), async () => {
      inventories.push(entries.filter((entry) => completed.has(entry)).map((entry) => path.basename(entry.target)));
      await replacePublicationJournal(journal, { version: 1, completed: inventories.at(-1) });
    }, async (entry) => { if (entry === entries[1]) throw new Error('stop after durable second target'); }))
    .rejects.toThrow('stop after durable second target');
  expect(inventories).toEqual([['create.txt'], ['create.txt', 'replace.txt']]);
  expect(JSON.parse(await readFile(journal, 'utf8')).completed).toEqual(['create.txt', 'replace.txt']);
  expect(await readFile(entries[1].target, 'utf8')).toBe('after-replace.txt');
  expect(await lstat(entries[2].temporary)).toBeTruthy();

  await writeFile(entries[2].target, 'raced-create');
  await expect(validatePublicationRetry(entries, (entry) => completed.has(entry),
    async (entry) => publicationHash(await readFile(entry.target)) === entry.afterHash,
    async () => { throw new Error('completed target changed'); }, async (entry) => {
      if (entry === entries[2]) throw new Error('pending create appeared');
    })).rejects.toThrow('pending create appeared');
  expect(await readFile(entries[2].target, 'utf8')).toBe('raced-create');
});

it('rejects corrupt, linked, or non-regular staging and reconciles ambiguous post-publication bytes as pending', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'block-runner-publication-'));
  const temporary = path.join(directory, '.entry.tmp');
  const target = path.join(directory, 'entry.txt');
  const afterHash = await stagePublicationBytes(temporary, Buffer.from('approved'));
  const entry = { target, temporary, afterHash };
  await writeFile(temporary, 'corrupt');
  await expect(verifyStagedPublicationBytes(entry, 'corrupt staging')).rejects.toThrow('corrupt staging');
  await unlink(temporary);
  await symlink(target, temporary);
  await expect(verifyStagedPublicationBytes(entry, 'unsafe staging')).rejects.toThrow('unsafe staging');
  await unlink(temporary);
  await writeFile(temporary, 'approved');
  await writeFile(target, 'ambiguous other bytes');
  expect(await reconcilePublicationCompletion([entry], () => 'not regular')).toEqual(new Set());
  await expect(publishStagedFile(temporary, target, false)).rejects.toThrow();
  expect(await readFile(target, 'utf8')).toBe('ambiguous other bytes');
});
