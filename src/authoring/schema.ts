import { createHash } from 'node:crypto';
import path from 'node:path';

/** The only AuthoringPlan wire format accepted by this preview release. */
export const AUTHORING_PLAN_VERSION = 1 as const;

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export type AuthoringFieldMode = 'fixed' | 'editable' | 'override';
export type AuthoringStyleStrategy = 'native' | 'scoped-css' | 'mixed';
export type AuthoringStyleOutcomeKind = 'native' | 'token' | 'scoped-css' | 'dropped';
export type AuthoringAssetStatus = 'ready' | 'missing' | 'external';
export type AuthoringFileOperation = 'create' | 'replace';
export type AuthoringLockMode = 'insert' | 'all' | 'contentOnly' | 'none';

/** The WordPress editor/runtime pin used by the 0.9 registered-block compiler. */
export const AUTHORING_WORDPRESS_VERSION = '7.1' as const;

/** The authored material that was actually analysed to produce a registered-block plan. */
export type AuthoringSourceFormat = 'html' | 'directory';

export interface AuthoringSource {
  /** The source entry as supplied to the authoring run (or a stable stdin/inline label). */
  entry: string;
  /** SHA-256 of the exact source bytes analysed by Block Runner. */
  sha256: string;
  format: AuthoringSourceFormat;
}

/** A source position retained in the analysis ledger. */
export interface AuthoringCoverageLocation {
  path?: string;
  selector?: string;
  htmlLine?: number;
  htmlColumn?: number;
  offset?: number;
}

export type AuthoringCoverageStyleOutcome = 'native' | 'preset' | 'literal' | 'scoped-css' | 'warned' | 'blocked';

/** One source declaration and its final destination disposition. */
export interface AuthoringCoverageStyle {
  property: string;
  value: string;
  outcome: AuthoringCoverageStyleOutcome;
  /** Whether the declaration came from parity CSS or explicit editor-only CSS. */
  scope: 'shared' | 'editor';
  reason?: string;
  atRules: string[];
  source?: AuthoringCoverageLocation;
}

export type AuthoringCoverageAssetOutcome = 'prepared' | 'copied' | 'uploaded' | 'reused' | 'external' | 'unresolved' | 'blocked';

/** One concrete source asset reference and its final package/destination disposition. */
export interface AuthoringCoverageAsset {
  reference: string;
  rewritten?: string;
  kind: 'image' | 'font' | 'stylesheet' | 'media' | 'other';
  outcome: AuthoringCoverageAssetOutcome;
  reason?: string;
  /** Hash of the local bytes when this reference resolved to a prepared package asset. */
  sha256?: string;
  destination?: string;
  source?: AuthoringCoverageLocation;
}

/** Hashes and complete ledgers produced by the deterministic HTML analysis pass. */
export interface AuthoringCoverage {
  /** Effective stylesheet bytes scanned by the authoring pass. */
  stylesheet?: { entry: string; sha256: string };
  /** Explicit editor-only stylesheet bytes scanned by the authoring pass. */
  editorStylesheet?: { entry: string; sha256: string };
  /** Destination style inputs actually consulted while deciding ownership. */
  styleContext?: AuthoringStyleContext;
  /** One entry per source declaration observed by the authoring pass. */
  styles: AuthoringCoverageStyle[];
  /** One entry per concrete asset reference observed by the authoring pass. */
  assets: AuthoringCoverageAsset[];
}

/** A hash-bound description of the target style environment, never a request to edit it. */
export interface AuthoringStyleContext {
  theme?: { slug?: string; version?: string; settingsSha256?: string };
  viewports?: Partial<Record<'mobile' | 'tablet', { min?: string; max?: string }>>;
  unresolvedVariables?: string[];
  limitations?: string[];
}

/**
 * The registered block this plan is intended to create. `directory` is a safe relative suggested
 * package location used when preview has no explicit `--output-dir`; an explicit CLI destination
 * always takes precedence so its previewed path can be passed unchanged to `author write`.
 */
export interface AuthoringTarget {
  /** WordPress block name, for example `my-plugin/feature-grid`. */
  name: string;
  title: string;
  description?: string;
  category?: string;
  icon?: string;
  textDomain?: string;
  wordpress?: string;
  directory?: string;
  /**
   * Additional declarative block.json metadata. It is hash-bound and rendered in preview.
   * Static capability checks happen at compilation, where unsafe code-loading forms can be
   * rejected without narrowing this transport to a particular vendor schema revision.
   */
  metadata?: { [key: string]: JsonValue };
}

export interface AuthoringNodeLock {
  move?: boolean;
  remove?: boolean;
}

/** A native block and its native children; this is never HTML. */
export interface AuthoringStructureNode {
  /** Optional stable reference used by a field's `node` property. */
  id?: string;
  block: string;
  label?: string;
  attributes?: { [key: string]: JsonValue };
  lock?: AuthoringNodeLock;
  children?: AuthoringStructureNode[];
}

/** A value an editor can, cannot, or may override in a pattern. */
export interface AuthoringField {
  id: string;
  label: string;
  mode: AuthoringFieldMode;
  type?: string;
  node?: string;
  attribute?: string;
  default?: JsonValue;
  description?: string;
}

