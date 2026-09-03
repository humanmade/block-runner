/**
 * Build the repository's WordPress 7.1 synced-pattern fixture from the
 * compiler output. The proof must never depend on an opaque plugin archive or
 * a Core-only pattern which happens to have similar bindings.
 */
import { execFile } from 'node:child_process';
import { mkdir, readFile, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { compileAuthoringPlan } from '../src/authoring/compile.js';
import { validatePatternOverrideContract } from '../src/authoring/pattern-overrides.js';
import { getWp } from '../src/headless/wp.js';
import type { AuthoringPlan, AuthoringTemplate, WpBlock } from '../src/types.js';
import type { ProofFixture, ProofPatternRequiredBinding } from '../src/proof/runner.js';

const execFileAsync = promisify(execFile);
const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDirectory, '..');
const planPath = path.join(projectRoot, 'test', 'fixtures', 'authoring', 'pattern-overrides.plan.json');
const visualGoldenPath = path.join(projectRoot, 'proof', 'wordpress-7.1-pattern-overrides.expected.png');
const pluginSlug = 'block-runner-pattern-overrides-fixture';
const fixedTimestamp = new Date('2026-09-03T00:00:00.000Z');

export interface BuiltPatternOverridesFixture {
  inputPath: string;
  pluginDirectory: string;
  pluginZip: string;
  /** Complete custom-block markup used as each synced pattern's wp_block content. */
  generatedBlockMarkup: string;
  /** Native Core subtree used by the inexpensive headless validation gate. */
  nativeContainerMarkup: string;
  fixture: ProofFixture;
}

/**
 * The plugin, native serialization, canonical wp_block values, and runtime
 * visual-baseline location all derive from the checked-in authoring plan.
 */
export async function buildPatternOverridesFixture(outputDir: string): Promise<BuiltPatternOverridesFixture> {
  const root = path.resolve(outputDir);
  const inputPath = path.join(root, 'pattern-overrides.plan.json');
  const pluginDirectory = path.join(root, pluginSlug);
  const pluginZip = path.join(root, `${pluginSlug}.zip`);
  const plan = JSON.parse(await readFile(planPath, 'utf8')) as AuthoringPlan;
  const compiled = compileAuthoringPlan(plan);
  const contract = validatePatternOverrideContract(compiled.template, compiled.editableFields);
  const errors = [
    ...compiled.diagnostics.filter((diagnostic) => diagnostic.level === 'error').map((diagnostic) => diagnostic.message),
    ...contract.errors,
  ];
  if (errors.length > 0) throw new Error(`The generated pattern fixture plan is invalid: ${errors.join('; ')}`);

  const nativeContainerMarkup = await serializeNativeTemplate(compiled.template);
  assertBackgroundClass(nativeContainerMarkup, 'initial');
  const generatedBlockMarkup = wrapGeneratedBlock(plan.name, nativeContainerMarkup);

  const updatedPlan = canonicalUpdatePlan(plan);
  const updated = compileAuthoringPlan(updatedPlan);
  const updatedContract = validatePatternOverrideContract(updated.template, updated.editableFields);
  const updatedErrors = [
    ...updated.diagnostics.filter((diagnostic) => diagnostic.level === 'error').map((diagnostic) => diagnostic.message),
    ...updatedContract.errors,
  ];
  if (updatedErrors.length > 0) throw new Error(`The updated generated pattern fixture plan is invalid: ${updatedErrors.join('; ')}`);
  const updatedNativeMarkup = await serializeNativeTemplate(updated.template);
  assertBackgroundClass(updatedNativeMarkup, 'updated');
  const updatedBlockMarkup = wrapGeneratedBlock(plan.name, updatedNativeMarkup);

  await mkdir(pluginDirectory, { recursive: true });
  await writeFixed(inputPath, `${JSON.stringify(plan, null, 2)}\n`);
  await writePlugin(pluginDirectory, compiled);
  await archivePlugin(root, pluginZip);

  const fixture = proofFixture({
    plan,
    compiled,
    canonicalContent: generatedBlockMarkup,
    canonicalUpdateContent: updatedBlockMarkup,
    requiredBindings: contract.bindings.map(({ name, attribute }) => ({ name, attribute })),
    visualGoldenPath,
  });
  await Promise.all([
    writeFixed(path.join(root, 'proof-pattern-overrides.fixture.json'), `${JSON.stringify(fixture, null, 2)}\n`),
    writeFixed(path.join(root, 'native-container.blocks.html'), `${nativeContainerMarkup}\n`),
    writeFixed(path.join(root, 'generated-pattern.blocks.html'), `${generatedBlockMarkup}\n`),
  ]);

  return { inputPath, pluginDirectory, pluginZip, generatedBlockMarkup, nativeContainerMarkup, fixture };
}

