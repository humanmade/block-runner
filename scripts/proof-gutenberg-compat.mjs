import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const hash = (bytes) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const shape = (nodes) => nodes.map((node) => [node.name, shape(node.innerBlocks ?? [])]);
const count = (nodes) => nodes.reduce((sum, node) => sum + 1 + count(node.innerBlocks ?? []), 0);
const gates = ['client_registry', 'editor_inserter', 'editor_field_editing', 'editor_save', 'editor_reopen', 'frontend_status', 'frontend_semantics', 'frontend_media', 'frontend_assets', 'frontend_runtime_errors', 'pattern_overrides'];

/** Development-only observations: never invokes the release receipt runner. */
export async function proveGutenbergCompatibility({ root, outputDir, built, expectedTree, imageBase64 }) {
  const identity = {
    zip: hash(await readFile(built.pluginZip)), input: hash(await readFile(built.inputPath)),
    template: hash(await readFile(path.join(built.pluginDirectory, 'src', 'blocks', built.fixture.blockName.split('/')[1], 'edit.js'))),
  };
  const receipt = { kind: 'development-compatibility', identity, lanes: [], status: 'failed' };
  const lanes = [
    { name: 'wordpress-7.1', core: '7.1', port: 8891 },
    { name: 'wordpress-7.1.2', core: '7.1.2', port: 8892 },
    { name: 'wordpress-7.1.2-gutenberg-24.0.0', core: '7.1.2', gutenberg: '24.0.0', port: 8893 },
  ];
  try {
    for (const lane of lanes) {
      const directory = path.join(outputDir, lane.name);
      await mkdir(directory, { recursive: true });
      const config = path.join(directory, '.wp-env.json');
      const stage = path.join(directory, 'stage');
      await mkdir(stage, { recursive: true });
      await copyFile(built.pluginZip, path.join(stage, 'fixture.zip'));
      await writeFile(config, JSON.stringify({ core: `WordPress/WordPress#${lane.core}`, phpVersion: '8.3', port: lane.port,
        mappings: { 'wp-content/compat-stage': stage },
        config: { WP_DEBUG: true, WP_DEBUG_LOG: true, WP_DEBUG_DISPLAY: false, SCRIPT_DEBUG: true },
        testsEnvironment: false,
      }, null, 2));
      const observed = { ...lane, identity, commands: [], status: 'failed' };
      receipt.lanes.push(observed);
      let owned = false;
      async function command(command, args, timeout = 60_000) {
        try {
          const result = await execute(command, args, { cwd: root, timeout, maxBuffer: 16 * 1024 * 1024 });
          observed.commands.push({ command, args, exitCode: 0, ...result });
          return result.stdout.trim();
        } catch (error) {
          observed.commands.push({ command, args, exitCode: error.code ?? 1, stdout: error.stdout ?? '', stderr: `${error.message}\n${error.stderr ?? ''}` });
          throw error;
        }
      }
      const env = (args, timeout) => command('npx', ['--no-install', 'wp-env', `--config=${config}`, ...args], timeout);
      const wp = (args) => env(['run', 'cli', 'wp', ...args]);
      try {
        await command('docker', ['info', '--format', '{{.ServerVersion}}']);
        const status = JSON.parse(await env(['status', '--json']));
        assert.ok(['uninitialized', 'stopped'].includes(status.status), 'Compatibility environment is already running; refusing to claim ownership.');
        owned = true;
        await env(['start'], 360_000);
        await wp(['plugin', 'install', '/var/www/html/wp-content/compat-stage/fixture.zip', '--activate']);
        if (lane.gutenberg) await wp(['plugin', 'install', 'gutenberg', `--version=${lane.gutenberg}`, '--activate']);
        observed.runtime = JSON.parse(await wp(['eval', `echo wp_json_encode(array('wordpress'=>get_bloginfo('version'),'php'=>PHP_VERSION,'theme'=>array('name'=>wp_get_theme()->get('Name'),'version'=>wp_get_theme()->get('Version')),'gutenberg'=>defined('GUTENBERG_VERSION')?GUTENBERG_VERSION:null));`]));
        assert.equal(observed.runtime.wordpress, lane.core);
        assert.equal(observed.runtime.gutenberg, lane.gutenberg ?? null);
        assert.match(observed.runtime.php, /^8\.3\./);
        const baseUrl = `http://localhost:${lane.port}`;
        const fixture = JSON.parse(JSON.stringify(built.fixture).replaceAll('http://localhost:8888', baseUrl));
        // The compatibility matrix reuses field/persistence/pattern checks, not layout or accessibility acceptance.
        delete fixture.browserMatrix;
        const pattern = fixture.patternOverrides;
        const media = JSON.parse(await wp(['eval', `require_once ABSPATH.'wp-admin/includes/image.php'; $result=[]; for($i=0;$i<2;$i++){ $upload=wp_upload_bits('compat-'.$i.'.png',null,base64_decode('${imageBase64}')); if($upload['error']) throw new RuntimeException($upload['error']); $id=wp_insert_attachment(['post_mime_type'=>'image/png','post_title'=>'Compatibility image '.$i,'post_status'=>'inherit'],$upload['file']); wp_update_attachment_metadata($id,wp_generate_attachment_metadata($id,$upload['file'])); $result[]=['id'=>$id,'url'=>wp_get_attachment_url($id)]; } echo wp_json_encode($result);`]));
        pattern.instances.forEach((instance, i) => Object.values(instance.content).forEach((attrs) => {
          if ('id' in attrs && 'url' in attrs) Object.assign(attrs, media[i]);
        }));
        fixture.frontend.expectedMedia = media.map((item) => item.url);
        const savePattern = async (title, content) => JSON.parse(await wp(['eval', `$id=wp_insert_post(['post_type'=>'wp_block','post_status'=>'publish','post_title'=>base64_decode('${Buffer.from(title).toString('base64')}'),'post_content'=>base64_decode('${Buffer.from(content).toString('base64')}')],true); if(is_wp_error($id)) throw new RuntimeException($id->get_error_message()); update_post_meta($id,'wp_pattern_sync_status','sync'); echo wp_json_encode(['ref'=>$id,'canonicalContent'=>get_post_field('post_content',$id)]);`]));
        const positive = await savePattern(pattern.title, pattern.canonicalContent);
        pattern.ref = positive.ref;
        pattern.storedCanonicalContent = positive.canonicalContent;
        const negativeMarkup = pattern.canonicalContent.replace(/<!-- wp:([^\s]+)\s+({[\s\S]*?})\s*-->/g, (comment, name, raw) => {
          const attrs = JSON.parse(raw);
          if (attrs.metadata?.name !== pattern.negative.name || !attrs.metadata.bindings) return comment;
          delete attrs.metadata.bindings.__default;
          delete attrs.metadata.bindings[pattern.negative.attribute];
          return `<!-- wp:${name} ${JSON.stringify(attrs)} -->`;
        });
        const title = `${pattern.title} missing binding`;
        Object.assign(pattern.negative, await savePattern(title, negativeMarkup), { title });
        const browserConfig = path.join(directory, 'browser.json');
        const browserOutput = path.join(directory, 'browser-result.json');
        await writeFile(browserConfig, JSON.stringify({ fixture, baseUrl, requiredGates: gates }));
        await command(process.execPath, [path.join(root, 'scripts/proof-playwright.mjs'), '--config', browserConfig, '--out', browserOutput], 360_000);
        const browser = JSON.parse(await readFile(browserOutput, 'utf8'));
        observed.runtime.browser = browser.environment.browser;
        observed.gates = Object.fromEntries(gates.map((gate) => [gate, browser.gates[gate]?.status]));
        for (const gate of gates) assert.equal(browser.gates[gate]?.status, 'pass', `${lane.name}: ${gate}: ${browser.gates[gate]?.reason}`);
        const states = browser.gates.editor_reopen.details;
        observed.children = {};
        for (const phase of ['preEdit', 'saved', 'reopened']) {
          const roots = states[phase].tree.filter((block) => block.name === fixture.blockName);
          assert.equal(roots.length, 1);
          assert.deepEqual(shape(roots[0].innerBlocks), shape(expectedTree), `${phase} must contain exactly the compiled tree`);
          observed.children[phase] = { count: count(roots[0].innerBlocks), shape: shape(roots[0].innerBlocks) };
        }
        const runtime = browser.gates.frontend_runtime_errors.details.runtime;
        observed.console = runtime;
        assert.deepEqual(runtime.pageErrors, []);
        assert.deepEqual(runtime.consoleErrors, []);
        observed.templateDeprecations = runtime.consoleWarnings.filter((warning) => warning.includes('The template prop of InnerBlocks and useInnerBlocksProps'));
        if (lane.gutenberg) assert.ok(observed.templateDeprecations.length, 'Expected template deprecation was not observed.');
        assert.equal(hash(await readFile(built.pluginZip)), identity.zip);
        observed.status = 'passed';
      } catch (error) {
        observed.error = error.stack ?? String(error);
        // Continue independent lanes while retaining the failed lane.
      } finally {
        if (owned) await env(['stop']).catch((error) => { observed.status = 'failed'; observed.cleanupError = String(error); });
        await writeFile(path.join(directory, 'receipt.json'), `${JSON.stringify(observed, null, 2)}\n`);
        process.stderr.write(`${lane.name}: ${observed.status} (${directory})\n`);
      }
    }
    receipt.status = receipt.lanes.every((lane) => lane.status === 'passed') ? 'passed' : 'failed';
  } finally {
    await writeFile(path.join(outputDir, 'compatibility.json'), `${JSON.stringify(receipt, null, 2)}\n`);
  }
  return receipt;
}
