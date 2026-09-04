import { execFile as execFileCallback } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { runProof, type ProofFixture, type ProofGateId, type ProofRunResult } from '../src/index.js';

const execFile = promisify(execFileCallback);
const enabled = process.env.BLOCK_RUNNER_PROOF_MUTATIONS === '1';

/**
 * These intentionally use the production proof runner with wp-env and the
 * Playwright helper. They do not use `gateRunner`: each ZIP is a valid plugin
 * baseline with exactly one changed behavior. Enable deliberately in a
 * Docker-capable job because each case boots a real WordPress 7.1/MySQL runtime.
 */
(enabled ? describe.sequential : describe.skip)('real WordPress proof mutations', () => {
  const cases: Array<{
    mutation: Mutation;
    profile: 'runtime' | 'editor' | 'full';
    gate: ProofGateId;
    prerequisiteGates: readonly ProofGateId[];
  }> = [
    {
      mutation: 'registration',
      profile: 'runtime',
      gate: 'php_registry',
      prerequisiteGates: ['headless_validation', 'zip_installation', 'plugin_activation', 'environment_observation'],
    },
    {
      mutation: 'save',
      profile: 'editor',
      gate: 'editor_save',
      prerequisiteGates: [
        'headless_validation', 'zip_installation', 'plugin_activation', 'php_registry', 'rest_block_type',
        'client_registry', 'environment_observation', 'editor_inserter', 'editor_field_editing',
      ],
    },
    {
      mutation: 'stylesheet',
      profile: 'full',
      gate: 'frontend_assets',
      prerequisiteGates: [
        'headless_validation', 'zip_installation', 'plugin_activation', 'php_registry', 'rest_block_type',
        'client_registry', 'environment_observation', 'editor_inserter', 'editor_field_editing', 'editor_save',
        'editor_reopen', 'frontend_status', 'frontend_semantics', 'frontend_links', 'frontend_runtime_errors',
      ],
    },
    {
      mutation: 'pattern',
      profile: 'full',
      gate: 'pattern_overrides',
      prerequisiteGates: [
        'headless_validation', 'zip_installation', 'plugin_activation', 'php_registry', 'rest_block_type',
        'client_registry', 'environment_observation', 'editor_inserter', 'editor_field_editing', 'editor_save',
        'editor_reopen', 'frontend_status', 'frontend_semantics', 'frontend_links', 'frontend_assets',
        'frontend_runtime_errors', 'php_logs', 'static_deactivation_html', 'static_deactivation_registration',
        'static_deactivation_assets', 'static_deactivation_editor_controls',
      ],
    },
  ];

  for (const testCase of cases) {
    it(`isolates ${testCase.gate} for a deliberately broken ${testCase.mutation} artifact`, async () => {
      const root = await mkdtemp(path.join(tmpdir(), `block-runner-${testCase.mutation}-mutation-`));
      try {
        const baseline = await runMutationProof(root, testCase, 'baseline');
        expectPassingGates(baseline, [...testCase.prerequisiteGates, testCase.gate]);

        const mutated = await runMutationProof(root, testCase, testCase.mutation);
        expectGate(mutated, testCase.gate).toBe('fail');
        // These gates are independent prerequisites of the target assertion;
        // a failure here must not be allowed to satisfy the mutation test.
        expectPassingGates(mutated, testCase.prerequisiteGates);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }, 480_000);
  }
});

type Mutation = 'registration' | 'save' | 'stylesheet' | 'pattern';
type Variant = 'baseline' | Mutation;

async function runMutationProof(
  root: string,
  testCase: { mutation: Mutation; profile: 'runtime' | 'editor' | 'full' },
  variant: Variant,
): Promise<ProofRunResult> {
  const pluginZip = await createMutationPlugin(root, testCase.mutation, variant);
  const inputPath = path.join(root, `${testCase.mutation}-${variant}-input.html`);
  await writeFile(inputPath, '<section><p>Proof input</p></section>');

  return runProof({
    profile: testCase.profile,
    pluginZip,
    inputPath,
    markup: '<!-- wp:paragraph --><p>Proof input</p><!-- /wp:paragraph -->',
    fixture: mutationFixture(testCase.mutation, variant),
    outputDir: path.join(root, `${variant}-receipt`),
  });
}

function mutationFixture(mutation: Mutation, variant: Variant): ProofFixture {
  const slug = mutationSlug(mutation, variant);
  const label = `Proof mutation ${mutation} ${variant}`;
  const savedLink = `https://example.com/saved-${slug}`;
  const patternLink = `https://example.com/pattern-${slug}`;
  return {
    blockName: `block-runner-proof/${slug}`,
    pluginSlug: slug,
    blockTitle: label,
    // The initial block leaves its media control empty while the inserted
    // pattern exercises every supported surface. It is a competing control
    // for the old media/alt selector's unscoped placeholder branch.
    editableFields: editableFields(`Saved ${mutation} ${variant} value`, savedLink, `Saved ${slug} alt`)
      .filter((field) => field.surface !== 'media'),
    patternOverrides: {
      title: `${label} pattern`,
      editableFields: editableFields(`Pattern ${mutation} ${variant} value`, patternLink, `Pattern ${slug} alt`, `https://example.com/pattern-${slug}.png`),
    },
    frontend: {
      // The runner always navigates to the post it creates; this is the
      // explicit, reviewed scope required by the frontend proof gates.
      url: 'http://localhost:8888/',
      subtreeSelector: 'main',
      expectedLinks: [savedLink, patternLink],
    },
  };
}

function editableFields(content: string, link: string, alt: string, media?: string) {
  return [
    { path: 'content', surface: 'richText' as const, value: content },
    { path: 'url', surface: 'link' as const, value: link },
    { path: 'alt', surface: 'altText' as const, value: alt },
    ...(media ? [{ path: 'mediaUrl', surface: 'media' as const, value: media }] : []),
  ] as const;
}

async function createMutationPlugin(root: string, mutation: Mutation, variant: Variant): Promise<string> {
  const slug = mutationSlug(mutation, variant);
  const plugin = path.join(root, slug);
  await mkdir(plugin, { recursive: true });
  const blockName = `block-runner-proof/${slug}`;
  const title = `Proof mutation ${mutation} ${variant}`;
  const patternTitle = `${title} pattern`;
  const style = variant === 'stylesheet' ? '' : ',"style":"file:./style.css"';
  const registration = variant === 'registration'
    ? ''
    : `add_action( 'init', function() { register_block_type( __DIR__ ); } );`;
  const pattern = `add_action( 'init', function() {
      register_block_pattern( 'block-runner-proof/${slug}-pattern', array(
        'title' => '${escapePhp(patternTitle)}',
        'content' => '<!-- wp:${blockName} --><div class="proof-mutation" data-proof-alt="Pattern original alt" data-proof-media-url="https://example.com/pattern-original.png"><p class="proof-mutation__content">Pattern original value</p><a class="proof-mutation__link" href="https://example.com/pattern-original">Proof link</a></div><!-- /wp:${blockName} -->',
      ) );
    } );`;
  const savedContent = variant === 'save' ? JSON.stringify('Broken save output') : 'props.attributes.content';
  const contentChange = variant === 'pattern'
    ? `if ( props.attributes.content === 'Pattern original value' ) return;\n          props.setAttributes( { content: content } );`
    : 'props.setAttributes( { content: content } );';

  await Promise.all([
    writeFile(path.join(plugin, `${slug}.php`), `<?php
/**
 * Plugin Name: ${title}
 * Version: 1.0.0
 */
${registration}
${pattern}
`),
    writeFile(path.join(plugin, 'block.json'), `{
  "apiVersion": 3,
  "name": "${blockName}",
  "title": "${title}",
  "category": "widgets",
  "editorScript": "file:./index.js"${style},
  "attributes": {
    "content": { "type": "string", "source": "html", "selector": ".proof-mutation__content" },
    "url": { "type": "string", "source": "attribute", "selector": ".proof-mutation__link", "attribute": "href" },
    "alt": { "type": "string", "source": "attribute", "selector": ".proof-mutation", "attribute": "data-proof-alt" },
    "mediaUrl": { "type": "string", "source": "attribute", "selector": ".proof-mutation", "attribute": "data-proof-media-url" }
  }
}`),
    writeFile(path.join(plugin, 'index.js'), `( function( blocks, blockEditor, element ) {
  var RichText = blockEditor.RichText;
  var createElement = element.createElement;
  blocks.registerBlockType( ${JSON.stringify(blockName)}, {
    title: ${JSON.stringify(title)},
    edit: function( props ) {
      return createElement( 'div', { className: 'proof-mutation' },
        createElement( RichText, {
          tagName: 'p',
          className: 'proof-mutation__content',
          value: props.attributes.content,
          onChange: function( content ) {
            ${contentChange}
          },
          placeholder: 'Proof content'
        } ),
        createElement( 'input', {
          type: 'url',
          'aria-label': 'Proof link URL',
          disabled: !props.isSelected,
          value: props.attributes.url || '',
          onChange: function( event ) { props.setAttributes( { url: event.target.value } ); }
        } ),
        createElement( 'input', {
          type: 'text',
          'aria-label': 'Proof alt text',
          disabled: !props.isSelected,
          value: props.attributes.alt || '',
          onChange: function( event ) { props.setAttributes( { alt: event.target.value } ); }
        } ),
        createElement( 'input', {
          type: 'url',
          'aria-label': 'Proof media URL',
          disabled: !props.isSelected,
          value: props.attributes.mediaUrl || '',
          onChange: function( event ) { props.setAttributes( { mediaUrl: event.target.value } ); }
        } ),
        props.attributes.url ? createElement( 'a', { href: props.attributes.url }, 'Proof link' ) : null,
        props.attributes.mediaUrl
          ? createElement( 'img', { src: props.attributes.mediaUrl, alt: props.attributes.alt || '' } )
          : createElement( 'div', { className: 'components-placeholder' } )
      );
    },
    save: function( props ) {
      return createElement( 'div', {
        className: 'proof-mutation',
        'data-proof-alt': props.attributes.alt,
        'data-proof-media-url': props.attributes.mediaUrl
      },
      createElement( RichText.Content, { tagName: 'p', className: 'proof-mutation__content', value: ${savedContent} } ),
      props.attributes.url ? createElement( 'a', { className: 'proof-mutation__link', href: props.attributes.url }, 'Proof link' ) : null
      );
    }
  } );
} )( window.wp.blocks, window.wp.blockEditor, window.wp.element );
`),
    writeFile(path.join(plugin, 'index.asset.php'), "<?php return array( 'dependencies' => array( 'wp-blocks', 'wp-block-editor', 'wp-element' ), 'version' => '1.0.0' );\n"),
    writeFile(path.join(plugin, 'style.css'), '.proof-mutation { color: rgb(12, 34, 56); }\n'),
  ]);

  const zip = path.join(root, `${slug}.zip`);
  await execFile('zip', ['-qr', zip, slug], { cwd: root });
  return zip;
}

function mutationSlug(mutation: Mutation, variant: Variant): string {
  return `proof-mutation-${mutation}-${variant}`;
}

function expectGate(result: ProofRunResult, gate: ProofGateId) {
  const record = result.receipt.gates.find((candidate) => candidate.gate === gate);
  expect(record, `Missing ${gate} receipt record`).toBeDefined();
  return expect(record?.status);
}

function expectPassingGates(result: ProofRunResult, gates: readonly ProofGateId[]): void {
  for (const gate of gates) expectGate(result, gate).toBe('pass');
}

function escapePhp(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}