/** Locking that applies to the authored block as a whole. */
export interface AuthoringLocking {
  mode: AuthoringLockMode;
  move?: boolean;
  remove?: boolean;
  insert?: boolean;
}

/** The disposition of one source style after native-style mapping. */
export interface AuthoringStyleOutcome {
  property: string;
  outcome: AuthoringStyleOutcomeKind;
  value?: string;
  token?: string;
  reason?: string;
}

export interface AuthoringStyles {
  strategy: AuthoringStyleStrategy;
  outcomes: AuthoringStyleOutcome[];
  /** Component-local selectors before the compiler adds its owned block root. */
  rules?: AuthoringCssRule[];
  /** Supplemental editor affordances, subject to the same scoping and asset checks. */
  editorRules?: AuthoringCssRule[];
  /**
   * Hash-confirmed, licensed faces shared by the editor and frontend. Each face points at the
   * corresponding `assets[]` entry; source paths and hashes stay in that one asset record. Font
   * faces are deliberately not an editor-only field: `style.scss` is loaded in both contexts,
   * while `editor.scss` is supplemental and must not duplicate a face.
   */
  fonts?: AuthoringFontFace[];
}

/** A checked @font-face descriptor whose source is resolved from a confirmed asset ID. */
export interface AuthoringFontFace {
  assetId: string;
  family: string;
  fontStyle?: string;
  fontWeight?: string;
  fontStretch?: string;
  fontDisplay?: string;
  unicodeRange?: string;
}

/** The explicit ownership/license decision attached to one bundled font asset. */
export interface AuthoringFontLicense {
  ownership: string;
  license: string;
  notice?: string;
}

export interface AuthoringCssDeclaration {
  property: string;
  value: string;
  important?: boolean;
}

/** Structured CSS only: no imports, Sass, executable fragments, or unscoped output. */
export type AuthoringCssRule = {
  kind: 'style';
  selector: string;
  declarations: AuthoringCssDeclaration[];
} | {
  kind: 'conditional';
  name: 'media' | 'supports' | 'container';
  prelude: string;
  rules: AuthoringCssRule[];
};

export interface AuthoringPatternOverride {
  field: string;
  label?: string;
  description?: string;
}

export interface AuthoringPattern {
  ready: boolean;
  overrides: AuthoringPatternOverride[];
}

export interface AuthoringAsset {
  id: string;
  source: string;
  kind?: string;
  /** A path below the generated package, when the asset is copied into it. */
  destination?: string;
  status?: AuthoringAssetStatus;
  required?: boolean;
  /** SHA-256 of a local source file, required before it may be copied. */
  sha256?: string;
  /** Explicit ownership and license record required for a bundled WOFF/WOFF2 asset. */
  fontLicense?: AuthoringFontLicense;
  /** Explicit native media attributes which use this bundled image. */
  uses?: Array<{ node: string; attribute: 'url' }>;
}

/**
 * A prospective generated file for low-level destination writers. The registered-block compiler
 * deliberately rejects `content`: declarative AuthoringPlans may only select its own output paths.
 */
export interface AuthoringFile {
  /** Portable, relative POSIX path below the output directory. */
  path: string;
  kind?: string;
  content?: string;
  /** Replacing a collision requires this separate, hash-bound approval decision. */
  operation?: AuthoringFileOperation;
}

/**
 * A complete, declarative input to registered-block authoring.
 *
 * The contract keeps human decisions separate from generated source: the structure and editor
 * model are explicit, while registered-block compilation treats files as compiler-owned output
 * paths and collision policy rather than executable source.
 */
export interface AuthoringPlan {
  version: typeof AUTHORING_PLAN_VERSION;
  generatorVersion: string;
  target: AuthoringTarget;
  /** Present on plans produced by HTML analysis; absent on a hand-authored plan. */
  source?: AuthoringSource;
  /** Complete, hash-bound dispositions from the HTML analysis pass. */
  coverage?: AuthoringCoverage;
  structure: AuthoringStructureNode[];
  /** Explicit direct-child insertion policy; defaults to the initial template's direct children. */
  allowedBlocks?: string[];
  fields: AuthoringField[];
  locking: AuthoringLocking;
  styles: AuthoringStyles;
  pattern: AuthoringPattern;
  assets: AuthoringAsset[];
  files: AuthoringFile[];
  warnings: string[];
}

export class AuthoringPlanValidationError extends Error {
  constructor(message: string) {
    super(`invalid authoring plan: ${message}`);
    this.name = 'AuthoringPlanValidationError';
  }
}

/**
 * Parse (when necessary), validate, and normalize an untrusted AuthoringPlan.
 *
 * Normalization fills the deliberately boring defaults, rejects unknown fields, and returns a
 * fresh JSON-only value. It is also the single gate used by hashing and rendering, so a preview
 * cannot accidentally describe a different object from the one that is confirmed later.
 */
export function validateAuthoringPlan(input: unknown): AuthoringPlan {
  return normalizePlan(parseInput(input));
}

/**
 * Validate and return a recursively key-sorted plan object. Array order is deliberately retained:
 * it describes native child order and is therefore material. Use `serializeAuthoringPlan` when a
 * wire representation is required.
 */
