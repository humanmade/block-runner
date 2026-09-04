import { BOX_SIDES, BoxSide } from './declarations.js';

export interface Declaration {
  /** Lowercased longhand property name. */
  property: string;
  /** Trimmed value, `!important` removed. */
  value: string;
  /** The shorthand this was expanded from, when it was. Reported so warnings name what the author wrote. */
  shorthand?: string;
  /** Whether the author marked it `!important`. Drives last-wins precedence, then discarded. */
  important?: boolean;
  /**
   * Where it was authored — a class selector like `.hero` for a `<style>` rule, or undefined for an
   * inline `style` attribute. Carried so a warning names the rule the author must fix, not just the
   * element the rule landed on (principle 6).
   */
  origin?: string;
  /**
   * Index of the originating rule within the stylesheet. Two rules can share a selector
   * (`.hero{…} .other{…} .hero{…}`), and the sidecar must keep them as separate rules in their
   * original positions — collapsing them onto the first occurrence reverses the author's cascade.
   */
  originIndex?: number;
  /**
   * Stable stylesheet-rule identity used internally by registered-block authoring. Unlike the
   * selector text, it distinguishes repeated selectors and the same selector inside a conditional
   * at-rule from its top-level counterpart.
   */
  originId?: string;
}

export interface OverriddenDeclaration extends Declaration {
  /**
   * `later` — beaten by a subsequent declaration on the same property.
   * `important` — a *later* plain declaration beaten by an earlier `!important` one.
   */
  by: 'later' | 'important';
}

export interface ParsedInlineStyle {
  declarations: Declaration[];
  /** Declarations beaten by another declaration on the same property. */
  overridden: OverriddenDeclaration[];
  /**
   * Chunks that are not parseable declarations. These must still be reported — a malformed
   * declaration that vanishes without a word is exactly the silent degradation we forbid, and
   * it usually means the input generator emitted something broken.
   *
   * An *empty* chunk (`color:red;;padding:8px`) is deliberately not a problem: a redundant
   * semicolon is valid CSS carrying no declaration and no author intent, and warning on it would
   * only train the reader to skim past the report.
   */
  problems: string[];
}

/**
 * Parse an inline `style` attribute into normalised longhand declarations.
 *
 * Splitting on `;`/`:` naively breaks on `url(data:image/svg+xml;base64,…)` and on quoted font
 * stacks, both of which turn up in generated design HTML — so this tracks quote and paren depth,
 * honouring backslash escapes inside quotes.
 */
export function parseInlineStyle(styleAttribute: string): ParsedInlineStyle {
  const { declarations, problems } = parseDeclarationBlock(styleAttribute);
  const { declarations: winners, overridden } = resolvePrecedence(declarations);
  return { declarations: winners, overridden, problems };
}

/**
 * Parse a declaration block — an inline `style` attribute or a `<style>` rule body, which share
 * syntax — into raw longhand declarations, *without* resolving precedence.
 *
 * Precedence is deliberately separate: when class-rule and inline declarations are merged for one
 * element they must be resolved together, in cascade order, not per source.
 */
export function parseDeclarationBlock(
  css: string,
  origin?: string,
  originIndex?: number,
  originId?: string,
): { declarations: Declaration[]; problems: string[] } {
  const parsed: Declaration[] = [];
  const problems: string[] = [];

  const { css: stripped, unterminatedComment } = stripComments(css);
  if (unterminatedComment) {
    // CSS-correct behaviour is to comment out the remainder, but an unterminated comment in a
    // generated style attribute means whatever followed it was silently lost — worth saying.
    problems.push('unterminated /* comment — everything after it was ignored');
  }

  for (const chunk of splitTopLevel(stripped, isSemicolon)) {
    const separator = indexOfTopLevel(chunk, ':');
    if (separator === -1) {
      problems.push(chunk);
      continue;
    }

    const property = chunk.slice(0, separator).trim().toLowerCase();
    const rawValue = chunk.slice(separator + 1).trim();
    if (!property || !rawValue) {
      problems.push(chunk);
      continue;
    }

    const { value, important } = stripImportant(rawValue);
    if (!value) {
      problems.push(chunk);
      continue;
    }

    // `important` and `origin` are set only when meaningful, so they read as flags rather than
    // noise on every entry (and keep object equality simple in tests).
    parsed.push(
      ...expandShorthand(property, value).map((entry) => ({
        ...entry,
        ...(important ? { important } : {}),
        ...(origin ? { origin } : {}),
        ...(originIndex === undefined ? {} : { originIndex }),
        ...(originId === undefined ? {} : { originId }),
      })),
    );
  }

  return { declarations: parsed, problems };
}

