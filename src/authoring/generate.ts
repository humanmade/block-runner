import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { parse as parseJavaScript } from '@babel/parser';
import Ajv from 'ajv';
import { JSDOM } from 'jsdom';
import postcss from 'postcss';
import {
  canonicalizeAuthoringPlan,
  hashAuthoringPlan,
  type AuthoringFileOperation,
  type AuthoringPlan,
  type AuthoringStructureNode,
  type AuthoringStyleOutcome,
  type JsonValue,
} from './schema.js';
import WORDPRESS_BLOCK_SCHEMA_7_1 from './vendor/wordpress-block.schema.7.1.json';
import { patternOverrideName, supportedPatternOverrideAttributes } from './overrides.js';
import { authoringRegistryIdentity, validateEditableField, validateNativeComposition, type AuthoringRegistryIdentity } from './capabilities.js';
import { collectConfirmedAssets, fontOwnershipDecision, type GeneratedAssetFile } from './assets.js';
import {
  renderConfirmedStyleRules,
  renderFontLicenseNotice,
  renderFontLicenseText,
  renderLicensedFontFaces,
  type FontLicenseNotice,
  type LicensedFontFace,
} from './styles.js';

/**
 * The owned source-template contract. Changing it changes every generated package and must be an
 * intentional, reviewed release decision.
 */
export const REGISTERED_BLOCK_TEMPLATE_VERSION = '0.9-static-v8' as const;
/**
 * The declarative-style renderer is part of the owned template contract.  It never accepts a
 * stylesheet fragment from the plan: its inputs are validated outcomes and structured rules.
 */
export const REGISTERED_BLOCK_STYLE_EMITTER_VERSION = '3' as const;
export const WORDPRESS_BLOCK_SCHEMA_VERSION = '7.1' as const;
export const WORDPRESS_BLOCK_SCHEMA_URL = `https://schemas.wp.org/wp/${WORDPRESS_BLOCK_SCHEMA_VERSION}/block.json`;

export type GeneratedSourceKind = 'json' | 'javascript' | 'scss' | 'php' | 'text';

export const GENERATED_REGISTERED_BLOCK_PATHS = [
  'block.json',
  'index.js',
  'edit.js',
  'save.js',
  'style.scss',
  'editor.scss',
  'block.php',
] as const;

const ASSET_URL_MODULE = 'asset-urls.mjs' as const;
const FONT_LICENSES_FILE = 'font-licenses.txt' as const;
export type GeneratedSourcePath = typeof GENERATED_REGISTERED_BLOCK_PATHS[number] | typeof ASSET_URL_MODULE | typeof FONT_LICENSES_FILE;

export interface GeneratedSourceFile {
  path: GeneratedSourcePath;
  kind: GeneratedSourceKind;
  content: string;
  hash: string;
  operation: AuthoringFileOperation;
}

export interface GeneratedSourceManifestEntry {
  path: string;
  kind: GeneratedSourceKind | 'asset';
  contentHash: string;
  operation: AuthoringFileOperation;
  templateVersion: typeof REGISTERED_BLOCK_TEMPLATE_VERSION;
  sourcePlanHash: string;
}

export interface GeneratedSourceManifest {
  templateVersion: typeof REGISTERED_BLOCK_TEMPLATE_VERSION;
  sourcePlanHash: string;
  /** Pin used for this headless capability check; it is not evidence for every WordPress site. */
  registry: AuthoringRegistryIdentity;
  files: GeneratedSourceManifestEntry[];
}

export interface GeneratedRegisteredBlock {
  assets: GeneratedAssetFile[];
  /** The exact native template emitted into edit.js, also used by runtime proof. */
  template: TemplateNode[];
  templateVersion: typeof REGISTERED_BLOCK_TEMPLATE_VERSION;
  sourcePlanHash: string;
  files: GeneratedSourceFile[];
  manifest: GeneratedSourceManifest;
}

export class AuthoringGenerationError extends Error {
  readonly reason: string;
  readonly source: { path: string };

  constructor(reason: string, sourcePath: string) {
    super(`${reason} at ${sourcePath}`);
    this.name = 'AuthoringGenerationError';
    this.reason = reason;
    this.source = { path: sourcePath };
  }
}

type TemplateNode = [string, Record<string, JsonValue>, TemplateNode[]?];

const EXECUTABLE_BEHAVIOUR_KEYS = new Set([
  'render', 'rendercallback', 'renderphp', 'view', 'viewscript', 'viewscriptmodule', 'script',
  'javascript', 'php', 'interactivity', 'interactive', 'eventhandler', 'onclick', 'onload', 'action', 'behaviour', 'behavior',
]);

const STYLE_OUTCOMES = new Set<AuthoringStyleOutcome['outcome']>(['native', 'token', 'scoped-css', 'dropped']);

// Every emitted property is deliberately listed here. New declarations require an explicit
// template/emitter review instead of becoming an arbitrary CSS transport.
const SCOPED_STYLE_PROPERTIES = new Set([
  'align-content', 'align-items', 'align-self', 'background-color', 'border', 'border-bottom',
  'border-bottom-color', 'border-bottom-left-radius', 'border-bottom-right-radius', 'border-bottom-style',
  'border-bottom-width', 'border-color', 'border-left', 'border-left-color', 'border-left-style',
  'border-left-width', 'border-radius', 'border-right', 'border-right-color', 'border-right-style',
  'border-right-width', 'border-style', 'border-top', 'border-top-color', 'border-top-left-radius',
  'border-top-right-radius', 'border-top-style', 'border-top-width', 'border-width', 'box-shadow',
  'color', 'column-gap', 'display', 'flex', 'flex-basis', 'flex-direction', 'flex-grow', 'flex-shrink',
  'flex-wrap', 'font-family', 'font-size', 'font-style', 'font-weight', 'gap', 'grid-template-columns',
  'grid-template-rows', 'height', 'justify-content', 'justify-items', 'justify-self', 'letter-spacing',
  'line-height', 'margin', 'margin-bottom', 'margin-left', 'margin-right', 'margin-top', 'max-height',
  'max-width', 'min-height', 'min-width', 'opacity', 'outline', 'outline-color', 'outline-offset',
  'outline-style', 'outline-width', 'overflow', 'overflow-x', 'overflow-y', 'padding', 'padding-bottom',
  'padding-left', 'padding-right', 'padding-top', 'row-gap', 'text-align', 'text-decoration',
  'text-decoration-color', 'text-decoration-line', 'text-decoration-style', 'text-transform', 'width',
]);

