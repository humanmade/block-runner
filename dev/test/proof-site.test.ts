import { cp, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { prepareSiteSource } from '../../src/site/input.js';
import { compileSite } from '../../src/site/compile.js';
import { writeCompiledSite } from '../../src/site/write.js';
import { prepareSiteProof, runSiteProof, SITE_PROOF_GATES, siteOwnedRecord, siteFixturePhp, topologicalSitePages, siteTrashOverridesPhp } from '../../src/proof/site.js';
import { EvidenceStore } from '../../src/proof/receipt.js';
import { evaluateProofProfile, PROOF_PROFILES } from '../../src/proof/profiles.js';
import type { ProofCommandResult } from '../../src/proof/runner.js';

const fixture = fileURLToPath(new URL('./fixtures/site-intent', import.meta.url));
async function bundle(published = true) {
  const root = await mkdtemp(path.join(await realpath(tmpdir()), 'block-runner-proof-site-'));
  await cp(fixture, path.join(root, 'source'), { recursive: true });
  const intent = JSON.parse(await readFile(path.join(root, 'source/site.intent.json'), 'utf8'));
  if (published) for (const page of intent.pages) page.status = 'publish';
  const result = await prepareSiteSource(intent, path.join(root, 'source'));
  if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
  const compiled = await compileSite(result.source, { attachmentBindings: { 'home-hero': { id: 321, url: 'http://localhost:8888/hero.png' } } });
  if (!compiled.ok) throw new Error(JSON.stringify(compiled.diagnostics));
  const directory = path.join(root, 'bundle');
  await writeCompiledSite(directory, result.source, compiled.site);
  const evidence = new EvidenceStore(path.join(root, 'receipts'));
  return { root, directory, evidence };
}
const commandResult = (stdout = '', exitCode = 0): ProofCommandResult => ({ command: 'fixture-adapter', args: [], stdout, stderr: '', exitCode });

describe('controlled site proof', () => {
  it('pins the explicit published variant without promoting the ordinary draft fixture', async () => {
    const draft = await bundle(false);
    await expect(prepareSiteProof(draft.directory, draft.evidence)).rejects.toThrow('draft statuses are never promoted');
    const control = await bundle();
    const prepared = await prepareSiteProof(control.directory, control.evidence);
    expect(prepared.theme.slug).toBe('sample-studio');
    expect(prepared.bundleHash).toMatch(/^sha256:/);
    expect(prepared.source.sourceIntent.pages.every((page) => page.status === 'publish')).toBe(true);
  });
  it('rejects changed bundle bytes before runtime setup', async () => {
    const input = await bundle();
    await writeFile(path.join(input.directory, 'theme/style.css'), 'changed');
    await expect(prepareSiteProof(input.directory, input.evidence)).rejects.toThrow('inventory mismatch');
  });
  it('rejects an asset mutation between inventory verification and source preparation', async () => {
    const input = await bundle();
    const assetPath = path.join(input.directory, 'source/assets/media/hero.png');
    const originalBytes = await readFile(assetPath);
    const originalPut = input.evidence.put.bind(input.evidence);
    let mutated = false;
    vi.spyOn(input.evidence, 'put').mockImplementation(async (value, options) => {
      const reference = await originalPut(value, options);
      if (!mutated && value instanceof Uint8Array && Buffer.from(value).equals(originalBytes)) {
        mutated = true;
        await writeFile(assetPath, Buffer.concat([originalBytes, Buffer.from('mutation')]));
      }
      return reference;
    });
    await expect(prepareSiteProof(input.directory, input.evidence)).rejects.toThrow('Prepared source asset differs from verified bundle inventory');
    expect(mutated).toBe(true);
  });
  it('requires every independent gate and refuses failed, skipped, blocked or missing outcomes', () => {
    const profile = PROOF_PROFILES.site;
    const records = profile.requiredGates.map((gate) => ({ gate, status: 'pass' as const }));
    expect(evaluateProofProfile('site', records).ok).toBe(true);
    for (const gate of profile.requiredGates) for (const status of ['fail', 'skip', 'blocked'] as const) {
      expect(evaluateProofProfile('site', records.map((record) => record.gate === gate ? { ...record, status } : record)).ok).toBe(false);
    }
    expect(evaluateProofProfile('site', records.slice(1)).ok).toBe(false);
  });
  it('keeps cleanup ownership and option restoration guards explicit', () => {
    expect(siteOwnedRecord({ id: 21, marker: 'owned' }, 'owned', 21)).toBe(true);
    expect(siteOwnedRecord({ id: 21, marker: 'other' }, 'owned', 21)).toBe(false);
    const cleanup = siteFixturePhp('owned', 'cleanup', {});
    expect(cleanup.indexOf('Unowned runtime or principal')).toBeLessThan(cleanup.indexOf('wp_trash_post'));
    expect(cleanup).toContain("get_post_meta($id,'_block_runner_proof',true)!==$marker");
    expect(cleanup).toContain('$preserved[]=$id');
  });
  it('sorts nested pages and rejects unresolved parents', () => {
    expect(topologicalSitePages([{ id: 'child', parentId: 'parent' }, { id: 'parent' }]).map((page) => page.id)).toEqual(['parent', 'child']);
    expect(() => topologicalSitePages([{ id: 'child', parentId: 'absent' }])).toThrow('unresolved');
    const cleanup = siteTrashOverridesPhp('owned', [{ id: 1, content: 'exact', postType: 'wp_template_part' }]);
    expect(cleanup).toContain('wp_trash_post');
    expect(cleanup).not.toContain('wp_delete');
  });
  it('wrong target preflight performs zero page or media fixture writes', async () => {
    const input = await bundle();
    const site = await prepareSiteProof(input.directory, input.evidence);
    const writes: string[] = [];
    const result = await runSiteProof({ site, stagedTheme: path.join(input.root, 'staged'), baseUrl: 'http://localhost:8888', helper: 'fixture-helper', evidence: input.evidence, negativeControl: 'wrong-target',
      wp: async (php) => { writes.push(php); if (php.includes('get_user_by')) return commandResult('1'); return commandResult(php.includes('echo base64_encode') ? Buffer.from('original').toString('base64') : ''); },
      command: async (_command, args) => { await writeFile(args[args.indexOf('--out') + 1]!, JSON.stringify({ runtimeBinding: { verified: false } })); return commandResult('', 1); },
    });
    expect(writes.some((php) => php.includes('wp_insert_post') || php.includes('wp_insert_attachment'))).toBe(false);
    expect(result.gates.site_fixture?.status).toBe('blocked');
  });
  it.each(['missing-content', 'broken-asset', 'broken-mobile'] as const)('seeds %s only after browser target verification', async (negativeControl) => {
    const input = await bundle();
    const site = await prepareSiteProof(input.directory, input.evidence);
    const writes: string[] = [];
    let browserCalls = 0;
    const result = await runSiteProof({ site, stagedTheme: path.join(input.root, 'staged/sample-studio'), baseUrl: 'http://localhost:8888', helper: 'fixture-helper', evidence: input.evidence, negativeControl,
      wp: async (php) => {
        writes.push(php);
        if (php.includes('get_user_by')) return commandResult('1');
        if (php.includes('get_stylesheet_directory_uri')) return commandResult('http://localhost:8888/custom-themes/sample-studio');
        if (php.includes('echo base64_encode')) return commandResult(Buffer.from('original').toString('base64'));
        if (php.includes('wp_insert_attachment')) return commandResult(JSON.stringify({ 'home-hero': { id: 71, url: 'http://localhost:8888/owned-image.png' } }));
        if (php.includes('wp_insert_post')) return commandResult(JSON.stringify({ home: 81, about: 82, services: 83, consulting: 84, contact: 85 }));
        if (php.includes('wp_trash_post')) return commandResult('{"preserved":[]}');
        return commandResult();
      },
      command: async (_command, args) => {
        browserCalls++;
        const report = browserCalls === 1 ? { runtimeBinding: { verified: true }, principal: { id: 1 } } : { gates: Object.fromEntries(SITE_PROOF_GATES.map((gate) => [gate, { status: gate === ({ 'missing-content': 'site_content', 'broken-asset': 'site_assets', 'broken-mobile': 'site_navigation' }[negativeControl]) ? 'fail' : 'pass' }])) };
        await writeFile(args[args.indexOf('--out') + 1]!, JSON.stringify(report));
        return commandResult();
      },
    });
    expect(browserCalls).toBe(2);
    expect(result.gates.site_cleanup?.status).toBe('pass');
    expect(result.gates[({ 'missing-content': 'site_content', 'broken-asset': 'site_assets', 'broken-mobile': 'site_navigation' } as const)[negativeControl]]?.status).toBe('fail');
    const pageWrite = writes.find((php) => php.includes('wp_insert_post'))!;
    const encoded = /\$data=json_decode\(base64_decode\('([^']+)'\)/.exec(pageWrite)![1]!;
    const seeded = JSON.parse(Buffer.from(encoded, 'base64').toString());
    if (negativeControl === 'missing-content') expect(seeded.pages[0].content).toBe('');
    if (negativeControl === 'broken-asset') expect(seeded.pages[0].content).toContain('missing-proof-image');
    if (negativeControl === 'broken-mobile') expect(await readFile(path.join(input.root, 'staged/sample-studio/assets/styles/site.css'), 'utf8')).toContain('pointer-events:none');
  });
});
