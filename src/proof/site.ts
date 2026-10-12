import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, writeFile, mkdtemp } from 'node:fs/promises';
import path from 'node:path';
import { prepareSiteSource } from '../site/input.js';
import { compileSite } from '../site/compile.js';
import type { PreparedSiteSource, CompiledSite } from '../site/types.js';
import type { ProofCommandResult, ProofGateResult } from './runner.js';
import type { EvidenceStore } from './receipt.js';
import { prepareThemeProof, type PreparedThemeProof } from './theme.js';

export const SITE_PROOF_GATES = ['site_fixture', 'site_content', 'site_routes', 'site_assets', 'site_frontend_styles', 'site_editor_styles', 'site_navigation', 'site_page_edit', 'site_part_edit', 'site_cleanup', 'site_runtime_errors'] as const;
export type SiteProofGate = typeof SITE_PROOF_GATES[number];
export interface PreparedSiteProof {
  root: string;
  source: PreparedSiteSource;
  bundleHash: string;
  sourceHash: string;
  theme: PreparedThemeProof;
}
const hash = (bytes: Uint8Array | string) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;

/** This is deliberately a five-page published proof fixture, never a general site apply adapter. */
export async function prepareSiteProof(directory: string, evidence: EvidenceStore): Promise<PreparedSiteProof> {
  const root = path.resolve(directory);
  if ((await lstat(root)).isSymbolicLink()) throw new Error('Site proof requires a direct bundle directory.');
  const manifestBytes = await readFile(path.join(root, 'site.manifest.json'));
  const manifest = JSON.parse(manifestBytes.toString());
  if (manifest.formatVersion !== 1 || !Array.isArray(manifest.bundleFiles)) throw new Error('Site proof requires a version 1 site bundle inventory.');
  const seen = new Set<string>();
  for (const entry of manifest.bundleFiles) {
    if (typeof entry.path !== 'string' || entry.path.includes('\\') || entry.path.split('/').some((part: string) => !part || part === '.' || part === '..') || path.isAbsolute(entry.path) || seen.has(entry.path)) throw new Error('Unsafe or duplicate site bundle inventory path.');
    seen.add(entry.path);
    let cursor = root;
    for (const segment of entry.path.split('/')) {
      cursor = path.join(cursor, segment);
      if ((await lstat(cursor)).isSymbolicLink()) throw new Error('Site proof refuses symlinked bundle files.');
    }
    const bytes = await readFile(cursor);
    if (hash(bytes).slice(7) !== entry.sha256.replace(/^sha256:/, '') || bytes.length !== entry.size) throw new Error(`Site bundle inventory mismatch: ${entry.path}`);
    await evidence.put(bytes);
  }
  if (!seen.has('site.intent.json')) throw new Error('Site bundle does not pin its source intent.');
  const intent = JSON.parse(await readFile(path.join(root, 'site.intent.json'), 'utf8'));
  if (intent.pages?.length !== 5 || intent.pages.some((page: { status?: string }) => page.status !== 'publish')) throw new Error('Site proof requires a controlled source declaring exactly five published pages; draft statuses are never promoted.');
  const prepared = await prepareSiteSource(intent, path.join(root, 'source/assets'));
  if (!prepared.ok) throw new Error(JSON.stringify(prepared.diagnostics));
  const theme = await prepareThemeProof(path.join(root, 'theme'), evidence);
  if (theme.manifest.files.some((file) => !seen.has(`theme/${file.file}`)) || prepared.source.assets.some((asset) => !seen.has(`source/assets/${asset.path}`))) throw new Error('Site bundle contains unpinned theme or source asset bytes.');
  if (!intent.parts?.header || !intent.parts?.footer) throw new Error('Controlled site fixture requires declared header and footer parts.');
  theme.slug = prepared.source.sourceIntent.theme.slug;
  const ref = await evidence.put(manifestBytes, { mediaType: 'application/json' });
  return { root, source: prepared.source, bundleHash: ref.sha256, sourceHash: hash(JSON.stringify(prepared.source.sourceIntent)), theme };
}

export function siteOwnedRecord(record: { marker?: string; id?: number }, marker: string, id: number): boolean {
  return Boolean(marker) && record.marker === marker && Number.isInteger(id) && id > 0 && record.id === id;
}