const TOKEN_PRESET_KINDS: Record<string, string> = {
  'background-color': 'color',
  'border-bottom-color': 'color',
  'border-color': 'color',
  'border-left-color': 'color',
  'border-right-color': 'color',
  'border-top-color': 'color',
  color: 'color',
  'outline-color': 'color',
  'text-decoration-color': 'color',
  'column-gap': 'spacing',
  gap: 'spacing',
  margin: 'spacing',
  'margin-bottom': 'spacing',
  'margin-left': 'spacing',
  'margin-right': 'spacing',
  'margin-top': 'spacing',
  padding: 'spacing',
  'padding-bottom': 'spacing',
  'padding-left': 'spacing',
  'padding-right': 'spacing',
  'padding-top': 'spacing',
  'row-gap': 'spacing',
  'font-family': 'font-family',
  'font-size': 'font-size',
};

/**
 * Compile a confirmed declarative plan into the static source files a WordPress block build
 * expects. This intentionally does not call convert/finalize: that path handles post content,
 * while this one has a stricter code-generation boundary and its own parsers.
 */
export interface RegisteredBlockOutputPlan {
  files: ReadonlyArray<{ path: string; operation: AuthoringFileOperation }>;
}

/**
 * Derive the exact output map from a reviewed plan without materializing generated source.
 * Preview uses this to bind its destination fingerprint before confirmation.
 */
export function planRegisteredBlockOutput(input: AuthoringPlan): RegisteredBlockOutputPlan {
  const plan = prepareStaticPlan(input);
  return { files: [...outputFiles(plan), ...collectConfirmedAssets(plan).map(({ path, operation }) => ({ path, operation }))] };
}

/**
 * Compile a confirmed declarative plan into the static source files a WordPress block build
 * expects. This intentionally does not call convert/finalize: that path handles post content,
 * while this one has a stricter code-generation boundary and its own parsers.
 */
export function compileRegisteredBlock(input: AuthoringPlan): GeneratedRegisteredBlock {
  const plan = prepareStaticPlan(input);
  const sourcePlanHash = hashAuthoringPlan(plan);
  const output = outputFiles(plan);
  const operations = new Map(output.map((file) => [file.path, file.operation]));
  const rootClass = blockRootClass(plan.target.name);
  const assets = collectConfirmedAssets(plan);
  const fontStyles = renderFontStyles(plan, assets);

  const template = compileConfirmedTemplate(plan);
  const allowedBlocks = plan.allowedBlocks ?? unique(template.map(([name]) => name)).sort();
  const metadata = emitBlockJson(plan, allowedBlocks);
  const files: GeneratedSourceFile[] = [
    sourceFile('block.json', 'json', metadata, operations.get('block.json')!),
    sourceFile('index.js', 'javascript', emitIndexJs(), operations.get('index.js')!),
    sourceFile('edit.js', 'javascript', emitEditJs(template, allowedBlocks, plan.locking.mode, assets), operations.get('edit.js')!),
    sourceFile('save.js', 'javascript', emitSaveJs(), operations.get('save.js')!),
    sourceFile('style.scss', 'scss', fontStyles.css
      + emitScss(plan.styles.outcomes, rootClass)
      + stylesheetSuffix(plan.styles.rules, rootClass, plan), operations.get('style.scss')!),
    // Shared styles are loaded by WordPress in both contexts. The editor stylesheet is a stable,
    // owned template seam for explicitly confirmed editor-only affordances.
    sourceFile('editor.scss', 'scss', emitScss([], rootClass)
      + stylesheetSuffix(plan.styles.editorRules, rootClass, plan, 'styles.editorRules'), operations.get('editor.scss')!),
    sourceFile('block.php', 'php', emitPhp(), operations.get('block.php')!),
  ];
  if (fontStyles.licenseText) {
    files.push(sourceFile(FONT_LICENSES_FILE, 'text', fontStyles.licenseText, operations.get(FONT_LICENSES_FILE)!));
  }
  if (operations.has(ASSET_URL_MODULE)) {
    files.push(sourceFile(ASSET_URL_MODULE, 'javascript', emitAssetUrls(template, assets), operations.get(ASSET_URL_MODULE)!));
  }

  validateGeneratedSources(files);

  const manifest: GeneratedSourceManifest = {
    templateVersion: REGISTERED_BLOCK_TEMPLATE_VERSION,
    sourcePlanHash,
    registry: authoringRegistryIdentity(),
    files: [...files, ...assets].map((file) => ({
      path: file.path,
      kind: file.kind,
      contentHash: file.hash,
      operation: file.operation,
      templateVersion: REGISTERED_BLOCK_TEMPLATE_VERSION,
      sourcePlanHash,
    })),
  };
  return { template, templateVersion: REGISTERED_BLOCK_TEMPLATE_VERSION, sourcePlanHash, files, assets, manifest };
}

/** Readable alias for callers that call the compiler a generator. */
export const generateRegisteredBlock = compileRegisteredBlock;

/** The confirmation boundary materializes an immutable, hash-bound source package. */
export const materializeAuthoringPlan = compileRegisteredBlock;

