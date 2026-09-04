import type {
  AuthoringDiagnostic,
  AuthoringEditableField,
  AuthoringNode,
  AuthoringPlan,
  AuthoringRole,
  AuthoringTemplate,
  CompiledAuthoringBlock,
  InnerBlocksLock,
} from '../types.js';
import { applyPatternOverrides, isPatternOverrideBinding, patternOverrideNameFor, supportedPatternOverrideAttributes } from './overrides.js';
import { compileRegisteredBlock } from './generate.js';
import { validateAuthoringPlan, type AuthoringPlan as CanonicalPlan, type AuthoringStructureNode, type JsonValue } from './schema.js';

const ROLE_BLOCKS: Record<Exclude<AuthoringRole, 'wrapper' | 'custom'>, string> = {
  group: 'core/group',
  columns: 'core/columns',
  column: 'core/column',
  cover: 'core/cover',
  heading: 'core/heading',
  paragraph: 'core/paragraph',
  image: 'core/image',
  list: 'core/list',
  'list-item': 'core/list-item',
  buttons: 'core/buttons',
  button: 'core/button',
  quote: 'core/quote',
};

const VALID_LOCKS = new Set<InnerBlocksLock>([false, 'insert', 'all', 'contentOnly']);

/**
 * Compile a reviewed authoring plan into a deliberately small registered-block source package.
 *
 * The generated wrapper has no content attributes. Its complete editable state is the native
 * InnerBlocks template, which means WordPress owns the text, image, list, and button editor
 * surfaces and serializes them normally.
 */
export function compileAuthoringPlan(plan: AuthoringPlan): CompiledAuthoringBlock {
  const diagnostics: AuthoringDiagnostic[] = [];
  const paths = new Set<string>();
  const overrideNames = new Set<string>();
  const editableFields: AuthoringEditableField[] = [];

  // The wrapper does not own an editor field, but its path is still part of the same stable plan
  // namespace. Recording it catches accidental collisions with a child path.
  notePath(plan.root, paths, diagnostics);

  if (plan.root.role !== 'wrapper') {
    diagnostics.push({
      level: 'error',
      code: 'invalid-root',
      path: plan.root.path,
      message: 'An authoring plan root must use the wrapper role; only its children become InnerBlocks.',
    });
  }

  const template = (plan.root.children ?? []).map((node) => compileNode(
    node,
    paths,
    overrideNames,
    editableFields,
    diagnostics,
  ));
  const allowedBlocks = unique(plan.allowedBlocks ?? template.map(([block]) => block));
  const templateLock = normalizeLock(plan.templateLock, diagnostics);

  if (templateLock === 'contentOnly') {
    diagnostics.push({
      level: 'warning',
      code: 'gutenberg-76794',
      path: plan.root.path,
      message:
        'WordPress 7.1 exposes Edit pattern controls for a top-level custom block with contentOnly InnerBlocks (Gutenberg #76794). The runtime fixture observes those controls; this is upstream UI, not invalid-block or recovery state.',
    });
  }

  if (diagnostics.some((diagnostic) => diagnostic.level === 'error')) {
    return { files: {}, template, allowedBlocks, templateLock, editableFields, diagnostics };
  }
  // The semantic format is an input adapter, not a second implementation of
  // registered block source. Expose the exact plan callers can preview/confirm.
  const canonicalPlan = toCanonicalPlan(plan, template, allowedBlocks, templateLock, diagnostics);
  const generated = compileRegisteredBlock(canonicalPlan);
  const files = Object.fromEntries(generated.files.map(({ path, content }) => [path, content]));
  files['authoring.manifest.json'] = json({
    version: 1, rootPath: plan.root.path, templateLock, allowedBlocks,
    editableFields, diagnostics, generated: generated.manifest,
  });
  files['README.md'] = readme(templateLock);
  return { files, template: generated.template, allowedBlocks, templateLock, editableFields, diagnostics, canonicalPlan };
}