/**
 * Resolve the cascade over an ordered declaration list. Callers pass declarations in cascade order
 * — class rules first, inline last — so a single pass settles both sources together.
 */
export function resolvePrecedence(declarations: Declaration[]): {
  declarations: Declaration[];
  overridden: OverriddenDeclaration[];
} {
  return applyPrecedence(declarations);
}

/**
 * Later declaration wins, except that a plain declaration never overrides an `!important` one —
 * the same rule a browser applies within a single style attribute.
 *
 * Losers are returned rather than discarded so every authored declaration can still be accounted
 * for. They are not *degradation* — the author's own later declaration overrode them, exactly as a
 * browser would — so they are reported under `--explain`, not warned about.
 */
function applyPrecedence(declarations: Declaration[]): {
  declarations: Declaration[];
  overridden: OverriddenDeclaration[];
} {
  const winners = new Map<string, Declaration>();
  const overridden: OverriddenDeclaration[] = [];

  for (const declaration of declarations) {
    // Is this declaration's own property already held by an !important declaration? That includes
    // an earlier !important *shorthand* covering it — `font:16px serif !important` protects
    // `font-size` — so the check runs in both directions, not just on matching names.
    const protectedBy = [...winners.values()].find(
      (winner) => winner.important && covers(winner.property, declaration.property),
    );
    if (protectedBy && !declaration.important) {
      overridden.push({ ...declaration, by: 'important' });
      continue;
    }

    // Reset the winners this declaration covers — but per property, not all-or-nothing. An
    // !important longhand survives a later plain shorthand while its plain siblings do not.
    for (const [property, winner] of [...winners]) {
      if (!covers(declaration.property, property)) {
        continue;
      }
      if (winner.important && !declaration.important) {
        continue;
      }
      overridden.push({ ...winner, by: 'later' });
      winners.delete(property);
    }

    winners.set(declaration.property, declaration);
  }

  return { declarations: [...winners.values()], overridden };
}

/** Whether declaring `property` sets or resets `target`. */
function covers(property: string, target: string): boolean {
  const resets = resetsOf(property);
  return resets.includes('*') || resets.includes(target);
}

/**
 * Expand the shorthands we can carry. Only box shorthands are expanded — `border`, `background`,
 * and `font` fold in properties with no single block-style home, so expanding them would invent
 * mappings the block can't hold. They stay whole and are reported as unmapped.
 */
export function expandShorthand(property: string, value: string): Declaration[] {
  if (property !== 'padding' && property !== 'margin') {
    return [{ property, value }];
  }

  // Split on whitespace runs, not literal spaces: generated HTML wraps long style attributes
  // across lines, and a tab or newline here would otherwise fold the whole shorthand into one
  // bogus value applied to all four sides.
  const parts = splitTopLevel(value, isWhitespace);

  if (parts.length === 0 || parts.length > 4) {
    return [{ property, value }];
  }

  const sides = expandBox(parts);
  return BOX_SIDES.map((side) => ({
    property: `${property}-${side}`,
    value: sides[side],
    shorthand: property,
  }));
}

function expandBox(parts: string[]): Record<BoxSide, string> {
  const [a, b = a, c = a, d = b] = parts;
  return { top: a, right: b, bottom: c, left: d };
}

function stripImportant(value: string): { value: string; important: boolean } {
  const match = /^(.*?)\s*!\s*important\s*$/is.exec(value);
  if (!match) {
    return { value: value.trim(), important: false };
  }
  return { value: match[1].trim(), important: true };
}

