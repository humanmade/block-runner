import type { CssDeclaration, CssRule } from './styles.js';

export interface ResponsiveCascadeCandidate {
  /** The source selector whose one declaration is proposed for native state transport. */
  selector: string;
  /** The CSS scanner identity of that exact source declaration. */
  declarationId: string;
  property: string;
}

interface RuleDeclaration {
  selector: string;
  declaration: CssDeclaration;
  conditions: readonly string[];
}

/**
 * Returns true unless a responsive declaration can be lifted without changing the source
 * cascade. WordPress state rules are `!important`, so this deliberately refuses uncertain cases
 * instead of trying to reproduce selector specificity or source-order interactions.
 */
export function hasUnsafeResponsiveNativeCascade(input: {
  document: Document;
  rules: readonly CssRule[];
  candidate: ResponsiveCascadeCandidate;
}): boolean {
  const property = input.candidate.property.toLowerCase();
  const targets = selectTargets(input.document, input.candidate.selector);
  if (!targets) return true;
  const declarations = flattenDeclarations(input.rules);
  const candidateOffset = declarations.find((item) => item.declaration.id === input.candidate.declarationId)?.declaration.source.start.offset;
  if (candidateOffset === undefined) return true;

  for (const target of targets) {
    if (hasInlineCascadeConflict(target, property)) return true;
  }

  for (const item of declarations) {
    if (item.declaration.id === input.candidate.declarationId) continue;
    if (!coversProperty(item.declaration.property, property)) continue;
    if (isSafeEarlierSameSelectorBase(item, input.candidate, property, candidateOffset)) continue;
    if (selectorMayMatchAnyTarget(item.selector, targets)) return true;
  }
  return false;
}

/**
 * Finds ordinary source declarations that must not be promoted to an inline/native base style.
 * An inline base style outranks ordinary stylesheet declarations, so a source media or pseudo
 * override that used to win would otherwise stop applying. The sole permitted competing shape is
 * an unconditional, normal declaration with the identical selector and longhand property; the
 * existing source-order native conversion owns that simple cascade.
 */
export function baseStyleDeclarationIdsRequiringScopedCss(input: {
  document: Document;
  rules: readonly CssRule[];
}): ReadonlySet<string> {
  const declarations = flattenDeclarations(input.rules);
  const blocked = new Set<string>();

  for (const base of declarations) {
    if (base.conditions.length !== 0 || base.selector.includes(':')) continue;
    const targets = selectAllTargets(input.document, base.selector);
    if (!targets) continue;
    const property = base.declaration.property.toLowerCase();

    for (const competing of declarations) {
      if (competing.declaration.id === base.declaration.id) continue;
      if (!coversProperty(competing.declaration.property, property)) continue;
      if (isSafeUnconditionalSameSelectorLonghand(base, competing, property)) continue;
      if (selectorMayMatchAnyTarget(competing.selector, targets)) {
        blocked.add(base.declaration.id);
        break;
      }
    }
  }
  return blocked;
}

function selectTargets(document: Document, selector: string): Element[] | undefined {
  const targets = selectAllTargets(document, selector);
  return targets?.length === 1 ? targets : undefined;
}

function selectAllTargets(document: Document, selector: string): Element[] | undefined {
  try {
    const targets = [...document.querySelectorAll(selector)];
    return targets.length ? targets : undefined;
  } catch {
    return undefined;
  }
}

function hasInlineCascadeConflict(target: Element, property: string): boolean {
  const style = (target as HTMLElement).style;
  if (!style) return false;
  for (let index = 0; index < style.length; index += 1) {
    if (coversProperty(style.item(index), property)) return true;
  }
  return false;
}

function flattenDeclarations(rules: readonly CssRule[], conditions: readonly string[] = []): RuleDeclaration[] {
  return rules.flatMap((rule): RuleDeclaration[] => {
    if (rule.kind === 'conditional') return flattenDeclarations(rule.rules, [...conditions, rule.id]);
    if (rule.kind !== 'style') return [];
    return rule.declarations.map((declaration) => ({ selector: rule.selector, declaration, conditions }));
  });
}

function coversProperty(source: string, target: string): boolean {
  const property = source.toLowerCase();
  if (property === target || property === 'all') return true;
  if (property === 'font') return isFontProperty(target) || target === 'line-height';
  if (property === 'background') return target.startsWith('background-');
  for (const family of [ 'margin', 'padding' ]) {
    if (property === family || property === `${family}-block` || property === `${family}-inline`) {
      return target.startsWith(`${family}-`);
    }
  }
  // Logical and physical border shorthands overlap through writing-mode-dependent mappings.
  // Treat every border shorthand as covering every border longhand rather than guessing that map.
  return (property === 'border' || property.startsWith('border-')) && target.startsWith('border-');
}

function isFontProperty(property: string): boolean {
  return property === 'font' || property.startsWith('font-');
}

function isSafeEarlierSameSelectorBase(
  item: RuleDeclaration,
  candidate: ResponsiveCascadeCandidate,
  property: string,
  candidateOffset: number,
): boolean {
  // At the responsive interval, a prior normal base declaration on exactly the same selector
  // loses to the candidate in ordinary CSS just as it loses to the emitted WP state CSS.
  // Do not generalize this across selectors, conditions, priorities, shorthands, or source order.
  return item.conditions.length === 0
    && !item.declaration.important
    && item.selector.trim() === candidate.selector.trim()
    && item.declaration.property.toLowerCase() === property
    && item.declaration.source.start.offset < candidateOffset;
}

function isSafeUnconditionalSameSelectorLonghand(
  base: RuleDeclaration,
  competing: RuleDeclaration,
  property: string,
): boolean {
  return competing.conditions.length === 0
    && !base.declaration.important
    && !competing.declaration.important
    && !competing.selector.includes(':')
    && base.selector.trim() === competing.selector.trim()
    && competing.declaration.property.toLowerCase() === property;
}

function selectorMayMatchAnyTarget(selector: string, targets: readonly Element[]): boolean {
  // A pseudo-state is not active in the static JSDOM source document. Remove it only to ask
  // whether its non-state selector targets the same source node; malformed/complex leftovers
  // fail closed below. Removing `:not()` may broaden the selector, which is conservative.
  const comparable = selector.includes(':') ? selector.replace(/::?[-_a-zA-Z][-_a-zA-Z0-9]*(?:\([^()]*\))?/g, '') : selector;
  if (!comparable.trim()) return true;
  try {
    return targets.some((target) => target.matches(comparable));
  } catch {
    return true;
  }
}
