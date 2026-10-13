import { spawn } from 'node:child_process';
import { siteRecordOption, SITE_OWNERSHIP_META, SITE_APPLY_LOCK_OPTION, type SiteWpCliOptions, type SiteReadTransport } from './wpcli.js';
import { managedStateHash } from './plan.js';
import type { SiteSnapshot, SiteApplyStep, SitePlanOperation } from './plan-types.js';
export interface SiteApplyBoundary {
  siteId: string;
  planHash: string;
  token: string;
  target: SiteSnapshot['target'];
  principal: SiteSnapshot['principal'];
  theme: SiteSnapshot['theme'];
}
export type SiteApplyRequest = {
  action: 'lock' | 'unlock';
} | {
  action: 'marker';
  index?: {
    key: string;
    id: number;
  };
  operation: {
    token: string;
    planHash: string;
    status: 'started' | 'outcome_unknown' | 'completed';
    target: SiteSnapshot['target'];
    principalId: number;
    currentStep?: SiteApplyStep;
    stepEvidence?: {
      operation: SitePlanOperation;
      beforeState: unknown;
    };
  };
} | {
  action: 'mutate';
  step: SiteApplyStep;
  operation: SitePlanOperation;
  before: SiteSnapshot;
  stateHash: string;
};
/** Only fixed operations are exposed. A transport error after invocation has uncertain effects. */
export async function siteApplyWpCli(wp: SiteWpCliOptions, boundary: SiteApplyBoundary, request: SiteApplyRequest, transport?: SiteReadTransport): Promise<{
  status: string;
  id?: number;
}> {
  if (!wp.wpPath || [wp.wpPath, wp.wpUrl, wp.wpUser, wp.wpBinary].some(value => value?.includes('\0'))) throw new Error('invalid WP-CLI selection');
  const selection = [`--path=${wp.wpPath}`, ...(wp.wpUrl ? [`--url=${wp.wpUrl}`] : []), ...(wp.wpUser ? [`--user=${wp.wpUser}`] : [])];
  let output: string;
  try {
    output = transport ? await transport(wp.wpBinary ?? 'wp', [...selection, 'eval', script(boundary, request)]) : await runWithInput(wp.wpBinary ?? 'wp', [...selection, 'eval-file', '-'], `<?php\n${script(boundary, request)}`);
  } catch {
    throw new Error('WP-CLI site apply transport failed; preserve operation evidence and inspect the selected local installation');
  }
  try {
    const result = JSON.parse(output) as {
      status: string;
      id?: number;
    };
    if (!result || !['complete', 'refused', 'outcome_unknown'].includes(result.status)) throw new Error();
    return result;
  } catch {
    throw new Error('WP-CLI site apply returned invalid boundary readback; preserve operation evidence');
  }
}
function runWithInput(executable: string, args: string[], input: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      stdio: ['pipe', 'pipe', 'ignore']
    });
    let output = '';
    let settled = false;
    const fail = () => {
      if (settled) return;
      settled = true;
      child.kill();
      reject(new Error('WP-CLI site apply process failed'));
    };
    child.on('error', fail);
    child.stdin.on('error', fail);
    child.stdout.on('error', fail);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      if (settled) return;
      output += chunk;
      if (Buffer.byteLength(output) > 1024 * 1024) fail();
    });
    child.on('close', code => {
      if (settled) return;
      if (code !== 0) {
        fail();
        return;
      }
      settled = true;
      resolve(output);
    });
    try {
      child.stdin.end(input);
    } catch {
      fail();
    }
  });
}
function script(boundary: SiteApplyBoundary, request: SiteApplyRequest): string {
  // The executor keeps complete transition evidence. PHP needs only this mutation's baseline.
  const payloadRequest = request.action === 'mutate' ? {
    ...request,
    before: {
      entities: request.operation.id ? request.before.entities.filter(entity => entity.id === request.operation.id) : [],
      options: request.operation.kind === 'option' ? {
        [request.operation.entityId]: request.before.options[request.operation.entityId]
      } : {}
    }
  } : request;
  const encoded = Buffer.from(JSON.stringify({
    ...boundary,
    request: payloadRequest,
    ...(request.action === 'mutate' && request.operation.id ? {
      beforeStateHash: managedStateHash(request.before.entities.find(entity => entity.id === request.operation.id)?.state ?? {})
    } : {}),
    option: siteRecordOption(boundary.siteId),
    lock: SITE_APPLY_LOCK_OPTION
  })).toString('base64');
  return `
$e=json_decode(base64_decode('${encoded}'),true); $r=$e['request']; $attempted=false;
$same=function($a,$b) use (&$same) { if (is_array($a) && is_array($b)) { if(count($a)!==count($b)) return false; foreach($a as $k=>$v) if(!array_key_exists($k,$b)||!$same($v,$b[$k])) return false; return true; } return $a===$b; };
$state=function($p) { $s=array('content'=>$p->post_content,'title'=>$p->post_title,'status'=>$p->post_status); if($p->post_type==='page') { $s['slug']=$p->post_name; $s['parentId']=(int)$p->post_parent; $s['template']=(string)get_post_meta($p->ID,'_wp_page_template',true); } return $s; };
$result=(function() use($e,$r,&$attempted,$same,$state) {
 try {
  $target=array('homeUrl'=>home_url(),'siteUrl'=>site_url(),'blogId'=>(int)get_current_blog_id());
  if(!$same($target,$e['target']) || (int)get_current_user_id()!==$e['principal']['userId']) return array('status'=>'refused');
  foreach($e['principal']['capabilities'] as $cap=>$allowed) if((bool)current_user_can($cap)!==$allowed) return array('status'=>'refused');
  if($r['action']==='unlock') { if(get_option($e['lock'])!==$e['token']) return array('status'=>'refused'); delete_option($e['lock']); return array('status'=>get_option($e['lock'],null)===null?'complete':'refused'); }
  if(get_stylesheet()!==$e['theme']['slug']) return array('status'=>'refused');
  $inventory=array(); $root=get_stylesheet_directory();
  foreach(new RecursiveIteratorIterator(new RecursiveDirectoryIterator($root,FilesystemIterator::SKIP_DOTS)) as $file) { if($file->isLink()) return array('status'=>'refused'); if($file->isFile()) $inventory[]=array('path'=>str_replace(DIRECTORY_SEPARATOR,'/',substr($file->getPathname(),strlen($root)+1)),'sha256'=>hash_file('sha256',$file->getPathname()),'size'=>$file->getSize()); }
  usort($inventory,function($a,$b){return strcmp($a['path'],$b['path']);});
  if(!$same($inventory,$e['theme']['inventory'])) return array('status'=>'refused');
  if($r['action']==='lock') {
   // A matching token identifies an operation, not one still-running process.
   return array('status'=>add_option($e['lock'],$e['token'],'',false)?'complete':'refused');
  }
  if(get_option($e['lock'])!==$e['token']) return array('status'=>'refused');
  $record=get_option($e['option'],null);
  if($r['action']==='marker') {
   if(!is_array($record)) $record=array('version'=>1,'siteId'=>$e['siteId'],'entities'=>array(),'options'=>array(),'operation'=>null);
   if(($record['siteId']??null)!==$e['siteId']) return array('status'=>'refused');
   $old=$record['operation']; if($old && ($old['status']??null)!=='completed' && (($old['token']??null)!==$e['token'] || ($old['planHash']??null)!==$e['planHash'])) return array('status'=>'refused');
   if(isset($r['index'])) $record['entities'][$r['index']['key']]=$r['index']['id'];
   $record['operation']=$r['operation']; update_option($e['option'],$record,false);
   return array('status'=>$same(get_option($e['option']),$record)?'complete':'outcome_unknown');
  }
  $marker=is_array($record)?($record['operation']??null):null;
  if(!$marker || ($marker['token']??null)!==$e['token'] || ($marker['planHash']??null)!==$e['planHash'] || ($marker['status']??null)!=='started' || !$same($marker['currentStep']??null,$r['step'])) return array('status'=>'refused');
  $op=$r['operation']; if(!$same($marker['stepEvidence']['operation']??null,$op))return array('status'=>'refused'); $desired=$op['desired']; $kind=$op['kind']; $id=$op['id']??null;
  if($kind==='option') {
   if(!in_array($op['entityId'],array('show_on_front','page_on_front'),true) || !$same($op['entityId']==='page_on_front'?(int)get_option($op['entityId']):get_option($op['entityId']),$r['before']['options'][$op['entityId']])) return array('status'=>'refused');
   $attempted=true; update_option($op['entityId'],$desired['value']);
   $record['options'][$op['entityId']]=array('lastAppliedValue'=>$desired['value']); update_option($e['option'],$record,false);
   return array('status'=>'complete');
  }
  if(!in_array($kind,array('page','pattern'),true)) return array('status'=>'refused');
  $type=$kind==='page'?'page':'wp_block';
  if($id) {
   $baseline=null; foreach($r['before']['entities'] as $entity) if($entity['id']===$id) $baseline=$entity;
   $owners=$baseline['ownership']??array(); $owner=count($owners)===1?$owners[0]:null;
   if(!$owner || ($owner['version']??null)!==1 || ($owner['siteId']??null)!==$e['siteId'] || ($owner['entityId']??null)!==$op['entityId'] || ($owner['kind']??null)!==$kind || ($owner['lastAppliedHash']??null)!==$e['beforeStateHash'])return array('status'=>'refused');
   $p=get_post($id); if(!$baseline || !$p || $p->post_type!==$type || !$same($state($p),$baseline['state']) || !$same(get_post_meta($id,'${SITE_OWNERSHIP_META}',false),$baseline['ownership'])) return array('status'=>'refused');
  } else {
   foreach(get_posts(array('post_type'=>$type,'post_status'=>array('publish','draft','private','pending','trash','future','auto-draft'),'numberposts'=>-1)) as $p) {
    foreach(get_post_meta($p->ID,'${SITE_OWNERSHIP_META}',false) as $owner) if(($owner['siteId']??null)===$e['siteId'] && ($owner['entityId']??null)===$op['entityId']) return array('status'=>'refused');
    if($kind==='page' && $p->post_name===$desired['slug'] && (int)$p->post_parent===$desired['parentId']) return array('status'=>'refused');
   }
  }
  $data=array('post_type'=>$type,'post_title'=>$desired['title'],'post_content'=>$desired['content'],'post_status'=>$desired['status']);
  if($id) { $data['ID']=$id; if($desired['status']==='draft') $data['edit_date']=true; }
  // Template metadata is assigned below. wp_update_post otherwise inherits and revalidates the old template after writing.
  if($kind==='page') { $data['post_name']=$desired['slug']; $data['post_parent']=$desired['parentId']; $data['page_template']=''; }
  $attempted=true; $written=$id ? wp_update_post(wp_slash($data),true) : wp_insert_post(wp_slash($data),true); if(is_wp_error($written)||!$written) throw new Exception('save'); $id=(int)$written;
  if($kind==='page') update_post_meta($id,'_wp_page_template',$desired['template']);
  $owner=array('version'=>1,'siteId'=>$e['siteId'],'entityId'=>$op['entityId'],'kind'=>$kind,'lastAppliedHash'=>$r['stateHash']);
  if(isset($op['id'])) update_post_meta($id,'${SITE_OWNERSHIP_META}',$owner); else if(!add_post_meta($id,'${SITE_OWNERSHIP_META}',$owner,true)) throw new Exception('ownership');
  if(!$same(get_post_meta($id,'${SITE_OWNERSHIP_META}',false),array($owner))) throw new Exception('ownership readback');
  $record['entities'][$r['step']['key']]=$id; update_option($e['option'],$record,false);
  if(!$same(get_option($e['option']),$record)) throw new Exception('index readback');
  return array('status'=>'complete','id'=>$id);
 } catch(Throwable $error) { return array('status'=>$attempted?'outcome_unknown':'refused'); }
})(); echo wp_json_encode($result);`;
}