export function canonicalizeAuthoringPlan(input: unknown): AuthoringPlan {
  return sortJson(validateAuthoringPlan(input) as unknown as JsonValue) as unknown as AuthoringPlan;
}

/** Stable canonical JSON, with recursively sorted object keys and preserved array order. */
export function serializeAuthoringPlan(input: unknown): string {
  // `AuthoringPlan` is structurally JSON data, but its named interface intentionally does not
  // have a catch-all index signature. Keep that implementation detail out of the public type.
  return JSON.stringify(canonicalizeAuthoringPlan(input));
}

/** SHA-256 of canonical JSON, as lower-case hexadecimal (without a display-only prefix). */
export function hashAuthoringPlan(input: unknown): string {
  return createHash('sha256').update(serializeAuthoringPlan(input)).digest('hex');
}

/** Kept explicit for consumers which refer to the value as a canonical plan hash. */
export const canonicalAuthoringPlanJson = serializeAuthoringPlan;
export const canonicalAuthoringPlanHash = hashAuthoringPlan;

/**
 * Plan paths are portable paths inside an output root. They cannot select a parent, an absolute
 * location, a Windows drive/UNC path, or an empty component that normalisation could reinterpret.
 */
export function isSafeAuthoringRelativePath(value: string, options: { allowDot?: boolean } = {}): boolean {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0') || value.includes('\\')) {
    return false;
  }
  if (value === '.') {
    return options.allowDot === true;
  }
  // `C:relative` is not absolute according to Node, but is resolved against a per-drive
  // working directory on Windows, so it is not a portable child path either.
  if (path.posix.isAbsolute(value) || path.win32.isAbsolute(value) || /^[A-Za-z]:/.test(value)) {
    return false;
  }
  const parts = value.split('/');
  return parts.every((part) => part.length > 0 && part !== '.' && part !== '..');
}

function parseInput(input: unknown): unknown {
  if (typeof input !== 'string') {
    return input;
  }
  try {
    return JSON.parse(input) as unknown;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw invalid('$', `could not parse JSON (${message})`);
  }
}

function normalizePlan(input: unknown): AuthoringPlan {
  const value = objectAt(input, '$');
  knownKeys(
    value,
    '$',
    [
      'version',
      'generatorVersion',
      'target',
      'source',
      'coverage',
      'structure',
      'allowedBlocks',
      'fields',
      'locking',
      'styles',
      'pattern',
      'assets',
      'files',
      // `plannedFiles` is accepted only as a migration-friendly input spelling. Canonical JSON
      // always uses `files`, so a plan receives exactly one confirmation hash.
      'plannedFiles',
      'warnings',
    ],
  );
  if (value.version !== AUTHORING_PLAN_VERSION) {
    throw invalid('$.version', `must be ${AUTHORING_PLAN_VERSION}`);
  }
  if ('files' in value && 'plannedFiles' in value) {
    throw invalid('$', 'must not contain both files and plannedFiles');
  }

  const filesInput = value.files ?? value.plannedFiles ?? [];
  const structure = arrayAt(value.structure ?? [], '$.structure').map((node, index) =>
    normalizeNode(node, `$.structure[${index}]`),
  );
  const fields = arrayAt(value.fields ?? [], '$.fields').map((field, index) =>
    normalizeField(field, `$.fields[${index}]`),
  );
  const assets = arrayAt(value.assets ?? [], '$.assets').map((asset, index) =>
    normalizeAsset(asset, `$.assets[${index}]`),
  );
  const styles = normalizeStyles(value.styles ?? {}, '$.styles');
  const files = arrayAt(filesInput, '$.files').map((file, index) => normalizeFile(file, `$.files[${index}]`));
  const source = value.source === undefined ? undefined : normalizeSource(value.source, '$.source');
  const coverage = value.coverage === undefined ? undefined : normalizeCoverage(value.coverage, '$.coverage');
  if (coverage !== undefined && source === undefined) {
    throw invalid('$.coverage', 'requires a hash-bound $.source');
  }

  unique(structureNodeIds(structure), '$.structure', 'node id');
  unique(fields.map((field) => field.id), '$.fields', 'field id');
  unique(assets.map((asset) => asset.id), '$.assets', 'asset id');
  unique(files.map((file) => file.path), '$.files', 'file path');
  rejectFilePathPrefixes(files.map((file) => file.path));
  validateFontAssetBindings(styles, assets);

  return {
    version: AUTHORING_PLAN_VERSION,
    generatorVersion: nonEmptyString(value.generatorVersion, '$.generatorVersion'),
    target: normalizeTarget(value.target, '$.target'),
    ...(source === undefined ? {} : { source }),
    ...(coverage === undefined ? {} : { coverage }),
    structure,
    ...(value.allowedBlocks === undefined ? {} : { allowedBlocks: arrayAt(value.allowedBlocks, '$.allowedBlocks').map((name, index) => {
      const block = nonEmptyString(name, `$.allowedBlocks[${index}]`);
      if (!/^[a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9-]*$/.test(block)) throw invalid(`$.allowedBlocks[${index}]`, 'must be a WordPress block name');
      return block;
    }) }),
    fields,
    locking: normalizeLocking(value.locking ?? {}, '$.locking'),
    styles,
    pattern: normalizePattern(value.pattern ?? {}, '$.pattern'),
    assets,
    files,
    warnings: arrayAt(value.warnings ?? [], '$.warnings').map((warning, index) =>
      nonEmptyString(warning, `$.warnings[${index}]`),
    ),
  };
}

