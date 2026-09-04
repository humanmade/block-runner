import { hashAuthoringPlan, type AuthoringPlan } from './schema.js';

/**
 * Extra facts collected by the caller for a particular destination.  They deliberately live
 * outside the plan: a plan can be inspected without granting it authority to write anywhere.
 */
export interface AuthoringPreviewContext {
  /** SHA-256 of the canonical plan, normally including the generator version. */
  hash?: string;
  /** SHA-256 confirmation that additionally binds this preview's destination snapshot. */
  confirmationHash?: string;
  /** Absolute or display-safe destination selected for this invocation. */
  destination?: string;
  /** Opaque fingerprint of the destination observed while previewing. */
  destinationFingerprint?: string;
}

export interface AuthoringPreviewOptions extends AuthoringPreviewContext {
  /** Terminal column count. Defaults to the current stdout width, or 80 when unavailable. */
  width?: number;
  /**
   * Kept for callers which share output options with other commands. Preview intentionally emits
   * no escape sequences, so `NO_COLOR` is always honoured and this option has no visual effect.
   */
  color?: boolean;
}

type RecordValue = Record<string, unknown>;

/**
 * Render an inspectable, non-interactive preview of an authoring plan.
 *
 * The renderer has no I/O and never emits terminal escapes. The CLI may use the same renderer for
 * a TTY and redirected output without risking ANSI in a machine-readable channel. Its only source
 * of nondeterminism would be a terminal width, which is an explicit option and defaults to 80 in
 * non-terminal environments.
 */
export function renderAuthoringPreview(plan: AuthoringPlan, options: AuthoringPreviewOptions = {}): string {
  const width = previewWidth(options.width);
  const value = asRecord(plan);
  const target = asRecord(value.target);
  const lines: string[] = [];

  heading(lines, 'Authoring plan preview', width, '=');
  addKeyValue(lines, 'Plan version', value.version, width);
  addKeyValue(lines, 'Generator version', value.generatorVersion, width);
  addKeyValue(lines, 'Plan SHA-256', options.hash ?? hashAuthoringPlan(plan), width);
  addKeyValue(lines, 'Confirmation SHA-256', options.confirmationHash, width);

  section(lines, 'Target', width);
  const namespace = readString(target, ['namespace']);
  const name = readString(target, ['name']);
  addKeyValue(lines, 'Block', namespace && name ? `${namespace}/${name}` : name || namespace, width);
  addKeyValue(lines, 'Title', target.title, width);
  addKeyValue(lines, 'Description', target.description, width);
  addKeyValue(lines, 'Category', target.category, width);
  addKeyValue(lines, 'Icon', target.icon, width);
  addKeyValue(lines, 'Text domain', target.textDomain ?? target.textdomain, width);
  addKeyValue(lines, 'WordPress', target.wordpress, width);
  const destination = options.destination ?? readString(target, ['directory', 'destination', 'outputDir']);
  addKeyValue(lines, 'Destination', destination, width);
  addKeyValue(lines, 'Destination fingerprint', options.destinationFingerprint, width);

  section(lines, 'Structure', width);
  const structure = asArray(value.structure);
  if (structure.length === 0) {
    bullet(lines, 'none', width);
  } else {
    structure.forEach((node, index) => renderStructureNode(lines, node, '', index === structure.length - 1, width));
  }
  const locking = asRecord(value.locking);
  if (Object.keys(locking).length > 0) {
    bullet(lines, `locking: ${describeLocking(locking)}`, width);
  }

  section(lines, 'Editable fields', width);
  const fields = asArray(value.fields);
  if (fields.length === 0) {
    bullet(lines, 'none', width);
  } else {
    fields.forEach((field, index) => bullet(lines, describeField(field, index), width));
  }

  section(lines, 'Style outcomes', width);
  const styles = asRecord(value.styles);
  const strategy = readString(styles, ['strategy']);
  if (strategy) {
    bullet(lines, `strategy: ${strategy}`, width);
  }
  const outcomes = asArray(styles.outcomes);
  if (outcomes.length === 0) {
    bullet(lines, 'none', width);
  } else {
    outcomes.forEach((outcome, index) => bullet(lines, describeStyleOutcome(outcome, index), width));
  }

  section(lines, 'Assets', width);
  const assets = asArray(value.assets);
  if (assets.length === 0) {
    bullet(lines, 'none', width);
  } else {
    assets.forEach((asset, index) => bullet(lines, describeAsset(asset, index), width));
  }

  section(lines, 'Pattern readiness', width);
  const pattern = asRecord(value.pattern);
  const ready = pattern.ready;
  bullet(lines, ready === true ? 'ready' : ready === false ? 'not ready' : 'not specified', width);
  const overrides = asArray(pattern.overrides);
  if (overrides.length === 0) {
    bullet(lines, 'overrides: none', width);
  } else {
    overrides.forEach((override, index) => bullet(lines, `[override] ${describeItem(override, index)}`, width));
  }

  section(lines, 'Planned files', width);
  const files = asArray(value.files);
  if (files.length === 0) {
    bullet(lines, 'none', width);
  } else {
    files.forEach((file, index) => bullet(lines, describeFile(file, index), width));
  }

  section(lines, 'Warnings', width);
  const warnings = asArray(value.warnings);
  if (warnings.length === 0) {
    bullet(lines, 'none', width);
  } else {
    warnings.forEach((warning) => bullet(lines, plain(warning), width));
  }

  section(lines, 'Write status', width);
  bullet(lines, 'No files written.', width);

  return `${lines.join('\n')}\n`;
}

