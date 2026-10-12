import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { compileThemeDocuments } from '../../src/site/compile.js';
import { writeCompiledSite } from '../../src/site/write.js';
import { mkdtemp, mkdir, writeFile, symlink, realpath, readFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { hashBytes } from '../../src/publication.js';
import { prepareSiteSource } from '../../src/site/input.js';
import { describe, expect, it } from 'vitest';
import { readSiteSnapshot, siteRecordOption } from '../../src/site/wpcli.js';
import { managedStateHash, reconcileSitePlan, readSitePlanInput, observedAttachmentBindings, planSite } from '../../src/site/plan.js';
import type { SiteSnapshot, SiteEntity } from '../../src/site/plan-types.js';
import type { PreparedSiteSource, ThemeArtifact, CompiledSitePage } from '../../src/site/types.js';

function source(): PreparedSiteSource {
  return { sourceIntent: { version:1, siteId:'sample', homePageId:'home', theme:{slug:'sample',title:'Sample',themeJson:{version:3}}, templates:{index:{body:{blocks:[{block:'core/paragraph',text:'Index'}]}}}, parts:{}, patterns:{}, pages:[{id:'home',route:'/',title:'Home',template:'index',status:'draft',body:{blocks:[{block:'core/paragraph',text:'Hello'}]}}], assets:[], assetUses:[] }, assetRoot:'/assets',assets:[],sourceIdentity:'source-hash',unresolvedAssetUses:[] };
}
function theme(input = source()): ThemeArtifact { return {sourceIntent:input.sourceIntent,sourceAssets:input.assets,targetBindings:{},targetBindingFingerprint:'binding-hash',themeFiles:[],syncedPatterns:[],pendingPageBindings:[],diagnostics:[],inventory:[],artifactIdentity:'theme-hash'}; }
function pages(): CompiledSitePage[] {return [{id:'home',route:'/',title:'Home',template:'index',status:'draft',content:'<!-- wp:paragraph --><p>Hello</p><!-- /wp:paragraph -->',diagnostics:[]}];}
function snapshot(): SiteSnapshot {return {target:{homeUrl:'https://example.test',siteUrl:'https://example.test/wp',blogId:2},runtime:{wordpress:'7.1',php:'8.4.26'},principal:{userId:7,capabilities:{edit_pages:true,edit_others_pages:true,manage_options:true,edit_theme_options:true,publish_pages:true,upload_files:true}},theme:{slug:'sample',assetBaseUrl:'https://example.test/wp/wp-content/themes/sample',inventory:[]},routing:{permalinkStructure:'/%postname%/',rewriteRulesHash:'rules-hash',routes:[]},entities:[],overrides:[],navigation:[],options:{show_on_front:'posts',page_on_front:0},siteRecord:null};}
function owned(): SiteEntity {const state={content:pages()[0]!.content,title:'Home',slug:'home',parentId:0,template:'index',status:'draft'};return {id:14,kind:'page',route:'/',state,ownership:[{version:1,siteId:'sample',entityId:'home',kind:'page',lastAppliedHash:managedStateHash(state)}]};}
const plan = (observed = snapshot(), input = source()) => reconcileSitePlan(input,theme(input),pages(),observed);

describe('read-only local WP-CLI edge',()=>{
  it('passes executable and exact target/principal as argument arrays, only fixed read eval',async()=>{
    const calls: Array<{executable:string,args:string[]}> = [];
    const result=await readSiteSnapshot({wpPath:'/tmp/wp path;$(touch nope)',wpUrl:'https://example.test/sub',wpUser:'editor',wpBinary:'/tmp/wp binary'},'sample',async(executable,args)=>{calls.push({executable,args});return JSON.stringify(snapshot());});
    expect(result.target.blogId).toBe(2);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.executable).toBe('/tmp/wp binary');
    expect(calls[0]!.args.slice(0,4)).toEqual(['--path=/tmp/wp path;$(touch nope)','--url=https://example.test/sub','--user=editor','eval']);
    expect(calls[0]!.args[4]).toContain(siteRecordOption('sample'));
    expect(calls[0]!.args[4]).toContain("'edit_posts','edit_others_posts','publish_posts','publish_blocks','edit_published_posts'");
    expect(calls[0]!.args[4]).not.toMatch(/\b(?:wp_insert\w*|wp_update\w*|update_option|add_post_meta|update_post_meta|media_handle\w*|unlink|file_put_contents)\s*\(/);
  });
  it('refuses user zero and secret-bearing URL identity',async()=>{
    const observed=snapshot(); observed.principal.userId=0;
    await expect(readSiteSnapshot({wpPath:'/wp'},'sample',async()=>JSON.stringify(observed))).rejects.toThrow('--wp-user');
    observed.principal.userId=7;observed.target.homeUrl='https://user:password@example.test';
    await expect(readSiteSnapshot({wpPath:'/wp'},'sample',async()=>JSON.stringify(observed))).rejects.toThrow('secret');
  });
});
describe('bounded site reconciliation',()=>{
  it('has stable exact confirmation hashes and binds target/state/media bytes',()=>{
    const first=plan();expect(first.executable).toBe(true);expect(plan().confirmationHash).toBe(first.confirmationHash);
    const observed=snapshot();observed.target.blogId=3;expect(plan(observed).confirmationHash).not.toBe(first.confirmationHash);
    const input=source();input.assets=[{id:'photo',path:'photo.png',kind:'image',role:'attachment',sha256:'aaa',bytes:new Uint8Array()}];
    const second=plan(snapshot(),input);input.assets[0]!.sha256='bbb';expect(plan(snapshot(),input).confirmationHash).not.toBe(second.confirmationHash);
  });
  it('does not adopt same-title unmanaged pages and blocks occupied routes',()=>{
    const observed=snapshot();const entity=owned();entity.ownership=[];entity.route='/unrelated';observed.entities=[entity];
    expect(plan(observed).operations.find(op=>op.kind==='page')).toMatchObject({action:'create',entityId:'home'});
    entity.route='/';expect(plan(observed).conflicts.some(item=>item.code==='route-conflict')).toBe(true);
  });
  it.each(['content','title','slug','parentId','template','status'])('blocks pre-plan human changes to %s',field=>{
    const observed=snapshot();const entity=owned();entity.state[field]=field==='parentId'?9:'Human edit';observed.entities=[entity];
    expect(plan(observed).conflicts.some(item=>item.code==='managed-state-changed')).toBe(true);
  });
  it('preserves ownership across desired title and route changes',()=>{
    const observed=snapshot();observed.entities=[owned()];const input=source();input.sourceIntent.pages[0]!.title='New title';
    const result=plan(observed,input);expect(result.executable).toBe(true);expect(result.operations.find(op=>op.kind==='page')).toMatchObject({action:'update',id:14});
  });
  it('blocks duplicate keys, changed theme/runtime, insufficient capability and outstanding unknown operations',()=>{
    const observed=snapshot();const duplicate=owned();duplicate.id=15;observed.entities=[owned(),duplicate];observed.theme.slug='wrong';observed.runtime.wordpress='7.0';observed.principal.capabilities.manage_options=false;observed.siteRecord={version:1,siteId:'sample',entities:{},options:{},operation:{token:'x',planHash:'x',status:'outcome_unknown'}};
    expect(plan(observed).conflicts.map(item=>item.code)).toEqual(expect.arrayContaining(['duplicate-ownership','theme-mismatch','runtime-mismatch','missing-capability','outstanding-operation']));
  });
  it('retains omitted owned entities and blocks changed explicitly managed options',()=>{
    const observed=snapshot();const orphan=owned();orphan.route='/old';orphan.ownership[0]!.entityId='old';observed.entities=[orphan];observed.siteRecord={version:1,siteId:'sample',entities:{},options:{show_on_front:{lastAppliedValue:'page'}},operation:null};
    const result=plan(observed);expect(result.operations).toContainEqual(expect.objectContaining({action:'retain',id:14,desired:{orphaned:true}}));expect(result.conflicts.some(item=>item.code==='managed-option-changed')).toBe(true);
  });

  it('blocks deleted owned IDs, duplicate metadata rows and database theme shadows',()=>{
    const observed=snapshot();const entity=owned();entity.ownership.push({...entity.ownership[0]!});observed.entities=[entity];observed.siteRecord={version:1,siteId:'sample',entities:{'page:gone':99},options:{},operation:null};observed.overrides=[{id:55,kind:'wp_template',theme:['sample'],content:'Editor override'}];
    expect(plan(observed).conflicts.map(item=>item.code)).toEqual(expect.arrayContaining(['missing-owned-id','duplicate-ownership-metadata','theme-shadow']));
  });
  it('blocks external native navigation and synced-pattern dependencies',()=>{
    const input=source();input.sourceIntent.templates.index!.body.blocks=[{block:'core/navigation',attrs:{ref:123}},{block:'core/block',attrs:{ref:124}}];
    expect(plan(snapshot(),input).conflicts.map(item=>item.code)).toEqual(expect.arrayContaining(['unsupported-navigation-reference','unsupported-synced-pattern-reference']));
  });
  it('keeps attachment imports pending without manufactured WordPress IDs',()=>{
    const input=source();input.assets=[{id:'photo',path:'photo.png',kind:'image',role:'attachment',sha256:'aaa',bytes:new Uint8Array()}];input.sourceIntent.assets=[{id:'photo',path:'photo.png',kind:'image',role:'attachment'}];input.sourceIntent.assetUses=[{documentId:'page:home',nodePath:[0],attribute:'attrs.id',assetId:'photo'}];
    const result=reconcileSitePlan(input,theme(input),[],snapshot());expect(result.executable).toBe(true);expect(result.operations.find(op=>op.kind==='attachment')).not.toHaveProperty('id');expect(result.operations.find(op=>op.kind==='page')).toMatchObject({requiresFinalization:true,pendingBindings:input.sourceIntent.assetUses});
  });
});

describe('source and retained bundle boundaries',()=>{
  it('loads raw source without pre-existing IDs and refuses undeclared graph references',async()=>{
    const root=await mkdtemp(path.join(await realpath(os.tmpdir()),'site-plan-source-'));const file=path.join(root,'intent.json');await writeFile(file,JSON.stringify(source().sourceIntent));
    expect((await readSitePlanInput(file,root)).retainedBindings).toEqual({});
    await expect(readSitePlanInput(file)).rejects.toThrow('asset root');
    const input=source().sourceIntent;input.templates.index!.body.blocks=[{block:'core/template-part',attrs:{slug:'missing'}}];await writeFile(file,JSON.stringify(input));
    await expect(readSitePlanInput(file,root)).rejects.toThrow('unknown template part');
  });
  it('verifies retained source bytes/inventory and rejects corruption and symlink input',async()=>{
    const root=await mkdtemp(path.join(await realpath(os.tmpdir()),'site-plan-bundle-'));const assetRoot=root;
    const input=source().sourceIntent;const bytes=Buffer.from(JSON.stringify(input));await writeFile(path.join(root,'site.intent.json'),bytes);
    const prepared=await prepareSiteSource(input,assetRoot);if(!prepared.ok)throw new Error('fixture invalid');
    const manifest={formatVersion:1,siteId:input.siteId,sourceIdentity:prepared.source.sourceIdentity,sourceAssets:[],targetBindings:{},bundleFiles:[{path:'site.intent.json',sha256:hashBytes(bytes),size:bytes.length}]};await writeFile(path.join(root,'site.manifest.json'),JSON.stringify(manifest));
    expect((await readSitePlanInput(root)).source.sourceIdentity).toBe(prepared.source.sourceIdentity);
    await writeFile(path.join(root,'site.intent.json'),Buffer.from('corrupt'));await expect(readSitePlanInput(root)).rejects.toThrow('retained bundle bytes differ');
    const linked=path.join(root,'linked');await symlink(root,linked);await expect(readSitePlanInput(linked)).rejects.toThrow('symlinks');
  });
});

describe('destination attachment bindings',()=>{
  it('checks exact numeric identity, URL and bytes without title or basename matching',()=>{
    const input=source();input.assets=[{id:'photo',path:'photo.png',kind:'image',role:'attachment',sha256:'aaa',bytes:new Uint8Array()}];
    const state={sha256:'aaa'};const observed=snapshot();observed.entities=[{id:22,kind:'attachment',route:null,state,attachment:{url:'https://example.test/uploads/photo.png',linkUrl:'https://example.test/photo/',currentFileSha256:'scaled',width:100,height:100,sizes:{full:{url:'https://example.test/uploads/photo.png',width:100,height:100}}},ownership:[{version:1,siteId:'sample',entityId:'photo',kind:'attachment',assetSha256:'aaa',lastAppliedHash:managedStateHash(state)}]}];
    const retained={source:input,retainedBindings:{photo:{id:22,url:'https://example.test/uploads/photo.png'}}};
    expect(observedAttachmentBindings(retained,observed)).toMatchObject({photo:{...retained.retainedBindings.photo,attachmentPageUrl:'https://example.test/photo/',observedSize:{width:100,height:100},imageSizes:{full:{url:'https://example.test/uploads/photo.png',width:100,height:100}}}});
    observed.entities[0]!.state.sha256='changed';expect(()=>observedAttachmentBindings(retained,observed)).toThrow('destination bytes');
    observed.entities=[];expect(()=>observedAttachmentBindings(retained,observed)).toThrow('absent');
    expect(()=>observedAttachmentBindings({...retained,retainedThemeAssetBaseUrl:'https://old-target.test/theme'},snapshot())).toThrow('different target');
  });
});

const fixtureRoot=fileURLToPath(new URL('./fixtures/site-intent/',import.meta.url));
async function sourceFirstFixture() {
  const intentFile=path.join(fixtureRoot,'site.intent.json');
  const input=await readSitePlanInput(intentFile,fixtureRoot);
  const observed=snapshot();observed.theme.slug=input.source.sourceIntent.theme.slug;
  observed.theme.assetBaseUrl=`https://example.test/wp/wp-content/themes/${observed.theme.slug}`;
  const compiled=await compileThemeDocuments(input.source,{themeAssetBaseUrl:observed.theme.assetBaseUrl});
  if(!compiled.ok)throw new Error(JSON.stringify(compiled.diagnostics));
  observed.theme.inventory=compiled.artifact.inventory;
  observed.routing.routes=input.source.sourceIntent.pages.filter(page=>page.route!=='/').map(page=>({route:page.route,kind:'available',matchedRule:'native-page-rule',queryFingerprint:'query-hash'}));
  return {intentFile,input,observed,artifact:compiled.artifact};
}
describe('source-first plan orchestration and CLI',()=>{
  it('plans a first install with original pending media, finalized other pages and zero WP writes',async()=>{
    const {intentFile,observed}=await sourceFirstFixture();const calls:string[][]=[];
    const result=await planSite(intentFile,{assetRoot:fixtureRoot,wpPath:'/wp',wpUser:'7',strict:true},async(_,args)=>{calls.push(args);return JSON.stringify(observed);});
    expect(result.executable).toBe(true);expect(calls).toHaveLength(1);expect(calls[0]![1]).toBe('--user=7');
    const home=result.operations.find(op=>op.kind==='page'&&op.entityId==='home')!;
    expect(home).toMatchObject({action:'create',requiresFinalization:true});expect(home.desired).not.toHaveProperty('content');expect(home).not.toHaveProperty('id');expect(home.body).toEqual((await readSitePlanInput(intentFile,fixtureRoot)).source.sourceIntent.pages[0]!.body);
    expect(result.operations.find(op=>op.kind==='page'&&op.entityId==='about')!.desired!.content).toContain('thoughtful studio');
    const again=await planSite(intentFile,{assetRoot:fixtureRoot,wpPath:'/wp',wpUser:'7',strict:true},async()=>JSON.stringify(observed));expect(again.confirmationHash).toBe(result.confirmationHash);
  });
  it('uses the actual retained theme-only bundle and rejects pending theme media or undeclared page media',async()=>{
    const {input,observed,artifact}=await sourceFirstFixture();const root=await mkdtemp(path.join(await realpath(os.tmpdir()),'site-plan-integrated-'));const bundle=path.join(root,'bundle');await writeCompiledSite(bundle,input.source,artifact);
    expect((await planSite(bundle,{wpPath:'/wp'},async()=>JSON.stringify(observed))).executable).toBe(true);
    const sourceInput=source().sourceIntent;sourceInput.assets=[{id:'photo',path:'photo.png',role:'attachment',kind:'image'}];sourceInput.templates.index!.body.blocks=[{block:'core/image',url:'photo.png'}];sourceInput.assetUses=[{documentId:'template:index',nodePath:[0],attribute:'url',assetId:'photo'}];await writeFile(path.join(root,'photo.png'),await readFile(path.join(fixtureRoot,'media/hero.png')));const file=path.join(root,'intent.json');await writeFile(file,JSON.stringify(sourceInput));
    await expect(planSite(file,{wpPath:'/wp',assetRoot:root},async()=>JSON.stringify(snapshot()))).rejects.toThrow('attachment-binding-required');
    sourceInput.templates.index!.body.blocks=[{block:'core/post-content'}];sourceInput.assetUses=[];sourceInput.pages[0]!.body.blocks=[{block:'core/image',url:'undeclared.png'}];await writeFile(file,JSON.stringify(sourceInput));
    await expect(planSite(file,{wpPath:'/wp',assetRoot:root},async()=>JSON.stringify(snapshot()))).rejects.toThrow('undeclared-media-reference');
  });
  it('registers one site command, passes selected target/principal argv, and emits a new confirmation-bound file',async()=>{
    const {intentFile,observed}=await sourceFirstFixture();const root=await mkdtemp(path.join(await realpath(os.tmpdir()),'site-plan-cli-'));const output=path.join(root,'plan.json');const script=path.join(root,'wp binary');const argvFile=path.join(root,'argv.json');
    await writeFile(script,`#!/usr/bin/env node\nrequire('node:fs').writeFileSync(${JSON.stringify(argvFile)},JSON.stringify(process.argv.slice(2)));process.stdout.write(${JSON.stringify(JSON.stringify(observed))});\n`,{mode:0o755});
    const run=promisify(execFile);const args=['--import',import.meta.resolve('tsx'),fileURLToPath(new URL('../../src/cli.ts',import.meta.url)),'site','plan',intentFile,'--asset-root',fixtureRoot,'--wp-path','/wp path;literal','--wp-url','https://example.test/sub','--wp-user','7','--wp-binary',script,'--out',output,'--json'];
    const {stdout}=await run(process.execPath,args,{cwd:root});const report=JSON.parse(stdout);expect(report.executable).toBe(true);expect(JSON.parse(await readFile(output,'utf8'))).toEqual(report);expect(JSON.parse(await readFile(argvFile,'utf8')).slice(0,4)).toEqual(['--path=/wp path;literal','--url=https://example.test/sub','--user=7','eval']);
    await expect(run(process.execPath,args,{cwd:root})).rejects.toMatchObject({code:2});
  });
});

describe('bounded native target route resolution',()=>{
  function withRoute(route:string,kind:'available'|'singular'|'reserved'|'unsupported',postId?:number,postType?:string) {
    const input=source();input.sourceIntent.pages.push({id:'about',route,title:'About',template:'index',body:{blocks:[{block:'core/paragraph',text:'About'}]}});
    const observed=snapshot();observed.routing.routes=[{route,kind,matchedRule:'native-rule',queryFingerprint:'query-hash',...(postId?{postId}:{}),...(postType?{postType}:{})}];
    return {input,observed};
  }
  it.each([['/news-item','post'],['/work/demo','project']])('blocks existing public singular %s (%s)',(route,type)=>{
    const {input,observed}=withRoute(route,'singular',25,type);expect(plan(observed,input).conflicts.map(item=>item.code)).toContain('route-conflict');
  });
  it.each(['/category/news','/feed','/wp-json'])('blocks native reserved endpoint %s',route=>{
    const {input,observed}=withRoute(route,'reserved');expect(plan(observed,input).conflicts.map(item=>item.code)).toContain('route-conflict');
  });
  it.each(['/Foo','/two words'])('retains the native noncanonical slug refusal for %s',route=>{
    const {input,observed}=withRoute(route,'unsupported');observed.routing.routes[0]!.reason='route segment is not a canonical WordPress slug';
    const result=plan(observed,input);expect(result.executable).toBe(false);expect(result.conflicts).toContainEqual(expect.objectContaining({code:'unsupported-route',message:'route segment is not a canonical WordPress slug'}));
  });
  it('fails closed on unresolved/custom routes and absent cached/plain permalink configuration',()=>{
    const {input,observed}=withRoute('/members','unsupported');expect(plan(observed,input).conflicts.map(item=>item.code)).toContain('unsupported-route');
    observed.routing.permalinkStructure='';observed.routing.rewriteRulesHash=null;expect(plan(observed,input).conflicts.map(item=>item.code)).toContain('unsupported-routing');
  });
  it('binds rewrite hashes and accepts the explicitly declared fresh nested page slot',()=>{
    const input=source();input.sourceIntent.pages.push({id:'services',route:'/services',title:'Services',template:'index',body:{blocks:[]}},{id:'consulting',route:'/services/consulting',parentId:'services',title:'Consulting',template:'index',body:{blocks:[]}});
    const observed=snapshot();observed.routing.routes=['/services','/services/consulting'].map(route=>({route,kind:'available',matchedRule:'native-pagename',queryFingerprint:'query-hash'}));
    const compiled=[...pages(),...input.sourceIntent.pages.slice(1).map(page=>({...page,status:'draft' as const,content:'',diagnostics:[]}))];
    const first=reconcileSitePlan(input,theme(input),compiled,observed);expect(first.executable).toBe(true);expect(first.operations.find(op=>op.entityId==='consulting')!.desired!.parentId).toEqual({pendingPageId:'services'});
    observed.routing.rewriteRulesHash='changed';expect(reconcileSitePlan(input,theme(input),compiled,observed).confirmationHash).not.toBe(first.confirmationHash);
  });
});

describe('native page-slot pagination boundary',()=>{
  it('accepts the reported empty native pagination slot and blocks a reserved pagination result',()=>{
    const observed=snapshot();
    const input=source();input.sourceIntent.pages.push({id:'about',route:'/about',title:'About',template:'index',body:{blocks:[]}});
    observed.routing.routes=[{route:'/about',kind:'available',matchedRule:'(.?.+?)(?:/([0-9]+))?/?$',queryFingerprint:'empty-page-native-query'}];
    const compiled=[...pages(),{id:'about',route:'/about',title:'About',template:'index',status:'draft' as const,content:'',diagnostics:[]}];expect(reconcileSitePlan(input,theme(input),compiled,observed).executable).toBe(true);
    observed.routing.routes[0]!.kind='reserved';observed.routing.routes[0]!.reason='native page pagination endpoint';expect(reconcileSitePlan(input,theme(input),compiled,observed).conflicts.map(item=>item.code)).toContain('route-conflict');
  });
});
