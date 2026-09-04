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

/**
 * The owned source-template contract. Changing it changes every generated package and must be an
 * intentional, reviewed release decision.
 */
export const REGISTERED_BLOCK_TEMPLATE_VERSION = '0.9-static-v2' as const;
/**
 * The declarative-style renderer is part of the owned template contract.  It never accepts a
 * stylesheet from the plan: its inputs are individual, validated style outcomes.
 */
export const REGISTERED_BLOCK_STYLE_EMITTER_VERSION = '1' as const;
export const WORDPRESS_BLOCK_SCHEMA_VERSION = '7.1' as const;
export const WORDPRESS_BLOCK_SCHEMA_URL = `https://schemas.wp.org/wp/${WORDPRESS_BLOCK_SCHEMA_VERSION}/block.json`;

export type GeneratedSourceKind = 'json' | 'javascript' | 'scss' | 'php';

export const GENERATED_REGISTERED_BLOCK_PATHS = [
  'block.json',
  'index.js',
  'edit.js',
  'save.js',
  'style.scss',
  'editor.scss',
  'block.php',
] as const;

export type GeneratedSourcePath = typeof GENERATED_REGISTERED_BLOCK_PATHS[number];

export interface GeneratedSourceFile {
  path: GeneratedSourcePath;
  kind: GeneratedSourceKind;
  content: string;
  hash: string;
  operation: AuthoringFileOperation;
}

export interface GeneratedSourceManifestEntry {
  path: GeneratedSourceFile['path'];
  kind: GeneratedSourceKind;
  contentHash: string;
  operation: AuthoringFileOperation;
  templateVersion: typeof REGISTERED_BLOCK_TEMPLATE_VERSION;
  sourcePlanHash: string;
}

export interface GeneratedSourceManifest {
  templateVersion: typeof REGISTERED_BLOCK_TEMPLATE_VERSION;
  sourcePlanHash: string;
  files: GeneratedSourceManifestEntry[];
}

export interface GeneratedRegisteredBlock {
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
  files: ReadonlyArray<Pick<GeneratedSourceFile, 'path' | 'operation'>>;
}

/**
 * Derive the exact output map from a reviewed plan without materializing generated source.
 * Preview uses this to bind its destination fingerprint before confirmation.
 */
export function planRegisteredBlockOutput(input: AuthoringPlan): RegisteredBlockOutputPlan {
  return { files: outputFiles(prepareStaticPlan(input)) };
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

  const template = plan.structure.map((node, index) => toTemplateNode(node, `structure[${index}]`));
  const allowedBlocks = unique(template.map(([name]) => name)).sort();
  const metadata = emitBlockJson(plan, allowedBlocks);
  const files: GeneratedSourceFile[] = [
    sourceFile('block.json', 'json', metadata, operations.get('block.json')!),
    sourceFile('index.js', 'javascript', emitIndexJs(), operations.get('index.js')!),
    sourceFile('edit.js', 'javascript', emitEditJs(template, allowedBlocks, plan.locking.mode), operations.get('edit.js')!),
    sourceFile('save.js', 'javascript', emitSaveJs(), operations.get('save.js')!),
    sourceFile('style.scss', 'scss', emitScss(plan.styles.outcomes, rootClass), operations.get('style.scss')!),
    // Shared styles are loaded by WordPress in both contexts. The editor stylesheet is a stable,
    // owned template seam for future editor-only declarative outcomes, not plan-authored CSS.
    sourceFile('editor.scss', 'scss', emitScss([], rootClass), operations.get('editor.scss')!),
    sourceFile('block.php', 'php', emitPhp(), operations.get('block.php')!),
  ];

  validateGeneratedSources(files);

  const manifest: GeneratedSourceManifest = {
    templateVersion: REGISTERED_BLOCK_TEMPLATE_VERSION,
    sourcePlanHash,
    files: files.map((file) => ({
      path: file.path,
      kind: file.kind,
      contentHash: file.hash,
      operation: file.operation,
      templateVersion: REGISTERED_BLOCK_TEMPLATE_VERSION,
      sourcePlanHash,
    })),
  };
  return { templateVersion: REGISTERED_BLOCK_TEMPLATE_VERSION, sourcePlanHash, files, manifest };
}

/** Readable alias for callers that call the compiler a generator. */
export const generateRegisteredBlock = compileRegisteredBlock;

/** The confirmation boundary materializes an immutable, hash-bound source package. */
export const materializeAuthoringPlan = compileRegisteredBlock;

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
export function emitEditJs(template: TemplateNode[], allowedBlocks: string[], lock: AuthoringPlan['locking']['mode']): string {
  const templateLock = lock === 'none' ? false : lock;
  return `import { InnerBlocks, useBlockProps } from '@wordpress/block-editor';

const TEMPLATE = ${JSON.stringify(template, null, 2)};
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

function prepareStaticPlan(input: AuthoringPlan): AuthoringPlan {
  const plan = canonicalizeAuthoringPlan(input);
  assertNoExecutableBehaviour(plan);
  assertSafePlanData(plan);

  for (const [index, file] of plan.files.entries()) {
    if (file.content !== undefined) {
      throw new AuthoringGenerationError('unsupported-executable-behaviour: plan file content is not accepted', `files[${index}].content`);
    }
    if (!GENERATED_REGISTERED_BLOCK_PATHS.includes(file.path as GeneratedSourcePath)) {
      throw new AuthoringGenerationError('invalid-authoring-plan: file is outside the static registered-block package', `files[${index}].path`);
    }
  }
  return plan;
}

function outputFiles(plan: AuthoringPlan): Array<Pick<GeneratedSourceFile, 'path' | 'operation'>> {
  const operations = new Map(plan.files.map((file) => [file.path, file.operation ?? 'create'] as const));
  return GENERATED_REGISTERED_BLOCK_PATHS.map((path) => ({
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
  const children = (node.children ?? []).map((child, index) => toTemplateNode(child, `${path}.children[${index}]`));
  return children.length > 0 ? [node.block, attributes, children] : [node.block, attributes];
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