export function siteFixturePhp(marker: string, action: 'assets' | 'pages' | 'cleanup', payload: unknown): string {
  const data = Buffer.from(JSON.stringify(payload)).toString('base64');
  const token = Buffer.from(marker).toString('base64');
  const guard = `$marker=base64_decode('${token}'); if (get_option('blogdescription') !== $marker || !current_user_can('manage_options')) { throw new Exception('Unowned runtime or principal; zero fixture writes'); } $data=json_decode(base64_decode('${data}'),true);`;
  const owned = `$owned=get_option($marker,array('ids'=>array(),'options'=>array()));`;
  const persist = `update_option($marker,$owned,false);`;
  if (action === 'assets') return `${guard} if(get_option($marker,false)!==false) throw new Exception('Fixture ownership collision'); $owned=array('ids'=>array(),'options'=>array()); foreach(array('show_on_front','page_on_front','permalink_structure') as $key) $owned['options'][$key]=get_option($key); ${persist} $bindings=array(); foreach($data as $asset){ $upload=wp_upload_bits($asset['name'],null,base64_decode($asset['bytes'])); if($upload['error']) throw new Exception($upload['error']); $id=wp_insert_attachment(array('post_title'=>$marker,'post_status'=>'inherit','post_mime_type'=>wp_check_filetype($asset['name'])['type']),$upload['file'],0,true); if(is_wp_error($id)) throw new Exception($id->get_error_message()); update_post_meta($id,'_block_runner_proof',$marker); $owned['ids'][]=$id; ${persist} $bindings[$asset['id']]=array('id'=>$id,'url'=>wp_get_attachment_url($id)); } echo json_encode($bindings);`;
  if (action === 'pages') return `${guard} ${owned} $pages=array(); foreach($data['pages'] as $p){ $parent=isset($p['parentId'])?($pages[$p['parentId']]??0):0; if(isset($p['parentId'])&&!$parent) throw new Exception('Parent must precede child'); $slug=basename(trim($p['route'],'/')); $id=wp_insert_post(array('post_type'=>'page','post_status'=>$p['status'],'post_title'=>$p['title'],'post_name'=>$slug?:'home','post_content'=>$p['content'],'post_parent'=>$parent),true); if(is_wp_error($id)) throw new Exception($id->get_error_message()); update_post_meta($id,'_block_runner_proof',$marker); update_post_meta($id,'_wp_page_template',$p['template']); $owned['ids'][]=$id; ${persist} $pages[$p['id']]=$id; } update_option('show_on_front','page'); update_option('page_on_front',$pages[$data['homePageId']]); update_option('permalink_structure','/%postname%/'); flush_rewrite_rules(); echo json_encode($pages);`;
  return `${guard} ${owned} $preserved=array(); foreach(array_reverse($owned['ids']) as $id){ if(get_post_meta($id,'_block_runner_proof',true)!==$marker){$preserved[]=$id;continue;} if(!defined('EMPTY_TRASH_DAYS') || EMPTY_TRASH_DAYS<1) throw new Exception('Recoverable trash unavailable; fixture preserved'); if(!wp_trash_post($id)) $preserved[]=$id; }  $frontOwned=get_option('show_on_front')==='page' && in_array((int)get_option('page_on_front'),$owned['ids'],true); foreach($owned['options'] as $key=>$value){ if(in_array($key,array('show_on_front','page_on_front'),true)&&!$frontOwned){$preserved[]=$key;continue;} if($key==='page_on_front'&&!in_array((int)get_option($key),$owned['ids'],true)){ $preserved[]=$key; continue; } if($key==='show_on_front'&&get_option($key)!=='page'){ $preserved[]=$key;continue; } if($key==='permalink_structure'&&get_option($key)!=='/%postname%/'){ $preserved[]=$key;continue; } update_option($key,$value); } if(!$preserved) delete_option($marker); flush_rewrite_rules(); echo json_encode(array('preserved'=>$preserved));`;
}


export function topologicalSitePages<T extends { id: string; parentId?: string }>(pages: T[]): T[] {
  const pending = new Map(pages.map((page) => [page.id, page]));
  const ordered: T[] = [];
  while (pending.size) {
    const ready = [...pending.values()].filter((page) => !page.parentId || ordered.some((parent) => parent.id === page.parentId));
    if (!ready.length) throw new Error('Site fixture has unresolved or cyclic page parents');
    for (const page of ready) { ordered.push(page); pending.delete(page.id); }
  }
  return ordered;
}
export function siteTrashOverridesPhp(marker: string, overrides: Array<{ id: number; content: string; postType: string }>): string {
  const data = Buffer.from(JSON.stringify(overrides)).toString('base64');
  const token = Buffer.from(marker).toString('base64');
  return `$marker=base64_decode('${token}'); if(get_option('blogdescription')!==$marker || !current_user_can('manage_options')) throw new Exception('Override cleanup target/principal mismatch'); $data=json_decode(base64_decode('${data}'),true); $trashed=array(); $preserved=array(); foreach($data as $record){ $post=get_post($record['id']); if(!$post || !in_array($record['postType'],array('wp_template','wp_template_part'),true) || $post->post_type!==$record['postType'] || $post->post_content!==$record['content']){$preserved[]=$record['id'];continue;} update_post_meta($post->ID,'_block_runner_proof',$marker); if(!defined('EMPTY_TRASH_DAYS') || EMPTY_TRASH_DAYS<1) throw new Exception('Recoverable trash unavailable; override preserved'); if(wp_trash_post($post->ID))$trashed[]=$post->ID;else $preserved[]=$post->ID; } echo json_encode(array('trashed'=>$trashed,'preserved'=>$preserved));`;
}

