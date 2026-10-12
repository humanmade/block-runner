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
export interface SiteTemplateObservation {
  id: string;
  theme: string;
  type: 'wp_template' | 'wp_template_part';
  source: 'theme' | 'custom' | 'plugin';
  wpId: number;
  raw: string;
}
export interface SiteTemplateSnapshot {
  target: SiteSnapshot['target'];
  theme: string;
  principal: { userId: number; userLogin: string; canReadEditContext: boolean };
  runtime: { wordpress: string };
  entities: SiteTemplateObservation[];
}
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
export async function readSiteSnapshot(options: SiteWpCliOptions, siteId: string, transport: SiteReadTransport = localRead, desiredRoutes: string[] = []): Promise<SiteSnapshot> {
  if (!options.wpPath || options.wpPath.includes('\0')) throw new Error('wpPath is required');
  if (!/^[a-z0-9][a-z0-9-]*$/.test(siteId)) throw new Error('invalid siteId');
  const args = [`--path=${options.wpPath}`];
  for (const value of [options.wpUrl, options.wpUser, options.wpBinary]) if (value?.includes('\0')) throw new Error('WP-CLI arguments cannot contain NUL bytes');
  if (options.wpUrl) args.push(`--url=${options.wpUrl}`);
  if (options.wpUser) args.push(`--user=${options.wpUser}`);
  if (desiredRoutes.some(route=>!route.startsWith('/') || route.includes('\0') || route.includes('?') || route.includes('#'))) throw new Error('invalid desired route');
  args.push('eval', snapshotScript(siteId, desiredRoutes));
  const output = await transport(options.wpBinary ?? 'wp', args);
  let snapshot: SiteSnapshot;
  try { snapshot = JSON.parse(output) as SiteSnapshot; } catch { throw new Error('WP-CLI returned an invalid snapshot'); }
  validateSnapshot(snapshot);
  return snapshot;
}

/** Read theme templates and parts through the native REST edit context; this helper has no write path. */
export async function readSiteTemplateSnapshot(options: SiteWpCliOptions, expectedTheme: string, transport: SiteReadTransport = localRead): Promise<SiteTemplateSnapshot> {
  if (!options.wpPath || options.wpPath.includes('\0')) throw new Error('wpPath is required');
  if (!/^[a-z0-9][a-z0-9-]*$/.test(expectedTheme)) throw new Error('invalid expected theme slug');
  const args = [`--path=${options.wpPath}`];
  for (const value of [options.wpUrl, options.wpUser, options.wpBinary]) if (value?.includes('\0')) throw new Error('WP-CLI arguments cannot contain NUL bytes');
  if (options.wpUrl) args.push(`--url=${options.wpUrl}`);
  if (options.wpUser) args.push(`--user=${options.wpUser}`);
  args.push('eval', templateSnapshotScript(expectedTheme));
  const output = await transport(options.wpBinary ?? 'wp', args);
  let snapshot: SiteTemplateSnapshot;
  try { snapshot = JSON.parse(output) as SiteTemplateSnapshot; } catch { throw new Error('WP-CLI returned an invalid template snapshot'); }
  if (!snapshot || !snapshot.target || !Number.isInteger(snapshot.target.blogId) || snapshot.target.blogId < 1
    || snapshot.theme !== expectedTheme || !snapshot.principal || !Number.isInteger(snapshot.principal.userId) || snapshot.principal.userId < 1 || typeof snapshot.principal.userLogin !== 'string' || !snapshot.principal.userLogin
    || !snapshot.runtime || !Array.isArray(snapshot.entities)) throw new Error('WP-CLI returned an incomplete template snapshot');
  if (!snapshot.principal.canReadEditContext) throw new Error('selected WordPress principal lacks edit_posts for edit-context template inspection');
  const ids = new Set<string>();
  for (const entity of snapshot.entities) {
    const identity = entity && `${entity.type}:${entity.id}`;
    if (!entity || typeof entity.id !== 'string' || ids.has(identity) || entity.theme !== expectedTheme
      || !['wp_template', 'wp_template_part'].includes(entity.type) || !['theme', 'custom', 'plugin'].includes(entity.source)
      || !Number.isInteger(entity.wpId) || entity.wpId < 0 || typeof entity.raw !== 'string'
      || (entity.source === 'custom' && entity.wpId < 1) || (entity.source !== 'custom' && entity.wpId !== 0)) {
      throw new Error('WP-CLI returned an invalid or conflicting edit-context template entity');
    }
    ids.add(identity);
  }
  for (const url of [snapshot.target.homeUrl, snapshot.target.siteUrl]) {
    const parsed = new URL(url);
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) throw new Error('template snapshot URL contains unsupported identity or secret fields');
  }
  return snapshot;
}

