import { StylingRung, WpBlock } from '../types.js';
import { TokenInverseMap, matchColor } from '../tokens/repair.js';
import { CapabilitySource } from './capabilities.js';
import {
  BACKGROUND_COLOR_TARGET,
  GRADIENT_TARGET,
  StyleTarget,
  backgroundConsumption,
  classifyBackground,
  extractUrl,
  lookupDeclaration,
} from './declarations.js';
import {
  Declaration,
  OverriddenDeclaration,
  parseDeclarationBlock,
  parseInlineStyle,
  resolvePrecedence,
} from './parse.js';
import { backgroundWasConsumed } from './provenance.js';

/**
 * `!important` cannot survive into a block: WordPress writes the style object as plain declarations,
 * so the value lands but its cascade priority does not. That is a real fidelity deviation and is
 * reported rather than quietly normalised away.
 */
const IMPORTANT_DEVIATION =
  'mapped without its !important priority — WordPress writes block styles as plain declarations';

/**
 * Every authored declaration ends in exactly one of these. The three-way split is the point: a
 * report that warns about `display:flex` on a div that correctly became columns teaches the user
 * to ignore the report, and an ignored report is silent degradation wearing a hat.
 */
export type StyleOutcome = 'mapped' | 'consumed' | 'dropped' | 'overridden';

export interface StyleLedgerEntry {
  property: string;
  value: string;
  outcome: StyleOutcome;
  /** The class rule it was authored in (`.hero`), or undefined for an inline style attribute. */
  origin?: string;
  /** Whether it was authored `!important` — carried so the sidecar can preserve the priority. */
  important?: boolean;
  /** Position of the originating stylesheet rule, so the sidecar can keep rules in authored order. */
  originIndex?: number;
  /** Why it was dropped, or what it became. Phrased to point at the input. */
  reason?: string;
  /** The shorthand the author actually wrote, when this came from expanding one. */
  shorthand?: string;
  /** Where it landed, for mapped entries. */
  target?: string;
  /**
   * A fidelity deviation on an otherwise-mapped declaration — it landed, but not exactly as
   * authored. Warned like a drop, because "mapped" would overstate what happened.
   */
  deviation?: string;
  /**
   * Explicitly false when a dropped declaration cannot be rescued by the `open` rung — broken input,
   * or CSS with no single block to attach a class to. Well-formed drops are carryable by default.
   */
  carryable?: false;
}

/**
 * Whether the `open` rung can preserve this entry as sidecar CSS. Well-formed CSS that simply has no
 * block home qualifies; genuinely broken input does not, and neither does CSS with no single block
 * to carry the class.
 */
export function isCarryable(entry: StyleLedgerEntry): boolean {
  return entry.outcome === 'dropped' && entry.value !== '' && entry.carryable !== false;
}

export interface ApplyStylesInput {
  element: Element;
  block: WpBlock;
  styling: StylingRung;
  capabilities: CapabilitySource;
  tokens: TokenInverseMap;
  /** Single-class `<style>` rules in document order, for the classes this element carries. */
  classRules?: Array<{ className: string; declarations: Declaration[]; problems: string[] }>;
}

/**
 * Collect an element's authored CSS from every source we read, in cascade order.
 *
 * Class rules come first and inline last, because an inline `style` attribute outranks any class
 * selector — so a single precedence pass over the concatenation settles both together. Among class
 * rules themselves we use document order, which is correct for the equal-specificity single-class
 * selectors this slice reads; anything needing real specificity reasoning is out of scope.
 */
export function effectiveDeclarations(
  element: Element,
  classRules?: ApplyStylesInput['classRules'],
): {
  declarations: Declaration[];
  overridden: OverriddenDeclaration[];
  problems: string[];
} {
  const raw: Declaration[] = [];
  const problems: string[] = [];

  const classNames = new Set(element.classList);
  for (const rule of classRules ?? []) {
    if (!classNames.has(rule.className)) {
      continue;
    }
    raw.push(...rule.declarations);
    problems.push(...rule.problems);
  }

  const styleAttribute = element.getAttribute('style');
  if (styleAttribute?.trim()) {
    const inline = parseDeclarationBlock(styleAttribute);
    raw.push(...inline.declarations);
    problems.push(...inline.problems);
  }

  const { declarations, overridden } = resolvePrecedence(raw);
  return { declarations, overridden, problems };
}

