import { mkdtemp, realpath, writeFile, readFile, copyFile, chmod } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { hashCanonicalJson } from '../../src/proof/receipt.js';
import { hashBytes } from '../../src/publication.js';
import { describe, it, expect } from 'vitest';
import { applySite, type SiteApplyOptions } from '../../src/site/apply.js';
import { readSitePlanInput, reconcileSitePlan, planPreparedSite, managedStateHash } from '../../src/site/plan.js';
import { compileThemeDocuments, compileSitePageDocuments, compileSiteSyncedPatterns } from '../../src/site/compile.js';
import type { SiteSnapshot } from '../../src/site/plan-types.js';
import { siteApplyWpCli, type SiteApplyBoundary, type SiteApplyRequest } from '../../src/site/apply-wpcli.js';
import { siteRecordOption, SITE_APPLY_LOCK_OPTION } from '../../src/site/wpcli.js';
function phpAssociateEmptyObjects(value:unknown):unknown {
 if(Array.isArray(value))return value.map(phpAssociateEmptyObjects);
 if(value&&typeof value==='object'){const entries=Object.entries(value);return entries.length?Object.fromEntries(entries.map(([key,item])=>[key,phpAssociateEmptyObjects(item)])):[];}
 return value;
}
async function fixture(extra?: 'media'|'patterns',normalizeMarkerEmptyObjects=false) {
 const root=await mkdtemp(path.join(await realpath(os.tmpdir()),'site-apply-'));
 const source=path.join(root,'source.json');
 await writeFile(source,JSON.stringify({version:1,siteId:'sample',homePageId:'home',theme:{slug:'sample',title:'Sample',themeJson:{version:3}},templates:{index:{body:{blocks:[{block:'core/post-content'}]}}},parts:{},patterns:{},pages:[{id:'home',route:'/',title:'Home',template:'index',body:{blocks:[{block:'core/paragraph',text:'Hello',...(normalizeMarkerEmptyObjects?{attrs:{}}:{})}]}}],assets:[],assetUses:[]}));
 if(extra){const intent=JSON.parse(await readFile(source,'utf8'));if(extra==='media'){await copyFile(new URL('./fixtures/site-intent/media/hero.png',import.meta.url),path.join(root,'hero.png'));intent.assets=[{id:'hero',path:'hero.png',role:'attachment',kind:'image'}];intent.pages[0].body.blocks=normalizeMarkerEmptyObjects?[{block:'core/paragraph',text:'Hello',attrs:{}},{block:'core/image',attrs:{id:0}}]:[{block:'core/image',attrs:{id:0}}];intent.assetUses=[{documentId:'page:home',nodePath:[normalizeMarkerEmptyObjects?1:0],attribute:'attrs.id',assetId:'hero'}];}else{intent.syncedPatterns={version:1,definitions:{hero:{title:'Hero',body:{blocks:[{block:'core/paragraph',text:'Shared'}]}}},uses:[{documentId:'page:home',nodePath:[0],patternId:'hero'}]};intent.pages[0].body.blocks=[{block:'core/block'}];}await writeFile(source,JSON.stringify(intent));}
 const input=await readSitePlanInput(source,root);
 const live:SiteSnapshot={target:{homeUrl:'https://example.test',siteUrl:'https://example.test',blogId:1},runtime:{wordpress:'7.1',php:'8.4'},principal:{userId:7,capabilities:{edit_pages:true,edit_others_pages:true,manage_options:true,edit_theme_options:true}},theme:{slug:'sample',assetBaseUrl:'https://example.test/theme',inventory:[]},routing:{permalinkStructure:'/%postname%/',rewriteRulesHash:'rules',routes:[]},entities:[],overrides:[],navigation:[],options:{show_on_front:'posts',page_on_front:0},siteRecord:null};
 if(extra==='patterns')Object.assign(live.principal.capabilities,{edit_posts:true,edit_others_posts:true,publish_posts:true,publish_blocks:true,edit_published_posts:true});
 if(extra==='media')live.principal.capabilities.upload_files=true;
 const theme=await compileThemeDocuments(input.source,{themeAssetBaseUrl:live.theme.assetBaseUrl});if(!theme.ok)throw new Error('invalid fixture theme');live.theme.inventory=theme.artifact.inventory;
 const pages=await compileSitePageDocuments(input.source);const patterns=await compileSiteSyncedPatterns(input.source,{themeAssetBaseUrl:live.theme.assetBaseUrl});const plan=reconcileSitePlan(input.source,theme.artifact,pages.pages,structuredClone(live),{},pages.diagnostics,patterns);
 const options:SiteApplyOptions={source,assetRoot:root,confirm:plan.confirmationHash,journal:path.join(root,'journal.json'),wpPath:'/wp'};
 let lock:string|null=null;let fault:'none'|'unknown'|'owned'|'frontowned'|'changed'|'noowner'|'readback'|'source'|'marker'|'mediareadback'|'secret'='none';let routeMutation:'none'|'front'|'page'|'front-permalink'|'front-unsupported'='none';let mutations=0;
 let readFailure=false;let mediaReadCountdown=0;
 const requests:SiteApplyRequest[]=[];
 const transports={read:async()=>{if(mediaReadCountdown>0&&--mediaReadCountdown===0)throw new Error('ordinary snapshot error after completed media helper');if(readFailure){readFailure=false;throw new Error('readback unavailable');}return JSON.stringify(live);},mutate:async(_executable:string,args:string[])=>{
  const script=args.at(-1)!; const encoded=script.match(/base64_decode\('([^']+)'\)/)![1]!;
  const e=JSON.parse(Buffer.from(encoded,'base64').toString()) as SiteApplyBoundary & {request:SiteApplyRequest};const r=e.request;
  if(!r){const media=e as unknown as {assetSha256:string;assetId:string;versionKey:string;token:string};const journal=JSON.parse(await readFile(options.journal,'utf8'));expect(journal.currentStep).toEqual(live.siteRecord!.operation!.currentStep);expect(journal.currentStep.assetSha256).toBe(media.assetSha256);mutations++;const sha=media.assetSha256;live.entities.push({id:21,kind:'attachment',route:null,postStatus:'inherit',state:{sha256:sha},attachment:{url:'https://example.test/uploads/hero.png',currentFileSha256:sha,width:1200,height:800,sizes:{full:{url:'https://example.test/uploads/hero.png',width:1200,height:800}}},ownership:[{version:1,siteId:'sample',entityId:'hero',kind:'attachment',assetSha256:sha,lastAppliedHash:managedStateHash({sha256:sha})}]});if(fault==='mediareadback'){mediaReadCountdown=2;fault='none';}if(fault==='source'){const changed=JSON.parse(await readFile(source,'utf8'));changed.pages[0].title='Changed after media';await writeFile(source,JSON.stringify(changed));fault='none';}if(fault==='owned'){fault='none';throw new Error('media before response');}return JSON.stringify({status:'complete',id:21,sha256:sha});}
  requests.push(r);
  if(r.action==='lock'){if(lock)return JSON.stringify({status:'refused'});lock=e.token;}
  else if(r.action==='unlock'){if(lock!==e.token)return JSON.stringify({status:'refused'});lock=null;}
  else if(r.action==='marker') {if(fault==='marker'&&r.operation.currentStep?.status==='completed'){fault='none';return JSON.stringify({status:'refused'});}live.siteRecord??={version:1,siteId:'sample',entities:{},options:{},operation:null};live.siteRecord.operation=(normalizeMarkerEmptyObjects?phpAssociateEmptyObjects(r.operation):structuredClone(r.operation)) as typeof r.operation;if(r.index)live.siteRecord.entities[r.index.key]=r.index.id;}
  else if(r.action==='mutate') {
   const journal=JSON.parse(await readFile(options.journal,'utf8'));expect(journal.currentStep).toEqual(r.step);expect(live.siteRecord!.operation!.currentStep).toEqual(r.step);
   mutations++;
   if(fault==='unknown')throw new Error('lost response');
   if(fault==='secret')throw new Error('third-party bootstrap SENTINEL_PRIVATE_WP_CREDENTIAL');
   const op=r.operation;
   if(op.kind==='option'){live.options[op.entityId]=op.desired!.value;live.siteRecord!.options[op.entityId]={lastAppliedValue:op.desired!.value};if(routeMutation.startsWith('front')&&(op.entityId==='show_on_front'||op.entityId==='page_on_front')){live.routing.rewriteRulesHash=`rules-after-${op.entityId}`;if(routeMutation==='front-permalink')live.routing.permalinkStructure='/%category%/%postname%/';if(routeMutation==='front-unsupported')live.routing.unsupportedReason='changed by another writer';}}
   else {const entity={id:op.id??(op.kind==='pattern'?20:22),kind:op.kind,route:op.kind==='page'?'/home':null,state:structuredClone(op.desired!),postStatus:String(op.desired!.status),ownership:[{version:1 as const,siteId:'sample',entityId:op.entityId,kind:op.kind,lastAppliedHash:managedStateHash(op.desired!)}]};live.entities=live.entities.filter(item=>item.id!==entity.id);live.entities.push(entity);live.siteRecord!.entities[r.step.key]=entity.id;}
   if(routeMutation==='page'&&op.kind==='page')live.routing.rewriteRulesHash='rules-after-page-change';
   for(const page of live.entities.filter(item=>item.kind==='page'))page.route=live.options.show_on_front==='page'&&live.options.page_on_front===page.id?'/':`/${page.state.slug}`;
   if(fault==='noowner'&&op.kind==='page')live.entities.find(item=>item.kind==='page')!.ownership=[];
   if(fault==='readback'){fault='none';readFailure=true;}
   if(fault==='owned'){fault='none';throw new Error('created before response');}
   if(fault==='frontowned'&&op.kind==='option'&&op.entityId==='page_on_front'){fault='none';throw new Error('front option changed before response');}
   if(fault==='changed' && op.kind==='page')live.entities[0]!.state.status='private';
   return JSON.stringify({status:'complete',...(op.kind!=='option'?{id:op.id??(op.kind==='pattern'?20:22)}:{})});
  }
  return JSON.stringify({status:'complete'});
 }};
 return {root,source,plan,options,live,transports,requests,setFault:(value:typeof fault)=>{fault=value;},setRouteMutation:(value:typeof routeMutation)=>{routeMutation=value;},count:()=>mutations,setLock:(token='stale')=>{lock=token;},releaseLock:()=>{lock=null;}};
}
describe('confirmed database apply',()=>{
 it('keeps previously confirmed insertion-order source identities exact during semantic reconstruction',async()=>{
  const f=await fixture();const input=await readSitePlanInput(f.source,f.root);
  input.source.sourceIdentity=hashBytes(Buffer.from(JSON.stringify(input.source.sourceIntent)));
  const plan=await planPreparedSite(input,structuredClone(f.live));const confirmed=plan.confirmationHash;
  const result=await applySite(plan,{...f.options,confirm:confirmed},f.transports);
  expect(result.status).toBe('completed');expect(result.planHash).toBe(confirmed);expect(plan.sourceIdentity).toBe(input.source.sourceIdentity);expect(f.count()).toBe(3);
 });
 it.each(['none','live','source'] as const)('checks retained items together and refuses late %s changes',async(change)=>{
  const f=await fixture();expect((await applySite(f.plan,f.options,f.transports)).status).toBe('completed');
  const input=await readSitePlanInput(f.source,f.root);const plan=await planPreparedSite(input,structuredClone(f.live));
  expect(plan.operations.every(op=>op.action==='retain')).toBe(true);
  let reads=0;const originalRead=f.transports.read;
  const result=await applySite(plan,{...f.options,confirm:plan.confirmationHash,journal:path.join(f.root,'retained.json')},{...f.transports,read:async()=>{
   reads++;if(reads===4){if(change==='live')f.live.navigation.push({id:99,content:'human edit',status:'publish'});if(change==='source'){const source=JSON.parse(await readFile(f.source,'utf8'));source.pages[0].title='Human edit';await writeFile(f.source,JSON.stringify(source));}}
   return originalRead();
  }});
  expect(result.status).toBe(change==='none'?'completed':'partial');expect(reads).toBe(change==='none'?5:4);expect(f.count()).toBe(3);
  if(change!=='none')expect(result.error).toContain(change==='live'?'live state changed before completion':'source bytes changed before completion');
 });
 it('streams a large default mutation script to a short eval-file stdin invocation',async()=>{
  const root=await mkdtemp(path.join(await realpath(os.tmpdir()),'site-apply-stdin-'));
  const capture=path.join(root,'capture.json');
  const executable=path.join(root,'fake-wp');
  await writeFile(executable,`#!/usr/bin/env node\nlet input='';process.stdin.setEncoding('utf8');process.stdin.on('data',chunk=>input+=chunk);process.stdin.on('end',()=>{require('node:fs').writeFileSync(${JSON.stringify(capture)},JSON.stringify({args:process.argv.slice(2),input,eof:true}));process.stdout.write('{"status":"complete"}');});\n`);
  await chmod(executable,0o755);
  const longMarkup=`<!-- wp:paragraph --><p>${'Native paragraph content. '.repeat(12_000)}</p><!-- /wp:paragraph -->`;
  const boundary:SiteApplyBoundary={siteId:'sample',planHash:'plan-hash',token:'token',target:{homeUrl:'https://example.test',siteUrl:'https://example.test',blogId:1},principal:{userId:7,capabilities:{edit_pages:true}},theme:{slug:'sample',assetBaseUrl:'https://example.test/theme',inventory:[]}};
  const request:SiteApplyRequest={action:'marker',operation:{token:boundary.token,planHash:boundary.planHash,status:'started',target:boundary.target,principalId:boundary.principal.userId,stepEvidence:{operation:{action:'create',kind:'page',entityId:'home',desired:{title:'Home',content:longMarkup,status:'draft',slug:'home',parentId:0,template:'default'}},beforeState:{}}}};
  const result=await siteApplyWpCli({wpPath:'/wp',wpUrl:'https://example.test',wpUser:'7',wpBinary:executable},boundary,request);
  expect(result).toEqual({status:'complete'});
  const received=JSON.parse(await readFile(capture,'utf8')) as {args:string[];input:string;eof:boolean};
  expect(received.args).toEqual(['--path=/wp','--url=https://example.test','--user=7','eval-file','-']);
  expect(received.args.join(' ').length).toBeLessThan(200);
  expect(received.eof).toBe(true);
  expect(received.input.startsWith('<?php\n')).toBe(true);
  expect(Buffer.byteLength(received.input)).toBeGreaterThan(300_000);
  const encoded=received.input.match(/base64_decode\('([^']+)'\)/)?.[1];
  expect(encoded).toBe(Buffer.from(JSON.stringify({...boundary,request,option:siteRecordOption(boundary.siteId),lock:SITE_APPLY_LOCK_OPTION})).toString('base64'));
  expect(Buffer.from(encoded!,'base64').toString()).toContain(longMarkup);
 });
 it('creates once, reads back every field and explicit options, then replays before obsolete before-state',async()=>{
  const f=await fixture();const first=await applySite(f.plan,f.options,f.transports);expect(first.status).toBe('completed');expect(first.steps.map(item=>item.step.key)).toEqual(['page:home','option:show_on_front','option:page_on_front']);expect(f.count()).toBe(3);
  await writeFile(f.source,'source no longer present');expect(await applySite(f.plan,f.options,f.transports)).toEqual(first);expect(f.count()).toBe(3);
  f.live.entities[0]!.state.template='human';await expect(applySite(f.plan,f.options,f.transports)).rejects.toThrow('after-state');expect(f.count()).toBe(3);
 });
 it('keeps finalized page authority exact when PHP normalizes empty pending attrs objects',async()=>{
  const f=await fixture('media',true);const pending=f.plan.operations.find(op=>op.kind==='page')!;expect(JSON.stringify(pending.body)).toContain('"attrs":{}');
  const result=await applySite(f.plan,f.options,f.transports);expect(result.status).toBe('completed');
  const pageStep=result.steps.find(item=>item.step.kind==='page')!;expect(pageStep.operation).toMatchObject({kind:'page',entityId:'home',desired:{title:'Home',slug:'home',parentId:0,template:'index',status:'draft'}});
  for(const field of ['body','pendingBindings','pendingPatternUses','requiresFinalization'])expect(pageStep.operation).not.toHaveProperty(field);
  const entity=f.live.entities.find(item=>item.kind==='page')!;expect(entity.state).toEqual(pageStep.operation.desired);expect(entity.ownership).toHaveLength(1);expect(entity.ownership[0]).toMatchObject({siteId:'sample',entityId:'home',kind:'page',lastAppliedHash:managedStateHash(entity.state)});
 });
 it('accepts the native rewrite cache change caused by a changed front-page option',async()=>{const f=await fixture();f.setRouteMutation('front');const result=await applySite(f.plan,f.options,f.transports);expect(result.status).toBe('completed');expect(f.live.routing.rewriteRulesHash).toBe('rules-after-page_on_front');expect(f.count()).toBe(3);});
 it('does not accept a rewrite cache change when a page write leaves front-page options unchanged',async()=>{const f=await fixture();f.setRouteMutation('page');const result=await applySite(f.plan,f.options,f.transports);expect(result.status).toBe('outcome_unknown');expect(f.live.options).toEqual({show_on_front:'posts',page_on_front:0});expect(f.live.routing.rewriteRulesHash).toBe('rules-after-page-change');expect(f.count()).toBe(1);});
 it.each(['front-permalink','front-unsupported'] as const)('keeps other routing fields bound during %s',async(change)=>{const f=await fixture();f.setRouteMutation(change);const result=await applySite(f.plan,f.options,f.transports);expect(result.status).toBe('outcome_unknown');expect(f.live.routing.rewriteRulesHash).toBe('rules-after-show_on_front');expect(f.count()).toBe(2);});
 it('recovers an interrupted front-option readback and refreshes only completed page routes',async()=>{const f=await fixture();f.setRouteMutation('front');f.setFault('frontowned');expect((await applySite(f.plan,f.options,f.transports)).status).toBe('outcome_unknown');expect(f.live.entities[0]!.route).toBe('/');expect(f.live.routing.rewriteRulesHash).toBe('rules-after-page_on_front');const resumed=await applySite(f.plan,f.options,f.transports);expect(resumed.status).toBe('completed');expect(resumed.steps.find(item=>item.step.kind==='page')!.after!.route).toBe('/');expect(f.count()).toBe(3);});
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
 it.each(['owned','noowner'] as const)('refuses a stranded same-operation lock after %s response loss, preserving evidence',async(fault)=>{
  const f=await fixture();f.setFault(fault);const interrupted=await applySite(f.plan,f.options,f.transports);expect(interrupted.status).toBe('outcome_unknown');
  f.setLock(interrupted.token);const evidence=await readFile(f.options.journal);
  await expect(applySite(f.plan,f.options,f.transports)).rejects.toThrow('never stolen');expect(await readFile(f.options.journal)).toEqual(evidence);expect(f.count()).toBe(1);
  // Simulate guarded operator reconciliation only after all executors have stopped.
  f.releaseLock();const resumed=await applySite(f.plan,f.options,f.transports);
  expect(resumed.status).toBe(fault==='owned'?'completed':'outcome_unknown');expect(f.count()).toBe(fault==='owned'?3:1);expect(f.live.entities).toHaveLength(1);
 });
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
 it('never retains third-party transport stderr in the journal or returned CLI receipt',async()=>{const f=await fixture();f.setFault('secret');const result=await applySite(f.plan,f.options,f.transports);expect(result.status).toBe('outcome_unknown');expect(result.error).toContain('WP-CLI site apply transport failed');expect(JSON.stringify(result)).not.toContain('SENTINEL_PRIVATE_WP_CREDENTIAL');expect(await readFile(f.options.journal,'utf8')).not.toContain('SENTINEL_PRIVATE_WP_CREDENTIAL');expect(result.steps).toHaveLength(1);expect(f.count()).toBe(1);});
 it('retains media step authority when an ordinary snapshot error occurs after the import helper succeeds',async()=>{const f=await fixture('media');f.setFault('mediareadback');const result=await applySite(f.plan,f.options,f.transports);expect(result.status).toBe('outcome_unknown');expect(result.steps).toHaveLength(1);expect(result.steps[0]!.step.status).toBe('outcome_unknown');expect(f.live.siteRecord!.operation!.currentStep!.kind).toBe('attachment');expect(f.count()).toBe(1);expect((await applySite(f.plan,f.options,f.transports)).status).toBe('completed');expect(f.live.entities.filter(entity=>entity.kind==='attachment')).toHaveLength(1);expect(f.count()).toBe(4);});
 it('preserves an unowned create as unknown and refuses all repeats',async()=>{const f=await fixture();f.setFault('noowner');expect((await applySite(f.plan,f.options,f.transports)).status).toBe('outcome_unknown');expect((await applySite(f.plan,f.options,f.transports)).status).toBe('outcome_unknown');expect(f.count()).toBe(1);expect(f.live.entities).toHaveLength(1);});
 it.each(['readback','marker'] as const)('recovers exact owned state after %s interruption without another create',async(fault)=>{const f=await fixture();f.setFault(fault);expect((await applySite(f.plan,f.options,f.transports)).status).toBe('outcome_unknown');expect((await applySite(f.plan,f.options,f.transports)).status).toBe('completed');expect(f.count()).toBe(3);expect(f.live.entities).toHaveLength(1);});
 it('retains completed dependency effects and precise pending inventory when source bytes change before page writes',async()=>{const f=await fixture('media');f.setFault('source');const result=await applySite(f.plan,f.options,f.transports);expect(result.status).toBe('partial');expect(result.steps).toHaveLength(1);expect(result.steps[0]!.step.status).toBe('completed');expect(result.pending.map(op=>op.kind)).toEqual(['page','option','option']);expect(f.live.entities.map(entity=>entity.kind)).toEqual(['attachment']);expect(f.count()).toBe(1);});
 it('stops on status-only readback edits and preserves unknown evidence',async()=>{const f=await fixture();f.setFault('changed');const result=await applySite(f.plan,f.options,f.transports);expect(result.status).toBe('outcome_unknown');expect(f.count()).toBe(1);});
});
