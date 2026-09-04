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
export type AuthoringLockMode = 'all' | 'contentOnly' | 'none';

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
}

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
}

/**
 * A prospective generated file. Source generation is intentionally outside the preview: `content`
 * is therefore optional, but when supplied it is hash-bound just like every other plan decision.
 */
export interface AuthoringFile {
  /** Portable, relative POSIX path below the output directory. */
  path: string;
  kind?: string;
  content?: string;
  /** Replacing a collision requires this separate explicit, hash-bound plan decision. */
  operation?: AuthoringFileOperation;
}

/**
 * A complete, declarative input to registered-block authoring.
 *
 * The contract keeps human decisions separate from generated source: the structure and editor
 * model are explicit, while files describe intended outputs and may carry materialized content
 * only when another deterministic producer supplied it.
 */
export interface AuthoringPlan {
  version: typeof AUTHORING_PLAN_VERSION;
  generatorVersion: string;
  target: AuthoringTarget;
  structure: AuthoringStructureNode[];
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
      'structure',
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
  const files = arrayAt(filesInput, '$.files').map((file, index) => normalizeFile(file, `$.files[${index}]`));

  unique(structureNodeIds(structure), '$.structure', 'node id');
  unique(fields.map((field) => field.id), '$.fields', 'field id');
  unique(assets.map((asset) => asset.id), '$.assets', 'asset id');
  unique(files.map((file) => file.path), '$.files', 'file path');
  rejectFilePathPrefixes(files.map((file) => file.path));

  return {
    version: AUTHORING_PLAN_VERSION,
    generatorVersion: nonEmptyString(value.generatorVersion, '$.generatorVersion'),
    target: normalizeTarget(value.target, '$.target'),
    structure,
    fields,
    locking: normalizeLocking(value.locking ?? {}, '$.locking'),
    styles: normalizeStyles(value.styles ?? {}, '$.styles'),
    pattern: normalizePattern(value.pattern ?? {}, '$.pattern'),
    assets,
    files,
    warnings: arrayAt(value.warnings ?? [], '$.warnings').map((warning, index) =>
      nonEmptyString(warning, `$.warnings[${index}]`),
    ),
  };
}

function normalizeTarget(input: unknown, location: string): AuthoringTarget {
  const value = objectAt(input, location);
  knownKeys(value, location, ['name', 'title', 'description', 'category', 'icon', 'textDomain', 'wordpress', 'directory']);
  const name = nonEmptyString(value.name, `${location}.name`);
  if (!/^[a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9-]*$/.test(name)) {
    throw invalid(`${location}.name`, 'must be a lowercase WordPress block name such as my-plugin/feature-grid');
  }
  const directory = optionalString(value.directory, `${location}.directory`);
  if (directory !== undefined && !isSafeAuthoringRelativePath(directory, { allowDot: true })) {
    throw invalid(`${location}.directory`, 'must be a safe relative path');
  }
  return withOptional({
    name,
    title: nonEmptyString(value.title, `${location}.title`),
    description: optionalString(value.description, `${location}.description`),
    category: optionalString(value.category, `${location}.category`),
    icon: optionalString(value.icon, `${location}.icon`),
    textDomain: optionalString(value.textDomain, `${location}.textDomain`),
    wordpress: optionalString(value.wordpress, `${location}.wordpress`),
    directory,
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
      : enumAt(value.mode, `${location}.mode`, ['all', 'contentOnly', 'none'] as const),
    move: optionalBoolean(value.move, `${location}.move`),
    remove: optionalBoolean(value.remove, `${location}.remove`),
    insert: optionalBoolean(value.insert, `${location}.insert`),
  });
}

function normalizeStyles(input: unknown, location: string): AuthoringStyles {
  const value = objectAt(input, location);
  knownKeys(value, location, ['strategy', 'outcomes']);
  return {
    strategy: value.strategy === undefined
      ? 'native'
      : enumAt(value.strategy, `${location}.strategy`, ['native', 'scoped-css', 'mixed'] as const),
    outcomes: arrayAt(value.outcomes ?? [], `${location}.outcomes`).map((outcome, index) =>
      normalizeStyleOutcome(outcome, `${location}.outcomes[${index}]`),
    ),
  };
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
  knownKeys(value, location, ['id', 'source', 'kind', 'destination', 'status', 'required']);
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