function normalizeSource(input: unknown, location: string): AuthoringSource {
  const value = objectAt(input, location);
  knownKeys(value, location, ['entry', 'sha256', 'format']);
  const sha256 = nonEmptyString(value.sha256, `${location}.sha256`);
  if (!/^[a-f0-9]{64}$/.test(sha256)) {
    throw invalid(`${location}.sha256`, 'must be a lower-case SHA-256 hexadecimal digest');
  }
  return {
    entry: nonEmptyString(value.entry, `${location}.entry`),
    sha256,
    format: enumAt(value.format, `${location}.format`, ['html', 'directory'] as const),
  };
}

function normalizeCoverage(input: unknown, location: string): AuthoringCoverage {
  const value = objectAt(input, location);
  knownKeys(value, location, ['stylesheet', 'editorStylesheet', 'styleContext', 'styles', 'assets']);
  const styles = arrayAt(value.styles ?? [], `${location}.styles`).map((entry, index) =>
    normalizeCoverageStyle(entry, `${location}.styles[${index}]`),
  );
  const assets = arrayAt(value.assets ?? [], `${location}.assets`).map((entry, index) =>
    normalizeCoverageAsset(entry, `${location}.assets[${index}]`),
  );
  return {
    ...(value.stylesheet === undefined ? {} : { stylesheet: normalizeStylesheetFingerprint(value.stylesheet, `${location}.stylesheet`) }),
    ...(value.editorStylesheet === undefined
      ? {}
      : { editorStylesheet: normalizeStylesheetFingerprint(value.editorStylesheet, `${location}.editorStylesheet`) }),
    ...(value.styleContext === undefined ? {} : { styleContext: normalizeStyleContext(value.styleContext, `${location}.styleContext`) }),
    styles,
    assets,
  };
}

function normalizeStyleContext(input: unknown, location: string): AuthoringStyleContext {
  const value = objectAt(input, location);
  knownKeys(value, location, ['theme', 'viewports', 'unresolvedVariables', 'limitations']);
  const theme = value.theme === undefined ? undefined : (() => {
    const item = objectAt(value.theme, `${location}.theme`);
    knownKeys(item, `${location}.theme`, ['slug', 'version', 'settingsSha256']);
    const settingsSha256 = optionalString(item.settingsSha256, `${location}.theme.settingsSha256`);
    if (settingsSha256 !== undefined && !/^[a-f0-9]{64}$/.test(settingsSha256)) throw invalid(`${location}.theme.settingsSha256`, 'must be a lower-case SHA-256 hexadecimal digest');
    return withOptional({ slug: optionalString(item.slug, `${location}.theme.slug`), version: optionalString(item.version, `${location}.theme.version`), settingsSha256 });
  })();
  const viewports = value.viewports === undefined ? undefined : (() => {
    const item = objectAt(value.viewports, `${location}.viewports`);
    knownKeys(item, `${location}.viewports`, ['mobile', 'tablet']);
    const range = (name: 'mobile' | 'tablet') => item[name] === undefined ? undefined : (() => {
      const entry = objectAt(item[name], `${location}.viewports.${name}`);
      knownKeys(entry, `${location}.viewports.${name}`, ['min', 'max']);
      const min = optionalString(entry.min, `${location}.viewports.${name}.min`);
      const max = optionalString(entry.max, `${location}.viewports.${name}.max`);
      if (min === undefined && max === undefined) throw invalid(`${location}.viewports.${name}`, 'needs min or max');
      return withOptional({ min, max });
    })();
    return withOptional({ mobile: range('mobile'), tablet: range('tablet') });
  })();
  return withOptional({
    theme,
    viewports,
    unresolvedVariables: value.unresolvedVariables === undefined ? undefined : arrayAt(value.unresolvedVariables, `${location}.unresolvedVariables`).map((entry, index) => nonEmptyString(entry, `${location}.unresolvedVariables[${index}]`)),
    limitations: value.limitations === undefined ? undefined : arrayAt(value.limitations, `${location}.limitations`).map((entry, index) => nonEmptyString(entry, `${location}.limitations[${index}]`)),
  });
}

function normalizeStylesheetFingerprint(input: unknown, location: string): { entry: string; sha256: string } {
  const value = objectAt(input, location);
  knownKeys(value, location, ['entry', 'sha256']);
  const sha256 = nonEmptyString(value.sha256, `${location}.sha256`);
  if (!/^[a-f0-9]{64}$/.test(sha256)) {
    throw invalid(`${location}.sha256`, 'must be a lower-case SHA-256 hexadecimal digest');
  }
  return { entry: nonEmptyString(value.entry, `${location}.entry`), sha256 };
}