function collectDeclarations(input: ApplyStylesInput) {
  return effectiveDeclarations(input.element, input.classRules);
}

/**
 * Carry an element's inline CSS onto the block a rule just claimed for it.
 *
 * Runs on already-claimed nodes only, so the structural decision is never influenced by styling.
 * Mutates `block.attributes` in place; the pinned serializer re-runs `save()` at serialize time,
 * so post-creation mutation reaches the output (verified against the pin, including nested
 * children).
 */
export function applyElementStyles(input: ApplyStylesInput): StyleLedgerEntry[] {
  const { element, block } = input;

  const { declarations, overridden, problems } = collectDeclarations(input);
  if (declarations.length === 0 && overridden.length === 0 && problems.length === 0) {
    return [];
  }

  // Unparseable chunks are reported, never skipped: a declaration that disappears without a word
  // is silent degradation, and it usually means the input generator emitted something broken.
  const accounting: StyleLedgerEntry[] = [
    ...problems.map<StyleLedgerEntry>((chunk) => ({
      property: chunk,
      value: '',
      outcome: 'dropped',
      reason: 'not a parseable CSS declaration',
    })),
    ...overridden.map(overriddenEntry),
  ];

  // A Custom HTML fallback keeps the original markup verbatim, style attribute and all. Mapping
  // it onto the wrapper would apply the same CSS twice.
  if (block.name === 'core/html') {
    return [
      ...accounting,
      ...declarations.map((declaration) => ({
        ...declaration,
        outcome: 'consumed' as const,
        reason: 'preserved inline in the Custom HTML fallback',
      })),
    ];
  }

  return [
    ...accounting,
    ...declarations.map((declaration) => noteImportant(declaration, applyDeclaration(declaration, input))),
  ];
}

/** A mapped declaration that was authored `!important` landed without its priority — say so. */
function noteImportant(declaration: Declaration, entry: StyleLedgerEntry): StyleLedgerEntry {
  if (!declaration.important || entry.outcome !== 'mapped') {
    return entry;
  }
  return { ...entry, deviation: IMPORTANT_DEVIATION };
}

/**
 * Account for an element's CSS when a rule fanned it out into several blocks. There is no honest
 * single home for the styling, so every declaration is reported individually rather than as one
 * aggregate note — the ledger owes an outcome per declaration, not per element.
 */
export function unattributableStyles(
  element: Element,
  blockCount: number,
  classRules?: ApplyStylesInput['classRules'],
): StyleLedgerEntry[] {
  const { declarations, overridden, problems } = collectDeclarations({
    element,
    classRules,
  } as ApplyStylesInput);
  if (declarations.length === 0 && overridden.length === 0 && problems.length === 0) {
    return [];
  }

  const reason = `element produced ${blockCount} blocks, so its CSS has no single home`;

  return [
    ...problems.map<StyleLedgerEntry>((chunk) => ({
      property: chunk,
      value: '',
      outcome: 'dropped',
      reason: 'not a parseable CSS declaration',
    })),
    ...overridden.map(overriddenEntry),
    // Not carryable even at `open`: there is no single block to hang a sidecar class on.
    ...declarations.map<StyleLedgerEntry>((declaration) => ({
      ...declaration,
      outcome: 'dropped',
      reason,
      carryable: false,
    })),
  ];
}

/**
 * Account for inline CSS on elements *inside* a block's rich text — `<p>hi <span style="color:red">
 * x</span></p>`. Those descendants never pass through the walker, and their style attributes ride
 * into the RichText attribute verbatim.
 *
 * Under `relaxed` the CSS does survive, inline, so it is `consumed` — but under `strict` it breaches
 * the rung's contract (theme vocabulary only), so the caller strips it and it is reported dropped.
 * Either way it can no longer vanish unmentioned.
 */