async function serializeNativeTemplate(template: AuthoringTemplate): Promise<string> {
  const wp = await getWp();
  return wp.serialize(template.map((node) => blockFromTemplate(wp.createBlock, node)));
}

function blockFromTemplate(
  createBlock: (name: string, attributes?: Record<string, unknown>, innerBlocks?: WpBlock[]) => WpBlock,
  [name, attributes, children]: AuthoringTemplate[number],
): WpBlock {
  return createBlock(name, attributes, children?.map((child) => blockFromTemplate(createBlock, child)) ?? []);
}

function assertBackgroundClass(markup: string, version: string): void {
  if (!/\bhas-background\b/.test(markup)) {
    throw new Error(`The ${version} native group serialization lost Gutenberg's required has-background class.`);
  }
}

function wrapGeneratedBlock(blockName: string, nativeMarkup: string): string {
  const wrapperClass = `wp-block-${blockName.replace('/', '-')}`;
  return `<!-- wp:${blockName} -->\n<div class="${wrapperClass}">\n${nativeMarkup}\n</div>\n<!-- /wp:${blockName} -->`;
}

function proofFixture({
  plan,
  compiled,
  canonicalContent,
  canonicalUpdateContent,
  requiredBindings,
  visualGoldenPath,
}: {
  plan: AuthoringPlan;
  compiled: ReturnType<typeof compileAuthoringPlan>;
  canonicalContent: string;
  canonicalUpdateContent: string;
  requiredBindings: ProofPatternRequiredBinding[];
  visualGoldenPath: string;
}): ProofFixture {
  const nameFor = (pathName: string, attribute: string): string => {
    const field = compiled.editableFields.find((candidate) => candidate.path === pathName && candidate.attribute === attribute);
    if (!field?.overrideName) throw new Error(`Generated fixture is missing ${pathName}.${attribute}.`);
    return field.overrideName;
  };
  const title = nameFor('hero.title', 'content');
  const image = nameFor('hero.image', 'url');
  const cta = nameFor('hero.cta', 'url');
  const firstImage = { id: 101, url: 'https://example.test/first.jpg', alt: 'First instance image' };
  const secondImage = { id: 202, url: 'https://example.test/second.jpg', alt: 'Second instance image' };

  return {
    blockName: plan.name,
    pluginSlug,
    blockTitle: plan.title,
    // This separate insertion proves the generated wrapper itself exposes a
    // native editor surface before its exact markup becomes a synced pattern.
    editableFields: [{ path: 'hero.title', surface: 'richText', value: 'Proof editor field' }],
    patternOverrides: {
      title: 'Block Runner generated pattern overrides lifecycle',
      canonicalContent,
      instances: [
        {
          label: 'first',
          content: {
            [title]: { content: 'First instance title' },
            [image]: firstImage,
            [cta]: { text: 'First instance action', url: 'https://example.test/first' },
          },
        },
        {
          label: 'second',
          content: {
            [title]: { content: 'Second instance title' },
            [image]: secondImage,
            [cta]: { text: 'Second instance action', url: 'https://example.test/second' },
          },
        },
      ],
      canonicalUpdate: {
        marker: 'Canonical layout version two.',
        content: canonicalUpdateContent,
      },
      reset: {
        instance: 0,
        name: title,
        attribute: 'content',
        fallback: 'Canonical fallback after reset',
      },
      requiredBindings,
      structuralPolicy: 'contentOnly',
      negative: {
        name: title,
        attribute: 'content',
        value: 'This missing binding must not persist',
        fallback: 'Canonical heading',
      },
    },
    frontend: {
      url: 'http://localhost:8888/',
      subtreeSelector: 'body',
      expectedLinks: ['https://example.test/first', 'https://example.test/second'],
      expectedMedia: [firstImage.url, secondImage.url],
    },
    visual: {
      expectedPath: visualGoldenPath,
      threshold: 0,
    },
    accessibility: {
      editorSelector: '.editor-styles-wrapper',
      frontendSelector: 'body',
      manualReview: 'pass',
    },
  };
}

function canonicalUpdatePlan(plan: AuthoringPlan): AuthoringPlan {
  const updated = JSON.parse(JSON.stringify(plan)) as AuthoringPlan;
  const layout = updated.root.children?.[0];
  if (!layout) throw new Error('The generated fixture has no native layout container.');
  layout.attributes = { ...layout.attributes, className: 'block-runner-pattern-layout block-runner-layout-v2' };
  const title = layout.children?.find((child) => child.path === 'hero.title');
  const note = layout.children?.find((child) => child.path === 'hero.layout-note');
  if (!title || !note) throw new Error('The generated fixture is missing its title or layout marker.');
  title.content = 'Canonical fallback after reset';
  note.content = 'Canonical layout version two.';
  return updated;
}