/** Alias kept concise for programmatic consumers. */
export const previewAuthoringPlan = renderAuthoringPreview;

function renderStructureNode(lines: string[], value: unknown, prefix: string, last: boolean, width: number): void {
  const node = asRecord(value);
  const branch = prefix ? `${prefix}${last ? '`- ' : '|- '}` : '- ';
  const block = readString(node, ['block', 'name', 'type']) ?? 'unnamed block';
  const label = readString(node, ['label']);
  const id = readString(node, ['id']);
  const identity = [
    label && label !== block ? `${block} (${label})` : block,
    id ? `#${id}` : undefined,
  ]
    .filter(Boolean)
    .join(' ');
  const annotations = structureAnnotations(node);
  wrapped(lines, `${branch}${identity}${annotations.length > 0 ? ` ${annotations.join(' ')}` : ''}`, width, prefix ? `${prefix}${last ? '   ' : '|  '}` : '  ');

  const children = asArray(node.children ?? node.innerBlocks);
  const nextPrefix = prefix ? `${prefix}${last ? '   ' : '|  '}` : '  ';
  if (node.attributes !== undefined) {
    wrapped(lines, `${nextPrefix}attributes: ${stableJson(node.attributes)}`, width, `${nextPrefix}  `);
  }
  children.forEach((child, index) => renderStructureNode(lines, child, nextPrefix, index === children.length - 1, width));
}

function structureAnnotations(node: RecordValue): string[] {
  const annotations: string[] = [];
  const state = readString(node, ['mode', 'role', 'state']);
  if (state && isFieldMode(state)) {
    annotations.push(`[${state}]`);
  } else if (node.locked === true || node.editable === false) {
    annotations.push('[fixed]');
  } else if (node.editable === true) {
    annotations.push('[editable]');
  }
  if (node.locked === true && !annotations.includes('[fixed]')) {
    annotations.push('[locked]');
  }
  const lock = asRecord(node.lock);
  if (Object.keys(lock).length > 0) {
    const operations: string[] = [];
    if (typeof lock.move === 'boolean') {
      operations.push(`move=${lock.move ? 'allowed' : 'blocked'}`);
    }
    if (typeof lock.remove === 'boolean') {
      operations.push(`remove=${lock.remove ? 'allowed' : 'blocked'}`);
    }
    if (operations.length > 0) {
      annotations.push(`[${operations.join(',')}]`);
    }
  }
  return annotations;
}

