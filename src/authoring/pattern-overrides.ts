import type { AuthoringEditableField, AuthoringTemplate } from '../types.js';
import {
  PATTERN_OVERRIDE_SOURCE,
  isPatternOverrideBinding,
  patternOverrideNameFor,
  supportedPatternOverrideAttributes,
} from './overrides.js';

export interface PatternOverrideBinding {
  name: string;
  block: string;
  attribute: string;
  path: readonly number[];
}

export interface PatternOverrideContract {
  ok: boolean;
  bindings: PatternOverrideBinding[];
  errors: string[];
}

/**
 * Inspect the compiler's template before it is written into a synced pattern.
 * This is deliberately structural validation, not an invented render layer:
 * WordPress still owns binding resolution and core/block persistence.
 */
export function validatePatternOverrideContract(
  template: AuthoringTemplate,
  fields: readonly AuthoringEditableField[],
): PatternOverrideContract {
  const bindings: PatternOverrideBinding[] = [];
  const errors: string[] = [];
  const seenNames = new Set<string>();

  const visit = (nodes: AuthoringTemplate, ancestry: number[]): void => {
    nodes.forEach(([block, attributes, children], index) => {
      const path = [...ancestry, index];
      const metadata = attributes.metadata;
      const name = metadataName(metadata);
      const bindingMap = metadataBindings(metadata);
      const nativeAttributes = supportedPatternOverrideAttributes(block);

      if (bindingMap?.innerBlocks) {
        errors.push(`${block} at ${path.join('.')} attempts to bind structural innerBlocks.`);
      }

      for (const [attribute, binding] of Object.entries(bindingMap ?? {})) {
        if (!isPatternOverrideBinding(binding)) {
          errors.push(`${block}.${attribute} at ${path.join('.')} uses a non-${PATTERN_OVERRIDE_SOURCE} source.`);
          continue;
        }
        if (!name) {
          errors.push(`${block}.${attribute} at ${path.join('.')} has a pattern override binding without metadata.name.`);
          continue;
        }
        if (attribute === '__default') {
          if (nativeAttributes.length === 0) errors.push(`${block} at ${path.join('.')} has no supported native pattern fields.`);
          bindings.push(...nativeAttributes.map((attribute) => ({ name, block, attribute, path })));
          continue;
        }
        if (!isPatternOverrideBinding(bindingMap?.__default)) {
          errors.push(`${block} at ${path.join('.')} is missing the native __default pattern override binding.`);
          continue;
        }
        if (!nativeAttributes.includes(attribute)) {
          errors.push(`${block}.${attribute} at ${path.join('.')} is not a supported WordPress 7.1 pattern override attribute.`);
          continue;
        }
        bindings.push({ name, block, attribute, path });
      }

      if (name && bindingMap && Object.keys(bindingMap).some((attribute) => isPatternOverrideBinding(bindingMap[attribute]))) {
        if (seenNames.has(name)) {
          errors.push(`Pattern override metadata.name ${JSON.stringify(name)} appears more than once.`);
        }
        seenNames.add(name);
      }

      if (children) visit(children, path);
    });
  };

  visit(template, []);

  for (const field of fields) {
    if (!field.overrideName) continue;
    const found = bindings.some((binding) => binding.name === field.overrideName
      && binding.block === field.block
      && binding.attribute === field.attribute);
    if (!found) {
      errors.push(`Required override ${field.path}.${field.attribute} is missing its core/pattern-overrides binding.`);
    }
  }

  return { ok: errors.length === 0, bindings, errors };
}

/**
 * Canonical shape WordPress stores in core/block.content for one synced-pattern
 * instance. Callers supply values by metadata.name; no cloned InnerBlocks tree
 * is ever synthesized.
 */
export function patternOverrideContent(
  values: Readonly<Record<string, Readonly<Record<string, unknown>>>>,
): Record<string, Record<string, unknown>> {
  return Object.fromEntries(
    Object.entries(values).map(([name, attributes]) => [name, { ...attributes }]),
  );
}

export function templateOverrideName(
  attributes: Readonly<Record<string, unknown>>,
  attribute: string,
): string | undefined {
  return patternOverrideNameFor(attributes, attribute);
}

function metadataName(metadata: unknown): string | undefined {
  return metadata && typeof metadata === 'object' && !Array.isArray(metadata)
    && typeof (metadata as { name?: unknown }).name === 'string'
    ? (metadata as { name: string }).name
    : undefined;
}

function metadataBindings(metadata: unknown): Record<string, unknown> | undefined {
  const value = metadata && typeof metadata === 'object' && !Array.isArray(metadata)
    ? (metadata as { bindings?: unknown }).bindings
    : undefined;
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}