export function richTextDescendantStyles(
  root: Element,
  styling: StylingRung,
  classRules?: ApplyStylesInput['classRules'],
): StyleLedgerEntry[] {
  const entries: StyleLedgerEntry[] = [];

  for (const element of root.querySelectorAll('*')) {
    const { declarations, overridden, problems } = collectDeclarations({
      element,
      classRules,
    } as ApplyStylesInput);
    if (declarations.length === 0 && overridden.length === 0 && problems.length === 0) {
      continue;
    }
    entries.push(
      ...problems.map<StyleLedgerEntry>((chunk) => ({
        property: chunk,
        value: '',
        outcome: 'dropped',
        reason: 'not a parseable CSS declaration',
      })),
      ...overridden.map(overriddenEntry),
      ...declarations.map<StyleLedgerEntry>((declaration) =>
        richTextDescendantOutcome(declaration, element, styling),
      ),
    );
  }

  return entries;
}

/**
 * The three cases differ in whether the CSS actually survives, so they get different outcomes:
 * a class-authored declaration is genuinely lost (the `<style>` element is stripped, so the class
 * on the element points at nothing), an inline one survives verbatim, and `strict` refuses both.
 */
function richTextDescendantOutcome(
  declaration: Declaration,
  element: Element,
  styling: StylingRung,
): StyleLedgerEntry {
  const tag = `<${element.tagName.toLowerCase()}>`;

  if (styling === 'strict') {
    return {
      ...declaration,
      outcome: 'dropped',
      reason: `stripped from ${tag} inside rich text — strict styling keeps only on-system values`,
    };
  }

  if (declaration.origin) {
    return {
      ...declaration,
      outcome: 'dropped',
      reason: `authored on ${tag} inside rich text, where a block style cannot reach — the class survives but its stylesheet does not`,
    };
  }

  return {
    ...declaration,
    outcome: 'consumed',
    reason: `carried inline on ${tag} inside rich text, not as a block style`,
  };
}

function overriddenEntry(declaration: OverriddenDeclaration): StyleLedgerEntry {
  return {
    ...declaration,
    outcome: 'overridden',
    reason:
      declaration.by === 'important'
        ? 'overridden by an earlier !important declaration on the same property'
        : 'overridden by a later declaration on the same property',
  };
}

function applyDeclaration(declaration: Declaration, input: ApplyStylesInput): StyleLedgerEntry {
  const { property, value } = declaration;

  const wasRead = backgroundWasConsumed(input.block, input.element, extractUrl(value));
  switch (backgroundConsumption(property, value, wasRead)) {
    case 'full':
      return { ...declaration, outcome: 'consumed', reason: 'read by the structural rules' };
    case 'partial':
      // The image became the block's media, but the colour/position/size riding along in the
      // shorthand did not — that part is a real loss and must be said out loud.
      return {
        ...declaration,
        outcome: 'dropped',
        carryable: false,
        reason:
          'only the url() became block media — the other background shorthand components were not carried',
      };
    default:
      break;
  }

  const target = lookupDeclaration(property);
  if (!target) {
    return {
      ...declaration,
      outcome: 'dropped',
      reason: 'no native block style can hold this property',
    };
  }

  if (target.kind === 'refused') {
    return { ...declaration, outcome: 'dropped', reason: target.hint };
  }

  if (target.kind === 'background') {
    return applyBackground(declaration, input);
  }

  return applyStyleTarget(declaration, target, input);
}

/**
 * `background` folds colour, image, gradient, repeat and position into one value. Only the cases
 * with an unambiguous block home are mapped; the rest are reported rather than written into
 * `style.color.background` as if a gradient or `none` were a colour.
 */
function applyBackground(declaration: Declaration, input: ApplyStylesInput): StyleLedgerEntry {
  switch (classifyBackground(declaration.value)) {
    case 'image':
      // Reaching here means no structural rule read this URL as the block's media.
      return {
        ...declaration,
        outcome: 'dropped',
        reason:
          'not the media this block carries — a background image only survives when a structural rule reads it as block media',
      };
    case 'gradient':
      return applyStyleTarget(declaration, GRADIENT_TARGET, input);
    case 'color':
      return applyStyleTarget(declaration, BACKGROUND_COLOR_TARGET, input);
    default:
      return {
        ...declaration,
        outcome: 'dropped',
        reason: 'multi-component background shorthand has no single native block style',
      };
  }
}