/**
 * Font family names are global CSS identifiers. The authoring adapter must namespace source face
 * names with this prefix, and canonical plans must retain that namespaced value in any native or
 * residual `font-family` references. Requiring the prefix here keeps arbitrary plans from
 * publishing a globally colliding `Inter`/`Roboto` face without adding a second rewrite system.
 *
 * This is intentionally the same namespace used by the HTML adapter: a safe target-name slug plus
 * a short hash of the original target name. The hash means two otherwise similar block names do
 * not share a CSS family by accident, while retaining a readable family in generated CSS.
 */
export function registeredBlockFontFamilyPrefix(blockName: string): string {
  const slug = blockName
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'font';
  const digest = createHash('sha256').update(blockName, 'utf8').digest('hex').slice(0, 8);
  return `block-runner-${slug}-${digest}-`;
}

function stylesheetSuffix(rules: AuthoringPlan['styles']['rules'], root: string, plan: AuthoringPlan, at?: string): string {
  const { css } = renderConfirmedStyleRules(rules ?? [], root, plan.assets, at);
  return css ? `${css}\n` : '';
}

/**
 * Render the hash-confirmed font transport before ordinary component CSS. A face does not carry a
 * caller-controlled URL: its asset ID is resolved against the copied package asset, so the same
 * confirmation that permits the WOFF bytes also binds the generated `src`. Font faces are shared
 * because WordPress loads `style.scss` in both the editor and frontend; `editor.scss` stays
 * supplemental and never duplicates them.
 */
interface RenderedFontStyles {
  css: string;
  licenseText: string;
}

function renderFontStyles(plan: AuthoringPlan, assets: readonly GeneratedAssetFile[]): RenderedFontStyles {
  const faces = plan.styles.fonts ?? [];
  const fontAssets = plan.assets.filter((asset) => asset.kind?.toLowerCase() === 'font');
  if (!faces.length) {
    if (fontAssets.length) {
      throw new AuthoringGenerationError(
        'unresolved-font-face: every bundled font asset must have a confirmed styles.fonts descriptor',
        'styles.fonts',
      );
    }
    return { css: '', licenseText: '' };
  }

  const byId = new Map(plan.assets.map((asset) => [asset.id, asset] as const));
  const generatedByPath = new Map(assets.map((asset) => [asset.path, asset] as const));
  const renderedFaces: LicensedFontFace[] = [];
  const notices: FontLicenseNotice[] = [];

  for (const [index, face] of faces.entries()) {
    const at = `styles.fonts[${index}]`;
    const asset = byId.get(face.assetId);
    if (!asset) {
      throw new AuthoringGenerationError('unresolved-font-face: assetId does not name a plan asset', `${at}.assetId`);
    }
    if (asset.kind?.toLowerCase() !== 'font') {
      throw new AuthoringGenerationError('unresolved-font-face: assetId must reference a font asset', `${at}.assetId`);
    }
    if (asset.status !== 'ready' || !asset.destination) {
      throw new AuthoringGenerationError('unresolved-font-face: font asset must be a confirmed local package asset', `${at}.assetId`);
    }
    const generated = generatedByPath.get(asset.destination);
    if (!generated || generated.assetKind !== 'font') {
      throw new AuthoringGenerationError('unresolved-font-face: font asset was not materialized by the confirmed asset boundary', `${at}.assetId`);
    }
    const decision = fontOwnershipDecision(asset);
    if (!decision) {
      // collectConfirmedAssets normally catches this first; keep the font-face seam explicit so a
      // future asset collector cannot accidentally emit a face without its rights record.
      throw new AuthoringGenerationError('unresolved-font-face: font asset needs an ownership and license decision', `${at}.assetId`);
    }
    if (!face.family.trim().toLowerCase().startsWith(registeredBlockFontFamilyPrefix(plan.target.name))) {
      throw new AuthoringGenerationError(
        `unsafe-font-family: family must be explicitly block-owned with prefix ${JSON.stringify(registeredBlockFontFamilyPrefix(plan.target.name))}`,
        `${at}.family`,
      );
    }
    renderedFaces.push({
      family: face.family,
      src: `url("./${asset.destination}")`,
      ...(face.fontStyle === undefined ? {} : { fontStyle: face.fontStyle }),
      ...(face.fontWeight === undefined ? {} : { fontWeight: face.fontWeight }),
      ...(face.fontStretch === undefined ? {} : { fontStretch: face.fontStretch }),
      ...(face.fontDisplay === undefined ? {} : { fontDisplay: face.fontDisplay }),
      ...(face.unicodeRange === undefined ? {} : { unicodeRange: face.unicodeRange }),
    });
    if (!notices.some((notice) => notice.source === `./${asset.destination}` && notice.family === face.family)) {
      notices.push({
        family: face.family,
        // Keep the original path in the confirmed plan, but do not leak a user's local filesystem
        // layout into the generated plugin. The package-relative destination is auditable after
        // publication.
        source: `./${asset.destination}`,
        ownership: decision.ownership,
        license: decision.license,
        ...(decision.notice === undefined ? {} : { notice: decision.notice }),
      });
    }
  }

  const notice = renderFontLicenseNotice(notices);
  const licenseText = renderFontLicenseText(notices);
  const declarations = renderLicensedFontFaces(renderedFaces);
  return { css: `${notice}${declarations ? `${declarations}\n` : ''}`, licenseText };
}

/** Typed JSON emitter for the API-v3 metadata document. */
export function emitBlockJson(plan: Pick<AuthoringPlan, 'target'>, allowedBlocks: string[] = []): string {
  const metadata: Record<string, JsonValue> = {
    $schema: WORDPRESS_BLOCK_SCHEMA_URL,
    apiVersion: 3,
    name: plan.target.name,
    title: plan.target.title,
    category: plan.target.category ?? 'design',
    textdomain: plan.target.textDomain ?? plan.target.name.split('/')[0]!,
    editorScript: 'file:./index.js',
    // These are the deterministic assets emitted by the standard WordPress Sass build from
    // style.scss and editor.scss. `style` is shared by the editor and frontend; editorStyle is
    // deliberately supplemental and editor-only.
    style: 'file:./style-index.css',
    editorStyle: 'file:./index.css',
    allowedBlocks,
    supports: { html: false },
  };
  if (plan.target.description) metadata.description = plan.target.description;
  if (plan.target.icon) metadata.icon = plan.target.icon;
  const serialized = `${JSON.stringify(sortJson(metadata), null, 2)}\n`;
  validateBlockMetadata(JSON.parse(serialized));
  return serialized;
}