function templateSnapshotScript(expectedTheme: string): string {
  const theme = JSON.stringify(expectedTheme);
  return `
if (defined('ALTERNATE_WP_CRON') && ALTERNATE_WP_CRON) throw new Exception('alternate cron bootstrap is unsupported for read-only site inspection');
remove_action('shutdown','_wp_cron');
$expected = ${theme}; $active = get_stylesheet();
if ($active !== $expected) throw new Exception('active theme differs from the explicit bundle theme');
$entities = array();
foreach (array('templates'=>'wp_template','template-parts'=>'wp_template_part') as $route=>$type) {
  $request = new WP_REST_Request('GET','/wp/v2/' . $route);
  $request->set_param('context','edit'); $request->set_param('theme',$expected);
  $response = rest_do_request($request);
  if (is_wp_error($response)) throw new Exception('edit-context template REST request failed');
  if (!($response instanceof WP_REST_Response) || $response->get_status() >= 400) throw new Exception('edit-context template REST request was denied');
  $headers = $response->get_headers();
  if (isset($headers['X-WP-TotalPages']) && (int) $headers['X-WP-TotalPages'] !== 1) throw new Exception('edit-context template REST pagination cannot be verified');
  $items = $response->get_data(); if (!is_array($items)) throw new Exception('edit-context template REST response is incomplete');
  foreach ($items as $item) {
    if (!is_array($item) || !is_string($item['theme'] ?? null) || !is_string($item['id'] ?? null) || ($item['type'] ?? null) !== $type
      || !is_string($item['source'] ?? null) || !is_numeric($item['wp_id'] ?? null)
      || !is_array($item['content'] ?? null) || !is_string($item['content']['raw'] ?? null)) throw new Exception('edit-context template REST response omitted required raw identity fields');
    if ($item['theme'] !== $expected) continue;
    $raw = $item['content']['raw'];
    $wpId = (int) $item['wp_id'];
    if ($item['source'] === 'custom') {
      if ($wpId < 1) throw new Exception('custom template has no verified numeric wp_id');
      $post = get_post($wpId); $terms = get_the_terms($wpId,'wp_theme');
      if (!$post || $post->post_type !== $type || !is_array($terms) || count($terms) !== 1 || $terms[0]->name !== $expected
        || $item['id'] !== $expected . '//' . $post->post_name || !is_string($post->post_content)) throw new Exception('custom template identity does not match its numeric post and active theme taxonomy');
      $raw = $post->post_content;
    } elseif ($item['source'] === 'theme') {
      if ($wpId !== 0 || !str_starts_with($item['id'],$expected . '//')) throw new Exception('theme template identity does not match the active theme');
      $slug = substr($item['id'],strlen($expected) + 2); $parts = explode('/',$slug);
      foreach ($parts as $part) if ($part === '' || $part === '.' || $part === '..' || !preg_match('/^[A-Za-z0-9._-]+$/',$part)) throw new Exception('theme template ID has an unsafe source path');
      $folders = get_block_theme_folders($expected); $base = realpath(get_stylesheet_directory() . '/' . $folders[$type]);
      $candidate = get_stylesheet_directory() . '/' . $folders[$type] . '/' . $slug . '.html'; $cursor = get_stylesheet_directory();
      foreach (array_merge(array($folders[$type]),$parts) as $part) { $cursor .= '/' . $part; if (is_link($cursor)) throw new Exception('theme template source contains a symbolic link'); }
      $file = realpath($candidate);
      if (!$base || !$file || !is_file($file) || !str_starts_with($file,trailingslashit($base)) || !is_string($raw = file_get_contents($file))) throw new Exception('theme template source file is missing or cannot be read exactly');
    } elseif ($item['source'] === 'plugin' && $wpId !== 0) throw new Exception('plugin template returned an unexpected database ID');
    $entities[] = array('id'=>$item['id'],'theme'=>$item['theme'],'type'=>$type,'source'=>$item['source'],'wpId'=>$wpId,'raw'=>$raw);
  }
}
echo wp_json_encode(array('target'=>array('homeUrl'=>home_url(),'siteUrl'=>site_url(),'blogId'=>get_current_blog_id()),'theme'=>$active,
  'principal'=>array('userId'=>get_current_user_id(),'userLogin'=>wp_get_current_user()->user_login,'canReadEditContext'=>current_user_can('edit_posts')),
  'runtime'=>array('wordpress'=>get_bloginfo('version')),'entities'=>$entities));`;
}

