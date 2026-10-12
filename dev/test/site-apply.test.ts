import { mkdtemp, realpath, writeFile, readFile, copyFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { hashCanonicalJson } from '../../src/proof/receipt.js';
import { describe, it, expect } from 'vitest';
import { applySite, type SiteApplyOptions } from '../../src/site/apply.js';
import { readSitePlanInput, reconcileSitePlan, managedStateHash } from '../../src/site/plan.js';
import { compileThemeDocuments, compileSitePageDocuments, compileSiteSyncedPatterns } from '../../src/site/compile.js';
import type { SiteSnapshot } from '../../src/site/plan-types.js';
import type { SiteApplyBoundary, SiteApplyRequest } from '../../src/site/apply-wpcli.js';
async function fixture(extra?: 'media'|'patterns') {
 const root=await mkdtemp(path.join(await realpath(os.tmpdir()),'site-apply-'));
 const source=path.join(root,'source.json');
 await writeFile(source,JSON.stringify({version:1,siteId:'sample',homePageId:'home',theme:{slug:'sample',title:'Sample',themeJson:{version:3}},templates:{index:{body:{blocks:[{block:'core/post-content'}]}}},parts:{},patterns:{},pages:[{id:'home',route:'/',title:'Home',template:'index',body:{blocks:[{block:'core/paragraph',text:'Hello'}]}}],assets:[],assetUses:[]}));
 if(extra){const intent=JSON.parse(await readFile(source,'utf8'));if(extra==='media'){await copyFile(new URL('./fixtures/site-intent/media/hero.png',import.meta.url),path.join(root,'hero.png'));intent.assets=[{id:'hero',path:'hero.png',role:'attachment',kind:'image'}];intent.pages[0].body.blocks=[{block:'core/image',attrs:{id:0}}];intent.assetUses=[{documentId:'page:home',nodePath:[0],attribute:'attrs.id',assetId:'hero'}];}else{intent.syncedPatterns={version:1,definitions:{hero:{title:'Hero',body:{blocks:[{block:'core/paragraph',text:'Shared'}]}}},uses:[{documentId:'page:home',nodePath:[0],patternId:'hero'}]};intent.pages[0].body.blocks=[{block:'core/block'}];}await writeFile(source,JSON.stringify(intent));}
 const input=await readSitePlanInput(source,root);
 const live:SiteSnapshot={target:{homeUrl:'https://example.test',siteUrl:'https://example.test',blogId:1},runtime:{wordpress:'7.1',php:'8.4'},principal:{userId:7,capabilities:{edit_pages:true,edit_others_pages:true,manage_options:true,edit_theme_options:true}},theme:{slug:'sample',assetBaseUrl:'https://example.test/theme',inventory:[]},routing:{permalinkStructure:'/%postname%/',rewriteRulesHash:'rules',routes:[]},entities:[],overrides:[],navigation:[],options:{show_on_front:'posts',page_on_front:0},siteRecord:null};
 if(extra==='patterns')Object.assign(live.principal.capabilities,{edit_posts:true,edit_others_posts:true,publish_posts:true,publish_blocks:true,edit_published_posts:true});
 if(extra==='media')live.principal.capabilities.upload_files=true;
 const theme=await compileThemeDocuments(input.source,{themeAssetBaseUrl:live.theme.assetBaseUrl});if(!theme.ok)throw new Error('invalid fixture theme');live.theme.inventory=theme.artifact.inventory;
 const pages=await compileSitePageDocuments(input.source);const patterns=await compileSiteSyncedPatterns(input.source,{themeAssetBaseUrl:live.theme.assetBaseUrl});const plan=reconcileSitePlan(input.source,theme.artifact,pages.pages,structuredClone(live),{},pages.diagnostics,patterns);
 const options:SiteApplyOptions={source,assetRoot:root,confirm:plan.confirmationHash,journal:path.join(root,'journal.json'),wpPath:'/wp'};
 let lock:string|null=null;let fault:'none'|'unknown'|'owned'|'changed'|'noowner'|'readback'|'source'|'marker'='none';let mutations=0;
 let readFailure=false;
 const requests:SiteApplyRequest[]=[];
 const transports={read:async()=>{if(readFailure){readFailure=false;throw new Error('readback unavailable');}return JSON.stringify(live);},mutate:async(_executable:string,args:string[])=>{
  const script=args.at(-1)!; const encoded=script.match(/base64_decode\('([^']+)'\)/)![1]!;
  const e=JSON.parse(Buffer.from(encoded,'base64').toString()) as SiteApplyBoundary & {request:SiteApplyRequest};const r=e.request;
  if(!r){const media=e as unknown as {assetSha256:string;assetId:string;versionKey:string;token:string};const journal=JSON.parse(await readFile(options.journal,'utf8'));expect(journal.currentStep).toEqual(live.siteRecord!.operation!.currentStep);expect(journal.currentStep.assetSha256).toBe(media.assetSha256);mutations++;const sha=media.assetSha256;live.entities.push({id:21,kind:'attachment',route:null,postStatus:'inherit',state:{sha256:sha},attachment:{url:'https://example.test/uploads/hero.png',currentFileSha256:sha,width:1200,height:800,sizes:{full:{url:'https://example.test/uploads/hero.png',width:1200,height:800}}},ownership:[{version:1,siteId:'sample',entityId:'hero',kind:'attachment',assetSha256:sha,lastAppliedHash:managedStateHash({sha256:sha})}]});if(fault==='source'){const changed=JSON.parse(await readFile(source,'utf8'));changed.pages[0].title='Changed after media';await writeFile(source,JSON.stringify(changed));fault='none';}if(fault==='owned'){fault='none';throw new Error('media before response');}return JSON.stringify({status:'complete',id:21,sha256:sha});}
  requests.push(r);
  if(r.action==='lock'){if(lock)return JSON.stringify({status:'refused'});lock=e.token;}
  else if(r.action==='unlock'){if(lock!==e.token)return JSON.stringify({status:'refused'});lock=null;}
  else if(r.action==='marker') {if(fault==='marker'&&r.operation.currentStep?.status==='completed'){fault='none';return JSON.stringify({status:'refused'});}live.siteRecord??={version:1,siteId:'sample',entities:{},options:{},operation:null};live.siteRecord.operation=structuredClone(r.operation);if(r.index)live.siteRecord.entities[r.index.key]=r.index.id;}
  else if(r.action==='mutate') {
   const journal=JSON.parse(await readFile(options.journal,'utf8'));expect(journal.currentStep).toEqual(r.step);expect(live.siteRecord!.operation!.currentStep).toEqual(r.step);
   mutations++;
   if(fault==='unknown')throw new Error('lost response');
   const op=r.operation;
   if(op.kind==='option'){live.options[op.entityId]=op.desired!.value;live.siteRecord!.options[op.entityId]={lastAppliedValue:op.desired!.value};}
   else {const entity={id:op.id??(op.kind==='pattern'?20:22),kind:op.kind,route:op.kind==='page'?'/home':null,state:structuredClone(op.desired!),postStatus:String(op.desired!.status),ownership:[{version:1 as const,siteId:'sample',entityId:op.entityId,kind:op.kind,lastAppliedHash:managedStateHash(op.desired!)}]};live.entities=live.entities.filter(item=>item.id!==entity.id);live.entities.push(entity);live.siteRecord!.entities[r.step.key]=entity.id;}
   for(const page of live.entities.filter(item=>item.kind==='page'))page.route=live.options.show_on_front==='page'&&live.options.page_on_front===page.id?'/':`/${page.state.slug}`;
   if(fault==='noowner'&&op.kind==='page')live.entities.find(item=>item.kind==='page')!.ownership=[];
   if(fault==='readback'){fault='none';readFailure=true;}
   if(fault==='owned'){fault='none';throw new Error('created before response');}
   if(fault==='changed' && op.kind==='page')live.entities[0]!.state.status='private';
   return JSON.stringify({status:'complete',...(op.kind!=='option'?{id:op.id??(op.kind==='pattern'?20:22)}:{})});
  }
  return JSON.stringify({status:'complete'});
 }};
 return {root,source,plan,options,live,transports,requests,setFault:(value:typeof fault)=>{fault=value;},count:()=>mutations,setLock:()=>{lock='stale';}};
}
describe('confirmed database apply',()=>{
 it('creates once, reads back every field and explicit options, then replays before obsolete before-state',async()=>{
  const f=await fixture();const first=await applySite(f.plan,f.options,f.transports);expect(first.status).toBe('completed');expect(first.steps.map(item=>item.step.key)).toEqual(['page:home','option:show_on_front','option:page_on_front']);expect(f.count()).toBe(3);
  await writeFile(f.source,'source no longer present');expect(await applySite(f.plan,f.options,f.transports)).toEqual(first);expect(f.count()).toBe(3);
  f.live.entities[0]!.state.template='human';await expect(applySite(f.plan,f.options,f.transports)).rejects.toThrow('after-state');expect(f.count()).toBe(3);
 });
 it.each(['confirm','target','state','source'] as const)('refuses changed %s before a mutation',async(kind)=>{
  const f=await fixture();if(kind==='confirm')f.options.confirm='wrong';if(kind==='target')f.live.target.blogId=2;if(kind==='state')f.live.options.page_on_front=55;if(kind==='source')await writeFile(f.source,'{}');
  await expect(applySite(f.plan,f.options,f.transports)).rejects.toThrow();expect(f.count()).toBe(0);expect(f.requests.filter(item=>item.action==='mutate')).toHaveLength(0);
 });
 it('rejects a hash-confirmed forged update at unowned content before any target mutation',async()=>{
  const f=await fixture();const op=f.plan.operations.find(op=>op.kind==='page')!;const state=structuredClone(op.desired!);f.live.entities=[{id:22,kind:'page',route:'/home',state,postStatus:'draft',ownership:[]}];f.plan.snapshot=structuredClone(f.live);f.plan.snapshotFingerprint=hashCanonicalJson(f.plan.snapshot);op.action='update';op.id=22;const {confirmationHash:old,...body}=f.plan;f.plan.confirmationHash=hashCanonicalJson(body);f.options.confirm=f.plan.confirmationHash;
  await expect(applySite(f.plan,f.options,f.transports)).rejects.toThrow('reconciliation');expect(f.count()).toBe(0);expect(f.requests).toHaveLength(0);
 });
 it('refuses completed replay while another operation is unresolved',async()=>{const f=await fixture();expect((await applySite(f.plan,f.options,f.transports)).status).toBe('completed');f.live.siteRecord!.operation={token:'other',planHash:'other',status:'outcome_unknown'};await expect(applySite(f.plan,f.options,f.transports)).rejects.toThrow('outstanding');expect(f.count()).toBe(3);});
 it('refuses concurrent/stale lock without steal or expiry',async()=>{const f=await fixture();f.setLock();await expect(applySite(f.plan,f.options,f.transports)).rejects.toThrow('never stolen');expect(f.count()).toBe(0);});
 it('retains uncertain create and never duplicates it without exact ownership proof',async()=>{
  const f=await fixture();f.setFault('unknown');const result=await applySite(f.plan,f.options,f.transports);expect(result.status).toBe('outcome_unknown');expect(result.steps[0]!.step.status).toBe('outcome_unknown');expect(f.count()).toBe(1);
  const replay=await applySite(f.plan,f.options,f.transports);expect(replay.status).toBe('outcome_unknown');expect(f.count()).toBe(1);
  const fresh={...f.options,journal:path.join(f.root,'fresh.json')};await expect(applySite(f.plan,fresh,f.transports)).rejects.toThrow('outstanding');expect(f.count()).toBe(1);
 });
 it('proves a created owned entity after response loss, then resumes options without duplicate create',async()=>{
  const f=await fixture();f.setFault('owned');expect((await applySite(f.plan,f.options,f.transports)).status).toBe('outcome_unknown');expect(f.count()).toBe(1);
  const resumed=await applySite(f.plan,f.options,f.transports);expect(resumed.status).toBe('completed');expect(f.live.entities).toHaveLength(1);expect(f.count()).toBe(3);
 });
 it.each(['media','patterns'] as const)('recovers after %s dependency creation without duplicating its ID',async(extra)=>{
  const f=await fixture(extra);f.setFault('owned');const first=await applySite(f.plan,f.options,f.transports);expect(first.status).toBe('outcome_unknown');expect(f.count()).toBe(1);
  const resumed=await applySite(f.plan,f.options,f.transports);expect({status:resumed.status,error:resumed.error}).toEqual({status:'completed',error:undefined});expect(f.live.entities.filter(item=>item.kind===(extra==='media'?'attachment':'pattern'))).toHaveLength(1);expect(f.live.entities.filter(item=>item.kind==='page')).toHaveLength(1);expect(f.count()).toBe(4);
 });
 it('a fresh unchanged plan is a no-op, while explicit desired title changes update the existing ID',async()=>{
  const f=await fixture();expect((await applySite(f.plan,f.options,f.transports)).status).toBe('completed');
  const fresh=async()=>{const input=await readSitePlanInput(f.source,f.root);const theme=await compileThemeDocuments(input.source,{themeAssetBaseUrl:f.live.theme.assetBaseUrl});if(!theme.ok)throw new Error('theme');const pages=await compileSitePageDocuments(input.source);return reconcileSitePlan(input.source,theme.artifact,pages.pages,structuredClone(f.live));};
  const unchanged=await fresh();expect(unchanged.operations.every(op=>op.action==='retain')).toBe(true);Object.assign(f.options,{confirm:unchanged.confirmationHash,journal:path.join(f.root,'unchanged.json')});expect((await applySite(unchanged,f.options,f.transports)).status).toBe('completed');expect(f.count()).toBe(3);
  const intent=JSON.parse(await readFile(f.source,'utf8'));intent.pages[0].title='Changed';await writeFile(f.source,JSON.stringify(intent));const edited=await fresh();Object.assign(f.options,{confirm:edited.confirmationHash,journal:path.join(f.root,'edited.json')});expect((await applySite(edited,f.options,f.transports)).status).toBe('completed');expect(f.live.entities[0]!.id).toBe(22);expect(f.live.entities[0]!.state.title).toBe('Changed');expect(f.count()).toBe(4);
 });
 it('preserves an unowned create as unknown and refuses all repeats',async()=>{const f=await fixture();f.setFault('noowner');expect((await applySite(f.plan,f.options,f.transports)).status).toBe('outcome_unknown');expect((await applySite(f.plan,f.options,f.transports)).status).toBe('outcome_unknown');expect(f.count()).toBe(1);expect(f.live.entities).toHaveLength(1);});
 it.each(['readback','marker'] as const)('recovers exact owned state after %s interruption without another create',async(fault)=>{const f=await fixture();f.setFault(fault);expect((await applySite(f.plan,f.options,f.transports)).status).toBe('outcome_unknown');expect((await applySite(f.plan,f.options,f.transports)).status).toBe('completed');expect(f.count()).toBe(3);expect(f.live.entities).toHaveLength(1);});
 it('retains completed dependency effects and precise pending inventory when source bytes change before page writes',async()=>{const f=await fixture('media');f.setFault('source');const result=await applySite(f.plan,f.options,f.transports);expect(result.status).toBe('partial');expect(result.steps).toHaveLength(1);expect(result.steps[0]!.step.status).toBe('completed');expect(result.pending.map(op=>op.kind)).toEqual(['page','option','option']);expect(f.live.entities.map(entity=>entity.kind)).toEqual(['attachment']);expect(f.count()).toBe(1);});
 it('stops on status-only readback edits and preserves unknown evidence',async()=>{const f=await fixture();f.setFault('changed');const result=await applySite(f.plan,f.options,f.transports);expect(result.status).toBe('outcome_unknown');expect(f.count()).toBe(1);});
});