/** Typed JavaScript emitter. The client registers using metadata, never a generated duplicate. */
export function emitIndexJs(): string {
  return `import { registerBlockType } from '@wordpress/blocks';
import metadata from './block.json';
import Edit from './edit';
import save from './save';
import './style.scss';
import './editor.scss';

registerBlockType( metadata.name, {
  edit: Edit,
  save,
} );
`;
}

/** Typed JSX emitter for a static InnerBlocks editor surface. */
export function emitEditJs(template: TemplateNode[], allowedBlocks: string[], lock: AuthoringPlan['locking']['mode'], assets: readonly GeneratedAssetFile[] = []): string {
  const templateLock = lock === 'none' ? false : lock;
  const imports = referencedAssetIndices(template, assets).map((index) => /\.svg$/i.test(assets[index]!.path)
    ? `import { asset${index} } from './${ASSET_URL_MODULE}';`
    : `import asset${index} from ${JSON.stringify(`./${assets[index]!.path}`)};`).join('\n');
  // Only native image URL attributes are substituted, never arbitrary text.
  const renderTemplate = (nodes: TemplateNode[]): string => `[${nodes.map(([name, attrs, children]) => {
    const entries = Object.entries(attrs).map(([key, value]) => {
      const asset = name === 'core/image' && key === 'url' ? assets.findIndex((item) => `./${item.path}` === value) : -1;
      return `${JSON.stringify(key)}: ${asset >= 0 ? `asset${asset}` : JSON.stringify(value)}`;
    });
    return `[${JSON.stringify(name)}, {${entries.join(', ')} }${children ? `, ${renderTemplate(children)}` : ''}]`;
  }).join(',\n')}]`;
  return `import { InnerBlocks, useBlockProps } from '@wordpress/block-editor';
${imports}

const TEMPLATE = ${assets.length ? renderTemplate(template) : JSON.stringify(template, null, 2)};
const ALLOWED_BLOCKS = ${JSON.stringify(allowedBlocks, null, 2)};
const TEMPLATE_LOCK = ${JSON.stringify(templateLock)};

export default function Edit() {
  return (
    <div { ...useBlockProps() }>
      <InnerBlocks
        allowedBlocks={ ALLOWED_BLOCKS }
        template={ TEMPLATE }
        templateLock={ TEMPLATE_LOCK }
      />
    </div>
  );
}
`;
}

/** Typed JSX emitter for static saved markup: native inner blocks own all planned content. */
export function emitSaveJs(): string {
  return `import { InnerBlocks, useBlockProps } from '@wordpress/block-editor';

export default function save() {
  return (
    <div { ...useBlockProps.save() }>
      <InnerBlocks.Content />
    </div>
  );
}
`;
}

/**
 * Render the versioned, root-owned style subset from declarative plan outcomes.
 *
 * Native outcomes belong to the native blocks in the structure and dropped outcomes deliberately
 * produce no CSS. Token values are derived as WordPress preset references; scoped CSS outcomes
 * can only use an allowlisted declaration and a value that cannot introduce CSS structure.
 */
export function emitScss(outcomes: readonly AuthoringStyleOutcome[], rootClass: string): string {
  assertOwnedRootClass(rootClass);
  const declarations = outcomes.flatMap((outcome, index) => renderStyleOutcome(outcome, `styles.outcomes[${index}]`));
  const lines = [
    `/* Generated by registered-block style emitter v${REGISTERED_BLOCK_STYLE_EMITTER_VERSION}. */`,
    `${rootClass} {`,
    ...declarations.map((declaration) => `  ${declaration}`),
    '}',
    '',
  ];
  return lines.join('\n');
}

/** Typed PHP emitter. It registers the package directory, letting WordPress load block.json metadata. */
export function emitPhp(): string {
  return `<?php
/** Static block metadata registration. */
defined( 'ABSPATH' ) || exit;

add_action( 'init', static function () {
  register_block_type( __DIR__ );
} );
`;
}

