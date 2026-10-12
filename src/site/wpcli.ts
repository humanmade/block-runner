import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promisify } from 'node:util';
import type { SiteSnapshot } from './plan-types.js';

export const SITE_OWNERSHIP_META = '_block_runner_site';
export function siteRecordOption(siteId: string): string {
  return `_block_runner_site_${createHash('sha256').update(siteId).digest('hex')}`;
}
export interface SiteWpCliOptions { wpPath: string; wpUrl?: string; wpBinary?: string; wpUser?: string }
export type SiteReadTransport = (executable: string, args: string[]) => Promise<string>;
const run = promisify(execFile);
const localRead: SiteReadTransport = async (executable, args) => {
  try {
    const { stdout } = await run(executable, args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
    return stdout;
  } catch {
    // Child stderr can contain credentials from third-party bootstrap code.
    throw new Error('WP-CLI snapshot failed; inspect the selected local installation and principal');
  }
};

/** The adapter exposes only this fixed read operation, never arbitrary commands or mutation methods. */
export async function readSiteSnapshot(options: SiteWpCliOptions, siteId: string, transport: SiteReadTransport = localRead): Promise<SiteSnapshot> {
  if (!options.wpPath || options.wpPath.includes('\0')) throw new Error('wpPath is required');
  if (!/^[a-z0-9][a-z0-9-]*$/.test(siteId)) throw new Error('invalid siteId');
  const args = [`--path=${options.wpPath}`];
  for (const value of [options.wpUrl, options.wpUser, options.wpBinary]) if (value?.includes('\0')) throw new Error('WP-CLI arguments cannot contain NUL bytes');
  if (options.wpUrl) args.push(`--url=${options.wpUrl}`);
  if (options.wpUser) args.push(`--user=${options.wpUser}`);
  args.push('eval', snapshotScript(siteId));
  const output = await transport(options.wpBinary ?? 'wp', args);
  let snapshot: SiteSnapshot;
  try { snapshot = JSON.parse(output) as SiteSnapshot; } catch { throw new Error('WP-CLI returned an invalid snapshot'); }
  validateSnapshot(snapshot);
  return snapshot;
}

function validateSnapshot(value: SiteSnapshot): void {
  if (!value || !value.target || !Number.isInteger(value.target.blogId) || value.target.blogId < 1 || !value.runtime || !value.theme || !Array.isArray(value.theme.inventory) || !Array.isArray(value.entities) || !Array.isArray(value.overrides) || !Array.isArray(value.navigation) || !value.options || !value.principal || !value.principal.capabilities) {
    throw new Error('WP-CLI returned an incomplete snapshot');
  }
  for (const url of [value.target.homeUrl, value.target.siteUrl, value.theme.assetBaseUrl]) {
    const parsed = new URL(url);
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) throw new Error('snapshot URL contains unsupported identity or secret fields');
  }
  if (!Number.isInteger(value.principal.userId) || value.principal.userId < 1) throw new Error('Select an authenticated WordPress principal with --wp-user or WP-CLI configuration (observed user ID 0)');
}