function normalizeCoverageLocation(input: unknown, location: string): AuthoringCoverageLocation {
  const value = objectAt(input, location);
  knownKeys(value, location, ['path', 'selector', 'htmlLine', 'htmlColumn', 'offset']);
  return withOptional({
    path: optionalString(value.path, `${location}.path`),
    selector: optionalString(value.selector, `${location}.selector`),
    htmlLine: optionalNonNegativeInteger(value.htmlLine, `${location}.htmlLine`),
    htmlColumn: optionalNonNegativeInteger(value.htmlColumn, `${location}.htmlColumn`),
    offset: optionalNonNegativeInteger(value.offset, `${location}.offset`),
  });
}

function normalizeCoverageStyle(input: unknown, location: string): AuthoringCoverageStyle {
  const value = objectAt(input, location);
  knownKeys(value, location, ['property', 'value', 'outcome', 'scope', 'reason', 'atRules', 'source']);
  return withOptional({
    property: nonEmptyString(value.property, `${location}.property`),
    value: stringAt(value.value, `${location}.value`),
    outcome: enumAt(value.outcome, `${location}.outcome`, ['native', 'preset', 'literal', 'scoped-css', 'warned', 'blocked'] as const),
    scope: value.scope === undefined ? 'shared' : enumAt(value.scope, `${location}.scope`, ['shared', 'editor'] as const),
    reason: optionalString(value.reason, `${location}.reason`),
    atRules: arrayAt(value.atRules ?? [], `${location}.atRules`).map((rule, index) => nonEmptyString(rule, `${location}.atRules[${index}]`)),
    source: value.source === undefined ? undefined : normalizeCoverageLocation(value.source, `${location}.source`),
  });
}

function normalizeCoverageAsset(input: unknown, location: string): AuthoringCoverageAsset {
  const value = objectAt(input, location);
  knownKeys(value, location, ['reference', 'rewritten', 'kind', 'outcome', 'reason', 'sha256', 'destination', 'source']);
  const sha256 = optionalString(value.sha256, `${location}.sha256`);
  if (sha256 !== undefined && !/^[a-f0-9]{64}$/.test(sha256)) {
    throw invalid(`${location}.sha256`, 'must be a lower-case SHA-256 hexadecimal digest');
  }
  const destination = optionalString(value.destination, `${location}.destination`);
  if (destination !== undefined && !isSafeAuthoringRelativePath(destination)) {
    throw invalid(`${location}.destination`, 'must be a safe relative path');
  }
  return withOptional({
    reference: nonEmptyString(value.reference, `${location}.reference`),
    rewritten: optionalString(value.rewritten, `${location}.rewritten`),
    kind: enumAt(value.kind, `${location}.kind`, ['image', 'font', 'stylesheet', 'media', 'other'] as const),
    outcome: enumAt(value.outcome, `${location}.outcome`, ['prepared', 'copied', 'uploaded', 'reused', 'external', 'unresolved', 'blocked'] as const),
    reason: optionalString(value.reason, `${location}.reason`),
    sha256,
    destination,
    source: value.source === undefined ? undefined : normalizeCoverageLocation(value.source, `${location}.source`),
  });
}

function normalizeTarget(input: unknown, location: string): AuthoringTarget {
  const value = objectAt(input, location);
  knownKeys(value, location, ['name', 'title', 'description', 'category', 'icon', 'textDomain', 'wordpress', 'directory', 'metadata']);
  const name = nonEmptyString(value.name, `${location}.name`);
  if (!/^[a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9-]*$/.test(name)) {
    throw invalid(`${location}.name`, 'must be a lowercase WordPress block name such as my-plugin/feature-grid');
  }
  const directory = optionalString(value.directory, `${location}.directory`);
  if (directory !== undefined && !isSafeAuthoringRelativePath(directory, { allowDot: true })) {
    throw invalid(`${location}.directory`, 'must be a safe relative path');
  }
  const wordpress = value.wordpress === undefined
    ? AUTHORING_WORDPRESS_VERSION
    : optionalString(value.wordpress, `${location}.wordpress`)!;
  if (!/^7\.1(?:\.\d+)?$/.test(wordpress)) {
    throw invalid(`${location}.wordpress`, `must target WordPress ${AUTHORING_WORDPRESS_VERSION}; this 0.9 compiler has no compatibility branch for ${JSON.stringify(wordpress)}`);
  }
  return withOptional({
    name,
    title: nonEmptyString(value.title, `${location}.title`),
    description: optionalString(value.description, `${location}.description`),
    category: optionalString(value.category, `${location}.category`),
    icon: optionalString(value.icon, `${location}.icon`),
    textDomain: optionalString(value.textDomain, `${location}.textDomain`),
    wordpress,
    directory,
    metadata: value.metadata === undefined ? undefined : jsonObjectAt(value.metadata, `${location}.metadata`),
  });
}