/** Parse every generated source type before any caller can write it to disk. */
export function validateGeneratedSources(files: readonly GeneratedSourceFile[]): void {
  for (const file of files) {
    try {
      switch (file.kind) {
        case 'json':
          validateBlockMetadata(JSON.parse(file.content));
          break;
        case 'javascript':
          parseJavaScript(file.content, { sourceType: 'module', plugins: ['jsx'] });
          break;
        case 'scss':
          // Generated SCSS is deliberately plain CSS. PostCSS therefore parses exactly the syntax
          // WordPress's Sass build will receive, without accepting any unreviewed Sass behaviour.
          postcss.parse(file.content, { from: file.path });
          break;
        case 'php':
          parsePhp(file.content);
          break;
        case 'text':
          if (!file.content.trim()) throw new Error('text source cannot be empty');
          break;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new AuthoringGenerationError(`generated-source-invalid: ${file.path}: ${message}`, `files.${file.path}`);
    }
  }
}

/** Validate metadata with the pinned WordPress API-v3 JSON schema through AJV, never a Zod subset. */
export function validateBlockMetadata(metadata: unknown): void {
  const validate = new Ajv({ allErrors: true, strict: false }).compile(WORDPRESS_BLOCK_SCHEMA_7_1);
  if (!validate(metadata)) {
    const details = validate.errors?.map((error) => `${error.instancePath || '$'} ${error.message ?? 'is invalid'}`).join('; ');
    throw new AuthoringGenerationError(`metadata-schema-invalid: ${details ?? 'unknown schema error'}`, 'block.json');
  }
}

function sourceFile(
  path: GeneratedSourceFile['path'],
  kind: GeneratedSourceKind,
  content: string,
  operation: AuthoringFileOperation,
): GeneratedSourceFile {
  return { path, kind, content, hash: sha256(content), operation };
}

function referencedAssetIndices(template: TemplateNode[], assets: readonly GeneratedAssetFile[]): number[] {
  const indices = new Set<number>();
  const visit = (nodes: TemplateNode[]): void => {
    for (const [name, attrs, children] of nodes) {
      const index = name === 'core/image' ? assets.findIndex((asset) => `./${asset.path}` === attrs.url) : -1;
      if (index >= 0) indices.add(index);
      visit(children ?? []);
    }
  };
  visit(template);
  return [...indices].sort((a, b) => a - b);
}

function emitAssetUrls(template: TemplateNode[], assets: readonly GeneratedAssetFile[]): string {
  // wp-scripts applies SVGR/url-loader to SVGs imported by .js, producing a data URL which
  // WordPress strips on filtered saves. In an ESM .mjs module, webpack's standard URL asset
  // dependency emits the original file instead. No custom webpack config or loader is needed.
  return referencedAssetIndices(template, assets).filter((index) => /\.svg$/i.test(assets[index]!.path))
    .map((index) => `export const asset${index} = new URL(${JSON.stringify(`./${assets[index]!.path}`)}, import.meta.url).href;`)
    .join('\n') + '\n';
}

function prepareStaticPlan(input: AuthoringPlan): AuthoringPlan {
  const plan = canonicalizeAuthoringPlan(input);
  assertNoExecutableBehaviour(plan);
  assertSafePlanData(plan);
  validateLockingOperations(plan.locking);
  // This common boundary is reached by preview and source generation, including direct plans.
  try {
    validateNativeComposition(plan.structure);
  } catch (error) {
    rethrowCapabilityError(error, 'structure');
  }
  // Preview must refuse unsupported styles too, rather than promising an unwritable package.
  emitScss(plan.styles.outcomes, blockRootClass(plan.target.name));
  // Preview and writing reject the same unresolved editor decisions.
  compileConfirmedTemplate(plan);
  if (plan.allowedBlocks) {
    if (new Set(plan.allowedBlocks).size !== plan.allowedBlocks.length) {
      throw new AuthoringGenerationError('duplicate-allowed-block', 'allowedBlocks');
    }
    if (plan.structure.some((node) => !plan.allowedBlocks!.includes(node.block))) {
      throw new AuthoringGenerationError('initial-template-not-allowed: every direct child must be in the insertion allowlist', 'allowedBlocks');
    }
  }

  for (const [index, file] of plan.files.entries()) {
    if (file.content !== undefined) {
      throw new AuthoringGenerationError('unsupported-executable-behaviour: plan file content is not accepted', `files[${index}].content`);
    }
    if (!outputFiles(plan).some((output) => output.path === file.path) && !plan.assets.some((asset) => asset.destination === file.path)) {
      throw new AuthoringGenerationError('invalid-authoring-plan: file is outside the static registered-block package', `files[${index}].path`);
    }
  }
  const assets = collectConfirmedAssets(plan);
  // The same checked face/notice emitter runs during preview so an invalid font descriptor cannot
  // survive the confirmation hash and fail only when source files are materialized.
  renderFontStyles(plan, assets);
  return plan;
}

function outputFiles(plan: AuthoringPlan): Array<Pick<GeneratedSourceFile, 'path' | 'operation'>> {
  const operations = new Map(plan.files.map((file) => [file.path, file.operation ?? 'create'] as const));
  const paths: GeneratedSourcePath[] = [...GENERATED_REGISTERED_BLOCK_PATHS];
  if (plan.styles.fonts?.length) paths.push(FONT_LICENSES_FILE);
  if (plan.assets.some((asset) => asset.status === 'ready' && asset.uses?.length && /\.svg$/i.test(asset.destination ?? ''))) {
    paths.push(ASSET_URL_MODULE);
  }
  return paths.map((path) => ({
    path,
    operation: operations.get(path) ?? 'create',
  }));
}

function assertNoExecutableBehaviour(plan: AuthoringPlan): void {
  const visit = (value: unknown, path: string): void => {
    if (Array.isArray(value)) {
      value.forEach((item, index) => visit(item, `${path}[${index}]`));
      return;
    }
    if (!value || typeof value !== 'object') return;
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      const childPath = `${path}.${key}`;
      if (isExecutableBehaviourKey(key)) {
        throw new AuthoringGenerationError(`unsupported-executable-behaviour: ${key} is outside the static source contract`, childPath);
      }
      visit(item, childPath);
    }
  };
  visit(plan, '$');
}

function assertSafePlanData(plan: AuthoringPlan): void {
  const urlKeys = new Set(['url', 'href', 'src', 'srcset', 'mediaurl', 'poster', 'link', 'linkurl', 'linkdestination', 'source']);
  const visit = (value: JsonValue | undefined, path: string, key?: string): void => {
    if (typeof value === 'string') {
      if (key && urlKeys.has(key.toLowerCase())) assertSafeUrl(value, path);
      if (looksLikeMarkup(value)) assertSafeRichMarkup(value, path);
      return;
    }
    if (typeof value === 'number' && !Number.isFinite(value)) {
      throw new AuthoringGenerationError('unsafe-inner-content: non-finite number is not JSON data', path);
    }
    if (Array.isArray(value)) {
      value.forEach((item, index) => visit(item, `${path}[${index}]`));
      return;
    }
    if (value && typeof value === 'object') {
      for (const [childKey, child] of Object.entries(value)) visit(child, `${path}.${childKey}`, childKey);
    }
  };
  const visitStructure = (nodes: AuthoringStructureNode[], path: string): void => {
    nodes.forEach((node, index) => {
      const nodePath = `${path}[${index}]`;
      visit(node.attributes, `${nodePath}.attributes`);
      visitStructure(node.children ?? [], `${nodePath}.children`);
    });
  };
  visitStructure(plan.structure, 'structure');
  visit(plan.fields as unknown as JsonValue, 'fields');
  visit(plan.pattern as unknown as JsonValue, 'pattern');
  visit(plan.assets as unknown as JsonValue, 'assets');
}