/** Alias kept readable for consumers that call the authoring API a compiler rather than a generator. */
export const compileAuthoringBlock = compileAuthoringPlan;

function compileNode(
  node: AuthoringNode,
  paths: Set<string>,
  overrideNames: Set<string>,
  editableFields: AuthoringEditableField[],
  diagnostics: AuthoringDiagnostic[],
): [string, Record<string, unknown>, AuthoringTemplate?] {
  notePath(node, paths, diagnostics);
  const block = blockFor(node, diagnostics);
  const attributes = initialAttributes(node, block);
  applyPatternOverrides(node, block, attributes, overrideNames, diagnostics);
  const children = childrenFor(node, block).map((child) => compileNode(
    child,
    paths,
    overrideNames,
    editableFields,
    diagnostics,
  ));
  const template: [string, Record<string, unknown>, AuthoringTemplate?] =
    children.length > 0 ? [block, attributes, children] : [block, attributes];

  editableFields.push(...editorSurfaces(node, block, attributes));
  noteCustomInnerBlocks(node, diagnostics);
  return template;
}

function notePath(node: AuthoringNode, paths: Set<string>, diagnostics: AuthoringDiagnostic[]): void {
  if (typeof node.path !== 'string' || node.path.trim() === '') {
    diagnostics.push({
      level: 'error',
      code: 'missing-path',
      message: 'Every AuthoringNode needs a non-empty stable path.',
    });
    return;
  }
  if (paths.has(node.path)) {
    diagnostics.push({
      level: 'error',
      code: 'duplicate-path',
      path: node.path,
      message: `AuthoringNode path ${JSON.stringify(node.path)} is used more than once.`,
    });
    return;
  }
  paths.add(node.path);
}

function blockFor(node: AuthoringNode, diagnostics: AuthoringDiagnostic[]): string {
  if (node.role === 'custom') {
    if (node.block) return node.block;
    diagnostics.push({
      level: 'error',
      code: 'unsupported-role',
      path: node.path,
      message: 'A custom AuthoringNode requires its registered child block name.',
    });
    return 'core/group';
  }
  if (node.role === 'wrapper') {
    diagnostics.push({
      level: 'error',
      code: 'unsupported-role',
      path: node.path,
      message: 'A wrapper is only valid as the plan root, never as a nested template node.',
    });
    return 'core/group';
  }
  const roleBlock = ROLE_BLOCKS[node.role];
  if (!roleBlock) {
    diagnostics.push({
      level: 'error',
      code: 'unsupported-role',
      path: node.path,
      message: `Authoring role ${JSON.stringify(node.role)} has no native Core block mapping.`,
    });
    return 'core/group';
  }
  if (node.block && node.block !== roleBlock) {
    diagnostics.push({
      level: 'warning',
      code: 'unsupported-role',
      path: node.path,
      message: `Ignoring ${JSON.stringify(node.block)} for ${node.role}; this role must remain ${roleBlock}.`,
    });
  }
  return roleBlock;
}

function initialAttributes(node: AuthoringNode, block: string): Record<string, unknown> {
  const attributes = { ...(node.attributes ?? {}) };
  switch (block) {
    case 'core/heading':
      attributes.content = node.content ?? asString(attributes.content, '');
      attributes.level = node.level ?? asNumber(attributes.level, 2);
      break;
    case 'core/paragraph':
    case 'core/list-item':
      attributes.content = node.content ?? asString(attributes.content, '');
      break;
    case 'core/image':
      attributes.url = node.url ?? asString(attributes.url, '');
      attributes.alt = node.alt ?? asString(attributes.alt, '');
      break;
    case 'core/button':
      attributes.text = node.content ?? asString(attributes.text, '');
      attributes.url = node.url ?? asString(attributes.url, '');
      break;
    case 'core/quote':
      // `value` is the pre-6.0 quote shape. WordPress 7.1 migrates it to inner blocks in the
      // editor, which makes a generated leaf quote invalid after reopening. Quote text belongs
      // to the explicit paragraph child emitted by childrenFor instead.
      delete attributes.value;
      break;
  }
  return attributes;
}

