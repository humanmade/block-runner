import { mkdtemp, realpath, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { describe, it, expect } from 'vitest';
import { applySite, type SiteApplyOptions } from '../../src/site/apply.js';
import { readSitePlanInput, reconcileSitePlan, managedStateHash } from '../../src/site/plan.js';
import { compileThemeDocuments, compileSitePageDocuments } from '../../src/site/compile.js';
import type { SiteSnapshot } from '../../src/site/plan-types.js';
import type { SiteApplyBoundary, SiteApplyRequest } from '../../src/site/apply-wpcli.js';
async function fixture() {
 const root=await mkdtemp(path.join(await realpath(os.tmpdir()),'site-apply-'));
 const source=path.join(root,'source.json');
 await writeFile(source,JSON.stringify({version:1,siteId:'sample',homePageId:'home',theme:{slug:'sample',title:'Sample',themeJson:{version:3}},templates:{index:{body:{blocks:[{block:'core/post-content'}]}}},parts:{},patterns:{},pages:[{id:'home',route:'/',title:'Home',template:'index',body:{blocks:[{block:'core/paragraph',text:'Hello'}]}}],assets:[],assetUses:[]}));
 const input=await readSitePlanInput(source,root);
 const live:SiteSnapshot={target:{homeUrl:'https://example.test',siteUrl:'https://example.test',blogId:1},runtime:{wordpress:'7.1',php:'8.4'},principal:{userId:7,capabilities:{edit_pages:true,edit_others_pages:true,manage_options:true,edit_theme_options:true}},theme:{slug:'sample',assetBaseUrl:'https://example.test/theme',inventory:[]},routing:{permalinkStructure:'/%postname%/',rewriteRulesHash:'rules',routes:[]},entities:[],overrides:[],navigation:[],options:{show_on_front:'posts',page_on_front:0},siteRecord:null};
 const theme=await compileThemeDocuments(input.source,{themeAssetBaseUrl:live.theme.assetBaseUrl});if(!theme.ok)throw new Error('invalid fixture theme');live.theme.inventory=theme.artifact.inventory;
 const pages=await compileSitePageDocuments(input.source);const plan=reconcileSitePlan(input.source,theme.artifact,pages.pages,structuredClone(live));
 const options:SiteApplyOptions={source,assetRoot:root,confirm:plan.confirmationHash,journal:path.join(root,'journal.json'),wpPath:'/wp'};
 let lock:string|null=null;let fault:'none'|'unknown'|'owned'|'changed'='none';let mutations=0;
 const requests:SiteApplyRequest[]=[];
 const transports={read:async()=>JSON.stringify(live),mutate:async(_executable:string,args:string[])=>{
  const script=args.at(-1)!; const encoded=script.match(/base64_decode\('([^']+)'\)/)![1]!;
  const e=JSON.parse(Buffer.from(encoded,'base64').toString()) as SiteApplyBoundary & {request:SiteApplyRequest};const r=e.request;requests.push(r);
  if(r.action==='lock'){if(lock)return JSON.stringify({status:'refused'});lock=e.token;}
  else if(r.action==='unlock'){if(lock!==e.token)return JSON.stringify({status:'refused'});lock=null;}
  else if(r.action==='marker') {live.siteRecord??={version:1,siteId:'sample',entities:{},options:{},operation:null};live.siteRecord.operation=structuredClone(r.operation);if(r.index)live.siteRecord.entities[r.index.key]=r.index.id;}
  else if(r.action==='mutate') {
   const journal=JSON.parse(await readFile(options.journal,'utf8'));expect(journal.currentStep).toEqual(r.step);expect(live.siteRecord!.operation!.currentStep).toEqual(r.step);
   mutations++;
   if(fault==='unknown')throw new Error('lost response');
   const op=r.operation;
   if(op.kind==='option'){live.options[op.entityId]=op.desired!.value;live.siteRecord!.options[op.entityId]={lastAppliedValue:op.desired!.value};}
   else {const entity={id:op.id??22,kind:op.kind,route:'/home',state:structuredClone(op.desired!),postStatus:String(op.desired!.status),ownership:[{version:1 as const,siteId:'sample',entityId:op.entityId,kind:op.kind,lastAppliedHash:managedStateHash(op.desired!)}]};live.entities=live.entities.filter(item=>item.id!==entity.id);live.entities.push(entity);live.siteRecord!.entities[r.step.key]=entity.id;}
   for(const page of live.entities.filter(item=>item.kind==='page'))page.route=live.options.show_on_front==='page'&&live.options.page_on_front===page.id?'/':`/${page.state.slug}`;
   if(fault==='owned'){fault='none';throw new Error('created before response');}
   if(fault==='changed' && op.kind==='page')live.entities[0]!.state.status='private';
   return JSON.stringify({status:'complete',...(op.kind!=='option'?{id:op.id??22}:{})});
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
 it('stops on status-only readback edits and preserves unknown evidence',async()=>{const f=await fixture();f.setFault('changed');const result=await applySite(f.plan,f.options,f.transports);expect(result.status).toBe('outcome_unknown');expect(f.count()).toBe(1);});
});