function assertSafeUrl(value: string, path: string): void {
  // Decode a few levels before stripping controls: java%0ascript: and java\nscript: are both
  // javascript: to a URL consumer.
  let decoded = value;
  for (let index = 0; index < 3; index += 1) {
    try {
      const next = decodeURIComponent(decoded);
      if (next === decoded) break;
      decoded = next;
    } catch {
      break;
    }
  }
  const normalized = decoded.replace(/[\u0000-\u0020\u007f-\u009f]/g, '');
  if (normalized === '' || normalized.startsWith('#') || normalized.startsWith('/') || normalized.startsWith('./') || normalized.startsWith('../')) return;
  const scheme = normalized.match(/^([a-z][a-z0-9+.-]*):/i)?.[1]?.toLowerCase();
  // A scheme-less value is a relative URL. It is safe for this static package; unsafe protocols
  // necessarily have a scheme and are rejected below.
  if (scheme && !['http', 'https', 'mailto', 'tel'].includes(scheme)) {
    throw new AuthoringGenerationError(`unsafe-inner-content: unsafe URL scheme in ${JSON.stringify(value)}`, path);
  }
}

function assertSafeRichMarkup(markup: string, path: string): void {
  const fragment = JSDOM.fragment(markup);
  const disallowedElements = new Set(['script', 'style', 'iframe', 'object', 'embed', 'form', 'input', 'button', 'svg', 'math', 'meta', 'link']);
  const allowedAttributes = new Set(['href', 'target', 'rel', 'title', 'class', 'id', 'lang', 'dir', 'cite', 'datetime', 'start', 'value', 'colspan', 'rowspan', 'scope', 'abbr']);
  for (const element of fragment.querySelectorAll('*')) {
    const tag = element.tagName.toLowerCase();
    if (disallowedElements.has(tag)) {
      throw new AuthoringGenerationError(`unsafe-inner-content: disallowed <${tag}> markup`, path);
    }
    for (const attribute of element.attributes) {
      const name = attribute.name.toLowerCase();
      if (name.startsWith('on') || !allowedAttributes.has(name)) {
        throw new AuthoringGenerationError(`unsafe-inner-content: unsafe ${attribute.name} attribute`, path);
      }
      if (name === 'href' || name === 'cite') assertSafeUrl(attribute.value, path);
    }
  }
}

function validateStyleOutcome(value: AuthoringStyleOutcome, path: string): AuthoringStyleOutcome {
  const outcome = value.outcome;
  const property = value.property.trim().toLowerCase();
  const styleValue = value.value;
  const token = value.token;
  const reason = value.reason;
  if (!STYLE_OUTCOMES.has(outcome)) {
    throw new AuthoringGenerationError('invalid-authoring-plan: style outcome is unsupported', path + '.outcome');
  }
  if (outcome === 'scoped-css') {
    if (!SCOPED_STYLE_PROPERTIES.has(property)) {
      throw new AuthoringGenerationError('unsupported-style-outcome: ' + JSON.stringify(property) + ' has no owned CSS emitter', path + '.property');
    }
    if (!styleValue || styleValue.trim() === '') {
      throw new AuthoringGenerationError('invalid-authoring-plan: scoped-css outcome needs a value', path + '.value');
    }
    assertSafeStyleValue(styleValue, path + '.value');
  }
  if (outcome === 'token') {
    if (!TOKEN_PRESET_KINDS[property]) {
      throw new AuthoringGenerationError('unsupported-style-outcome: ' + JSON.stringify(property) + ' has no preset emitter', path + '.property');
    }
    if (!token || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(token)) {
      throw new AuthoringGenerationError('invalid-authoring-plan: token outcome needs a lowercase preset slug', path + '.token');
    }
  }
  return {
    property,
    outcome,
    ...(styleValue === undefined ? {} : { value: styleValue }),
    ...(token === undefined ? {} : { token }),
    ...(reason === undefined ? {} : { reason }),
  };
}

function renderStyleOutcome(value: AuthoringStyleOutcome, path: string): string[] {
  const outcome = validateStyleOutcome(value, path);
  switch (outcome.outcome) {
    case 'scoped-css':
      return [outcome.property + ': ' + outcome.value!.trim() + ';'];
    case 'token':
      return [
        outcome.property
          + ': var(--wp--preset--'
          + TOKEN_PRESET_KINDS[outcome.property]
          + '--'
          + outcome.token
          + ');',
      ];
    case 'native':
    case 'dropped':
      return [];
  }
}