/**
 * Longhands each shorthand resets. Without this, `font-size:48px;font:16px serif` would keep the
 * stale 48px even though the later shorthand reset it — the shorthand itself is unmappable and gets
 * dropped, but it must still defeat the earlier longhand.
 *
 * `padding`/`margin` are absent because they are expanded to longhands before precedence runs, so
 * exact-name matching already handles them. `border` deliberately does not list `border-radius`:
 * the `border` shorthand resets width/style/color only.
 */
const SHORTHAND_RESETS: Record<string, string[]> = {
  font: [
    'font-size',
    'font-family',
    'font-weight',
    'font-style',
    'font-variant',
    'font-stretch',
    'line-height',
  ],
  background: [
    'background-color',
    'background-image',
    'background-position',
    'background-size',
    'background-repeat',
    'background-attachment',
    'background-origin',
    'background-clip',
  ],
  border: ['border-width', 'border-style', 'border-color'],
};

/** Properties a declaration overrides: itself, plus the longhands it resets. */
function resetsOf(property: string): string[] {
  if (property === 'all') {
    return ['*'];
  }
  return [property, ...(SHORTHAND_RESETS[property] ?? [])];
}

const isSemicolon = (char: string) => char === ';';
const isWhitespace = (char: string) => /\s/.test(char);

/**
 * Remove `/* … *&#47;` comments, which are valid inside a style attribute. Without this,
 * `color:red;/* note *&#47;padding:8px` parses `/* note *&#47;padding` as a property name and the
 * perfectly good padding is reported as malformed. Comments inside quoted strings are content, not
 * comments, so quote state is tracked.
 */
function stripComments(input: string): { css: string; unterminatedComment: boolean } {
  let out = '';
  let quote: string | null = null;
  let escaped = false;
  let index = 0;
  let unterminatedComment = false;

  while (index < input.length) {
    const char = input[index];

    if (quote) {
      out += char;
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === quote) {
        quote = null;
      }
      index += 1;
      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
      out += char;
      index += 1;
      continue;
    }

    if (char === '/' && input[index + 1] === '*') {
      const end = input.indexOf('*/', index + 2);
      // An unterminated comment comments out the rest, as a CSS parser would treat it.
      if (end === -1) {
        unterminatedComment = true;
        index = input.length;
      } else {
        index = end + 2;
      }
      continue;
    }

    out += char;
    index += 1;
  }

  return { css: out, unterminatedComment };
}

/**
 * Split where `isSeparator` matches, but only at depth zero — outside (), [], and quotes.
 */
function splitTopLevel(input: string, isSeparator: (char: string) => boolean): string[] {
  const parts: string[] = [];
  let current = '';
  let depth = 0;
  let quote: string | null = null;
  let escaped = false;

  for (const char of input) {
    if (quote) {
      current += char;
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === quote) {
        quote = null;
      }
      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
      current += char;
      continue;
    }

    if (char === '(' || char === '[') {
      depth += 1;
    } else if (char === ')' || char === ']') {
      depth = Math.max(0, depth - 1);
    }

    if (depth === 0 && isSeparator(char)) {
      parts.push(current);
      current = '';
      continue;
    }

    current += char;
  }

  parts.push(current);
  return parts.map((part) => part.trim()).filter(Boolean);
}

function indexOfTopLevel(input: string, char: string): number {
  let depth = 0;
  let quote: string | null = null;
  let escaped = false;

  for (let index = 0; index < input.length; index += 1) {
    const current = input[index];

    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (current === '\\') {
        escaped = true;
      } else if (current === quote) {
        quote = null;
      }
      continue;
    }

    if (current === '"' || current === "'") {
      quote = current;
      continue;
    }

    if (current === '(' || current === '[') {
      depth += 1;
    } else if (current === ')' || current === ']') {
      depth = Math.max(0, depth - 1);
    } else if (current === char && depth === 0) {
      return index;
    }
  }

  return -1;
}