function normalizeNode(input: unknown, location: string): AuthoringStructureNode {
  const value = objectAt(input, location);
  knownKeys(value, location, ['id', 'block', 'label', 'attributes', 'lock', 'children']);
  const attributes = value.attributes === undefined ? undefined : jsonObjectAt(value.attributes, `${location}.attributes`);
  const children = value.children === undefined
    ? undefined
    : arrayAt(value.children, `${location}.children`).map((child, index) =>
      normalizeNode(child, `${location}.children[${index}]`),
    );
  return withOptional({
    id: optionalString(value.id, `${location}.id`),
    block: nonEmptyString(value.block, `${location}.block`),
    label: optionalString(value.label, `${location}.label`),
    attributes,
    lock: value.lock === undefined ? undefined : normalizeNodeLock(value.lock, `${location}.lock`),
    children,
  });
}

function normalizeNodeLock(input: unknown, location: string): AuthoringNodeLock {
  const value = objectAt(input, location);
  knownKeys(value, location, ['move', 'remove']);
  return withOptional({
    move: optionalBoolean(value.move, `${location}.move`),
    remove: optionalBoolean(value.remove, `${location}.remove`),
  });
}

function normalizeField(input: unknown, location: string): AuthoringField {
  const value = objectAt(input, location);
  knownKeys(value, location, ['id', 'label', 'mode', 'type', 'node', 'attribute', 'default', 'description']);
  const mode = enumAt(value.mode, `${location}.mode`, ['fixed', 'editable', 'override'] as const);
  return withOptional({
    id: nonEmptyString(value.id, `${location}.id`),
    label: nonEmptyString(value.label, `${location}.label`),
    mode,
    type: optionalString(value.type, `${location}.type`),
    node: optionalString(value.node, `${location}.node`),
    attribute: optionalString(value.attribute, `${location}.attribute`),
    default: value.default === undefined ? undefined : jsonAt(value.default, `${location}.default`),
    description: optionalString(value.description, `${location}.description`),
  });
}

function normalizeLocking(input: unknown, location: string): AuthoringLocking {
  const value = objectAt(input, location);
  knownKeys(value, location, ['mode', 'move', 'remove', 'insert']);
  return withOptional({
    mode: value.mode === undefined
      ? 'none'
      : enumAt(value.mode, `${location}.mode`, ['insert', 'all', 'contentOnly', 'none'] as const),
    move: optionalBoolean(value.move, `${location}.move`),
    remove: optionalBoolean(value.remove, `${location}.remove`),
    insert: optionalBoolean(value.insert, `${location}.insert`),
  });
}

function normalizeStyles(input: unknown, location: string): AuthoringStyles {
  const value = objectAt(input, location);
  knownKeys(value, location, ['strategy', 'outcomes', 'rules', 'editorRules', 'fonts']);
  return {
    strategy: value.strategy === undefined
      ? 'native'
      : enumAt(value.strategy, `${location}.strategy`, ['native', 'scoped-css', 'mixed'] as const),
    outcomes: arrayAt(value.outcomes ?? [], `${location}.outcomes`).map((outcome, index) =>
      normalizeStyleOutcome(outcome, `${location}.outcomes[${index}]`),
    ),
    ...(value.rules === undefined ? {} : { rules: normalizeCssRules(value.rules, `${location}.rules`) }),
    ...(value.editorRules === undefined ? {} : { editorRules: normalizeCssRules(value.editorRules, `${location}.editorRules`) }),
    ...(value.fonts === undefined ? {} : {
      fonts: arrayAt(value.fonts, `${location}.fonts`).map((face, index) =>
        normalizeFontFace(face, `${location}.fonts[${index}]`),
      ),
    }),
  };
}

function normalizeFontFace(input: unknown, location: string): AuthoringFontFace {
  const value = objectAt(input, location);
  knownKeys(value, location, ['assetId', 'family', 'fontStyle', 'fontWeight', 'fontStretch', 'fontDisplay', 'unicodeRange']);
  return withOptional({
    assetId: nonEmptyString(value.assetId, `${location}.assetId`),
    family: nonEmptyString(value.family, `${location}.family`),
    fontStyle: optionalString(value.fontStyle, `${location}.fontStyle`),
    fontWeight: optionalString(value.fontWeight, `${location}.fontWeight`),
    fontStretch: optionalString(value.fontStretch, `${location}.fontStretch`),
    fontDisplay: optionalString(value.fontDisplay, `${location}.fontDisplay`),
    unicodeRange: optionalString(value.unicodeRange, `${location}.unicodeRange`),
  });
}

/**
 * A face is useful only when its source is one of the plan's confirmed font assets. Keeping this
 * cross-reference at the schema boundary prevents a plan from looking complete while the
 * generator has no byte/licence record from which to resolve its `src`.
 */
function validateFontAssetBindings(styles: AuthoringStyles, assets: AuthoringAsset[]): void {
  const byId = new Map(assets.map((asset) => [asset.id, asset]));
  for (const [index, face] of (styles.fonts ?? []).entries()) {
    const asset = byId.get(face.assetId);
    if (!asset) {
      throw invalid(`$.styles.fonts[${index}].assetId`, `must reference an asset in $.assets (received ${JSON.stringify(face.assetId)})`);
    }
    if (asset.kind?.toLowerCase() !== 'font') {
      throw invalid(`$.styles.fonts[${index}].assetId`, `must reference an asset whose kind is "font" (received ${JSON.stringify(asset.kind ?? '')})`);
    }
  }
}