async function writePlugin(pluginDirectory: string, compiled: ReturnType<typeof compileAuthoringPlan>): Promise<void> {
  const buildDirectory = path.join(pluginDirectory, 'build');
  const sourceDirectory = path.join(pluginDirectory, 'generated-source');
  await Promise.all([mkdir(buildDirectory, { recursive: true }), mkdir(sourceDirectory, { recursive: true })]);
  const blockMetadata = compiled.files['block.json']!;
  const browserSource = browserRegistrationSource(blockMetadata, compiled.files['template.js']!);
  const files: Record<string, string> = {
    'block-runner-pattern-overrides-fixture.php': `<?php\n/**\n * Plugin Name: Block Runner Pattern Overrides Fixture\n * Version: 1.0.0\n * Requires at least: 7.1\n */\nadd_action( 'init', static function () { register_block_type( __DIR__ . '/build' ); } );\n`,
    'build/block.json': blockMetadata,
    'build/index.js': browserSource,
    'build/index.asset.php': "<?php return array( 'dependencies' => array( 'wp-blocks', 'wp-block-editor', 'wp-element' ), 'version' => '1.0.0' );\n",
    'build/style-index.css': fixtureStyle(),
    ...Object.fromEntries(Object.entries(compiled.files).map(([name, contents]) => [`generated-source/${name}`, contents] as const)),
  };
  await Promise.all(Object.entries(files).map(async ([file, contents]) => writeFixed(path.join(pluginDirectory, file), contents)));
}

function browserRegistrationSource(blockMetadata: string, templateSource: string): string {
  return [
    '/* Deterministically bundled from Block Runner compiler output. */',
    templateSource.replace(/^export const /gm, 'const '),
    '( function ( wp ) {',
    '  const { registerBlockType } = wp.blocks;',
    '  const { useBlockProps, useInnerBlocksProps } = wp.blockEditor;',
    '  const { createElement } = wp.element;',
    `  const metadata = ${blockMetadata};`,
    '  registerBlockType( metadata.name, {',
    '    edit() {',
    '      const blockProps = useBlockProps();',
    '      const innerBlocksProps = useInnerBlocksProps( blockProps, { allowedBlocks: ALLOWED_BLOCKS, template: TEMPLATE, templateLock: TEMPLATE_LOCK } );',
    "      return createElement( 'div', innerBlocksProps );",
    '    },',
    '    save() {',
    '      const blockProps = useBlockProps.save();',
    '      const innerBlocksProps = useInnerBlocksProps.save( blockProps );',
    "      return createElement( 'div', innerBlocksProps );",
    '    },',
    '  } );',
    '} )( window.wp );',
    '',
  ].join('\n');
}

function fixtureStyle(): string {
  return `.wp-block-block-runner-pattern-overrides-fixture { border: 2px solid #174ea6; border-radius: 8px; }
.wp-block-block-runner-pattern-overrides-fixture .block-runner-pattern-layout { padding: 1.5rem; }
.wp-block-block-runner-pattern-overrides-fixture .block-runner-layout-v2 { border-top: 4px solid #174ea6; }
`;
}

async function archivePlugin(root: string, pluginZip: string): Promise<void> {
  const files = [
    `${pluginSlug}/block-runner-pattern-overrides-fixture.php`,
    `${pluginSlug}/build/block.json`,
    `${pluginSlug}/build/index.asset.php`,
    `${pluginSlug}/build/index.js`,
    `${pluginSlug}/build/style-index.css`,
    `${pluginSlug}/generated-source/README.md`,
    `${pluginSlug}/generated-source/authoring.manifest.json`,
    `${pluginSlug}/generated-source/block.json`,
    `${pluginSlug}/generated-source/edit.js`,
    `${pluginSlug}/generated-source/index.js`,
    `${pluginSlug}/generated-source/save.js`,
    `${pluginSlug}/generated-source/style.scss`,
    `${pluginSlug}/generated-source/template.js`,
  ];
  await execFileAsync('zip', ['-X', '-q', pluginZip, ...files], { cwd: root, timeout: 30_000 });
  await utimes(pluginZip, fixedTimestamp, fixedTimestamp);
}

async function writeFixed(destination: string, contents: string): Promise<void> {
  await mkdir(path.dirname(destination), { recursive: true });
  await writeFile(destination, contents, 'utf8');
  await utimes(destination, fixedTimestamp, fixedTimestamp);
}

async function main(): Promise<void> {
  const output = process.argv[2] ?? path.join(tmpdir(), `block-runner-pattern-overrides-${process.pid}`);
  const built = await buildPatternOverridesFixture(output);
  process.stdout.write(`${JSON.stringify({
    inputPath: built.inputPath,
    pluginZip: built.pluginZip,
    generatedBlockMarkup: path.join(output, 'generated-pattern.blocks.html'),
    nativeContainerMarkup: path.join(output, 'native-container.blocks.html'),
    fixture: path.join(output, 'proof-pattern-overrides.fixture.json'),
  }, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await main();
}