function childrenFor(node: AuthoringNode, block: string): AuthoringNode[] {
  const children = node.children ?? [];
  if (block !== 'core/quote') return children;

  const attributes = node.attributes ?? {};
  const hasLegacyValue = typeof attributes.value === 'string';
  const hasQuoteContent = node.content !== undefined || hasLegacyValue;

  // A leaf quote must still have a real Core paragraph editor surface. The derived path is stable
  // in the compiled plan and manifest, rather than reporting the quote's obsolete `value` field.
  if (children.length === 0 || hasQuoteContent) {
    return [
      {
        path: `${node.path}.content`,
        role: 'paragraph',
        content: node.content ?? asString(attributes.value, ''),
      },
      ...children,
    ];
  }
  return children;
}

function editorSurfaces(
  node: AuthoringNode,
  block: string,
  attributes: Record<string, unknown>,
): AuthoringEditableField[] {
  const withPath = (attribute: string, surface: AuthoringEditableField['surface']): AuthoringEditableField => ({
    path: node.path,
    role: node.role,
    block,
    attribute,
    surface,
    ...(patternOverrideNameFor(attributes, attribute)
      ? { overrideName: patternOverrideNameFor(attributes, attribute) }
      : {}),
  });

  switch (block) {
    case 'core/heading':
    case 'core/paragraph':
    case 'core/list-item':
      return 'content' in attributes ? [withPath('content', 'richText')] : [];
    case 'core/image':
      return [withPath('url', 'media'), withPath('alt', 'altText')];
    case 'core/button':
      return [withPath('text', 'richText'), withPath('url', 'link')];
    default:
      return [];
  }
}

function noteCustomInnerBlocks(node: AuthoringNode, diagnostics: AuthoringDiagnostic[]): void {
  const hasJustification = typeof node.justification === 'string' && node.justification.trim() !== '';
  if (node.role === 'custom' && !hasJustification) {
    diagnostics.push({
      level: 'warning',
      code: 'custom-child-justification-required',
      path: node.path,
      message:
        'A custom child block was requested without a justification. Keep one region on the wrapper; record why this child is necessary before it owns specialised structure.',
    });
    return;
  }
  if (!node.requiresOwnInnerBlocks || (node.role === 'custom' && hasJustification)) return;
  diagnostics.push({
    level: 'warning',
    code: 'multiple-innerblocks-regions',
    path: node.path,
    message:
      'This design needs another InnerBlocks region. Keep one region on the wrapper; introduce a custom child only after recording why its own region is necessary.',
  });
}

function normalizeLock(value: InnerBlocksLock | undefined, diagnostics: AuthoringDiagnostic[]): InnerBlocksLock {
  if (value === undefined) return false;
  if (VALID_LOCKS.has(value)) return value;
  // This protects consumers receiving plan JSON at runtime; TypeScript callers cannot reach it.
  diagnostics.push({
    level: 'error',
    code: 'invalid-root',
    message: `Unsupported template lock ${JSON.stringify(value)}.`,
  });
  return false;
}

