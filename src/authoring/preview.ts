import { hashAuthoringPlan, type AuthoringPlan } from './schema.js';
import { deriveRegisteredBlockOutputFiles, REGISTERED_BLOCK_TEMPLATE_VERSION } from './generate.js';

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
  /** Exact destination paths inspected for this preview. */
  touchedFiles?: ReadonlyArray<AuthoringPreviewTouchedFile>;
}

/** A destination-bound output change shown before the confirmation hash. */
export interface AuthoringPreviewTouchedFile {
  /** Absolute path inspected by the preview. */
  path: string;
  /** The hash-bound operation selected for this compiler-owned output. */
  operation: 'create' | 'replace';
  /** Whether this exact path existed as a regular file during inspection. */
  exists?: boolean;
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
  renderReviewSummary(lines, value, options, width);

  section(lines, 'Plan identity', width);
  addKeyValue(lines, 'Plan version', value.version, width);
  addKeyValue(lines, 'Generator version', value.generatorVersion, width);
  addKeyValue(lines, 'Compiler template', REGISTERED_BLOCK_TEMPLATE_VERSION, width);

  const source = asRecord(value.source);
  if (Object.keys(source).length > 0) {
    section(lines, 'Source', width);
    addKeyValue(lines, 'Entry', source.entry, width);
    addKeyValue(lines, 'Format', source.format, width);
    addKeyValue(lines, 'Source SHA-256', source.sha256, width);
  }

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
  if (target.metadata !== undefined) {
    addKeyValue(lines, 'Native metadata', stableJson(target.metadata), width);
  }
  const destination = options.destination ?? readString(target, ['directory', 'destination', 'outputDir']);
  // The exact destination is part of the confirmation boundary, so it must remain copyable
  // even when a narrow terminal would otherwise split it across lines.
  addExactKeyValue(lines, 'Destination', destination);
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
  for (const key of ['rules', 'editorRules']) {
    const rules = asArray(styles[key]);
    if (rules.length) {
      bullet(lines, key === 'rules' ? 'Shared CSS (scoped beneath the block root):' : 'Editor-only CSS (scoped beneath the block root):', width);
      renderCssRules(lines, rules, width);
    }
  }
  const fonts = asArray(styles.fonts);
  if (fonts.length) {
    bullet(lines, 'Licensed fonts (shared by editor and frontend):', width);
    fonts.forEach((font, index) => bullet(lines, describeFont(font, index), width));
  }

  section(lines, 'Assets', width);
  const assets = asArray(value.assets);
  if (assets.length === 0) {
    bullet(lines, 'none', width);
  } else {
    assets.forEach((asset, index) => bullet(lines, describeAsset(asset, index), width));
  }

