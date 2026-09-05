/**
 * Build the repository's WordPress 7.1 synced-pattern fixture from the
 * compiler output. The proof must never depend on an opaque plugin archive or
 * a Core-only pattern which happens to have similar bindings.
 */
import { execFile } from 'node:child_process';
import { chmod, lstat, mkdir, readFile, readdir, utimes, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { compileRegisteredBlock, registeredBlockFontFamilyPrefix } from '../src/authoring/generate.js';
import { patternOverrideName } from '../src/authoring/overrides.js';
import {
  npmEnvironmentForGeneratedPlugin,
  planStandalonePluginOutput,
  writePluginOutput,
} from '../src/plugin/profile.js';
import type { AuthoringPlan } from '../src/authoring/schema.js';
import { validatePatternOverrideContract } from '../src/authoring/pattern-overrides.js';
import { getWp } from '../src/headless/wp.js';
import type { AuthoringTemplate, WpBlock } from '../src/types.js';
import type { ProofArtifactContract, ProofFixture, ProofPatternRequiredBinding } from '../src/proof/runner.js';
import { PROOF_IMAGE_BASE64, PROOF_SVG_SOURCE } from '../src/proof/fixture-image.js';

const execFileAsync = promisify(execFile);
const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDirectory, '..');
const planPath = path.join(projectRoot, 'test', 'fixtures', 'authoring', 'pattern-overrides.plan.json');
const visualGoldenPath = fixtureVisualGoldenPath();
const pluginSlug = 'block-runner-pattern-overrides-fixture';
const fixedTimestamp = new Date('2026-09-03T00:00:00.000Z');
const fixedZipMode = 0o644;

/** Font rasterization differs by host OS; never compare Linux against the macOS review. */
export function fixtureVisualGoldenPath(platform: string = process.platform): string {
  const suffix = platform === 'darwin' ? '' : `.${platform}`;
  // An unreviewed platform resolves to a missing golden and is blocked by the proof gate.
  return path.join(projectRoot, 'proof', `wordpress-7.1-pattern-overrides${suffix}.expected.png`);
}

const RETAINED_FIXTURE_ASSET_SOURCES = new Map([
  ['canonical-image', 'source/canonical.png'],
  ['static-logo', 'source/logo.svg'],
  ['proof-font', 'source/proof-font.woff2'],
]);

export type RootLayoutReproduction = 'grid' | 'flex';

export interface PatternOverridesFixtureOptions {
  /**
   * Both values set the layout on the generated wrapper root. With rootOwned, the
   * fixture also flattens its semantic group so native siblings exercise that layout.
   */
  rootLayout?: RootLayoutReproduction;
  /** Flatten the fixture into direct native root children for the layout regression matrix. */
  rootOwned?: boolean;
}

/**
 * Keep the checked-in proof input independent of the temporary directory used to build it.
 * The fixture owns these two asset IDs, so their retained paths are explicit rather than inferred
 * from a host-specific absolute source path. The compiler resolves them against its proof root.
 */
export function portableFixturePlan(plan: AuthoringPlan): AuthoringPlan {
  return {
    ...plan,
    assets: plan.assets.map((asset) => ({
      ...asset,
      source: RETAINED_FIXTURE_ASSET_SOURCES.get(asset.id) ?? asset.source,
    })),
  };
}

export interface BuiltPatternOverridesFixture {
  inputPath: string;
  pluginDirectory: string;
  pluginZip: string;
  /** Complete custom-block markup used as each synced pattern's wp_block content. */
  generatedBlockMarkup: string;
  /** Native Core subtree used by the inexpensive headless validation gate. */
  nativeContainerMarkup: string;
  /** Capability record bound to the exact generated ZIP, never inferred from the fixture. */
  artifact: ProofArtifactContract;
  fixture: ProofFixture;
}

/**
 * The plugin, native serialization, canonical wp_block values, and runtime
 * visual-baseline location all derive from the checked-in authoring plan.
 */