export async function runSiteProof(input: {
  site: PreparedSiteProof; stagedTheme: string; baseUrl: string; helper: string;
  wp: (php: string, userId?: number) => Promise<ProofCommandResult>;
  command: (command: string, args: string[]) => Promise<ProofCommandResult>;
  evidence: EvidenceStore;
  negativeControl?: 'missing-content' | 'broken-asset' | 'wrong-target' | 'accordion-mismatch' | 'broken-mobile';
}): Promise<{ gates: Partial<Record<SiteProofGate, ProofGateResult>>; compiled?: CompiledSite; theme?: PreparedThemeProof; browser?: unknown }> {
  const { site, evidence } = input;
  const marker = `block-runner-site-proof:${randomUUID()}`;
  const gates: Partial<Record<SiteProofGate, ProofGateResult>> = {};
  let original: string | undefined;
  let fixtureStarted = false;
  let compiled: CompiledSite | undefined;
  let theme: PreparedThemeProof | undefined;
  let browser: unknown;
  let principalId: number | undefined;
  let overrides: Array<{ id: number; content: string; postType: string }> = [];
  const execute = async (php: string) => {
    const result = await input.wp(php, principalId);
    await evidence.putJson(result);
    if (result.exitCode !== 0) throw new Error(result.stderr || result.stdout || 'Site fixture command failed');
    return result.stdout.trim();
  };
  try {
    const login = Buffer.from(process.env.WP_USERNAME ?? 'admin').toString('base64');
    principalId = Number(await execute(`$user=get_user_by('login',base64_decode('${login}')); echo $user ? $user->ID : 0;`));
    if (!Number.isInteger(principalId) || principalId < 1) throw new Error('Configured proof principal was not observed in the owned runtime');
    original = await execute("echo base64_encode(get_option('blogdescription')); ");
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(original)) throw new Error('Cannot capture runtime marker option safely');
    await execute(`update_option('blogdescription',base64_decode('${Buffer.from(marker).toString('base64')}'));`);
    const preflightWork = await mkdtemp(path.join(site.root, '.site-target-'));
    const preflightConfig = path.join(preflightWork, 'config.json');
    const preflightOutput = path.join(preflightWork, 'result.json');
    await writeFile(preflightConfig, JSON.stringify({ baseUrl: input.baseUrl, runtimeMarker: input.negativeControl === 'wrong-target' ? `${marker}:wrong` : marker, verifyOnly: true, principalId }));
    const preflight = await input.command(process.execPath, [input.helper, '--config', preflightConfig, '--out', preflightOutput]);
    await evidence.putJson(preflight);
    const target = JSON.parse(await readFile(preflightOutput, 'utf8'));
    if (preflight.exitCode !== 0 || target.runtimeBinding?.verified !== true || target.principal?.id !== principalId) throw new Error('Browser target/principal mismatch; zero fixture writes');
    fixtureStarted = true;
    const bindings = JSON.parse(await execute(siteFixturePhp(marker, 'assets', site.source.assets.filter((asset) => asset.role === 'attachment').map((asset) => ({ id: asset.id, name: path.basename(asset.path), bytes: Buffer.from(asset.bytes).toString('base64') })))));
    if (input.negativeControl === 'accordion-mismatch' && !Object.values(site.source.sourceIntent.templates).concat(Object.values(site.source.sourceIntent.parts)).some((document) => JSON.stringify(document.body).includes('core/accordion-heading'))) throw new Error('Accordion negative control requires a declared accordion heading in the controlled fixture.');
    const themeAssetBaseUrl = await execute('echo get_stylesheet_directory_uri();');
    if (new URL(themeAssetBaseUrl).origin !== new URL(input.baseUrl).origin) throw new Error('Observed theme asset URI points outside the owned runtime');
    const result = await compileSite(site.source, { attachmentBindings: bindings, themeAssetBaseUrl });
    if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
    compiled = result.site;
    for (const file of compiled.themeFiles) {
      const destination = path.join(input.stagedTheme, file.path);
      await mkdir(path.dirname(destination), { recursive: true });
      let bytes = file.bytes;
      if (input.negativeControl === 'accordion-mismatch' && file.path.endsWith('.html') && Buffer.from(bytes).toString().includes('wp:accordion-heading')) bytes = Buffer.from(Buffer.from(bytes).toString().replace(/(wp:accordion-heading\s*\{[^}]*"iconPosition":)"left"/, '$1"right"'));
      if (input.negativeControl === 'broken-mobile' && file.path === 'style.css') bytes = Buffer.concat([Buffer.from(bytes), Buffer.from('\n@media(max-width:600px){.wp-block-navigation__responsive-container-open{pointer-events:none!important}}\n')]);
      await writeFile(destination, bytes);
    }
    theme = await prepareThemeProof(input.stagedTheme, evidence);
    const seededPages = topologicalSitePages(structuredClone(compiled.pages));
    if (input.negativeControl === 'missing-content') seededPages[0]!.content = '';
    if (input.negativeControl === 'broken-asset') seededPages[0]!.content = seededPages[0]!.content.replace(/src="[^"]+"/, `src="${input.baseUrl}/missing-proof-image.png"`);
    const ids = JSON.parse(await execute(siteFixturePhp(marker, 'pages', { pages: seededPages, homePageId: site.source.sourceIntent.homePageId })));
    const identity = await evidence.putJson({ sourceHash: site.sourceHash, bundleHash: site.bundleHash, targetBuildHash: compiled.artifactIdentity, negativeControl: input.negativeControl, targetBindingFingerprint: compiled.targetBindingFingerprint, bindings, themeSnapshot: theme.snapshot });
    gates.site_fixture = { status: 'pass', evidence: [identity] };
    const work = await mkdtemp(path.join(site.root, '.site-proof-'));
    const configPath = path.join(work, 'config.json');
    const outputPath = path.join(work, 'result.json');
    await writeFile(configPath, JSON.stringify({ baseUrl: input.baseUrl, runtimeMarker: marker, theme: theme.slug, pages: compiled.pages.map((page) => ({ ...page, wpId: ids[page.id] })), intent: site.source.sourceIntent, screenshotDirectory: work, themeAssetBaseUrl, principalId, themeAssets: compiled.assets.map((file) => file.path), cssProperties: site.source.assets.filter((asset) => asset.kind === 'stylesheet').flatMap((asset) => [...Buffer.from(asset.bytes).toString().matchAll(/(--[a-zA-Z0-9-]+)\s*:\s*([^;}]+)/g)].map((match) => ({ name: match[1], value: match[2]!.trim() }))) }));
    const command = await input.command(process.execPath, [input.helper, '--config', configPath, '--out', outputPath]);
    await evidence.putJson(command);
    const report = JSON.parse(await readFile(outputPath, 'utf8'));
    overrides = report.recoverableOverrides ?? [];
    browser = report.browser;
    const ref = await evidence.putJson(report);
    for (const gate of SITE_PROOF_GATES.filter((name) => name !== 'site_fixture' && name !== 'site_cleanup')) {
      const record = report.gates?.[gate];
      gates[gate] = record && ['pass', 'fail', 'blocked'].includes(record.status) ? { ...record, evidence: [ref] } : { status: 'blocked', reason: `Browser report omitted ${gate}`, evidence: [ref] };
    }
    const screenshots = [];
    for (const screenshot of report.screenshots ?? []) screenshots.push(await evidence.put(await readFile(path.join(work, path.basename(screenshot))), { mediaType: 'image/png' }));
    if (gates.site_navigation) gates.site_navigation.evidence = [ref, ...screenshots];
  } catch (error) {
    for (const gate of SITE_PROOF_GATES) gates[gate] ??= { status: 'blocked', reason: error instanceof Error ? error.message : String(error) };
  } finally {
    if (fixtureStarted) {
      try {
        const overrideCleanup = JSON.parse(await execute(siteTrashOverridesPhp(marker, overrides)));
        if (overrideCleanup.preserved.length) throw new Error('Shared override ownership changed; preserved for recovery');
        const cleanup = JSON.parse(await execute(siteFixturePhp(marker, 'cleanup', {})));
        gates.site_cleanup = { status: cleanup.preserved.length ? 'fail' : 'pass', details: cleanup };
      } catch (error) { gates.site_cleanup = { status: 'fail', reason: String(error) }; }
    }
    if (original !== undefined) {
      try { await execute(`if(get_option('blogdescription')!==base64_decode('${Buffer.from(marker).toString('base64')}')) throw new Exception('Runtime marker changed; preserving option'); update_option('blogdescription',base64_decode('${original}'));`); }
      catch (error) { gates.site_cleanup = { status: 'fail', reason: String(error) }; }
    }
  }
  return { gates, compiled, theme, browser };
}