function assertSafeStyleValue(value: string, path: string): void {
  const trimmed = value.trim();
  // Values remain declarative data rather than a CSS fragment. In particular, no rule/declaration
  // delimiter, at-rule, URL, escape, or comment token can be smuggled through this emitter.
  if (
    trimmed === ''
    || /[\u0000-\u001f\u007f;{}<>@\\]/.test(trimmed)
    || /\/\*|\*\//.test(trimmed)
    || /url\s*\(/i.test(trimmed)
    || /expression\s*\(/i.test(trimmed)
  ) {
    throw new AuthoringGenerationError('invalid-authoring-plan: scoped-css value is not safe declarative style data', path);
  }
}

function assertOwnedRootClass(rootClass: string): void {
  if (!/^\.wp-block-[a-z][a-z0-9-]*-[a-z][a-z0-9-]*$/.test(rootClass)) {
    throw new AuthoringGenerationError('invalid-style-emitter: root class must be an owned WordPress block selector', 'styles');
  }
}

function parsePhp(source: string): void {
  // php-parser is an AST parser for PHP, not a token-sequence heuristic. `createRequire` avoids
  // making generated browser assets depend on it; it exists only in this compiler boundary.
  const require = createRequire(import.meta.url);
  type PhpParserEngine = new (options: unknown) => { parseCode: (input: string, filename: string) => unknown };
  const loaded = require('php-parser') as {
    Engine?: PhpParserEngine;
    default?: PhpParserEngine;
  } | PhpParserEngine;
  const Engine = typeof loaded === 'function' ? loaded : loaded.Engine ?? loaded.default;
  if (!Engine) throw new Error('php-parser did not provide an Engine constructor');
  new Engine({ parser: { php7: true }, ast: { withPositions: true } }).parseCode(source, 'block.php');
}

function toTemplateNode(node: AuthoringStructureNode, path: string): TemplateNode {
  const attributes = sortJson((node.attributes ?? {}) as JsonValue) as Record<string, JsonValue>;
  if (node.lock) {
    const existingLock = attributes.lock;
    attributes.lock = {
      ...(existingLock && typeof existingLock === 'object' && !Array.isArray(existingLock)
        ? existingLock as Record<string, JsonValue>
        : {}),
      ...node.lock,
    };
  }
  const children = (node.children ?? []).map((child, index) => toTemplateNode(child, `${path}.children[${index}]`));
  return children.length > 0 ? [node.block, attributes, children] : [node.block, attributes];
}

/** Resolve only the content fields and native bindings explicitly confirmed in the plan. */
function compileConfirmedTemplate(plan: AuthoringPlan): TemplateNode[] {
  const nodes = structuredClone(plan.structure);
  const byId = new Map<string, AuthoringStructureNode>();
  const visit = (items: AuthoringStructureNode[], parentPath = 'structure'): void => {
    for (const [index, node] of items.entries()) {
      const nodePath = `${parentPath}[${index}]`;
      if (node.id) byId.set(node.id, node);
      validateNativeLock(node.attributes?.lock, `${nodePath}.attributes.lock`);
      const metadata = node.attributes?.metadata;
      if (metadata && typeof metadata === 'object' && !Array.isArray(metadata) && metadata.bindings !== undefined) {
        throw new AuthoringGenerationError('unconfirmed-bindings: declare pattern overrides through fields', `structure.${node.id ?? node.block}.attributes.metadata.bindings`);
      }
      visit(node.children ?? [], `${nodePath}.children`);
    }
  };
  visit(nodes);
  const overrideFields = new Set(plan.pattern.overrides.map(({ field }) => field));
  if (overrideFields.size !== plan.pattern.overrides.length) {
    throw new AuthoringGenerationError('duplicate-pattern-override', 'pattern.overrides');
  }
  if (overrideFields.size > 0 && !plan.pattern.ready) {
    throw new AuthoringGenerationError('pattern-overrides-require-ready-pattern', 'pattern.ready');
  }
  const fieldsByNode = new Map<string, AuthoringPlan['fields']>();
  for (const field of plan.fields) {
    if (!field.node) continue;
    const fields = fieldsByNode.get(field.node) ?? [];
    fields.push(field);
    fieldsByNode.set(field.node, fields);
  }
  const fixedNodeIds = new Set<string>();
  const seen = new Set<string>();
  for (const [index, field] of plan.fields.entries()) {
    const at = `fields[${index}]`;
    const node = field.node ? byId.get(field.node) : undefined;
    if (!node || !field.attribute) {
      throw new AuthoringGenerationError('unresolved-editor-field: node and native attribute are required', at);
    }
    try {
      validateEditableField(field, index, node);
    } catch (error) {
      rethrowCapabilityError(error, `${at}.attribute`);
    }
    const key = `${field.node}:${field.attribute}`;
    if (seen.has(key)) throw new AuthoringGenerationError('duplicate-editor-field', at);
    seen.add(key);
    const attrs = node.attributes ??= {};
    if (field.default !== undefined) attrs[field.attribute] = structuredClone(field.default);
    const override = overrideFields.has(field.id);
    const existingLock = validateNativeLock(attrs.lock, `${at}.node.attributes.lock`);
    if (field.mode !== 'fixed' && existingLock?.edit === true) {
      throw new AuthoringGenerationError(
        'conflicting-editable-field: attributes.lock.edit=true makes this native node read-only',
        at,
      );
    }
    if (field.mode === 'fixed') {
      if (override) {
        throw new AuthoringGenerationError('unsupported-pattern-override: a fixed field cannot be a pattern override', at);
      }
      const peers = fieldsByNode.get(field.node!) ?? [];
      if (peers.some((peer) => peer.id !== field.id && peer.mode !== 'fixed')) {
        throw new AuthoringGenerationError(
          'unsupported-fixed-field: WordPress lock.edit is block-level; a native node cannot mix fixed and editable fields',
          at,
        );
      }
      fixedNodeIds.add(field.node!);
    }
    if (field.mode === 'override' && !override) {
      throw new AuthoringGenerationError('unconfirmed-pattern-override', at);
    }
    if (!override) continue;
    if (field.mode === 'fixed' || !supportedPatternOverrideAttributes(node.block, { [field.attribute]: true }).includes(field.attribute)) {
      throw new AuthoringGenerationError('unsupported-pattern-override: requires an editable native content attribute', at);
    }
    const metadata = attrs.metadata;
    if (metadata !== undefined && (!metadata || typeof metadata !== 'object' || Array.isArray(metadata))) {
      throw new AuthoringGenerationError('invalid-native-metadata', at);
    }
    const existing = (metadata ?? {}) as Record<string, JsonValue>;
    const bindings = existing.bindings;
    if (bindings !== undefined && (!bindings || typeof bindings !== 'object' || Array.isArray(bindings))) {
      throw new AuthoringGenerationError('invalid-native-bindings', at);
    }
    const name = patternOverrideName(field.node!);
    if (existing.name !== undefined && existing.name !== name) {
      throw new AuthoringGenerationError('conflicting-pattern-override-name', at);
    }
    attrs.metadata = {
      ...existing,
      name,
      bindings: { __default: { source: 'core/pattern-overrides' } },
    };
  }
  for (const field of overrideFields) {
    if (!plan.fields.some((candidate) => candidate.id === field)) {
      throw new AuthoringGenerationError('unresolved-pattern-override-field', 'pattern.overrides');
    }
  }
  for (const [id, node] of byId) {
    const selected = plan.fields.filter((field) => field.node === id && overrideFields.has(field.id));
    if (!selected.length) continue;
    const unconfirmed = supportedPatternOverrideAttributes(node.block)
      .filter((attribute) => !selected.some((field) => field.attribute === attribute));
    if (unconfirmed.length) {
      throw new AuthoringGenerationError(
        `partial-pattern-override: WordPress enables a whole native content region; confirm these additional attributes or disable overrides: ${unconfirmed.join(', ')}`,
        `structure.${id}`,
      );
    }
  }
  const mediaUses = new Set<string>();
  for (const [index, asset] of plan.assets.entries()) {
    for (const use of asset.uses ?? []) {
      const node = byId.get(use.node);
      if (!node || node.block !== 'core/image' || !asset.destination || asset.status !== 'ready') {
        throw new AuthoringGenerationError('unsupported-asset-use: a copied image requires a native Image target', `assets[${index}]`);
      }
      const key = `${use.node}:${use.attribute}`;
      if (mediaUses.has(key)) throw new AuthoringGenerationError('duplicate-asset-use', `assets[${index}]`);
      mediaUses.add(key);
      const attrs = node.attributes ??= {};
      if (plan.fields.some((field) => field.node === use.node && field.attribute === use.attribute && field.default !== undefined)
        || (attrs.url !== undefined && attrs.url !== asset.source && attrs.url !== `./${asset.destination}`)) {
        throw new AuthoringGenerationError('conflicting-asset-default: choose the bundled image or a field URL, not both', `assets[${index}]`);
      }
      attrs.url = `./${asset.destination}`;
      // Bundled files are not WordPress Media Library records.
      if (attrs.id !== undefined) throw new AuthoringGenerationError('bundled-image-cannot-claim-media-id', `structure.${use.node}.attributes.id`);
    }
  }
  for (const id of fixedNodeIds) {
    const node = byId.get(id)!;
    const attrs = node.attributes ??= {};
    const lock = validateNativeLock(attrs.lock, `structure.${id}.attributes.lock`) ?? {};
    if (lock.edit === false) {
      throw new AuthoringGenerationError('conflicting-fixed-field: lock.edit=false contradicts a fixed field', `structure.${id}.attributes.lock.edit`);
    }
    attrs.lock = { ...lock, edit: true };
  }
  assertSafePlanData({ ...plan, structure: nodes });
  return nodes.map((node, index) => toTemplateNode(node, `structure[${index}]`));
}

function rethrowCapabilityError(error: unknown, fallbackPath: string): never {
  if (error instanceof Error && error.name === 'AuthoringGenerationError') {
    const capability = error as Error & { reason?: string; source?: { path?: string } };
    throw new AuthoringGenerationError(capability.reason ?? error.message, capability.source?.path ?? fallbackPath);
  }
  throw error;
}

/** Gutenberg's lock attribute is an object with boolean operation switches. */
function validateNativeLock(value: JsonValue | undefined, sourcePath: string): Record<string, JsonValue> | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new AuthoringGenerationError('invalid-native-lock: lock must be an object', sourcePath);
  }
  for (const operation of ['edit', 'move', 'remove'] as const) {
    if (value[operation] !== undefined && typeof value[operation] !== 'boolean') {
      throw new AuthoringGenerationError(`invalid-native-lock: lock.${operation} must be boolean`, `${sourcePath}.${operation}`);
    }
  }
  return value as Record<string, JsonValue>;
}

