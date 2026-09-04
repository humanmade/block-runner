/** Print or check corpus hashes using the scorer's exact byte/path hashing algorithm. No model calls. */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { canonicalJson, corpusHashes, hashCorpusTree, hashFile } from './authoring/score.js';

export function createAuthoringHashManifest(directory: string): Record<string, unknown> {
  const bare = (value: string): string => value.replace(/^sha256:/, '');
  const corpus = corpusHashes(directory, { verifyManifest: false });
  const file = (name: string): string => bare(hashFile(path.join(directory, name)));
  return {
    algorithm: 'sha256',
    generatedFrom: 'repository content; regenerate before a release record if any listed input changes',
    values: {
      suiteHash: { value: bare(corpus.corpusHash), inputs: 'all corpus files except hashes.json and runs/, ordered by path; canonical JSON path/raw-byte-SHA-256 pairs' },
      fixtureDefinitionHash: { value: bare(hashCorpusTree(directory, (relative) => relative.startsWith('fixtures/'))), inputs: 'fixtures/** as canonical path/raw-byte-SHA-256 pairs' },
      sourceSetHash: { value: bare(corpus.sourceSetHash), inputs: 'sources/** as canonical path/raw-byte-SHA-256 pairs' },
      fixtureIndexHash: file('fixtures.json'),
      fixtureSchemaHash: file('schema.json'),
      contractHash: file('contract.md'),
      candidateContractHash: file('candidate-contract.json'),
      provenanceGuideHash: file('provenance.template.json'),
      releaseMatrixHash: file('release-matrix.json'),
      suiteManifestHash: file('suite.json'),
      fixtureManifestHash: bare(corpus.fixtureManifestHash),
      sourceDependencyHash: bare(corpus.sourceDependencyHash),
      expectedPlanHash: bare(corpus.expectedPlanHash),
      receiptSchemaHash: file('receipt.schema.json'),
    },
    perRunOnly: {
      scorerHash: 'Hash the exact scorer/runner revision, not this corpus.',
      templateHash: 'Hash the production compiler and plugin profile used for the candidate.',
      dependencyHash: 'Hash the exact candidate lockfile and installed dependency inventory.',
      wordpressHash: 'Hash the observed WordPress install and installed plugin inventory.',
      themeHash: 'Hash the observed theme slug/version and active theme.json.',
      browserHash: 'Hash observed browser name/version plus viewport and deviceScaleFactor.',
    },
    command: 'node --import tsx scripts/authoring-hashes.ts',
  };
}

function main(): void {
  const args = process.argv.slice(2);
  if (args.some((arg) => arg !== '--check')) throw new Error('Usage: node --import tsx scripts/authoring-hashes.ts [--check]');
  const directory = path.resolve('benchmarks/authoring');
  const expected = createAuthoringHashManifest(directory);
  if (args.includes('--check')) {
    const recorded = JSON.parse(readFileSync(path.join(directory, 'hashes.json'), 'utf8'));
    if (canonicalJson(recorded) !== canonicalJson(expected)) throw new Error('Authoring corpus hashes are stale; regenerate with scripts/authoring-hashes.ts');
    console.log('Authoring corpus hashes match all current inputs.');
  } else {
    console.log(JSON.stringify(expected, null, 2));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main();