function validateSnapshot(value: SiteSnapshot): void {
  if (!value || !value.target || !Number.isInteger(value.target.blogId) || value.target.blogId < 1 || !value.runtime || !value.routing || !Array.isArray(value.routing.routes) || !value.theme || !Array.isArray(value.theme.inventory) || !Array.isArray(value.entities) || !Array.isArray(value.overrides) || !Array.isArray(value.navigation) || !value.options || !value.principal || !value.principal.capabilities) {
    throw new Error('WP-CLI returned an incomplete snapshot');
  }
  for (const url of [value.target.homeUrl, value.target.siteUrl, value.theme.assetBaseUrl]) {
    const parsed = new URL(url);
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) throw new Error('snapshot URL contains unsupported identity or secret fields');
  }
  for (const entity of value.entities) {
    if (entity.kind !== 'attachment') continue;
    if (!entity.attachment) throw new Error('snapshot attachment has no native metadata');
    if (typeof entity.postStatus !== 'string' || entity.postStatus.length === 0) throw new Error('snapshot attachment has no observed WordPress post status');
    for (const url of [entity.attachment.url, ...Object.values(entity.attachment.sizes ?? {}).map(size => size.url)]) {
      if (url === null || url === undefined) continue;
      const parsed = new URL(url);
      if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) throw new Error('attachment metadata URL contains unsupported identity or secret fields');
    }
    if (entity.attachment.linkUrl) {
      const parsed = new URL(entity.attachment.linkUrl);
      if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.hash) throw new Error('attachment page URL contains unsupported identity or secret fields');
    }
    for (const [slug, size] of Object.entries(entity.attachment.sizes ?? {})) {
      if (!/^[a-zA-Z0-9_-]+$/.test(slug) || !Number.isInteger(size.width) || size.width < 1 || !Number.isInteger(size.height) || size.height < 1) throw new Error('attachment metadata contains an invalid image size');
    }
  }
  if (!Number.isInteger(value.principal.userId) || value.principal.userId < 1) throw new Error('Select an authenticated WordPress principal with --wp-user or WP-CLI configuration (observed user ID 0)');
}