function applyStyleTarget(
  declaration: Declaration,
  target: Extract<StyleTarget, { kind: 'style' }>,
  input: ApplyStylesInput,
): StyleLedgerEntry {
  const { block, capabilities, styling } = input;
  const path = target.path.join('.');

  if (!capabilities.declaresAttribute(block.name, 'style')) {
    return {
      ...declaration,
      outcome: 'dropped',
      reason: `${block.name} declares no style attribute`,
    };
  }

  if (!capabilities.supports(block.name, target.supports)) {
    const scope = capabilities.kind === 'context' ? 'the target site' : 'the pinned block library';
    return {
      ...declaration,
      outcome: 'dropped',
      reason: `${block.name} does not support ${path} in ${scope}`,
    };
  }

  if (styling === 'strict') {
    return applyStrict(declaration, target, input);
  }

  setStylePath(block, target.path, declaration.value);
  return { ...declaration, outcome: 'mapped', target: `style.${path}` };
}

/**
 * `strict` converts to the theme's vocabulary only: a value that snaps to a token becomes a
 * preset, and a value with no token home is dropped and logged. That is the rung's whole
 * contract — pixel fidelity is what `relaxed` is for.
 */
function applyStrict(
  declaration: Declaration,
  target: Extract<StyleTarget, { kind: 'style' }>,
  input: ApplyStylesInput,
): StyleLedgerEntry {
  const { block, capabilities, tokens } = input;
  const { value } = declaration;
  const path = target.path.join('.');

  const preset = presetFor(target, value, tokens);
  if (!preset) {
    return {
      ...declaration,
      outcome: 'dropped',
      reason: `no theme token matches this value — strict styling keeps only on-system values`,
    };
  }

  if (preset.kind === 'attribute') {
    if (!capabilities.declaresAttribute(block.name, preset.attribute)) {
      return {
        ...declaration,
        outcome: 'dropped',
        reason: `${block.name} declares no ${preset.attribute} attribute`,
      };
    }
    block.attributes[preset.attribute] = preset.slug;
    return { ...declaration, outcome: 'mapped', target: `${preset.attribute}="${preset.slug}"` };
  }

  setStylePath(block, target.path, preset.value);
  return { ...declaration, outcome: 'mapped', target: `style.${path}=${preset.value}` };
}

type Preset =
  | { kind: 'attribute'; attribute: string; slug: string }
  | { kind: 'style'; value: string };

function presetFor(
  target: Extract<StyleTarget, { kind: 'style' }>,
  value: string,
  tokens: TokenInverseMap,
): Preset | undefined {
  const [group, key] = target.path;

  if (group === 'color' && (key === 'text' || key === 'background')) {
    const slug = matchColor(value, tokens);
    if (!slug) {
      return undefined;
    }
    return { kind: 'attribute', attribute: key === 'text' ? 'textColor' : 'backgroundColor', slug };
  }

  if (group === 'typography' && key === 'fontSize') {
    const slug = tokens.fontSizes.get(value);
    return slug ? { kind: 'attribute', attribute: 'fontSize', slug } : undefined;
  }

  if (group === 'typography' && key === 'fontFamily') {
    const slug = tokens.fonts.get(value);
    return slug ? { kind: 'attribute', attribute: 'fontFamily', slug } : undefined;
  }

  if (group === 'spacing') {
    const slug = tokens.spacingValues.get(value);
    // Spacing presets live inside the style object as a var: reference, not as a top-level
    // attribute — matching how token repair already writes them.
    return slug ? { kind: 'style', value: `var:preset|spacing|${slug}` } : undefined;
  }

  // lineHeight, fontWeight, letterSpacing and borderRadius have no preset vocabulary the token
  // resolver reads today, so `strict` has nowhere on-system to put them.
  //
  // minWidth is the exception waiting to happen: WordPress 7.1 adds dimension presets
  // (`--wp--preset--dimension--{slug}`), so once the token resolver learns to read
  // `settings.dimensions`, this should snap like spacing does.
  return undefined;
}

function setStylePath(block: WpBlock, path: string[], value: string): void {
  const style = (block.attributes.style ??= {}) as Record<string, unknown>;
  let cursor: Record<string, unknown> = style;

  for (const segment of path.slice(0, -1)) {
    const next = cursor[segment];
    cursor[segment] =
      next && typeof next === 'object' && !Array.isArray(next) ? next : {};
    cursor = cursor[segment] as Record<string, unknown>;
  }

  cursor[path[path.length - 1]] = value;
}