function toCanonicalPlan(
  plan: AuthoringPlan,
  template: AuthoringTemplate,
  allowedBlocks: string[],
  templateLock: InnerBlocksLock,
  diagnostics: AuthoringDiagnostic[],
): CanonicalPlan {
  const fields: CanonicalPlan['fields'] = [];
  const overrides: CanonicalPlan['pattern']['overrides'] = [];
  const structureFor = (tuples: AuthoringTemplate, sources: AuthoringNode[]): AuthoringStructureNode[] =>
    tuples.map(([block, raw, children], index) => {
      const node = sources[index]!;
      const attributes = structuredClone(raw) as Record<string, JsonValue>;
      const metadata = attributes.metadata;
      if (metadata && typeof metadata === 'object' && !Array.isArray(metadata)
        && metadata.bindings && typeof metadata.bindings === 'object' && !Array.isArray(metadata.bindings)
        && Object.values(metadata.bindings).some((binding) => !isPatternOverrideBinding(binding))) {
        throw new Error(`Unsupported native binding at ${node.path}; generic Block Bindings cannot be discarded during plan adaptation.`);
      }
      const bound = metadata && typeof metadata === 'object' && !Array.isArray(metadata)
        && metadata.bindings && typeof metadata.bindings === 'object' && !Array.isArray(metadata.bindings)
        && '__default' in metadata.bindings;
      if (metadata && typeof metadata === 'object' && !Array.isArray(metadata)) {
        delete metadata.bindings;
      }
      // The legacy boolean enables a whole native region. Expand that exact
      // contract into individually reviewable canonical fields, including
      // optional image/button attributes absent from the initial content.
      const attributesToDeclare = bound ? supportedPatternOverrideAttributes(block)
        : editorSurfaces(node, block, raw).map(({ attribute }) => attribute);
      for (const attribute of attributesToDeclare) {
        const id = `${node.path}:${attribute}`;
        fields.push({ id, label: `${node.path} ${attribute}`, mode: bound ? 'override' : 'editable', node: node.path, attribute });
        if (bound) overrides.push({ field: id });
      }
      return {
        id: node.path, block, attributes,
        ...(children?.length ? { children: structureFor(children, childrenFor(node, block)) } : {}),
      };
    });
  const structure = structureFor(template, plan.root.children ?? []);
  return validateAuthoringPlan({
    version: 1, generatorVersion: '0.9.0',
    target: {
      name: plan.name, title: plan.title,
      ...(plan.description ? { description: plan.description } : {}),
      category: plan.category ?? 'design', icon: plan.icon ?? 'layout',
      ...(plan.textdomain ? { textDomain: plan.textdomain } : {}),
      wordpress: '7.1',
    },
    structure, allowedBlocks,
    fields, locking: { mode: templateLock === false ? 'none' : templateLock },
    styles: { strategy: 'native', outcomes: [] },
    pattern: { ready: overrides.length > 0, overrides },
    assets: [], files: [],
    warnings: diagnostics.filter(({ level }) => level === 'warning').map(({ path, message }) => `${path ?? 'plan'}: ${message}`),
  });
}

function readme(templateLock: InnerBlocksLock): string {
  const lock = templateLock === false ? '`false`' : `\`${templateLock}\``;
  const contentOnly =
    templateLock === 'contentOnly'
      ? '\n\n## WordPress 7.1 contentOnly limitation\n\nGutenberg #76794 exposes **Edit pattern** controls for a top-level custom block with `contentOnly` InnerBlocks. The WordPress 7.1 runtime fixture renders the Inspector and asserts that control is present. It is upstream UI, not invalid block markup or a recovery state. Changing the lock to `all` or `insert` changes the authoring model and is therefore not applied automatically.\n'
      : '';
  return `# Generated native InnerBlocks block\n\nThis package has one custom wrapper and one native InnerBlocks tree. Heading, paragraph, image, list, buttons, and button values are stored by their corresponding Core child blocks, not wrapper attributes.\n\nThe wrapper template lock is ${lock}: ${lockBehaviour(templateLock)} Its fixed direct-child allowlist is declared as top-level \`allowedBlocks\` in \`block.json\`; it is intentionally not a user-configurable support flag.\n${contentOnly}`;
}

function lockBehaviour(lock: InnerBlocksLock): string {
  switch (lock) {
    case false:
      return 'it explicitly opts out of an inherited template lock, so insertion, removal, and moving remain available subject to the direct-child allowlist.';
    case 'insert':
      return 'it prevents insertion and removal while allowing existing children to move.';
    case 'all':
      return 'it prevents insertion, removal, and moving.';
    case 'contentOnly':
      return 'it prevents structural operations and exposes only native content surfaces; a child cannot override this lock.';
  }
}

function json(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function unique(values: string[]): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    if (!seen.has(value)) {
      seen.add(value);
      result.push(value);
    }
  }
  return result;
}

function asString(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback;
}

function asNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}