export async function buildPatternOverridesFixture(
  outputDir: string,
  options: PatternOverridesFixtureOptions = {},
): Promise<BuiltPatternOverridesFixture> {
  const root = path.resolve(outputDir);
  const rootLayout = options.rootLayout ?? 'grid';
  const rootOwned = options.rootOwned ?? false;
  const inputPath = path.join(root, 'pattern-overrides.plan.json');
  const pluginDirectory = path.join(root, pluginSlug);
  const pluginZip = path.join(pluginDirectory, `${pluginSlug}.zip`);
  const plan = JSON.parse(await readFile(planPath, 'utf8')) as AuthoringPlan;
  const layoutPlan = rootOwned ? rootOwnedLayoutPlan(plan) : plan;
  const sourceImage = path.join(root, 'source', 'canonical.png');
  const imageBytes = Buffer.from(PROOF_IMAGE_BASE64, 'base64');
  await mkdir(path.dirname(sourceImage), { recursive: true });
  await writeFile(sourceImage, imageBytes);
  const sourceSvg = path.join(root, 'source', 'logo.svg');
  const svgBytes = Buffer.from(PROOF_SVG_SOURCE);
  await writeFile(sourceSvg, svgBytes);
  const sourceFont = path.join(root, 'source', 'proof-font.woff2');
  const fontBytes = await readFile(path.join(projectRoot, 'test', 'fixtures', 'fonts', 'IBMPlexMono-Regular.woff2'));
  await writeFile(sourceFont, fontBytes);
  const fontFamily = `${registeredBlockFontFamilyPrefix(plan.target.name)}proof`;
  const assetPlan: AuthoringPlan['assets'] = [{ id: 'canonical-image', source: 'source/canonical.png', status: 'ready', destination: 'assets/canonical.png',
    sha256: createHash('sha256').update(imageBytes).digest('hex'), uses: [{ node: 'hero.image', attribute: 'url' }] },
  { id: 'static-logo', source: 'source/logo.svg', status: 'ready', destination: 'assets/logo.svg',
    sha256: createHash('sha256').update(svgBytes).digest('hex'), uses: [{ node: 'hero.logo', attribute: 'url' }] },
  { id: 'proof-font', source: 'source/proof-font.woff2', kind: 'font', status: 'ready', destination: 'assets/proof-font.woff2',
    sha256: createHash('sha256').update(fontBytes).digest('hex'), fontLicense: {
      ownership: 'Block Runner test fixture',
      license: 'SIL Open Font License 1.1',
      notice: 'IBM Plex Mono fixture font used only to observe shared font loading.',
    } }];
  // The retained plan stays portable; the compiler receives resolved files for its asset reads.
  const portablePlan = portableFixturePlan({
    ...layoutPlan,
    assets: assetPlan,
    styles: {
      ...layoutPlan.styles,
      outcomes: [
        ...layoutPlan.styles.outcomes,
        { property: 'display', outcome: 'scoped-css', value: rootLayout },
        ...(rootLayout === 'grid'
          ? [{ property: 'grid-template-columns', outcome: 'scoped-css' as const, value: 'minmax(0, 1fr)' }]
          : [{ property: 'flex-direction', outcome: 'scoped-css' as const, value: 'column' }]),
      ],
      fonts: [{ assetId: 'proof-font', family: fontFamily, fontDisplay: 'block' }],
    },
  });
  const compilerPlan: AuthoringPlan = {
    ...portablePlan,
    assets: portablePlan.assets.map((asset) => ({ ...asset, source: path.resolve(root, asset.source) })),
  };
  const compiled = compileRegisteredBlock(compilerPlan);
  const directNativeChildren = compiled.template.map(([name]) => name);
  const contract = validatePatternOverrideContract(compiled.template, []);
  const errors = contract.errors;
  if (errors.length > 0) throw new Error(`The generated pattern fixture plan is invalid: ${errors.join('; ')}`);

  const updatedPlan = canonicalUpdatePlan(compilerPlan);
  const updated = compileRegisteredBlock(updatedPlan);
  const updatedContract = validatePatternOverrideContract(updated.template, []);
  const updatedErrors = updatedContract.errors;
  if (updatedErrors.length > 0) throw new Error(`The updated generated pattern fixture plan is invalid: ${updatedErrors.join('; ')}`);

  await mkdir(pluginDirectory, { recursive: true });
  await writeFixed(inputPath, `${JSON.stringify(portablePlan, null, 2)}\n`);
  const packagePlan = await planStandalonePluginOutput(pluginDirectory, {
    name: compilerPlan.target.name,
    files: Object.fromEntries([...compiled.files, ...compiled.assets].map((file) => [file.path, file.content])),
  });
  await writePluginOutput(packagePlan);
  const npmEnvironment = await npmEnvironmentForGeneratedPlugin(pluginDirectory);
  await execFileAsync('npm', ['ci', '--include=dev', '--ignore-scripts', '--no-audit', '--no-fund'], {
    cwd: pluginDirectory,
    timeout: 180_000,
    env: npmEnvironment,
  });
  await buildDeterministicPluginZip(pluginDirectory, npmEnvironment);
  await execFileAsync('npm', ['run', 'test:zip', '--', pluginZip], {
    cwd: pluginDirectory,
    timeout: 30_000,
    env: { ...npmEnvironment, TZ: 'UTC' },
  });

  // Observe real webpack-emitted files instead of predicting a content hash or inlining a URL.
  const buildRoot = path.join(pluginDirectory, 'build');
  const builtFiles = await readdir(buildRoot, { recursive: true });
  const assetUrls = new Map<string, string>();
  for (const asset of compiled.assets) {
    const matching: string[] = [];
    for (const file of builtFiles.filter((file) => path.extname(file) === path.extname(asset.path))) {
      if ((await readFile(path.join(buildRoot, file))).equals(asset.content)) matching.push(file);
    }
    if (matching.length !== 1) throw new Error(`The generated build must emit the exact confirmed ${asset.path} once.`);
    assetUrls.set(`./${asset.path}`, `http://localhost:8888/wp-content/plugins/${pluginSlug}/build/${matching[0]!.split(path.sep).join('/')}`);
  }
  const runtimeTemplate = (template: AuthoringTemplate): AuthoringTemplate => template.map(([name, attrs, children]) => [
    name, { ...attrs, ...(name === 'core/image' && typeof attrs.url === 'string' && assetUrls.has(attrs.url) ? { url: assetUrls.get(attrs.url)! } : {}) },
    ...(children ? [runtimeTemplate(children)] : []),
  ] as AuthoringTemplate[number]);
  const nativeContainerMarkup = await serializeNativeTemplate(runtimeTemplate(compiled.template));
  if (!rootOwned) assertBackgroundClass(nativeContainerMarkup, 'initial');
  const generatedBlockMarkup = wrapGeneratedBlock(compilerPlan.target.name, nativeContainerMarkup);
  const updatedNativeMarkup = await serializeNativeTemplate(runtimeTemplate(updated.template));
  if (!rootOwned) assertBackgroundClass(updatedNativeMarkup, 'updated');
  const updatedBlockMarkup = wrapGeneratedBlock(compilerPlan.target.name, updatedNativeMarkup);

  const artifact: ProofArtifactContract = {
    sha256: `sha256:${createHash('sha256').update(await readFile(pluginZip)).digest('hex')}`,
    capabilities: { patternOverrides: contract.bindings.length > 0 },
  };
  const fixture = proofFixture({
    plan: compilerPlan,
    canonicalContent: generatedBlockMarkup,
    canonicalUpdateContent: updatedBlockMarkup,
    requiredBindings: contract.bindings.map(({ name, attribute }) => ({ name, attribute })),
    visualGoldenPath,
    rootLayout,
    directNativeChildren,
    fontFamily,
  });
  await Promise.all([
    writeFixed(path.join(root, 'proof-pattern-overrides.fixture.json'), `${JSON.stringify(fixture, null, 2)}\n`),
    writeFixed(path.join(root, 'native-container.blocks.html'), `${nativeContainerMarkup}\n`),
    writeFixed(path.join(root, 'generated-pattern.blocks.html'), `${generatedBlockMarkup}\n`),
  ]);

  return { inputPath, pluginDirectory, pluginZip, generatedBlockMarkup, nativeContainerMarkup, artifact, fixture };
}