/**
 * `templateLock` is the only plan-level structural policy in the generated block. The optional
 * operation flags are allowed-operation booleans (`true` means allowed) retained for
 * backwards-compatible plan parsing; they must agree with Gutenberg's native baseline, otherwise
 * accepting them would claim a global lock the generated InnerBlocks API cannot provide. Native
 * per-child `structure[].lock` booleans use the opposite meaning (`true` means blocked).
 */
function validateLockingOperations(locking: AuthoringPlan['locking']): void {
  const expected: Record<AuthoringPlan['locking']['mode'], { move: boolean; remove: boolean; insert: boolean }> = {
    none: { move: true, remove: true, insert: true },
    insert: { move: true, remove: false, insert: false },
    all: { move: false, remove: false, insert: false },
    contentOnly: { move: false, remove: false, insert: false },
  };
  const native = expected[locking.mode];
  for (const operation of ['move', 'remove', 'insert'] as const) {
    const requested = locking[operation];
    if (requested !== undefined && requested !== native[operation]) {
      const mechanism = operation === 'insert'
        ? 'templateLock and allowedBlocks'
        : 'templateLock (or a per-node structure.lock exception)';
      throw new AuthoringGenerationError(
        `unsupported-locking-policy: locking.${operation}=${String(requested)} conflicts with templateLock ${JSON.stringify(locking.mode)}; use ${mechanism}`,
        `locking.${operation}`,
      );
    }
  }
}

function blockRootClass(name: string): string {
  return `.wp-block-${name.replace('/', '-')}`;
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function looksLikeMarkup(value: string): boolean {
  return /<\/?[a-z][^>]*>/i.test(value);
}

function isExecutableBehaviourKey(key: string): boolean {
  return EXECUTABLE_BEHAVIOUR_KEYS.has(key.replace(/[-_\s]/g, '').toLowerCase());
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function sortJson<T extends JsonValue>(value: T): T {
  if (Array.isArray(value)) return value.map((item) => sortJson(item)) as T;
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortJson(value[key]!)])) as T;
  }
  return value;
}