function describeLocking(locking: RecordValue): string {
  const mode = readString(locking, ['mode']) ?? 'not specified';
  const permissions: string[] = [];
  for (const [name, enabled] of [
    ['move', locking.move ?? locking.allowMove],
    ['remove', locking.remove ?? locking.allowRemove],
    ['insert', locking.insert ?? locking.allowInsert],
  ] as Array<[string, unknown]>) {
    if (typeof enabled === 'boolean') {
      permissions.push(`${name}=${enabled ? 'allowed' : 'blocked'}`);
    }
  }
  return permissions.length > 0 ? `${mode} (${permissions.join(', ')})` : mode;
}

function describeField(value: unknown, index: number): string {
  const field = asRecord(value);
  const mode = fieldMode(field);
  const id = readString(field, ['id', 'name', 'key']);
  const label = readString(field, ['label']);
  const name = label && label !== id ? `${label} (${id})` : label ?? id ?? `field ${index + 1}`;
  const type = readString(field, ['type', 'fieldType', 'kind']);
  const path = readString(field, ['path', 'attribute', 'bind', 'binding']);
  const node = readString(field, ['node']);
  const description = readString(field, ['description', 'help']);
  const defaultValue = field.default ?? field.defaultValue;
  const details = [
    type && !isFieldMode(type) ? type : undefined,
    node ? `node ${node}` : undefined,
    path ? `at ${path}` : undefined,
    defaultValue === undefined ? undefined : `default ${describeScalar(defaultValue)}`,
    description,
  ].filter((part): part is string => Boolean(part));
  return `[${mode}] ${name}${details.length > 0 ? ` - ${details.join('; ')}` : ''}`;
}

function describeStyleOutcome(value: unknown, index: number): string {
  const outcome = asRecord(value);
  const subject = readString(outcome, ['property', 'source', 'name', 'selector', 'id']) ?? `style ${index + 1}`;
  const result = readString(outcome, ['outcome', 'result', 'handling', 'destination', 'value']);
  const styleValue = readString(outcome, ['value']);
  const token = readString(outcome, ['token']);
  const reason = readString(outcome, ['reason', 'note', 'detail']);
  return [
    subject,
    result && result !== subject ? `-> ${result}` : undefined,
    token ? `token ${token}` : undefined,
    styleValue && styleValue !== result ? `value ${styleValue}` : undefined,
    reason,
  ]
    .filter(Boolean)
    .join('; ');
}

function describeAsset(value: unknown, index: number): string {
  const asset = asRecord(value);
  const source = readString(asset, ['source', 'path', 'url', 'name', 'id']) ?? `asset ${index + 1}`;
  const destination = readString(asset, ['destination', 'output', 'target']);
  const kind = readString(asset, ['kind', 'type']);
  const status = readString(asset, ['status']);
  const required = asset.required === true ? 'required' : asset.required === false ? 'optional' : undefined;
  return [
    kind ? `[${kind}] ${source}` : source,
    destination ? `-> ${destination}` : undefined,
    status ? `[${status}]` : undefined,
    required ? `[${required}]` : undefined,
  ]
    .filter(Boolean)
    .join(' ');
}

function describeFile(value: unknown, index: number): string {
  const file = asRecord(value);
  const path = readString(file, ['path', 'destination', 'name']) ?? `file ${index + 1}`;
  const kind = readString(file, ['kind', 'type']);
  const replacement =
    readString(file, ['operation', 'disposition', 'action']) ?? (file.replace === true || file.overwrite === true ? 'replace' : 'create');
  return `${path}${kind ? ` [${kind}]` : ''} [${replacement}]`;
}