  const coverage = asRecord(value.coverage);
  if (Object.keys(coverage).length > 0) {
    section(lines, 'Analysis coverage', width);
    const coveredStyles = asArray(coverage.styles);
    const coveredAssets = asArray(coverage.assets);
    bullet(lines, `styles: ${coveredStyles.length} (${dispositionCounts(coveredStyles) || 'none'})`, width);
    coveredStyles.forEach((style, index) => bullet(lines, describeCoverageStyle(style, index), width));
    bullet(lines, `assets: ${coveredAssets.length} (${dispositionCounts(coveredAssets) || 'none'})`, width);
    coveredAssets.forEach((asset, index) => bullet(lines, describeCoverageAsset(asset, index), width));
    const stylesheet = asRecord(coverage.stylesheet);
    addKeyValue(lines, 'Effective stylesheet SHA-256', stylesheet.sha256, width);
    const editorStylesheet = asRecord(coverage.editorStylesheet);
    addKeyValue(lines, 'Editor stylesheet SHA-256', editorStylesheet.sha256, width);
    const styleContext = asRecord(coverage.styleContext);
    if (Object.keys(styleContext).length) {
      bullet(lines, `Style context: ${describeStyleContext(styleContext)}`, width);
    }
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
  // Output paths are compiler-owned. Derive them here so every public caller reviews the same
  // shape as CLI preview/write even when a declarative plan intentionally has files: [].
  const files = deriveRegisteredBlockOutputFiles(plan);
  if (files.length === 0) {
    bullet(lines, 'none', width);
  } else {
    files.forEach((file, index) => bullet(lines, describeFile(file, index), width));
  }

  if (options.touchedFiles) {
    section(lines, 'Destination changes', width);
    if (options.touchedFiles.length === 0) {
      bullet(lines, 'none', width);
    } else {
      options.touchedFiles.forEach((file) => renderTouchedFile(lines, file, width));
    }
  }

  section(lines, 'Warnings', width);
  const warnings = asArray(value.warnings);
  if (warnings.length === 0) {
    bullet(lines, 'none', width);
  } else {
    warnings.forEach((warning) => bullet(lines, plain(warning), width));
  }

  section(lines, 'Confirmation', width);
  // These values deliberately come after every authoritative tree, warning, decision, and
  // destination change. A compact summary helps a human orient themselves; it never replaces
  // the detail that the confirmation actually binds.
  const planHash = options.hash ?? hashAuthoringPlan(plan);
  if (options.confirmationHash) {
    // A confirmation is a copy-and-paste token. Keep each complete hash on one literal line
    // instead of wrapping it at the terminal width and making a reviewed value ambiguous.
    addExactKeyValue(lines, 'Plan SHA-256', planHash);
    addExactKeyValue(lines, 'Confirmation SHA-256', options.confirmationHash);
  } else {
    addKeyValue(lines, 'Plan SHA-256', planHash, width);
  }

  section(lines, 'Write status', width);
  bullet(lines, 'No files written.', width);

  return `${lines.join('\n')}\n`;
}

function describeStyleContext(context: RecordValue): string {
  const theme = asRecord(context.theme);
  const viewports = asRecord(context.viewports);
  const unresolved = asArray(context.unresolvedVariables).map(plain);
  const limitations = asArray(context.limitations).map(plain);
  const parts = [
    Object.keys(theme).length ? `theme ${readString(theme, ['slug']) ?? '<unnamed>'}${readString(theme, ['version']) ? ` ${readString(theme, ['version'])}` : ''}` : 'theme context unavailable',
    Object.keys(viewports).length ? `viewports ${stableJson(viewports)}` : 'viewport context unavailable',
    unresolved.length ? `unresolved variables ${unresolved.join(', ')}` : '',
    ...limitations.map((item) => `limit: ${item}`),
  ].filter(Boolean);
  return parts.join('; ');
}

/** Alias kept concise for programmatic consumers. */
export const previewAuthoringPlan = renderAuthoringPreview;

function renderReviewSummary(
  lines: string[],
  value: RecordValue,
  options: AuthoringPreviewOptions,
  width: number,
): void {
  section(lines, 'Review summary', width);
  const fields = asArray(value.fields).map(asRecord);
  const modes = new Map<'fixed' | 'editable' | 'override', number>([
    ['fixed', 0], ['editable', 0], ['override', 0],
  ]);
  fields.forEach((field) => modes.set(fieldMode(field), (modes.get(fieldMode(field)) ?? 0) + 1));
  bullet(
    lines,
    `Editing: ${modes.get('fixed')} fixed, ${modes.get('editable')} editable, ${modes.get('override')} override field${fields.length === 1 ? '' : 's'}.`,
    width,
  );

  const styles = asRecord(value.styles);
  const coverage = asRecord(value.coverage);
  const droppedStyles = asArray(styles.outcomes).filter((outcome) => readString(asRecord(outcome), ['outcome']) === 'dropped').length;
  const blockedCoverageStyles = asArray(coverage.styles).filter((style) => {
    const outcome = readString(asRecord(style), ['outcome']);
    return outcome === 'warned' || outcome === 'blocked';
  }).length;
  const unresolvedCoverageAssets = asArray(coverage.assets).filter((asset) => {
    const outcome = readString(asRecord(asset), ['outcome']);
    return outcome === 'unresolved' || outcome === 'blocked';
  }).length;
  const missingPlanAssets = asArray(value.assets).filter((asset) => readString(asRecord(asset), ['status']) === 'missing').length;
  const warnings = asArray(value.warnings).length;
  const unresolved = droppedStyles + blockedCoverageStyles + unresolvedCoverageAssets + missingPlanAssets;
  bullet(
    lines,
    unresolved || warnings
      ? `Unresolved decisions and losses: ${unresolved} style or asset issue${unresolved === 1 ? '' : 's'}; ${warnings} warning${warnings === 1 ? '' : 's'}.`
      : 'Unresolved decisions and losses: none; no warnings.',
    width,
  );

  const assets = asArray(value.assets).map(asRecord);
  const ownedAssets = assets.filter((asset) => readString(asset, ['status']) === 'ready' || readString(asset, ['destination']) !== undefined);
  const externalAssets = assets.filter((asset) => readString(asset, ['status']) === 'external');
  const licensedFonts = ownedAssets.filter((asset) => readString(asset, ['kind']) === 'font' && Object.keys(asRecord(asset.fontLicense)).length > 0);
  bullet(
    lines,
    `Asset ownership: ${ownedAssets.length} package-owned, ${externalAssets.length} external, ${licensedFonts.length} licensed bundled font${licensedFonts.length === 1 ? '' : 's'}.`,
    width,
  );

  const styleOwnership = styleOwnershipSummary(styles, coverage);
  bullet(
    lines,
    `Style ownership: ${styleOwnership.native} native-owned, ${styleOwnership.shared} package-owned shared, ${styleOwnership.editor} editor-only.`,
    width,
  );

  const touchedFiles = options.touchedFiles ?? [];
  const creates = touchedFiles.filter((file) => file.operation === 'create').length;
  const replacements = touchedFiles.filter((file) => file.operation === 'replace').length;
  const destination = options.destination ?? readString(asRecord(value.target), ['directory', 'destination', 'outputDir']);
  if (destination || touchedFiles.length > 0) {
    bullet(
      lines,
      `Destination changes: ${destination ? 'selected destination' : 'destination not supplied'}; ${creates} create, ${replacements} replacement${replacements === 1 ? '' : 's'}${replacements ? ' requiring explicit hash-bound approval' : ''}. Exact paths follow below.`,
      width,
    );
  }
}

function styleOwnershipSummary(styles: RecordValue, coverage: RecordValue): {
  native: number;
  shared: number;
  editor: number;
} {
  const ledger = asArray(coverage.styles).map(asRecord);
  if (ledger.length > 0) {
    return {
      native: ledger.filter((style) => readString(style, ['scope']) === 'shared'
        && ['native', 'preset', 'literal'].includes(readString(style, ['outcome']) ?? '')).length,
      shared: ledger.filter((style) => readString(style, ['scope']) === 'shared'
        && readString(style, ['outcome']) === 'scoped-css').length,
      editor: ledger.filter((style) => readString(style, ['scope']) === 'editor'
        && readString(style, ['outcome']) === 'scoped-css').length,
    };
  }

  const outcomes = asArray(styles.outcomes).map(asRecord);
  return {
    native: outcomes.filter((outcome) => ['native', 'token'].includes(readString(outcome, ['outcome']) ?? '')).length,
    shared: outcomes.filter((outcome) => readString(outcome, ['outcome']) === 'scoped-css').length
      + cssDeclarationCount(asArray(styles.rules)),
    editor: cssDeclarationCount(asArray(styles.editorRules)),
  };
}

function cssDeclarationCount(rules: unknown[]): number {
  return rules.reduce<number>((count, input) => {
    const rule = asRecord(input);
    if (rule.kind === 'conditional') return count + cssDeclarationCount(asArray(rule.rules));
    return count + asArray(rule.declarations).length;
  }, 0);
}

function renderCssRules(lines: string[], rules: unknown[], width: number, prefix = ''): void {
  for (const input of rules) {
    const rule = asRecord(input);
    if (rule.kind === 'conditional') {
      renderCssRules(lines, asArray(rule.rules), width, `${prefix}@${plain(rule.name)} ${plain(rule.prelude)} > `);
    } else {
      const declarations = asArray(rule.declarations).map((inputDeclaration) => {
        const declaration = asRecord(inputDeclaration);
        return `${plain(declaration.property)}: ${plain(declaration.value)}${declaration.important === true ? ' !important' : ''}`;
      }).join('; ');
      bullet(lines, `${prefix}${plain(rule.selector)} { ${declarations} }`, width);
    }
  }
}

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
      operations.push(`move=${lock.move ? 'blocked' : 'allowed'}`);
    }
    if (typeof lock.remove === 'boolean') {
      operations.push(`remove=${lock.remove ? 'blocked' : 'allowed'}`);
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
  const license = asRecord(asset.fontLicense);
  const licenseRecord = Object.keys(license).length > 0
    ? `license ${readString(license, ['license']) ?? 'recorded'}${readString(license, ['ownership']) ? ` (${readString(license, ['ownership'])})` : ''}`
    : undefined;
  return [
    kind ? `[${kind}] ${source}` : source,
    destination ? `-> ${destination}` : undefined,
    status ? `[${status}]` : undefined,
    required ? `[${required}]` : undefined,
    licenseRecord,
    readString(asset, ['sha256']) ? `sha256:${readString(asset, ['sha256'])}` : undefined,
    ...asArray(asset.uses).map((use) => {
      const value = asRecord(use);
      return `${readString(value, ['node'])}.${readString(value, ['attribute'])}`;
    }),
  ]
    .filter(Boolean)
    .join(' ');
}

