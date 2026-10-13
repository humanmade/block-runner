import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { siteApplyWpCli, type SiteApplyBoundary, type SiteApplyRequest } from '../../src/site/apply-wpcli.js';
import { managedStateHash } from '../../src/site/plan.js';
import { siteRecordOption, SITE_APPLY_LOCK_OPTION } from '../../src/site/wpcli.js';
import type { SiteSnapshot } from '../../src/site/plan-types.js';
const run=promisify(execFile);
const boundary:SiteApplyBoundary={siteId:'sample',planHash:'confirmed',token:'token',target:{homeUrl:'https://example.test',siteUrl:'https://example.test',blogId:1},principal:{userId:7,capabilities:{edit_pages:true}},theme:{slug:'sample',assetBaseUrl:'https://example.test/theme',inventory:[]}};
const state={content:'Hello',title:'Home',status:'draft',slug:'home',parentId:0,template:'index'};
const step={key:'page:home',kind:'page' as const,entityId:'home',status:'started' as const};
const before:SiteSnapshot={target:boundary.target,runtime:{wordpress:'7.1',php:'8.4'},principal:boundary.principal,theme:boundary.theme,routing:{permalinkStructure:'/%postname%/',rewriteRulesHash:'rules',routes:[]},entities:[{id:22,kind:'page',route:'/home',state,ownership:[{version:1,siteId:'sample',entityId:'home',kind:'page',lastAppliedHash:managedStateHash(state)}]}],overrides:[],navigation:[],options:{show_on_front:'posts',page_on_front:0},siteRecord:null};
async function execute(request:SiteApplyRequest,flags:Record<string,unknown>={},selectedBoundary:SiteApplyBoundary=boundary) {
 const root=await mkdtemp(path.join(await realpath(os.tmpdir()),'apply-php-'));
 const data=Buffer.from(JSON.stringify({root,flags,state,owner:before.entities[0]!.ownership[0],option:siteRecordOption(selectedBoundary.siteId),lock:SITE_APPLY_LOCK_OPTION,step:request.action==='mutate'?request.step:step,evidence:request.action==='mutate'?{operation:request.operation,beforeState:request.operation.kind==='option'?request.before.options[request.operation.entityId]:request.before.entities.find(entity=>entity.id===request.operation.id)??null}:null})).toString('base64');
 let output='';let argsSeen:string[]=[];
 const response=await siteApplyWpCli({wpPath:'/wp path;$(false)',wpUser:'7'},selectedBoundary,request,async(_executable,args)=>{
  argsSeen=args;
  const stub=`
$d=json_decode(base64_decode('${data}'),true);$flags=$d['flags'];$writes=0;
$options=array($d['option']=>array('version'=>1,'siteId'=>'sample','entities'=>array(),'options'=>array(),'operation'=>array('token'=>'token','planHash'=>'confirmed','status'=>'started','currentStep'=>$d['step'],'stepEvidence'=>$d['evidence'])),$d['lock']=>'token','show_on_front'=>'posts','page_on_front'=>'0');
if(isset($flags['noLock']))unset($options[$d['lock']]);if(isset($flags['legacyLock']))$options[$d['option'].'_lock']='legacy';
class TestWpdb {public $options='options';function esc_like($s){return addcslashes($s,'_%');}function prepare($sql,$pattern){return $sql;}function get_col($sql){global $options;return array_keys($options);}}$wpdb=new TestWpdb();
if(isset($flags['wrongToken']))$options[$d['lock']]='foreign';if(isset($flags['wrongStep']))$options[$d['option']]['operation']['currentStep']['entityId']='foreign';
$p=(object)array('ID'=>22,'post_type'=>'page','post_content'=>$d['state']['content'],'post_title'=>$d['state']['title'],'post_status'=>$d['state']['status'],'post_name'=>'home','post_parent'=>0,'post_author'=>31,'post_excerpt'=>'Human excerpt','post_date'=>'2025-02-03 04:05:06','post_date_gmt'=>'2025-02-03 03:05:06','menu_order'=>19);
if(isset($flags['humanStatus']))$p->post_status='private';
$meta=array(22=>array('_wp_page_template'=>'index','_block_runner_site'=>array($d['owner'])));
function home_url(){return 'https://example.test';}function site_url(){return home_url();}function get_current_blog_id(){global $flags;return $flags['blogId']??1;}function get_current_user_id(){return 7;}function current_user_can($c){return true;}function get_stylesheet(){return 'sample';}function get_stylesheet_directory(){global $d;return $d['root'];}function wp_json_encode($v){return json_encode($v);}
function get_option($k,$default=false){global $options;return $options[$k]??$default;}function add_option($k,$v,$unused='',$autoload=false){global $options;if(array_key_exists($k,$options))return false;$options[$k]=$v;return true;}function delete_option($k){global $options;unset($options[$k]);return true;}function update_option($k,$v,$autoload=false){global $options,$writes;$writes++;$options[$k]=$v;return true;}
function get_post($id){global $p;return $id===22?$p:null;}function get_posts($args){global $p,$flags;return isset($flags['occupied'])?array($p):array();}function get_post_meta($id,$k,$single){global $meta;return $single?($meta[$id][$k]??''):($meta[$id][$k]??array());}
function wp_slash($v){return $v;}function is_wp_error($v){return false;}function wp_insert_post($v,$errors){global $p,$writes,$flags;$writes++;$p=(object)array('ID'=>22,'post_type'=>$v['post_type'],'post_content'=>$v['post_content'],'post_title'=>$v['post_title'],'post_status'=>$v['post_status'],'post_name'=>$v['post_name'],'post_parent'=>$v['post_parent']);return 22;}
function wp_update_post($v,$errors){global $p,$writes;$writes++;foreach(array('post_type','post_title','post_content','post_status','post_name','post_parent') as $key)if(array_key_exists($key,$v))$p->$key=$v[$key];if(!array_key_exists('page_template',$v)||$v['page_template']!=='')throw new Exception('inherited page template validation');return (int)$v['ID'];}
function update_post_meta($id,$k,$v){global $meta,$flags;if(isset($flags['ownershipCrash'])&&$k==='_block_runner_site')throw new Exception('crash');$meta[$id][$k]=$k==='_block_runner_site'?array($v):$v;return true;}
function add_post_meta($id,$k,$v,$unique){global $meta,$flags;if(isset($flags['ownershipCrash']))throw new Exception('crash');$meta[$id][$k]=array($v);return true;}
`;
  const {stdout}=await run('php',['-r',stub+args.at(-1)!+'\necho "\\n" . json_encode(array("writes"=>$writes,"options"=>$options,"meta"=>$meta,"post"=>$p));'],{encoding:'utf8'});const lines=stdout.split('\n');output=lines[1]!;return lines[0]!;
 });
 return {response,evidence:JSON.parse(output) as {writes:number;options:Record<string,unknown>;meta:Record<string,unknown>;post:Record<string,unknown>},argsSeen};
}
describe('fixed PHP mutation boundary executed with bounded WordPress stubs',()=>{
 it('sanitizes thrown transport stderr without attaching raw output or a cause',async()=>{let error:unknown;try{await siteApplyWpCli({wpPath:'/wp'},boundary,{action:'lock'},async()=>{throw Object.assign(new Error('bootstrap SENTINEL_PRIVATE_WP_CREDENTIAL'),{stderr:'SENTINEL_PRIVATE_WP_CREDENTIAL'});});}catch(value){error=value;}expect(error).toBeInstanceOf(Error);expect((error as Error).message).toContain('site apply transport failed');expect(String(error)).not.toContain('SENTINEL_PRIVATE_WP_CREDENTIAL');expect(JSON.stringify(error)).not.toContain('SENTINEL_PRIVATE_WP_CREDENTIAL');});
 it.each(['SENTINEL_PRIVATE_WP_CREDENTIAL','null'])('sanitizes invalid boundary output %s',async(output)=>{await expect(siteApplyWpCli({wpPath:'/wp'},boundary,{action:'lock'},async()=>output)).rejects.toThrow('invalid boundary readback');});
 it('locks the blog across namespaces, refuses the same token and legacy locks, and releases only its owner',async()=>{
  expect((await execute({action:'lock'})).response.status).toBe('refused');
  expect((await execute({action:'lock'},{},{...boundary,siteId:'other',token:'other-token'})).response.status).toBe('refused');
  expect((await execute({action:'lock'},{noLock:true,legacyLock:true})).response.status).toBe('refused');
  expect((await execute({action:'lock'},{noLock:true})).response.status).toBe('complete');
  expect((await execute({action:'lock'},{noLock:true,blogId:2},{...boundary,target:{...boundary.target,blogId:2}})).response.status).toBe('complete');
  expect((await execute({action:'unlock'},{wrongToken:true})).response.status).toBe('refused');
  expect((await execute({action:'unlock'})).response.status).toBe('complete');
 });
 it.each(['humanStatus','wrongToken','wrongStep'])('rechecks %s before insertion',async(flag)=>{
  const r=await execute({action:'mutate',step,operation:{kind:'page',entityId:'home',action:'update',id:22,desired:{...state,title:'New'}},before,stateHash:managedStateHash({...state,title:'New'})},{[flag]:true});expect(r.response.status).toBe('refused');expect(r.evidence.writes).toBe(0);
 });
 it('rejects a forged unowned update at the fixed PHP boundary with zero mutations',async()=>{const unowned=structuredClone(before);unowned.entities[0]!.ownership=[];const r=await execute({action:'mutate',step,operation:{kind:'page',entityId:'home',action:'update',id:22,desired:{...state,title:'Forged'}},before:unowned,stateHash:managedStateHash({...state,title:'Forged'})});expect(r.response.status).toBe('refused');expect(r.evidence.writes).toBe(0);});
 it('writes exact managed fields and ownership without shell evaluation',async()=>{const r=await execute({action:'mutate',step,operation:{kind:'page',entityId:'home',action:'update',id:22,desired:{...state,title:'New'}},before,stateHash:managedStateHash({...state,title:'New'})});expect(r.response).toEqual({status:'complete',id:22});expect(r.evidence.post).toMatchObject({post_title:'New',post_author:31,post_excerpt:'Human excerpt',post_date:'2025-02-03 04:05:06',post_date_gmt:'2025-02-03 03:05:06',menu_order:19});expect(r.argsSeen.slice(0,3)).toEqual(['--path=/wp path;$(false)','--user=7','eval']);});
 it('does not transmit unrelated content or snapshot inventories with a selected mutation',async()=>{
  const request:SiteApplyRequest={action:'mutate',step,operation:{kind:'page',entityId:'home',action:'update',id:22,desired:{...state,title:'New'}},before,stateHash:managedStateHash({...state,title:'New'})};
  const capture=async(value:SiteApplyRequest)=>{
   let encoded='';await siteApplyWpCli({wpPath:'/wp'},boundary,value,async(_exe,args)=>{encoded=args.at(-1)!.match(/base64_decode\('([^']+)'\)/)![1]!;return JSON.stringify({status:'complete',id:22});});return encoded;
  };
  const baseline=await capture(request);
  const larger=structuredClone(request);if(larger.action!=='mutate')throw new Error('fixture action');
  larger.before.entities.push({id:9001,kind:'page',route:'/unrelated',state:{content:'x'.repeat(500_000)},ownership:[]});
  larger.before.overrides.push({id:9002,kind:'wp_template',theme:['other'],content:'x'.repeat(500_000)});
  expect(await capture(larger)).toBe(baseline);
  const payload=JSON.parse(Buffer.from(baseline,'base64').toString());
  expect(payload.request.before).toEqual({entities:[before.entities[0]],options:{}});
 });
 it('refuses occupied slug/parent creation before insert',async()=>{const r=await execute({action:'mutate',step,operation:{kind:'page',entityId:'home',action:'create',desired:state},before,stateHash:managedStateHash(state)},{occupied:true});expect(r.response.status).toBe('refused');expect(r.evidence.writes).toBe(0);});
 it('reports insertion before ownership failure as uncertain',async()=>{const r=await execute({action:'mutate',step,operation:{kind:'page',entityId:'home',action:'create',desired:state},before,stateHash:managedStateHash(state)},{ownershipCrash:true});expect(r.response.status).toBe('outcome_unknown');expect(r.evidence.writes).toBe(1);});
 it('normalizes the native numeric front-page option only for its exact before-state check',async()=>{const r=await execute({action:'mutate',step:{key:'option:page_on_front',kind:'option',entityId:'page_on_front',status:'started'},operation:{action:'set-option',kind:'option',entityId:'page_on_front',desired:{value:22}},before,stateHash:managedStateHash({value:22})});expect(r.response.status).toBe('complete');expect(r.evidence.options.page_on_front).toBe(22);});
});