function snapshotScript(siteId: string, desiredRoutes: string[]): string {
  const option = JSON.stringify(siteRecordOption(siteId));
  const routes = Buffer.from(JSON.stringify(desiredRoutes.filter(route=>route!=='/'))).toString('base64');
  return `
// This process terminates after inspection; restoring core cron would spawn a write at shutdown.
if (defined('ALTERNATE_WP_CRON') && ALTERNATE_WP_CRON) throw new Exception('alternate cron bootstrap is unsupported for read-only site planning');
remove_action('shutdown','_wp_cron');
$capabilities = array();
foreach (array('edit_pages','publish_pages','edit_others_pages','edit_posts','edit_others_posts','publish_posts','publish_blocks','edit_published_posts','upload_files','manage_options','edit_theme_options') as $cap) $capabilities[$cap] = current_user_can($cap);
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
    $sizes = array();
    $full = wp_get_attachment_image_src($post->ID, 'full');
    if ($full) $sizes['full'] = array('url'=>$full[0], 'width'=>(int)$full[1], 'height'=>(int)$full[2]);
    foreach (isset($metadata['sizes']) && is_array($metadata['sizes']) ? $metadata['sizes'] : array() as $slug=>$size) {
      $variant = wp_get_attachment_image_src($post->ID, $slug);
      if ($variant) $sizes[$slug] = array('url'=>$variant[0], 'width'=>(int)$variant[1], 'height'=>(int)$variant[2]);
    }
    $attachment = array('url'=>wp_get_attachment_url($post->ID) ?: null,'linkUrl'=>get_attachment_link($post->ID) ?: null,'currentFileSha256'=>($file && is_file($file) && !is_link($file)) ? hash_file('sha256',$file) : null,'width'=>isset($metadata['width']) ? (int)$metadata['width'] : null,'height'=>isset($metadata['height']) ? (int)$metadata['height'] : null,'sizes'=>$sizes);
  }
  $meta = get_post_meta($post->ID, '${SITE_OWNERSHIP_META}', false);
  $entity = array('id'=>(int)$post->ID,'kind'=>$kind,'route'=>$route,'state'=>$state,'postStatus'=>$post->post_status,'ownership'=>$meta);
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
$desiredRoutes = json_decode(base64_decode('${routes}'), true);
$cachedRules = get_option('rewrite_rules');
$routing = array('permalinkStructure'=>(string)get_option('permalink_structure'),'rewriteRulesHash'=>is_array($cachedRules) && $cachedRules ? hash('sha256',wp_json_encode($cachedRules)) : null,'routes'=>array());
$unsupported = !$routing['permalinkStructure'] || !is_array($cachedRules) || !$cachedRules ? 'cached pretty-permalink rules are required; configure/flush explicitly outside planning' : null;
// Unknown request/query filters cannot be proved by this bounded core-only inspection.
foreach (array('do_parse_request','request','query_vars','parse_request','parse_query','pre_get_posts','posts_pre_query','url_to_postid','template_redirect','pre_option_rewrite_rules','option_rewrite_rules') as $hook) {
  if (!isset($GLOBALS['wp_filter'][$hook])) continue;
  foreach ($GLOBALS['wp_filter'][$hook]->callbacks as $callbacks) foreach ($callbacks as $entry) {
    $callback = $entry['function'];
    try { $reflection = is_array($callback) ? new ReflectionMethod($callback[0],$callback[1]) : (is_string($callback) && str_contains($callback,'::') ? new ReflectionMethod(...explode('::',$callback,2)) : new ReflectionFunction($callback)); $file = $reflection->getFileName(); }
    catch (Throwable $error) { $file = false; }
    if (!$file || !str_starts_with($file,ABSPATH . WPINC . '/')) $unsupported = 'custom request/query filter is unsupported: ' . $hook;
  }
}
$resolve = function($route) use ($cachedRules) {
  foreach (explode('/',trim($route,'/')) as $segment) if ($segment !== sanitize_title_with_dashes($segment,'','save')) return array('route'=>$route,'kind'=>'unsupported','matchedRule'=>null,'queryFingerprint'=>hash('sha256',$route),'reason'=>'route segment is not a canonical WordPress slug');
  $saved = array(); foreach (array('wp','wp_query','wp_the_query','post','wp_rewrite') as $key) $saved[$key] = array_key_exists($key,$GLOBALS) ? array(true,$GLOBALS[$key]) : array(false,null);
  $savedServer = $_SERVER; $savedGet = $_GET; $savedPost = $_POST;
  $savedDispatch = $GLOBALS['wp_filter']['parse_request'] ?? null;
  $savedCacheHook = isset($GLOBALS['wp_filter']['pre_option_rewrite_rules']) ? clone $GLOBALS['wp_filter']['pre_option_rewrite_rules'] : null;
  try {
    unset($GLOBALS['wp_filter']['parse_request']);
    add_filter('pre_option_rewrite_rules', function() use ($cachedRules) { return $cachedRules; });
    $GLOBALS['wp_rewrite'] = clone $GLOBALS['wp_rewrite'];
    $_GET = array(); $_POST = array(); $_SERVER['PATH_INFO'] = ''; $_SERVER['REQUEST_URI'] = rtrim((string)parse_url(home_url(),PHP_URL_PATH),'/') . $route; $_SERVER['PHP_SELF'] = rtrim((string)parse_url(home_url(),PHP_URL_PATH),'/') . '/index.php';
    $rest = '/' . rest_get_url_prefix();
    if ($route === $rest || str_starts_with($route,$rest . '/') || preg_match('#^/(?:wp-admin|wp-login\\.php)(?:/|$)#',$route)) return array('route'=>$route,'kind'=>'reserved','matchedRule'=>null,'queryFingerprint'=>hash('sha256',$route),'reason'=>'native administration or REST endpoint');
    $classify = function() use ($route) {
      $request = new WP(); $GLOBALS['wp'] = $request;
      if (!$request->parse_request()) return array('route'=>$route,'kind'=>'unsupported','matchedRule'=>null,'queryFingerprint'=>hash('sha256',$route),'reason'=>'native request parser refused route');
      $vars = $request->query_vars;
      $base = array('route'=>$route,'kind'=>'unsupported','matchedRule'=>$request->matched_rule ?: null,'queryFingerprint'=>hash('sha256',wp_json_encode($vars)));
      // Inspect the raw matched query too: filtered-out custom variables remain unsupported.
      $matched = array(); parse_str((string)$request->matched_query,$matched);
      if (isset($GLOBALS['wp_rewrite']->extra_rules_top[$request->matched_rule]) || isset($GLOBALS['wp_rewrite']->extra_rules[$request->matched_rule])) { $base['reason']='explicit extra rewrite rule is unsupported'; return $base; }
      $allowed = array('p','page_id','pagename','name','post_type','attachment','attachment_id','category_name','cat','tag','tag_id','taxonomy','term','author','author_name','year','monthnum','day','hour','minute','second','m','feed','paged','page','s','robots','favicon','embed','tb','cpage','error','rest_route');
      foreach (get_post_types(array('publicly_queryable'=>true),'objects') as $type) if ($type->query_var) $allowed[] = $type->query_var;
      foreach (get_taxonomies(array('publicly_queryable'=>true),'objects') as $taxonomy) if ($taxonomy->query_var) $allowed[] = $taxonomy->query_var;
      if (array_diff(array_keys($matched),$allowed)) { $base['reason'] = 'custom rewrite query variables are unsupported'; return $base; }
      if (isset($matched['rest_route'])) { $base['kind']='reserved'; $base['reason']='native REST endpoint'; return $base; }
      $query = new WP_Query(); $GLOBALS['wp_query'] = $query; $GLOBALS['wp_the_query'] = $query;
      $query->parse_query(array_merge($vars,array('posts_per_page'=>1,'no_found_rows'=>true,'suppress_filters'=>true,'cache_results'=>false,'update_post_meta_cache'=>false,'update_post_term_cache'=>false,'lazy_load_term_meta'=>false)));
      if ($query->is_archive || $query->is_feed || $query->is_search || $query->is_date || $query->is_author || $query->is_tax || $query->is_category || $query->is_tag || $query->is_post_type_archive || $query->is_paged || $query->is_embed || $query->is_trackback || $query->is_robots || $query->is_favicon) { $base['kind']='reserved'; $base['reason']='native archive, taxonomy, or endpoint'; return $base; }
      if (array_key_exists('page',$matched) && $matched['page'] !== '') { $base['kind']='reserved'; $base['reason']='native page pagination endpoint'; return $base; }
      // Reserved route flags are classified before get_posts can materialize taxonomy caches.
      if ($query->is_singular()) $query->get_posts();
      if ($query->is_singular() && $query->posts) { $base['kind']='singular'; $base['postId']=(int)$query->posts[0]->ID; $base['postType']=$query->posts[0]->post_type; return $base; }
      $pageSlot = $matched; if (isset($pageSlot['page']) && $pageSlot['page'] === '') unset($pageSlot['page']);
      if ($request->matched_rule && count(array_diff(array_keys($pageSlot),array('pagename','name'))) === 0 && (isset($matched['pagename']) || isset($matched['name']))) {
        $key = isset($matched['pagename']) ? 'pagename' : 'name';
        if (trim((string)$matched[$key],'/') === trim($route,'/')) { $base['kind']='available'; return $base; }
      }
      $base['reason']='unresolved native or custom rewrite route'; return $base;
    };
    $result = $classify();
    if ($result['kind'] === 'unsupported' && ($result['reason'] ?? '') === 'unresolved native or custom rewrite route') {
      // Native pending-page slot inspection uses the same cached rules, never a fabricated page.
      $GLOBALS['wp_rewrite']->use_verbose_page_rules = false;
      $pending = $classify(); if ($pending['kind']==='available') $result = $pending;
    }
    return $result;
  } finally {
    foreach ($saved as $key=>$value) { if ($value[0]) $GLOBALS[$key]=$value[1]; else unset($GLOBALS[$key]); }
    $_SERVER=$savedServer; $_GET=$savedGet; $_POST=$savedPost;
    if ($savedDispatch) $GLOBALS['wp_filter']['parse_request']=$savedDispatch; else unset($GLOBALS['wp_filter']['parse_request']);
    if ($savedCacheHook) $GLOBALS['wp_filter']['pre_option_rewrite_rules']=$savedCacheHook; else unset($GLOBALS['wp_filter']['pre_option_rewrite_rules']);
  }
};
if ($unsupported) $routing['unsupportedReason']=$unsupported;
foreach ($desiredRoutes as $route) $routing['routes'][] = $unsupported ? array('route'=>$route,'kind'=>'unsupported','matchedRule'=>null,'queryFingerprint'=>hash('sha256',$route),'reason'=>$unsupported) : $resolve($route);
echo wp_json_encode(array('target'=>array('homeUrl'=>home_url(),'siteUrl'=>site_url(),'blogId'=>get_current_blog_id()),'runtime'=>array('wordpress'=>get_bloginfo('version'),'php'=>PHP_VERSION),'principal'=>array('userId'=>get_current_user_id(),'capabilities'=>$capabilities),'theme'=>array('slug'=>get_stylesheet(),'assetBaseUrl'=>get_stylesheet_directory_uri(),'inventory'=>$inventory),'routing'=>$routing,'entities'=>$entities,'overrides'=>$overrides,'navigation'=>$navigation,'options'=>array('show_on_front'=>get_option('show_on_front'),'page_on_front'=>(int)get_option('page_on_front')),'siteRecord'=>$record));`;
}