function describeFont(value: unknown, index: number): string {
  const font = asRecord(value);
  const family = readString(font, ['family']) ?? `font ${index + 1}`;
  const assetId = readString(font, ['assetId', 'asset']) ?? 'unbound asset';
  const descriptors = ['fontStyle', 'fontWeight', 'fontStretch', 'fontDisplay', 'unicodeRange']
    .map((key) => {
      const value = readString(font, [key]);
      return value ? `${key} ${value}` : undefined;
    })
    .filter((value): value is string => Boolean(value));
  return `${family} <- ${assetId}${descriptors.length ? ` (${descriptors.join('; ')})` : ''}`;
}

function describeCoverageStyle(value: unknown, index: number): string {
  const style = asRecord(value);
  const scope = readString(style, ['scope']) ?? 'shared';
  const property = readString(style, ['property']) ?? `style ${index + 1}`;
  const styleValue = readString(style, ['value']);
  const outcome = readString(style, ['outcome']) ?? 'unclassified';
  const reason = readString(style, ['reason']);
  return `${scope}: ${property}${styleValue !== undefined ? `: ${styleValue}` : ''} -> ${outcome}${reason ? ` (${reason})` : ''}`;
}

function describeCoverageAsset(value: unknown, index: number): string {
  const asset = asRecord(value);
  const reference = readString(asset, ['reference']) ?? `asset ${index + 1}`;
  const outcome = readString(asset, ['outcome']) ?? 'unclassified';
  const rewritten = readString(asset, ['rewritten']);
  const destination = readString(asset, ['destination']);
  const reason = readString(asset, ['reason']);
  return `${reference} -> ${outcome}${rewritten ? ` (${rewritten})` : ''}${destination ? ` [${destination}]` : ''}${reason ? ` — ${reason}` : ''}`;
}

