import { describe, expect, it } from 'vitest';
import { readSiteSnapshot, siteRecordOption } from '../../src/site/wpcli.js';
import { managedStateHash, reconcileSitePlan } from '../../src/site/plan.js';
import type { SiteSnapshot, SiteEntity } from '../../src/site/plan-types.js';
import type { PreparedSiteSource, ThemeArtifact, CompiledSitePage } from '../../src/site/types.js';

function source(): PreparedSiteSource {
  return { sourceIntent: { version:1, siteId:'sample', homePageId:'home', theme:{slug:'sample',title:'Sample',themeJson:{version:3}}, templates:{index:{body:{blocks:[{block:'core/paragraph',text:'Index'}]}}}, parts:{}, patterns:{}, pages:[{id:'home',route:'/',title:'Home',template:'index',status:'draft',body:{blocks:[{block:'core/paragraph',text:'Hello'}]}}], assets:[], assetUses:[] }, assetRoot:'/assets',assets:[],sourceIdentity:'source-hash',unresolvedAssetUses:[] };
}
function theme(input = source()): ThemeArtifact { return {sourceIntent:input.sourceIntent,sourceAssets:input.assets,themeFiles:[],pendingPageBindings:[],diagnostics:[],inventory:[],artifactIdentity:'theme-hash'}; }
function pages(): CompiledSitePage[] {return [{id:'home',route:'/',title:'Home',template:'index',status:'draft',content:'<!-- wp:paragraph --><p>Hello</p><!-- /wp:paragraph -->',diagnostics:[]}];}
function snapshot(): SiteSnapshot {return {target:{homeUrl:'https://example.test',siteUrl:'https://example.test/wp',blogId:2},runtime:{wordpress:'7.1',php:'8.4.26'},principal:{userId:7,capabilities:{edit_pages:true,edit_others_pages:true,manage_options:true,edit_theme_options:true,publish_pages:true,upload_files:true}},theme:{slug:'sample',assetBaseUrl:'https://example.test/wp/wp-content/themes/sample',inventory:[]},entities:[],overrides:[],navigation:[],options:{show_on_front:'posts',page_on_front:0},siteRecord:null};}
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
    expect(calls[0]!.args[4]).not.toMatch(/wp_insert|wp_update|update_option|add_post_meta|update_post_meta|media_handle|unlink|file_put_contents/);
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
