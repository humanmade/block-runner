import { mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { publicationHash, publishStagedFile, readStableRegularFile, replacePublicationJournal, stagePublicationBytes, verifyPublicationTargets } from '../src/publication.js';

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

it('rejects changed or non-regular final targets at the shared boundary', async () => {
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
});
