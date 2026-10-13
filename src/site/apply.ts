import { randomUUID } from 'node:crypto';
import { lstat, open, rename } from 'node:fs/promises';
import path from 'node:path';
import { readStableRegularFile } from '../publication.js';
import { hashCanonicalJson } from '../proof/receipt.js';
import { compileSite, compileSiteSyncedPatterns, compileThemeDocuments } from './compile.js';
import { readSitePlanInput, planSite, observedAttachmentBindings, managedStateHash } from './plan.js';
import { importPlannedSiteAttachment, SiteMediaImportOutcomeUnknown } from './media-import.js';
import { attachmentVersionKey } from './media.js';
import { syncedPatternOrder } from './patterns.js';
import { readSiteSnapshot, type SiteWpCliOptions, type SiteReadTransport } from './wpcli.js';
import { siteApplyWpCli, type SiteApplyBoundary, type SiteApplyRequest } from './apply-wpcli.js';
import type { SitePlan, SiteSnapshot, SitePlanOperation, SiteApplyStep, SiteEntity } from './plan-types.js';

export interface SiteApplyOptions extends SiteWpCliOptions {
  confirm: string; source: string; journal: string; assetRoot?: string; strict?: boolean;
}
export interface SiteApplyReceipt {
  version: 1; siteId: string; planHash: string; token: string; target: SiteSnapshot['target']; principalId: number;
  status: 'started' | 'partial' | 'outcome_unknown' | 'completed';
  diagnostics: import('../types.js').ReportItem[]; pending: SitePlanOperation[];
  currentStep?: SiteApplyStep; steps: Array<{ step: SiteApplyStep; operation: SitePlanOperation; beforeState: unknown; after?: SiteEntity; value?: unknown }>;
  observed: SiteSnapshot; error?: string;
  lockRelease?: 'released' | 'unconfirmed';
  limitation: string;
}
export interface SiteApplyTransports { read?: SiteReadTransport; mutate?: SiteReadTransport }
const same = (a: unknown,b: unknown): boolean => hashCanonicalJson(a) === hashCanonicalJson(b);
function comparable(snapshot: SiteSnapshot): unknown {
  const copy = structuredClone(snapshot); if(copy.siteRecord) copy.siteRecord.operation=null; return copy;
}
function nativePageRoute(entity:SiteEntity,snapshot:SiteSnapshot):string {
  if(snapshot.options.show_on_front==='page' && snapshot.options.page_on_front===entity.id)return '/';
  const segments:string[]=[];const visited=new Set<number>();let current:SiteEntity|undefined=entity;
  while(current){if(visited.has(current.id))throw new Error('observed page parent cycle');visited.add(current.id);if(!(snapshot.options.show_on_front==='page'&&snapshot.options.page_on_front===current.id))segments.unshift(String(current.state.slug));const parent:number=Number(current.state.parentId);current=parent?snapshot.entities.find(item=>item.kind==='page'&&item.id===parent):undefined;if(parent&&!current)throw new Error('observed page parent absent');}
  return `/${segments.join('/')}`;
}
function assertTransition(before:SiteSnapshot,after:SiteSnapshot,op:SitePlanOperation,entity?:SiteEntity):void {
  const expected=structuredClone(before);
  if(entity){expected.entities=expected.entities.filter(item=>item.id!==entity.id);expected.entities.push(entity);expected.entities.sort((a,b)=>a.id-b.id);if(op.kind!=='attachment')expected.siteRecord!.entities[`${op.kind}:${op.entityId}`]=entity.id;else {const key=attachmentVersionKey(op.entityId,String(op.desired?.sha256));if(after.siteRecord?.entities[key]===entity.id)expected.siteRecord!.entities[key]=entity.id;}}
  if(op.kind==='option'){expected.options[op.entityId]=op.desired!.value;expected.siteRecord!.options[op.entityId]={lastAppliedValue:op.desired!.value};}
  for(const page of expected.entities.filter(item=>item.kind==='page'))page.route=nativePageRoute(page,expected);
  // Request resolution changes as pages become available.
  // A front-page option may refresh WordPress's rewrite hash; every other routing field stays bound.
  expected.routing.routes=after.routing.routes;
  if(op.kind==='option'&&(op.entityId==='show_on_front'||op.entityId==='page_on_front')&&!same(before.options[op.entityId],op.desired?.value)&&same(after.options[op.entityId],op.desired?.value)&&typeof after.routing.rewriteRulesHash==='string'&&after.routing.rewriteRulesHash.length>0)expected.routing.rewriteRulesHash=after.routing.rewriteRulesHash;
  if(!same(comparable(expected),comparable(after)))throw new Error('unexpected live changes during mutation readback');
}
/** Confirmed database-only apply. Readback detects conflicts; it does not exclude human writes. */
export async function applySite(plan: SitePlan, options: SiteApplyOptions, transports: SiteApplyTransports = {}): Promise<SiteApplyReceipt> {
  const {confirmationHash,...body}=plan;
  if(options.confirm!==confirmationHash || hashCanonicalJson(body)!==confirmationHash || !same(plan.snapshotFingerprint,hashCanonicalJson(plan.snapshot))) throw new Error('exact plan confirmation and integrity are required');
  const journalPath=path.resolve(options.journal); await safePath(journalPath,true);
  let journal: SiteApplyReceipt | undefined;
  try { journal=JSON.parse((await readStableRegularFile(journalPath,'journal changed while reading')).content.toString('utf8')) as SiteApplyReceipt; }
  catch(error) { if((error as NodeJS.ErrnoException).code!=='ENOENT') throw error; }
  // Use the confirmed routes even when they have no current numeric ID.
  const desiredRoutes=plan.snapshot.routing.routes.map(route=>route.route);
  const read=()=>readSiteSnapshot(options,plan.siteId,transports.read,desiredRoutes);
  let live=await read();
  const boundary: SiteApplyBoundary={siteId:plan.siteId,planHash:confirmationHash,token:journal?.token ?? randomUUID(),target:plan.snapshot.target,principal:plan.snapshot.principal,theme:plan.snapshot.theme};
  const call=(request:SiteApplyRequest)=>siteApplyWpCli(options,boundary,request,transports.mutate);
  const assertIdentity=():void=>{ if(!same(live.target,plan.snapshot.target)||!same(live.principal,plan.snapshot.principal)||!same(live.theme,plan.snapshot.theme)) throw new Error('target, principal or installed theme changed'); };
  assertIdentity();
  if(journal) {
    if(journal.version!==1||journal.siteId!==plan.siteId||journal.planHash!==confirmationHash||!journal.token||!same(journal.target,plan.snapshot.target)||journal.principalId!==live.principal.userId) throw new Error('journal belongs to a different confirmed operation');
    // Completed replay deliberately precedes obsolete executable-plan preconditions and source reads.
    if(journal.status==='completed') {
      const outstanding=live.siteRecord?.operation;if(outstanding&&outstanding.status!=='completed')throw new Error('outstanding site operation blocks completed receipt replay');
      if(!same(comparable(live),comparable(journal.observed))) throw new Error('completed receipt no longer matches full live after-state; prepare a fresh plan');
      return journal;
    }
  }
  if(!plan.executable||plan.conflicts.length) throw new Error('plan is not executable');
  const input=await readSitePlanInput(options.source,options.assetRoot);
  if(input.source.sourceIdentity!==plan.sourceIdentity||input.source.sourceIntent.siteId!==plan.siteId||!same(input.source.assets.map(({id,path,sha256})=>({id,path,sha256})),plan.assets)) throw new Error('source or asset bytes changed after confirmation');
  // Reconstruct the semantic plan from retained source and its confirmed baseline, never trusting edited operation claims.
  const semantic=await planSite(options.source,options,async()=>JSON.stringify(plan.snapshot));
  if(semantic.confirmationHash!==plan.confirmationHash)throw new Error('confirmed plan operations do not match source and baseline reconciliation');
  const marker=live.siteRecord?.operation;
  if(marker && marker.status!=='completed' && (!journal || marker.planHash!==confirmationHash||marker.token!==journal.token)) throw new Error('outstanding site operation blocks apply; preserve its receipt and reconcile explicitly');
  if(!journal && !same(comparable(live),comparable(plan.snapshot))) throw new Error('confirmed before-state changed; prepare a fresh plan');
  if((await call({action:'lock'})).status!=='complete') throw new Error(`site apply lock exists for ${plan.snapshot.target.homeUrl}; preserve confirmed plan, native marker and journal ${journalPath}. Stop all executors and WP-CLI descendants before guarded operator lock reconciliation; locks are never stolen`);
  try {
    live=await read(); assertIdentity();
    if(!journal && !same(comparable(live),comparable(plan.snapshot))) throw new Error('confirmed before-state changed while acquiring lock');
    journal ??= {version:1,siteId:plan.siteId,planHash:confirmationHash,token:boundary.token,target:plan.snapshot.target,principalId:plan.snapshot.principal.userId,status:'started',diagnostics:plan.diagnostics,pending:[],steps:[],observed:live,limitation:'Readback detects conflicts; the apply lock only serializes Block Runner applies and cannot exclude human edits or make WordPress hooks, metadata and media effects transactional.'};
    const save=()=>{journal!.pending=plan.operations.filter(op=>op.action!=='retain'&&!journal!.steps.some(item=>item.step.status==='completed'&&item.step.kind===op.kind&&item.step.entityId===op.entityId));return durableWrite(journalPath,journal!);};
    const mark=async(status:'started'|'outcome_unknown'|'completed',index?:{key:string;id:number}):Promise<void>=>{
      const active=journal!.currentStep?journal!.steps.find(item=>item.step.key===journal!.currentStep!.key):undefined;
      const evidence=active?{stepEvidence:{operation:active.operation,beforeState:active.beforeState}}:{};
      const beforeMarker=structuredClone(live);
      const result=await call({action:'marker',...(index?{index}:{}),operation:{token:boundary.token,planHash:confirmationHash,status,target:boundary.target,principalId:boundary.principal.userId,...evidence,...(journal!.currentStep?{currentStep:journal!.currentStep}:{})}});
      if(result.status!=='complete') throw new Error('target operation marker readback failed');
      live=await read(); assertIdentity();
      beforeMarker.siteRecord ??= {version:1,siteId:plan.siteId,entities:{},options:{},operation:null};
      if(index)beforeMarker.siteRecord.entities[index.key]=index.id;
      if(!same(comparable(beforeMarker),comparable(live)))throw new Error('live state changed during marker persistence');
      if(!same(live.siteRecord?.operation,{token:boundary.token,planHash:confirmationHash,status,target:boundary.target,principalId:boundary.principal.userId,...evidence,...(journal!.currentStep?{currentStep:journal!.currentStep}:{})})) throw new Error('target operation authority changed');
    };
    const prove=(record:SiteApplyReceipt['steps'][number], snapshot:SiteSnapshot):SiteEntity|undefined=>{
      const op=record.operation;
      if(op.kind==='option') { if(!same(snapshot.options[op.entityId],op.desired?.value)||!same(snapshot.siteRecord?.options[op.entityId]?.lastAppliedValue,op.desired?.value)) throw new Error('option outcome lacks exact proof'); return; }
      const candidates=snapshot.entities.filter(entity=>entity.kind===op.kind && (!op.id||entity.id===op.id) && entity.ownership.length===1 && entity.ownership.some(owner=>owner.siteId===plan.siteId&&owner.entityId===op.entityId&&owner.kind===op.kind&&owner.lastAppliedHash===managedStateHash(entity.state)&&(!record.step.assetSha256||owner.assetSha256===record.step.assetSha256)));
      const entity=candidates.length===1?candidates[0]:undefined;
      if(!entity || !same(entity.state,op.kind==='attachment'?{sha256:record.step.assetSha256}:op.desired)) throw new Error('mutation outcome lacks exact owned managed-state proof');
      if(entity.kind==='page'&&entity.route!==nativePageRoute(entity,snapshot))throw new Error('page route differs from its exact native parent/slug/options state');
      if(entity.kind==='attachment')observedAttachmentBindings(input,snapshot);
      if(record.after && !same(entity,record.after)) throw new Error('completed entity changed after readback');
      return entity;
    };
    // Never repeat a started mutation. Only an exact, unique owned outcome can advance it.
    if(journal.currentStep && (journal.currentStep.status!=='completed'||!same(comparable(live),comparable(journal.observed)))) {
      const pending=journal.steps.find(item=>item.step.key===journal!.currentStep!.key);
      if(!pending) throw new Error('started journal has no exact step evidence');
      try { const entity=prove(pending,live); assertTransition(journal.observed,live,pending.operation,entity); if(entity) pending.after=entity; if(pending.operation.kind==='option'&&(pending.operation.entityId==='show_on_front'||pending.operation.entityId==='page_on_front'))for(const completed of journal.steps){if(completed.step.status==='completed'&&completed.after?.kind==='page'){const actual=live.entities.find(item=>item.kind==='page'&&item.id===completed.after!.id);if(actual)completed.after.route=nativePageRoute(actual,live);}} pending.step.status='completed'; journal.currentStep={...pending.step}; await save(); await mark('started',entity?{key:pending.step.key,id:entity.id}:undefined); journal.observed=live; await save(); }
      catch { journal.status='outcome_unknown'; await save(); throw new Error('outcome_unknown: insufficient ownership/readback proof; no mutation may be retried'); }
    }
    for(const completed of journal.steps.filter(item=>item.step.status==='completed')) prove(completed,live);
    if(!journal.steps.length && !journal.observed.siteRecord && live.siteRecord){const expected=structuredClone(journal.observed);expected.siteRecord={version:1,siteId:plan.siteId,entities:{},options:{},operation:null};if(!same(comparable(live),comparable(expected)))throw new Error('live before-state changed before the first mutation');journal.observed=live;}
    if(!same(comparable(live),comparable(journal.observed))) throw new Error('live state changed since the durable last readback; prepare a fresh plan');
    journal.status='started'; delete journal.error; await save(); await mark('started'); journal.observed=live; await save();
    const perform=async(op:SitePlanOperation):Promise<void>=>{
      const key=op.kind==='attachment'?attachmentVersionKey(op.entityId,String(op.desired?.sha256)):`${op.kind}:${op.entityId}`;
      const done=journal!.steps.find(item=>item.step.key===key&&item.step.status==='completed'); if(done){prove(done,live);return;}
      live=await read(); assertIdentity(); if(!same(comparable(live),comparable(journal!.observed))) throw new Error('live state changed immediately before mutation');
      const refreshed=await readSitePlanInput(options.source,options.assetRoot);
      if(refreshed.source.sourceIdentity!==plan.sourceIdentity||!same(refreshed.source.assets.map(({id,path,sha256})=>({id,path,sha256})),plan.assets)) throw new Error('source bytes changed immediately before mutation');
      if(op.action==='retain') return;
      if(op.action==='update'){const entity=live.entities.find(entity=>entity.id===op.id);const owner=entity?.ownership.length===1?entity.ownership[0]:undefined;if(!entity||!owner||owner.version!==1||owner.siteId!==plan.siteId||owner.entityId!==op.entityId||owner.kind!==op.kind||owner.lastAppliedHash!==managedStateHash(entity.state))throw new Error('update requires exact existing ownership and full managed baseline');}
      const step:SiteApplyStep={key,kind:op.kind,entityId:op.entityId,...(op.kind==='attachment'?{assetSha256:String(op.desired?.sha256)}:{}),status:'started'};
      const record={step,operation:op,beforeState:op.kind==='option'?live.options[op.entityId]:live.entities.find(entity=>entity.id===op.id)??null} as SiteApplyReceipt['steps'][number]; journal!.steps.push(record);journal!.currentStep=step; journal!.status='started';await save();await mark('started');
      const beforeMutation=structuredClone(live);
      let attempted=false;
      try {
        attempted=true;
        if(op.kind==='attachment') {
          try { await importPlannedSiteAttachment({plan,source:input.source,assetId:op.entityId,wp:options,authority:{token:boundary.token,journalPath},readTransport:transports.read,mutationTransport:transports.mutate}); }
          catch(error) { if(error instanceof Error && !(error instanceof SiteMediaImportOutcomeUnknown))attempted=false; throw error; }
        }
        else {
          const result=await call({action:'mutate',step,operation:op,before:live,stateHash:managedStateHash(op.desired!)});
          if(result.status==='refused'){attempted=false;throw new Error('fixed WordPress boundary refused before mutation');}
          if(result.status!=='complete') throw new Error('mutation outcome unknown');
          if(result.id) record.operation={...op,id:result.id};
        }
        live=await read();assertIdentity();const entity=prove(record,live);
        // Media helper returns exact ownership but does not persist the shared site index.
        assertTransition(beforeMutation,live,op,entity);
        if(entity) record.after=entity;else record.value=live.options[op.entityId];
        if(op.kind==='option')for(const completed of journal!.steps){if(completed.after?.kind==='page'){const actual=live.entities.find(item=>item.id===completed.after!.id);if(actual)completed.after=structuredClone(actual);}}
        step.status='completed';journal!.currentStep={...step};await save();await mark('started',entity?{key,id:entity.id}:undefined);journal!.observed=live;await save();
      } catch(error) { if(attempted){step.status='outcome_unknown';journal!.currentStep={...step};journal!.status='outcome_unknown';await save();try{await mark('outcome_unknown');}catch{/* Keep durable uncertainty even when target is unavailable. */}} else { journal!.steps.pop(); delete journal!.currentStep; await save(); await mark('started'); journal!.observed=live; await save(); }throw error; }
    };
    let attachments=observedAttachmentBindings(input,live);
    let patternBindings=Object.fromEntries(live.entities.filter(entity=>entity.kind==='pattern'&&entity.ownership.some(owner=>owner.siteId===plan.siteId&&owner.lastAppliedHash===managedStateHash(entity.state))).map(entity=>[entity.ownership[0]!.entityId,entity.id]));
    const compileOptions=()=>({attachmentBindings:attachments,patternBindings,themeAssetBaseUrl:live.theme.assetBaseUrl,strict:options.strict});
    const theme=await compileThemeDocuments(input.source,compileOptions());
    if(!theme.ok||!same(theme.artifact.inventory,live.theme.inventory)) throw new Error('theme dependencies must be bound and explicitly deployed before database apply');
    for(const op of plan.operations.filter(op=>op.kind==='attachment')) await perform(op);
    attachments=observedAttachmentBindings(input,live);
    for(const id of syncedPatternOrder(input.source.sourceIntent)) {
      const op=plan.operations.find(op=>op.kind==='pattern'&&op.entityId===id);if(!op)throw new Error('missing planned pattern');
      const compiled=(await compileSiteSyncedPatterns(input.source,compileOptions())).find(pattern=>pattern.id===id);
      if(!compiled?.ok||compiled.content===undefined||compiled.pendingUses.length||compiled.pendingBindings.length) throw new Error('pattern dependency finalization failed');
      const desired={title:compiled.title,content:compiled.content,status:'publish'};
      const existing=op.id?live.entities.find(entity=>entity.id===op.id):undefined;
      const {body:_body,pendingBindings:_pendingBindings,pendingPatternUses:_pendingPatternUses,requiresFinalization:_requiresFinalization,...finalizedOp}=op;
      await perform({...finalizedOp,desired,action:op.action==='retain'&&!same(existing?.state,desired)?'update':op.action});
      const entity=live.entities.find(entity=>entity.kind==='pattern'&&entity.ownership.some(owner=>owner.siteId===plan.siteId&&owner.entityId===id));if(!entity)throw new Error('pattern readback absent');patternBindings[id]=entity.id;
    }
    const compiled=await compileSite(input.source,compileOptions());
    if(compiled.ok)journal.diagnostics=JSON.parse(JSON.stringify([...plan.diagnostics,...compiled.site.diagnostics]));
    if(!compiled.ok||!same(compiled.site.inventory,live.theme.inventory)) throw new Error('complete bound site gate or installed theme byte equality failed; dependency effects remain journaled');
    const ids=new Map(live.entities.filter(entity=>entity.kind==='page'&&entity.ownership.some(owner=>owner.siteId===plan.siteId)).map(entity=>[entity.ownership[0]!.entityId,entity.id]));
    for(const op of plan.operations.filter(op=>op.kind==='page'&&!op.desired?.orphaned)) {
      const page=compiled.site.pages.find(page=>page.id===op.entityId);if(!page)throw new Error('compiled page absent');
      const parent=page.parentId?ids.get(page.parentId):0;if(parent===undefined)throw new Error('page parent dependency absent');
      const desired={title:page.title,slug:page.route==='/'?page.id:page.route.split('/').at(-1)!,parentId:parent,template:page.template,status:page.status,content:page.content};
      const existing=op.id?live.entities.find(entity=>entity.id===op.id):undefined;
      const {body:_body,pendingBindings:_pendingBindings,pendingPatternUses:_pendingPatternUses,requiresFinalization:_requiresFinalization,...finalizedOp}=op;
      await perform({...finalizedOp,desired,action:op.action==='retain'&&!same(existing?.state,desired)?'update':op.action});
      const entity=live.entities.find(entity=>entity.kind==='page'&&entity.ownership.some(owner=>owner.siteId===plan.siteId&&owner.entityId===page.id));if(!entity)throw new Error('page readback absent');ids.set(page.id,entity.id);
    }
    for(const op of plan.operations.filter(op=>op.kind==='option')) {
      let value=op.desired?.value;if(value&&typeof value==='object'&&'pendingPageId' in value)value=ids.get(String(value.pendingPageId));if(value===undefined)throw new Error('option page binding absent');await perform({...op,desired:{value}});
    }
    live=await read();assertIdentity();for(const record of journal.steps)prove(record,live);
    for(const page of compiled.site.pages){const entity=live.entities.find(entity=>entity.id===ids.get(page.id));if(!entity||entity.route!==page.route)throw new Error('actual page route differs from confirmed route');}
    delete journal.currentStep;await save();await mark('completed');journal.status='completed';journal.observed=live;await save();return journal;
  } catch(error) {
    if(!journal) throw error;
    if(journal.status!=='outcome_unknown')journal.status='partial';journal.error=error instanceof Error?error.message:'apply failed';await durableWrite(journalPath,journal);return journal;
  } finally {
    try { if((await call({action:'unlock'})).status!=='complete') throw new Error('lock release refused'); if(journal){journal.lockRelease='released';await durableWrite(journalPath,journal);} }
    catch { if(journal){journal.lockRelease='unconfirmed';if(journal.status==='completed')journal.status='partial';journal.error='token-owned lock release is unconfirmed; explicit operator reconciliation is required';await durableWrite(journalPath,journal);} }
  }
}
async function safePath(file:string,allowMissing=false):Promise<void>{let cursor=path.parse(file).root;for(const part of file.slice(cursor.length).split(path.sep).filter(Boolean)){cursor=path.join(cursor,part);try{if((await lstat(cursor)).isSymbolicLink())throw new Error('journal path cannot contain symlinks');}catch(error){if(allowMissing&&cursor===file&&(error as NodeJS.ErrnoException).code==='ENOENT')return;throw error;}}}
async function durableWrite(file:string,value:SiteApplyReceipt):Promise<void>{
  await safePath(file,true);const temp=`${file}.${randomUUID()}.tmp`;const handle=await open(temp,'wx',0o600);
  try{await handle.writeFile(`${JSON.stringify(value,null,2)}\n`);await handle.sync();}finally{await handle.close();}
  await rename(temp,file);const directory=await open(path.dirname(file),'r');try{await directory.sync();}finally{await directory.close();}
}