function snapshotScript(siteId: string): string {
  const option = JSON.stringify(siteRecordOption(siteId));
  return `
$capabilities = array();
foreach (array('edit_pages','publish_pages','edit_others_pages','upload_files','manage_options','edit_theme_options') as $cap) $capabilities[$cap] = current_user_can($cap);
$entities = array(); $overrides = array(); $navigation = array();
$posts = get_posts(array('post_type'=>array('page','attachment','wp_block','wp_template','wp_template_part','wp_navigation'), 'post_status'=>array('publish','future','draft','pending','private','trash','inherit','auto-draft'), 'numberposts'=>-1, 'orderby'=>'ID', 'order'=>'ASC', 'suppress_filters'=>true));
foreach ($posts as $post) {
  if ($post->post_type === 'wp_template' || $post->post_type === 'wp_template_part') {
    $overrides[] = array('id'=>(int)$post->ID,'kind'=>$post->post_type,'theme'=>wp_get_object_terms($post->ID,'wp_theme',array('fields'=>'names')),'content'=>$post->post_content); continue;
  }
  if ($post->post_type === 'wp_navigation') { $navigation[] = array('id'=>(int)$post->ID,'content'=>$post->post_content,'status'=>$post->post_status); continue; }
  $kind = $post->post_type === 'page' ? 'page' : ($post->post_type === 'attachment' ? 'attachment' : 'pattern');
  $state = array('content'=>$post->post_content, 'title'=>$post->post_title, 'status'=>$post->post_status);
  $route = null; $attachment = null;
  if ($kind === 'page') {
    $state['slug'] = $post->post_name; $state['parentId'] = (int)$post->post_parent;
    $state['template'] = (string)get_post_meta($post->ID, '_wp_page_template', true);
    $homePath = rtrim((string)parse_url(home_url(), PHP_URL_PATH), '/');
    $permalink = get_permalink($post->ID);
    $permalinkPath = (string)parse_url($permalink, PHP_URL_PATH);
    $route = parse_url($permalink, PHP_URL_QUERY) ? '/' . trim(get_page_uri($post->ID), '/') : '/' . trim(substr($permalinkPath, strlen($homePath)), '/');
    if ((int)get_option('page_on_front') === (int)$post->ID && get_option('show_on_front') === 'page') $route = '/';
  }
  if ($kind === 'attachment') {
    $file = get_attached_file($post->ID);
    $original = wp_get_original_image_path($post->ID); if (!$original) $original = $file;
    $metadata = wp_get_attachment_metadata($post->ID);
    $state = array('sha256'=>($original && is_file($original) && !is_link($original)) ? hash_file('sha256',$original) : null);
    $attachment = array('url'=>wp_get_attachment_url($post->ID) ?: null,'currentFileSha256'=>($file && is_file($file) && !is_link($file)) ? hash_file('sha256',$file) : null,'width'=>isset($metadata['width']) ? (int)$metadata['width'] : null,'height'=>isset($metadata['height']) ? (int)$metadata['height'] : null);
  }
  $meta = get_post_meta($post->ID, '${SITE_OWNERSHIP_META}', false);
  $entity = array('id'=>(int)$post->ID,'kind'=>$kind,'route'=>$route,'state'=>$state,'ownership'=>$meta);
  if ($attachment) $entity['attachment'] = $attachment;
  $entities[] = $entity;
}
$root = get_stylesheet_directory(); $inventory = array();
$iterator = new RecursiveIteratorIterator(new RecursiveDirectoryIterator($root, FilesystemIterator::SKIP_DOTS));
foreach ($iterator as $file) {
  if ($file->isLink()) throw new Exception('theme symlinks unsupported');
  if (!$file->isFile()) continue;
  $relative = str_replace(DIRECTORY_SEPARATOR,'/',substr($file->getPathname(),strlen($root)+1));
  $inventory[] = array('path'=>$relative,'sha256'=>hash_file('sha256',$file->getPathname()),'size'=>$file->getSize());
}
usort($inventory, function($a,$b){return strcmp($a['path'],$b['path']);});
$record = get_option(${option}, null);
echo wp_json_encode(array('target'=>array('homeUrl'=>home_url(),'siteUrl'=>site_url(),'blogId'=>get_current_blog_id()),'runtime'=>array('wordpress'=>get_bloginfo('version'),'php'=>PHP_VERSION),'principal'=>array('userId'=>get_current_user_id(),'capabilities'=>$capabilities),'theme'=>array('slug'=>get_stylesheet(),'assetBaseUrl'=>get_stylesheet_directory_uri(),'inventory'=>$inventory),'entities'=>$entities,'overrides'=>$overrides,'navigation'=>$navigation,'options'=>array('show_on_front'=>get_option('show_on_front'),'page_on_front'=>(int)get_option('page_on_front')),'siteRecord'=>$record));`;
}