function normalizeCssRules(input: unknown, location: string, depth = 0): AuthoringCssRule[] {
  if (depth > 16) throw invalid(location, 'conditional CSS nesting exceeds 16 levels');
  return arrayAt(input, location).map((inputRule, index) => {
    const at = `${location}[${index}]`;
    const rule = objectAt(inputRule, at);
    const kind = enumAt(rule.kind, `${at}.kind`, ['style', 'conditional'] as const);
    if (kind === 'conditional') {
      knownKeys(rule, at, ['kind', 'name', 'prelude', 'rules']);
      return { kind, name: enumAt(rule.name, `${at}.name`, ['media', 'supports', 'container'] as const),
        prelude: nonEmptyString(rule.prelude, `${at}.prelude`), rules: normalizeCssRules(rule.rules, `${at}.rules`, depth + 1) };
    }
    knownKeys(rule, at, ['kind', 'selector', 'declarations']);
    return { kind, selector: nonEmptyString(rule.selector, `${at}.selector`),
      declarations: arrayAt(rule.declarations, `${at}.declarations`).map((inputDeclaration, declarationIndex) => {
        const declarationAt = `${at}.declarations[${declarationIndex}]`;
        const declaration = objectAt(inputDeclaration, declarationAt);
        knownKeys(declaration, declarationAt, ['property', 'value', 'important']);
        return withOptional({ property: nonEmptyString(declaration.property, `${declarationAt}.property`),
          value: nonEmptyString(declaration.value, `${declarationAt}.value`),
          important: optionalBoolean(declaration.important, `${declarationAt}.important`) });
      }),
    };
  });
}

function normalizeStyleOutcome(input: unknown, location: string): AuthoringStyleOutcome {
  const value = objectAt(input, location);
  knownKeys(value, location, ['property', 'outcome', 'value', 'token', 'reason']);
  return withOptional({
    property: nonEmptyString(value.property, `${location}.property`),
    outcome: enumAt(value.outcome, `${location}.outcome`, ['native', 'token', 'scoped-css', 'dropped'] as const),
    value: optionalString(value.value, `${location}.value`),
    token: optionalString(value.token, `${location}.token`),
    reason: optionalString(value.reason, `${location}.reason`),
  });
}

function normalizePattern(input: unknown, location: string): AuthoringPattern {
  const value = objectAt(input, location);
  knownKeys(value, location, ['ready', 'overrides']);
  return {
    ready: value.ready === undefined ? false : booleanAt(value.ready, `${location}.ready`),
    overrides: arrayAt(value.overrides ?? [], `${location}.overrides`).map((override, index) => {
      const itemLocation = `${location}.overrides[${index}]`;
      const item = objectAt(override, itemLocation);
      knownKeys(item, itemLocation, ['field', 'label', 'description']);
      return withOptional({
        field: nonEmptyString(item.field, `${itemLocation}.field`),
        label: optionalString(item.label, `${itemLocation}.label`),
        description: optionalString(item.description, `${itemLocation}.description`),
      });
    }),
  };
}

function normalizeAsset(input: unknown, location: string): AuthoringAsset {
  const value = objectAt(input, location);
  knownKeys(value, location, ['id', 'source', 'kind', 'destination', 'status', 'required', 'sha256', 'fontLicense', 'uses']);
  const destination = optionalString(value.destination, `${location}.destination`);
  if (destination !== undefined && !isSafeAuthoringRelativePath(destination)) {
    throw invalid(`${location}.destination`, 'must be a safe relative path');
  }
  return withOptional({
    id: nonEmptyString(value.id, `${location}.id`),
    source: nonEmptyString(value.source, `${location}.source`),
    kind: optionalString(value.kind, `${location}.kind`),
    destination,
    status: value.status === undefined
      ? undefined
      : enumAt(value.status, `${location}.status`, ['ready', 'missing', 'external'] as const),
    required: optionalBoolean(value.required, `${location}.required`),
    sha256: optionalString(value.sha256, `${location}.sha256`),
    fontLicense: value.fontLicense === undefined ? undefined : normalizeFontLicense(value.fontLicense, `${location}.fontLicense`),
    uses: value.uses === undefined ? undefined : arrayAt(value.uses, `${location}.uses`).map((use, index) => {
      const at = `${location}.uses[${index}]`;
      const item = objectAt(use, at);
      knownKeys(item, at, ['node', 'attribute']);
      return { node: nonEmptyString(item.node, `${at}.node`), attribute: enumAt(item.attribute, `${at}.attribute`, ['url'] as const) };
    }),
  });
}

function normalizeFontLicense(input: unknown, location: string): AuthoringFontLicense {
  const value = objectAt(input, location);
  knownKeys(value, location, ['ownership', 'license', 'notice']);
  return withOptional({
    ownership: nonEmptyString(value.ownership, `${location}.ownership`),
    license: nonEmptyString(value.license, `${location}.license`),
    notice: optionalString(value.notice, `${location}.notice`),
  });
}