/**
 * Build with the real wp-scripts plugin-zip implementation, but leave a deterministic seam
 * between its build and archive phases. Calling the generated `zip` script would rebuild and
 * restore wall-clock mtimes immediately before AdmZip reads them.
 */
export async function buildDeterministicPluginZip(
  pluginDirectory: string,
  npmEnvironment: NodeJS.ProcessEnv,
): Promise<void> {
  const environment = { ...npmEnvironment, NODE_ENV: 'production', TZ: 'UTC' };
  await execFileAsync('npm', ['run', 'build'], {
    cwd: pluginDirectory,
    timeout: 180_000,
    env: environment,
  });
  await normalizePluginZipInputs(pluginDirectory);
  const wpScripts = path.join(pluginDirectory, 'node_modules', '@wordpress', 'scripts', 'bin', 'wp-scripts.js');
  await execFileAsync(process.execPath, [wpScripts, 'plugin-zip'], {
    cwd: pluginDirectory,
    timeout: 180_000,
    env: environment,
  });
}

/** Normalize precisely the regular files selected by the generated package's `files` allowlist. */
export async function normalizePluginZipInputs(pluginDirectory: string): Promise<void> {
  const root = path.resolve(pluginDirectory);
  const buildRoot = path.join(root, 'build');
  const buildEntries = await readdir(buildRoot, { recursive: true });
  const selected = [
    path.join(root, 'package.json'),
    path.join(root, 'plugin.php'),
    path.join(root, 'readme.txt'),
    ...buildEntries.map((entry) => path.join(buildRoot, entry)),
  ];
  for (const file of selected) {
    const stats = await lstat(file);
    if (stats.isDirectory()) {
      // Recursive directory enumeration includes the build tree's structural directories, but a
      // root allowlisted file replaced by a directory is a malformed generated package.
      if (file.startsWith(`${buildRoot}${path.sep}`)) continue;
      throw new Error(`Generated ZIP input is not a regular file: ${file}`);
    }
    if (!stats.isFile() || stats.isSymbolicLink()) {
      // Symlinks and other non-regular entries would make the generated package depend on host
      // filesystem metadata and are refused explicitly.
      throw new Error(`Generated ZIP input is not a regular file: ${file}`);
    }
    await chmod(file, fixedZipMode);
    await utimes(file, fixedTimestamp, fixedTimestamp);
  }
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
  canonicalContent,
  canonicalUpdateContent,
  requiredBindings,
  visualGoldenPath,
  rootLayout,
  directNativeChildren,
  fontFamily,
}: {
  plan: AuthoringPlan;
  canonicalContent: string;
  canonicalUpdateContent: string;
  requiredBindings: ProofPatternRequiredBinding[];
  visualGoldenPath: string;
  rootLayout: RootLayoutReproduction;
  directNativeChildren: readonly string[];
  fontFamily: string;
}): ProofFixture {
  const nameFor = (pathName: string, attribute: string): string => {
    const field = plan.fields.find((candidate) => candidate.node === pathName && candidate.attribute === attribute);
    if (!field?.node) throw new Error(`Generated fixture is missing ${pathName}.${attribute}.`);
    return patternOverrideName(field.node);
  };
  const title = nameFor('hero.title', 'content');
  const image = nameFor('hero.image', 'url');
  const cta = nameFor('hero.cta', 'url');
  const firstImage = { id: 101, url: 'https://example.test/first.jpg', alt: 'First instance image' };
  const secondImage = { id: 202, url: 'https://example.test/second.jpg', alt: 'Second instance image' };

  return {
    blockName: plan.target.name,
    pluginSlug,
    blockTitle: plan.target.title,
    // This separate insertion proves the generated wrapper itself exposes a
    // native editor surface before its exact markup becomes a synced pattern.
    editableFields: [{ path: 'hero.title', metadataName: title, surface: 'richText', value: 'Proof editor field' }],
    browserMatrix: {
      rootLayout,
      directNativeChildren,
      fontFamily,
      longContent: 'A deliberately long native heading proves that the generated root remains the layout owner while the editor canvas wraps at narrow widths without creating an InnerBlocks intermediary.',
      image: { width: '240px', height: '60px' },
      desktopViewport: { width: 1280, height: 900 },
      narrowViewport: { width: 390, height: 844 },
    },
    patternOverrides: {
      title: 'Block Runner generated pattern overrides lifecycle',
      canonicalContent,
      instances: [
        {
          label: 'first',
          content: {
            [title]: { content: 'First instance title' },
            [image]: firstImage,
            [cta]: { text: 'First instance action', url: 'https://example.test/first', linkTarget: '', rel: '' },
          },
        },
        {
          label: 'second',
          content: {
            [title]: { content: 'Second instance title' },
            [image]: secondImage,
            [cta]: { text: 'Second instance action', url: 'https://example.test/second', linkTarget: '', rel: '' },
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
      subtreeSelector: '.wp-block-post-content',
      expectedLinks: ['https://example.test/first', 'https://example.test/second'],
      expectedMedia: [firstImage.url, secondImage.url],
    },
    visual: {
      expectedPath: visualGoldenPath,
      threshold: 0,
      selector: '.wp-block-post-content',
    },
    accessibility: {
      editorSelector: `.wp-block-${plan.target.name.replace('/', '-')}`,
      frontendSelector: '.wp-block-post-content',
      manualReview: 'blocked',
    },
  };
}

function rootOwnedLayoutPlan(plan: AuthoringPlan): AuthoringPlan {
  const layout = plan.structure.find((node) => node.id === 'hero.layout');
  if (!layout?.children?.length) throw new Error('The root-owned fixture requires the checked-in layout container children.');
  return { ...plan, structure: structuredClone(layout.children) };
}

function canonicalUpdatePlan(plan: AuthoringPlan): AuthoringPlan {
  const updated = JSON.parse(JSON.stringify(plan)) as AuthoringPlan;
  const layout = updated.structure.find((node) => node.id === 'hero.layout');
  if (layout) layout.attributes = { ...layout.attributes, className: 'block-runner-pattern-layout block-runner-layout-v2' };
  const children = layout?.children ?? updated.structure;
  const title = children.find((child) => child.id === 'hero.title');
  const note = children.find((child) => child.id === 'hero.layout-note');
  if (!title || !note) throw new Error('The generated fixture is missing its title or layout marker.');
  title.attributes = { ...title.attributes, content: 'Canonical fallback after reset' };
  note.attributes = { ...note.attributes, content: 'Canonical layout version two.' };
  return updated;
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