function describeItem(value: unknown, index: number): string {
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return plain(value);
  }
  const item = asRecord(value);
  const primary = readString(item, ['name', 'path', 'field', 'id', 'source', 'property']) ?? `item ${index + 1}`;
  const label = readString(item, ['label']);
  const identity = label && label !== primary ? `${label} (${primary})` : primary;
  const secondary = readString(item, ['description', 'target', 'attribute', 'value', 'reason']);
  return secondary && secondary !== identity ? `${identity} - ${secondary}` : identity;
}

function fieldMode(field: RecordValue): 'fixed' | 'editable' | 'override' {
  const supplied = readString(field, ['mode', 'role', 'state', 'editability']);
  if (supplied && isFieldMode(supplied)) {
    return supplied;
  }
  if (field.overridable === true || field.override === true) {
    return 'override';
  }
  return field.editable === false || field.locked === true ? 'fixed' : 'editable';
}

function isFieldMode(value: string): value is 'fixed' | 'editable' | 'override' {
  return value === 'fixed' || value === 'editable' || value === 'override';
}

function heading(lines: string[], label: string, width: number, fill: '=' | '-'): void {
  wrapped(lines, label, width, '');
  lines.push(fill.repeat(Math.max(1, Math.min(width, label.length))));
}

function section(lines: string[], label: string, width: number): void {
  lines.push('');
  heading(lines, label, width, '-');
}

function addKeyValue(lines: string[], key: string, value: unknown, width: number): void {
  if (value === undefined || value === null || value === '') {
    return;
  }
  wrapped(lines, `${key}: ${describeScalar(value)}`, width, '  ');
}

function bullet(lines: string[], value: string, width: number): void {
  wrapped(lines, `- ${value}`, width, '  ');
}

function wrapped(lines: string[], value: string, width: number, continuation: string): void {
  // `plain` intentionally trims untrusted values; retain only renderer-owned leading spaces so
  // the ASCII tree remains a tree while plan text cannot manufacture indentation or controls.
  const indentation = /^ */.exec(value)?.[0] ?? '';
  const text = `${indentation}${plain(value.slice(indentation.length))}`;
  if (text.length <= width) {
    lines.push(text);
    return;
  }

  const firstBreak = preferredBreak(text, width);
  lines.push(text.slice(0, firstBreak));
  let rest = text.slice(firstBreak).trimStart();
  // At exceptionally narrow widths preserving tree/list indentation would itself exceed the
  // terminal. Dropping it is preferable to emitting a line wider than requested.
  const continuationPrefix = continuation.length < width ? continuation : '';
  const available = Math.max(1, width - continuationPrefix.length);
  while (rest.length > available) {
    const breakAt = preferredBreak(rest, available);
    lines.push(`${continuationPrefix}${rest.slice(0, breakAt)}`);
    rest = rest.slice(breakAt).trimStart();
  }
  lines.push(`${continuationPrefix}${rest}`);
}

function preferredBreak(value: string, width: number): number {
  if (value.length <= width) {
    return value.length;
  }
  const space = value.lastIndexOf(' ', width);
  return space > 0 ? space : Math.max(1, width);
}

function previewWidth(width: number | undefined): number {
  const terminalWidth = typeof process !== 'undefined' ? process.stdout.columns : undefined;
  const requested = width ?? terminalWidth ?? 80;
  if (!Number.isFinite(requested)) {
    return 80;
  }
  return Math.max(1, Math.floor(requested));
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asRecord(value: unknown): RecordValue {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as RecordValue) : {};
}

function readString(record: RecordValue, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.length > 0) {
      return plain(value);
    }
  }
  return undefined;
}

function describeScalar(value: unknown): string {
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return plain(value);
  }
  if (value === null) {
    return 'null';
  }
  return stableJson(value);
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(', ')}]`;
  }
  if (value !== null && typeof value === 'object') {
    const record = value as RecordValue;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
      .join(', ')}}`;
  }
  return JSON.stringify(value) ?? 'undefined';
}

/** Remove escape/control bytes so plan content can never inject terminal formatting. */
function plain(value: unknown): string {
  return String(value)
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/[\x00-\x1f\x7f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
