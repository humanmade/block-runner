import type { AuthoringDiagnostic, AuthoringNode } from '../types.js';

/**
 * WordPress 7.1's native, synced-pattern override source.  Deliberately keep
 * this literal: this authoring path does not implement generic Block Bindings.
 */
export const PATTERN_OVERRIDE_SOURCE = 'core/pattern-overrides';

type Metadata = {
  name?: unknown;
  bindings?: Record<string, unknown>;
  [key: string]: unknown;
};

/**
 * Only Core attributes whose rendered value WordPress 7.1 exposes to pattern
 * overrides.  This is intentionally a closed map; arbitrary custom attributes
 * need their own proven render contract.
 */
const SUPPORTED_ATTRIBUTES: Readonly<Record<string, readonly string[]>> = Object.freeze({
  'core/heading': ['content'],
  'core/paragraph': ['content'],
  'core/list-item': ['content'],
  'core/image': ['id', 'url', 'alt'],
  'core/button': ['text', 'url'],
});

export function supportedPatternOverrideAttributes(
  block: string,
  attributes: Readonly<Record<string, unknown>>,
): string[] {
  return (SUPPORTED_ATTRIBUTES[block] ?? []).filter((attribute) => attribute in attributes);
}

/**
 * Produce the stable key consumed by a synced pattern's
 * `core/block.content[metadata.name]` object.  It derives only from a
 * producer-owned plan path, never client IDs, random values, or source order.
 */
export function patternOverrideName(path: string): string {
  const normalized = path
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'field';
  return `block-runner-${normalized.slice(0, 48)}-${shortHash(path)}`;
}

/**
 * Attach an explicit binding to each supported native attribute.  The name is
 * block-level because that is WordPress's canonical storage shape: one
 * metadata.name identifies a map of overridden attributes on that block.
 */
export function applyPatternOverrides(
  node: AuthoringNode,
  block: string,
  attributes: Record<string, unknown>,
  names: Set<string>,
  diagnostics: AuthoringDiagnostic[],
): void {
  const wanted = node.patternOverrides !== false;
  const supported = supportedPatternOverrideAttributes(block, attributes);

  if (!wanted) {
    removePatternOverrideBindings(attributes);
    return;
  }

  if (supported.length === 0) {
    // Containers are structural by design and do not get a noisy diagnostic
    // unless a plan explicitly asks to override them.
    if (node.patternOverrides === true) {
      diagnostics.push({
        level: 'error',
        code: 'unsupported-pattern-override',
        path: node.path,
        message: `${JSON.stringify(block)} has no WordPress 7.1 pattern-overrideable native content attributes.`,
      });
    }
    removePatternOverrideBindings(attributes);
    return;
  }

  const name = patternOverrideName(node.path);
  if (names.has(name)) {
    diagnostics.push({
      level: 'error',
      code: 'duplicate-override-name',
      path: node.path,
      message: `Pattern override name ${JSON.stringify(name)} is not unique; give each content region a unique stable path.`,
    });
    removePatternOverrideBindings(attributes);
    return;
  }
  names.add(name);

  const metadata = metadataFor(attributes);
  const existingBindings = metadata.bindings;
  if (existingBindings && Object.values(existingBindings).some((binding) => !isPatternOverrideBinding(binding))) {
    diagnostics.push({
      level: 'error',
      code: 'unsupported-pattern-override',
      path: node.path,
      message: 'Generated blocks only emit the core/pattern-overrides binding source; remove custom, post-data, or meta bindings from this plan.',
    });
  }

  metadata.name = name;
  metadata.bindings = Object.fromEntries(
    supported.map((attribute) => [attribute, { source: PATTERN_OVERRIDE_SOURCE }]),
  );
  attributes.metadata = metadata;
}

export function patternOverrideNameFor(
  attributes: Readonly<Record<string, unknown>>,
  attribute: string,
): string | undefined {
  const metadata = attributes.metadata;
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return undefined;
  const { name, bindings } = metadata as Metadata;
  if (typeof name !== 'string' || !bindings || typeof bindings !== 'object') return undefined;
  return isPatternOverrideBinding(bindings[attribute]) ? name : undefined;
}

export function isPatternOverrideBinding(value: unknown): boolean {
  return Boolean(
    value
      && typeof value === 'object'
      && !Array.isArray(value)
      && (value as { source?: unknown }).source === PATTERN_OVERRIDE_SOURCE,
  );
}

function removePatternOverrideBindings(attributes: Record<string, unknown>): void {
  const value = attributes.metadata;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  const metadata = { ...(value as Metadata) };
  const bindings = metadata.bindings;
  if (!bindings || typeof bindings !== 'object' || Array.isArray(bindings)) return;
  const retained = Object.fromEntries(
    Object.entries(bindings).filter(([, binding]) => !isPatternOverrideBinding(binding)),
  );
  if (Object.keys(retained).length === 0) {
    delete metadata.bindings;
    delete metadata.name;
  } else {
    metadata.bindings = retained;
  }
  attributes.metadata = metadata;
}

function metadataFor(attributes: Record<string, unknown>): Metadata {
  const existing = attributes.metadata;
  return existing && typeof existing === 'object' && !Array.isArray(existing)
    ? { ...(existing as Metadata) }
    : {};
}

/** A compact deterministic FNV-1a hash; cryptographic identity is not needed. */
function shortHash(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36).padStart(7, '0');
}