function normalizeFile(input: unknown, location: string): AuthoringFile {
  const value = objectAt(input, location);
  knownKeys(value, location, ['path', 'kind', 'content', 'operation']);
  const filePath = nonEmptyString(value.path, `${location}.path`);
  if (!isSafeAuthoringRelativePath(filePath)) {
    throw invalid(`${location}.path`, 'must be a safe relative path');
  }
  return withOptional({
    path: filePath,
    kind: optionalString(value.kind, `${location}.kind`),
    content: optionalString(value.content, `${location}.content`, { allowEmpty: true }),
    operation: value.operation === undefined
      ? undefined
      : enumAt(value.operation, `${location}.operation`, ['create', 'replace'] as const),
  });
}

function structureNodeIds(nodes: AuthoringStructureNode[]): string[] {
  const ids: string[] = [];
  const visit = (node: AuthoringStructureNode): void => {
    if (node.id !== undefined) {
      ids.push(node.id);
    }
    for (const child of node.children ?? []) {
      visit(child);
    }
  };
  for (const node of nodes) {
    visit(node);
  }
  return ids;
}

function unique(values: string[], location: string, kind: string): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) {
      throw invalid(location, `contains duplicate ${kind} ${JSON.stringify(value)}`);
    }
    seen.add(value);
  }
}

function rejectFilePathPrefixes(paths: string[]): void {
  const ordered = [...paths].sort();
  for (let index = 1; index < ordered.length; index += 1) {
    const previous = ordered[index - 1]!;
    const current = ordered[index]!;
    if (current.startsWith(`${previous}/`)) {
      throw invalid('$.files', `cannot contain both file ${JSON.stringify(previous)} and its descendant ${JSON.stringify(current)}`);
    }
  }
}

function objectAt(input: unknown, location: string): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw invalid(location, 'must be an object');
  }
  return input as Record<string, unknown>;
}

function jsonObjectAt(input: unknown, location: string): { [key: string]: JsonValue } {
  const object = objectAt(input, location);
  const output: { [key: string]: JsonValue } = Object.create(null) as { [key: string]: JsonValue };
  for (const key of Object.keys(object)) {
    output[key] = jsonAt(object[key], `${location}.${key}`);
  }
  return output;
}

function arrayAt(input: unknown, location: string): unknown[] {
  if (!Array.isArray(input)) {
    throw invalid(location, 'must be an array');
  }
  return input;
}

function jsonAt(input: unknown, location: string): JsonValue {
  if (input === null || typeof input === 'string' || typeof input === 'boolean') {
    return input;
  }
  if (typeof input === 'number') {
    if (!Number.isFinite(input)) {
      throw invalid(location, 'must be a finite JSON number');
    }
    return input;
  }
  if (Array.isArray(input)) {
    return input.map((value, index) => jsonAt(value, `${location}[${index}]`));
  }
  if (input && typeof input === 'object') {
    return jsonObjectAt(input, location);
  }
  throw invalid(location, 'must be JSON data');
}

function knownKeys(value: Record<string, unknown>, location: string, allowed: string[]): void {
  const known = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!known.has(key)) {
      throw invalid(`${location}.${key}`, 'is not part of AuthoringPlan v1');
    }
  }
}

function nonEmptyString(input: unknown, location: string): string {
  const value = stringAt(input, location);
  if (value.trim().length === 0) {
    throw invalid(location, 'must not be empty');
  }
  return value;
}

function optionalString(input: unknown, location: string, options: { allowEmpty?: boolean } = {}): string | undefined {
  if (input === undefined) {
    return undefined;
  }
  const value = stringAt(input, location);
  if (!options.allowEmpty && value.trim().length === 0) {
    throw invalid(location, 'must not be empty');
  }
  return value;
}

function stringAt(input: unknown, location: string): string {
  if (typeof input !== 'string') {
    throw invalid(location, 'must be a string');
  }
  return input;
}

function optionalBoolean(input: unknown, location: string): boolean | undefined {
  if (input === undefined) {
    return undefined;
  }
  return booleanAt(input, location);
}

function optionalNonNegativeInteger(input: unknown, location: string): number | undefined {
  if (input === undefined) {
    return undefined;
  }
  if (typeof input !== 'number' || !Number.isSafeInteger(input) || input < 0) {
    throw invalid(location, 'must be a non-negative integer');
  }
  return input;
}

function booleanAt(input: unknown, location: string): boolean {
  if (typeof input !== 'boolean') {
    throw invalid(location, 'must be a boolean');
  }
  return input;
}

function enumAt<T extends readonly string[]>(input: unknown, location: string, allowed: T): T[number] {
  if (typeof input !== 'string' || !allowed.includes(input)) {
    throw invalid(location, `must be one of ${allowed.map((value) => JSON.stringify(value)).join(', ')}`);
  }
  return input as T[number];
}

function withOptional<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as T;
}

function sortJson<T extends JsonValue>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((item) => sortJson(item)) as T;
  }
  if (value && typeof value === 'object') {
    const output: { [key: string]: JsonValue } = Object.create(null) as { [key: string]: JsonValue };
    for (const key of Object.keys(value).sort()) {
      output[key] = sortJson(value[key]!);
    }
    return output as T;
  }
  return value;
}

function invalid(location: string, message: string): AuthoringPlanValidationError {
  return new AuthoringPlanValidationError(`${location} ${message}`);
}