function dispositionCounts(values: unknown[]): string {
  const counts = new Map<string, number>();
  for (const value of values) {
    const outcome = readString(asRecord(value), ['outcome']) ?? 'unclassified';
    counts.set(outcome, (counts.get(outcome) ?? 0) + 1);
  }
  return [...counts].map(([outcome, count]) => `${outcome} ${count}`).join(', ');
}

function describeFile(value: unknown, index: number): string {
  const file = asRecord(value);
  const path = readString(file, ['path', 'destination', 'name']) ?? `file ${index + 1}`;
  const kind = readString(file, ['kind', 'type']);
  const replacement =
    readString(file, ['operation', 'disposition', 'action']) ?? (file.replace === true || file.overwrite === true ? 'replace' : 'create');
  return `${path}${kind ? ` [${kind}]` : ''} [${replacement}]`;
}

function renderTouchedFile(lines: string[], file: AuthoringPreviewTouchedFile, width: number): void {
  addExactKeyValue(lines, file.operation === 'replace' ? 'Replacement path' : 'Create path', file.path);
  bullet(lines, describeTouchedFile(file), width);
}

function describeTouchedFile(file: AuthoringPreviewTouchedFile): string {
  if (file.operation === 'replace') {
    return `[replace; ${file.exists ? 'existing file' : 'path currently absent'}; explicit hash-bound replacement approval required]`;
  }
  return `[create; ${file.exists ? 'conflict: existing file' : 'path currently absent'}]`;
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

function addExactKeyValue(lines: string[], key: string, value: unknown): void {
  if (value === undefined || value === null || value === '') {
    return;
  }
  lines.push(`${key}: ${plain(value)}`);
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
