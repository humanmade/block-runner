import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { TailwindBuildGraph, TailwindCompilerInput } from '../types.js';

/**
 * Source-style graph utilities for generated blocks.
 *
 * Tailwind is compiled only by the project's explicitly supplied, pinned compiler. A Tailwind
 * class is not CSS, and guessing its declaration from a token would make the generated block
 * depend on an unknown version, configuration, plugin set, source set, and browser target. The
 * compiler receives the complete materialized graph and its result is the only Tailwind CSS this
 * module will author.
 *
 * The scanner is deliberately small and conservative. It preserves the conditional constructs that
 * can safely remain in a block stylesheet (`@media`, `@supports`, and `@container`) and records all
 * other global or unsupported constructs rather than silently flattening or dropping them.
 */

export type BuildGraphField =
  | 'cssEntries'
  | 'imports'
  | 'directives'
  | 'sources'
  | 'safelist'
  | 'plugins'
  | 'environment'
  | 'browserTarget'
  | 'compiler';

/**
 * The inputs that determine a Tailwind (or Tailwind-like) generated stylesheet. Empty arrays are
 * meaningful: they say that the author explicitly has no imports, safelist, or plugins. Omitted
 * fields are not meaningful and therefore cannot support a fidelity claim.
 */
export interface CssBuildGraph extends TailwindBuildGraph {
  cssEntries?: readonly string[];
  imports?: readonly string[];
  directives?: readonly string[];
  sources?: readonly string[];
  safelist?: readonly string[];
  plugins?: readonly string[];
  environment?: Readonly<Record<string, string | number | boolean | null | undefined>>;
  browserTarget?: string | readonly string[];
}

export interface BuildGraphIssue {
  field: BuildGraphField;
  status: 'warning' | 'blocked';
  reason: string;
}

export interface BuildGraphValidation {
  /** All required graph inputs were supplied and entry/source values are non-empty. */
  complete: boolean;
  /** Tailwind mode was explicitly declared by the caller or by supplying a graph. */
  tailwindDetected: boolean;
  /** The supplied CSS is a compiled, self-contained stylesheet rather than Tailwind source. */
  compiled: boolean;
  /** A pinned compiler actually generated and, when supplied, matched this CSS. */
  provenanceVerified: boolean;
  /** `--tw-*` variables referenced by the CSS but not defined anywhere in that CSS. */
  unresolvedVariables: string[];
  /** Tailwind fidelity is blocked for an incomplete graph or an uncompiled/incomplete CSS result. */
  blocked: boolean;
  missing: BuildGraphField[];
  issues: BuildGraphIssue[];
}

export interface BuildGraphValidationOptions {
  /** Compiled or source CSS to inspect for Tailwind directives/variables. */
  css?: string;
  /** Explicitly declare Tailwind mode when the compiled CSS has no recognizable source token. */
  tailwindDetected?: boolean;
  /** Set only after `compileTailwindBuildGraph()` produced the CSS being validated. */
  provenanceVerified?: boolean;
}

const BUILD_GRAPH_FIELDS: readonly BuildGraphField[] = [
  'cssEntries',
  'imports',
  'directives',
  'sources',
  'safelist',
  'plugins',
  'environment',
  'browserTarget',
  'compiler',
];

const BUILD_GRAPH_LABELS: Record<BuildGraphField, string> = {
  cssEntries: 'CSS entry points',
  imports: 'resolved CSS imports',
  directives: 'Tailwind/CSS directives',
  sources: 'explicit content sources',
  safelist: 'explicit safelist',
  plugins: 'plugin list',
  environment: 'build environment',
  browserTarget: 'browser target',
  compiler: 'pinned Tailwind compiler',
};

/**
 * Validate the source inputs needed to make a Tailwind fidelity statement. Tailwind mode is not
 * considered usable until a caller has also run `compileTailwindBuildGraph()` and marked the exact
 * output as verified. Keeping this synchronous utility strict prevents a complete-looking graph
 * plus independently supplied CSS from being mistaken for compiler provenance.
 */
export function validateCssBuildGraph(
  graph: CssBuildGraph | undefined,
  options: BuildGraphValidationOptions = {},
): BuildGraphValidation {
  const css = options.css ?? '';
  const unresolvedVariables = unresolvedTailwindVariables(css);
  // Compiled CSS is not a trustworthy provenance signal: a one-rule Tailwind build can look
  // exactly like hand-written CSS. Tailwind mode therefore comes only from the caller's explicit
  // declaration (or from the presence of the graph itself), never from utility-shaped output.
  const tailwindDetected = options.tailwindDetected === true || graph !== undefined;
  const missing = BUILD_GRAPH_FIELDS.filter((field) => graphFieldMissing(graph, field));
  const compiled = !hasTailwindSourceSignal(css) && unresolvedVariables.length === 0;
  const provenanceVerified = tailwindDetected ? options.provenanceVerified === true : true;
  const blocked = tailwindDetected && (missing.length > 0 || !compiled || !provenanceVerified);
  const issues = missing.map<BuildGraphIssue>((field) => ({
    field,
    status: blocked ? 'blocked' : 'warning',
    reason: `${BUILD_GRAPH_LABELS[field]} were not supplied${
      tailwindDetected
        ? ' — Tailwind fidelity is blocked until the complete build graph is supplied'
        : ' — provide the complete source style graph before claiming generated-CSS fidelity'
    }`,
  }));

  if (tailwindDetected && !compiled) {
    issues.push({
      field: 'directives',
      status: 'blocked',
      reason: hasTailwindSourceSignal(css)
        ? 'Tailwind source directives/imports remain — supply the compiler output, not its source stylesheet'
        : `compiled CSS still references undefined Tailwind variables: ${unresolvedVariables.join(', ')}`,
    });
  }

  if (tailwindDetected && missing.length === 0 && !provenanceVerified) {
    issues.push({
      field: 'compiler',
      status: 'blocked',
      reason: 'Tailwind graph has not been compiled by its pinned compiler, so this CSS has no verified provenance',
    });
  }

  return {
    complete: missing.length === 0,
    tailwindDetected,
    compiled,
    provenanceVerified,
    unresolvedVariables,
    blocked,
    missing,
    issues,
  };
}

/** True only for Tailwind *source* that still needs a compiler, never for compiled declarations. */
export function hasTailwindSignal(css: string): boolean {
  return hasTailwindSourceSignal(css);
}

function hasTailwindSourceSignal(css: string): boolean {
  return /(?:^|[;{}\s])@(?:tailwind|apply|config|source|theme|utility|variant|custom-variant|plugin)\b|@import\s+(?:url\([^)]*tailwindcss[^)]*\)|["'][^"']*tailwindcss[^"']*["'])/im.test(css);
}

function unresolvedTailwindVariables(css: string): string[] {
  const defined = new Set<string>();
  for (const match of css.matchAll(/(--tw-[\w-]+)\s*:/gi)) {
    defined.add(match[1].toLowerCase());
  }
  const unresolved = new Set<string>();
  for (const match of css.matchAll(/var\(\s*(--tw-[\w-]+)/gi)) {
    const name = match[1].toLowerCase();
    if (!defined.has(name)) {
      unresolved.add(name);
    }
  }
  return [...unresolved].sort();
}

function graphFieldMissing(graph: CssBuildGraph | undefined, field: BuildGraphField): boolean {
  if (!graph || !(field in graph)) {
    return true;
  }

  const value = graph[field];
  if (field === 'compiler') {
    const compiler = graph.compiler;
    return !compiler
      || typeof compiler.name !== 'string'
      || !compiler.name.trim()
      || typeof compiler.version !== 'string'
      || !compiler.version.trim()
      || typeof compiler.compile !== 'function';
  }
  if (field === 'cssEntries' || field === 'sources') {
    return !Array.isArray(value) || value.length === 0 || value.some((entry) => typeof entry !== 'string' || !entry.trim());
  }
  if (field === 'browserTarget') {
    return (
      (typeof value === 'string' && !value.trim()) ||
      (typeof value !== 'string' &&
        (!Array.isArray(value) || value.length === 0 || value.some((entry) => typeof entry !== 'string' || !entry.trim())))
    );
  }
  if (field === 'environment') {
    return !value || typeof value !== 'object' || Array.isArray(value);
  }

  // The field's presence is intentional for imports/directives/safelist/plugins: [] is a complete
  // assertion that there are none, while `undefined` is not.
  return !Array.isArray(value);
}

export interface TailwindCompilationOptions {
  /** Design HTML path, used as the base for graph paths when available. */
  sourcePath?: string;
  /** CSS supplied as purported compiler output. It must exactly match when present. */
  expectedCss?: string;
}

export interface TailwindCompilation {
  css?: string;
  issues: BuildGraphIssue[];
  /** True only when the compiler ran and its output matched the supplied output (if any). */
  verified: boolean;
}

/**
 * Materialize and compile the declared Tailwind graph. This intentionally has no fallback that
 * infers a utility from class names or accepts a prebuilt stylesheet on trust: the supplied
 * compiler is the project's pin for Tailwind, plugins, custom variants, and browser targeting.
 */
export async function compileTailwindBuildGraph(
  graph: CssBuildGraph,
  options: TailwindCompilationOptions = {},
): Promise<TailwindCompilation> {
  const missing = BUILD_GRAPH_FIELDS.filter((field) => graphFieldMissing(graph, field));
  if (missing.length > 0) {
    return {
      issues: missing.map((field) => ({
        field,
        status: 'blocked',
        reason: `${BUILD_GRAPH_LABELS[field]} were not supplied — Tailwind cannot be compiled from an incomplete graph`,
      })),
      verified: false,
    };
  }

  const base = graphBaseDirectory(options.sourcePath);
  const entries = await materializeGraphFiles(graph.cssEntries!, base, 'cssEntries');
  const imports = await materializeGraphFiles(graph.imports!, base, 'imports');
  const issues = [...entries.issues, ...imports.issues];
  issues.push(...declaredTailwindInputIssues([...entries.files, ...imports.files], graph));
  if (issues.length > 0) {
    return { issues, verified: false };
  }

  const declaredImports = new Set(imports.files.map((file) => file.path));
  for (const entry of [...entries.files, ...imports.files]) {
    for (const specifier of cssImportSpecifiers(entry.css)) {
      const resolved = path.resolve(path.dirname(entry.path), specifier);
      if (!declaredImports.has(resolved)) {
        issues.push({
          field: 'imports',
          status: 'blocked',
          reason: `CSS entry ${entry.path} imports ${specifier}, but that import was not materialized in tailwind.imports`,
        });
      }
    }
  }
  if (issues.length > 0) {
    return { issues, verified: false };
  }

  const input: TailwindCompilerInput = {
    cssEntries: entries.files,
    imports: imports.files,
    directives: [...graph.directives!],
    sources: [...graph.sources!],
    safelist: [...graph.safelist!],
    plugins: [...graph.plugins!],
    environment: graph.environment!,
    browserTarget: graph.browserTarget!,
  };

  let css: string;
  try {
    css = await graph.compiler!.compile(input);
  } catch (error) {
    return {
      issues: [{
        field: 'compiler',
        status: 'blocked',
        reason: `pinned Tailwind compiler ${graph.compiler!.name}@${graph.compiler!.version} failed: ${errorMessage(error)}`,
      }],
      verified: false,
    };
  }
  if (typeof css !== 'string') {
    return {
      issues: [{
        field: 'compiler',
        status: 'blocked',
        reason: `pinned Tailwind compiler ${graph.compiler!.name}@${graph.compiler!.version} did not return CSS text`,
      }],
      verified: false,
    };
  }
  if (options.expectedCss !== undefined && canonicalCompilerCss(options.expectedCss) !== canonicalCompilerCss(css)) {
    return {
      css,
      issues: [{
        field: 'compiler',
        status: 'blocked',
        reason: `supplied CSS does not match output from pinned Tailwind compiler ${graph.compiler!.name}@${graph.compiler!.version}`,
      }],
      verified: false,
    };
  }
  return { css, issues: [], verified: true };
}

function graphBaseDirectory(sourcePath: string | undefined): string {
  if (!sourcePath || sourcePath === '-' || /^<.*>$/.test(sourcePath)) {
    return process.cwd();
  }
  return path.dirname(path.resolve(sourcePath));
}

async function materializeGraphFiles(
  values: readonly string[],
  base: string,
  field: 'cssEntries' | 'imports',
): Promise<{ files: Array<{ path: string; css: string }>; issues: BuildGraphIssue[] }> {
  const files: Array<{ path: string; css: string }> = [];
  const issues: BuildGraphIssue[] = [];
  for (const value of values) {
    const file = path.resolve(base, value);
    try {
      files.push({ path: file, css: await readFile(file, 'utf8') });
    } catch (error) {
      issues.push({
        field,
        status: 'blocked',
        reason: `declared ${field === 'cssEntries' ? 'CSS entry' : 'CSS import'} ${value} could not be read: ${errorMessage(error)}`,
      });
    }
  }
  return { files, issues };
}

function cssImportSpecifiers(css: string): string[] {
  const imports: string[] = [];
  const expression = /@import\s+(?:url\(\s*)?(?:["']([^"']+)["']|([^\s;)]+))/gi;
  let match: RegExpExecArray | null;
  while ((match = expression.exec(css))) {
    const specifier = (match[1] ?? match[2] ?? '').trim();
    if (specifier) imports.push(specifier);
  }
  return imports;
}

/**
 * The graph must describe the material we actually hand to the compiler. In particular, an empty
 * `directives` or `plugins` field is an explicit assertion that source entries contain none; do
 * not accept a custom variant/plugin merely because the field happened to be present.
 */
function declaredTailwindInputIssues(
  files: ReadonlyArray<{ path: string; css: string }>,
  graph: CssBuildGraph,
): BuildGraphIssue[] {
  const issues: BuildGraphIssue[] = [];
  const directives = graph.directives!.map(normalizeGraphDirective);
  const plugins = new Set(graph.plugins!.map((plugin) => plugin.trim()));
  const sources = new Set(graph.sources!.map((source) => source.trim()));
  const safelist = new Set(graph.safelist!.map((entry) => entry.trim()));

  for (const entry of files) {
    for (const directive of tailwindDirectives(entry.css)) {
      const normalized = normalizeGraphDirective(directive);
      if (!directives.includes(normalized)) {
        issues.push({
          field: 'directives',
          status: 'blocked',
          reason: `CSS entry ${entry.path} contains ${directive}, but it was not supplied in tailwind.directives`,
        });
      }
    }
    for (const plugin of tailwindPluginSpecifiers(entry.css)) {
      if (!plugins.has(plugin)) {
        issues.push({
          field: 'plugins',
          status: 'blocked',
          reason: `CSS entry ${entry.path} loads Tailwind plugin ${plugin}, but it was not supplied in tailwind.plugins`,
        });
      }
    }
    for (const source of tailwindSourceSpecifiers(entry.css)) {
      if (!sources.has(source)) {
        issues.push({
          field: 'sources',
          status: 'blocked',
          reason: `CSS entry ${entry.path} declares Tailwind source ${source}, but it was not supplied in tailwind.sources`,
        });
      }
    }
    for (const candidate of tailwindInlineSafelist(entry.css)) {
      if (!safelist.has(candidate)) {
        issues.push({
          field: 'safelist',
          status: 'blocked',
          reason: `CSS entry ${entry.path} declares inline Tailwind source ${candidate}, but it was not supplied in tailwind.safelist`,
        });
      }
    }
  }
  return issues;
}

function tailwindDirectives(css: string): string[] {
  const directives: string[] = [];
  const expression = /@(tailwind|apply|config|theme|utility|variant|custom-variant)\b[^;{}]*(?:;|\{)?/gi;
  let match: RegExpExecArray | null;
  while ((match = expression.exec(css))) {
    directives.push(match[0].replace(/[;{]\s*$/, '').trim());
  }
  return directives;
}

function tailwindPluginSpecifiers(css: string): string[] {
  const plugins: string[] = [];
  const expression = /@plugin\s+(?:["']([^"']+)["']|([^\s;{}]+))/gi;
  let match: RegExpExecArray | null;
  while ((match = expression.exec(css))) {
    const plugin = (match[1] ?? match[2] ?? '').trim();
    if (plugin) plugins.push(plugin);
  }
  return plugins;
}

function tailwindSourceSpecifiers(css: string): string[] {
  const sources: string[] = [];
  const expression = /@source\s+(?:["']([^"']+)["']|([^\s;{}]+))/gi;
  let match: RegExpExecArray | null;
  while ((match = expression.exec(css))) {
    const source = (match[1] ?? match[2] ?? '').trim();
    if (source && !/^inline\(/i.test(source)) sources.push(source);
  }
  return sources;
}

function tailwindInlineSafelist(css: string): string[] {
  const candidates: string[] = [];
  const expression = /@source\s+inline\(\s*(["'])(.*?)\1\s*\)/gi;
  let match: RegExpExecArray | null;
  while ((match = expression.exec(css))) {
    const candidate = (match[2] ?? '').trim();
    if (candidate) candidates.push(candidate);
  }
  return candidates;
}

function normalizeGraphDirective(value: string): string {
  return value.replace(/\s+/g, ' ').replace(/[;{]\s*$/, '').trim();
}

function canonicalCompilerCss(css: string): string {
  // Compilers may vary only in final newlines. Any other byte change has not been proven to be the
  // declared compiler output, so preserve the stronger provenance contract rather than guessing.
  return css.replace(/\r\n?/g, '\n').replace(/\n+$/, '');
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export interface CssPosition {
  offset: number;
  line: number;
  column: number;
}

export interface CssSourceRange {
  start: CssPosition;
  end: CssPosition;
}

export interface CssDeclaration {
  id: string;
  property: string;
  value: string;
  important: boolean;
  source: CssSourceRange;
}

export interface CssStyleRule {
  id: string;
  kind: 'style';
  selector: string;
  declarations: CssDeclaration[];
  source: CssSourceRange;
  /** Present for CSS nesting. Nested selectors are parsed and ledgered, then conservatively blocked. */
  nestedIn?: string;
}

export interface CssConditionalRule {
  id: string;
  kind: 'conditional';
  name: 'media' | 'supports' | 'container';
  prelude: string;
  rules: CssRule[];
  source: CssSourceRange;
}

export interface CssBlockedRule {
  id: string;
  kind: 'blocked';
  name: string;
  prelude: string;
  declarations: CssDeclaration[];
  rules: CssRule[];
  reason: string;
  source: CssSourceRange;
}

export type CssRule = CssStyleRule | CssConditionalRule | CssBlockedRule;

export type StyleLedgerOutcome = 'pending' | 'native' | 'preset' | 'literal' | 'scoped-css' | 'warned' | 'blocked';

/** One and only one of these entries is created for every parsed source declaration. */
export interface SourceStyleLedgerEntry {
  declarationId: string;
  ruleId: string;
  property: string;
  value: string;
  important: boolean;
  source: CssSourceRange;
  atRules: string[];
  outcome: StyleLedgerOutcome;
  reason?: string;
}

export interface CssRuleRecord {
  ruleId: string;
  kind: CssRule['kind'];
  prelude: string;
  source: CssSourceRange;
  outcome: 'pending' | 'scoped-css' | 'blocked';
  reason?: string;
}

export interface CssStylesheet {
  rules: CssRule[];
  ledger: SourceStyleLedgerEntry[];
  ruleRecords: CssRuleRecord[];
}

/**
 * Scan a stylesheet without flattening its conditional structure. CSS comments, quotes, url(),
 * attribute selectors, and escaped quotes are respected while finding braces and declarations.
 * Malformed tail content becomes a blocked rule record instead of disappearing.
 */
export function scanStylesheet(css: string): CssStylesheet {
  return new StylesheetScanner(css).scan();
}

export interface DeclarationDisposition {
  outcome: Exclude<StyleLedgerOutcome, 'pending' | 'scoped-css'> | 'scoped-css';
  reason?: string;
}

export interface ScopeStylesheetOptions {
  /** The deterministic generated-block root, e.g. `.wp-block-acme-hero`. */
  root: string;
  /**
   * Called only for a safe, local style rule. Returning native/preset/literal leaves that
   * declaration out of parity CSS; returning nothing keeps it as scoped CSS.
   */
  disposition?: (declaration: CssDeclaration, rule: CssStyleRule, context: { conditional: boolean }) => DeclarationDisposition | undefined;
  /** Rewrite source selector atoms before the root prefix is applied. */
  selectorTransform?: (selector: string, rule: CssStyleRule) => string;
}

export interface ScopedStylesheet {
  root: string;
  rules: CssRule[];
  /** The same retained rules before adding the root, for the confirmed-plan compiler. */
  localRules: CssRule[];
  ledger: SourceStyleLedgerEntry[];
  ruleRecords: CssRuleRecord[];
  css: string;
}

/**
 * Scope safe local selectors under a generated block root. Foundation rules and selectors that can
 * name or depend on the document outside that root are not rewritten: their declarations and rule
 * records are explicitly blocked. This is intentionally stricter than merely prefixing every
 * selector, because that would turn Preflight into a misleading claim of semantic equivalence.
 */
export function scopeStylesheet(stylesheet: CssStylesheet, options: ScopeStylesheetOptions): ScopedStylesheet {
  const ledger = stylesheet.ledger.map((entry) => ({ ...entry, atRules: [...entry.atRules] }));
  const ledgerByDeclaration = new Map(ledger.map((entry) => [entry.declarationId, entry]));
  const ruleRecords = stylesheet.ruleRecords.map((record) => ({ ...record }));
  const recordsByRule = new Map(ruleRecords.map((record) => [record.ruleId, record]));
  const localSelectors = new Map<string, string>();
  const rootProblem = validateScopeRoot(options.root);

  const blockRule = (rule: CssRule, reason: string): void => {
    const record = recordsByRule.get(rule.id);
    if (record) {
      record.outcome = 'blocked';
      record.reason = reason;
    }
    forEachDeclaration(rule, (declaration) => {
      const entry = ledgerByDeclaration.get(declaration.id);
      if (entry) {
        entry.outcome = 'blocked';
        entry.reason = reason;
      }
    });
  };

  const scopeRule = (rule: CssRule, conditional = false): CssRule | undefined => {
    if (rootProblem) {
      blockRule(rule, rootProblem);
      return undefined;
    }

    if (rule.kind === 'blocked') {
      blockRule(rule, rule.reason);
      return undefined;
    }

    if (rule.kind === 'conditional') {
      const children = rule.rules.map((child) => scopeRule(child, true)).filter((child): child is CssRule => Boolean(child));
      const record = recordsByRule.get(rule.id);
      if (children.length === 0) {
        if (record) {
          record.outcome = 'blocked';
          record.reason = 'contains no safe residual CSS after scoping';
        }
        return undefined;
      }
      if (record) {
        record.outcome = 'scoped-css';
      }
      return { ...rule, rules: children };
    }

    if (rule.nestedIn) {
      blockRule(rule, 'nested CSS selectors are not safely re-rootable without a nesting compiler');
      return undefined;
    }

    let transformedSelector = rule.selector;
    try {
      transformedSelector = options.selectorTransform?.(rule.selector, rule) ?? rule.selector;
    } catch (error) {
      blockRule(rule, errorMessage(error));
      return undefined;
    }
    const scoped = scopeLocalSelectorList(transformedSelector, options.root);
    if (!scoped.ok) {
      blockRule(rule, scoped.reason);
      return undefined;
    }

    const declarations: CssDeclaration[] = [];
    for (const declaration of rule.declarations) {
      const entry = ledgerByDeclaration.get(declaration.id);
      // A native block style is unconditional. Preserve media/support/container semantics as
      // exact scoped CSS until a dedicated, equivalent target responsive state is modelled.
      const disposition = conditional
        ? { outcome: 'scoped-css' as const }
        : options.disposition?.(declaration, rule, { conditional }) ?? { outcome: 'scoped-css' as const };
      if (!entry) {
        continue;
      }
      entry.outcome = disposition.outcome;
      entry.reason = disposition.reason;
      if (disposition.outcome === 'scoped-css') {
        declarations.push(declaration);
      }
    }

    const record = recordsByRule.get(rule.id);
    if (declarations.length === 0) {
      if (record) {
        const blocked = rule.declarations.some(
          (declaration) => ledgerByDeclaration.get(declaration.id)?.outcome === 'blocked',
        );
        record.outcome = blocked ? 'blocked' : 'scoped-css';
        record.reason = blocked
          ? 'contains no safe residual CSS after declaration safety checks'
          : 'all declarations were emitted through destination-native styles';
      }
      return undefined;
    }
    if (record) {
      record.outcome = 'scoped-css';
    }
    localSelectors.set(rule.id, transformedSelector);
    return { ...rule, selector: scoped.selector, declarations };
  };

  const rules = stylesheet.rules.map((rule) => scopeRule(rule)).filter((rule): rule is CssRule => Boolean(rule));
  const localRule = (rule: CssRule): CssRule => rule.kind === 'style'
    ? { ...rule, selector: localSelectors.get(rule.id)! }
    : { ...rule, rules: rule.rules.map(localRule) };
  const result: ScopedStylesheet = { root: options.root.trim(), rules, localRules: rules.map(localRule), ledger, ruleRecords, css: '' };
  result.css = renderResidualCss(result);
  return result;
}

/** Render the original rule order in a normalized, deterministic format. */
export function renderResidualCss(stylesheet: Pick<ScopedStylesheet, 'rules'>): string {
  return stylesheet.rules.map((rule) => renderRule(rule, 0)).filter(Boolean).join('\n');
}

/** Prefix a safe selector list, retaining pseudo states and a comma-list's original ordering. */
export function scopeLocalSelectorList(
  selectorList: string,
  root: string,
): { ok: true; selector: string } | { ok: false; reason: string } {
  const rootProblem = validateScopeRoot(root);
  if (rootProblem) {
    return { ok: false, reason: rootProblem };
  }

  const selectors = splitTopLevel(selectorList, ',').map((selector) => selector.trim()).filter(Boolean);
  if (selectors.length === 0) {
    return { ok: false, reason: 'empty selector cannot be scoped' };
  }

  for (const selector of selectors) {
    const problem = unsafeSelectorReason(selector);
    if (problem) {
      return { ok: false, reason: problem };
    }
  }

  return { ok: true, selector: selectors.map((selector) => `${root.trim()} ${selector}`).join(', ') };
}

export interface SelectorDependencyTransport {
  /** Marker conditions the conversion DOM must retain before native blocks discard raw attributes. */
  dependencies: SourceSelectorDependency[];
  /** Rewrite only id/attribute selector atoms; ordinary class selectors remain author-visible. */
  rewrite(selector: string): string;
}

/**
 * Preserve selector semantics across native conversion without blindly copying arbitrary source
 * attributes onto block attributes (which Gutenberg would silently discard). Attribute atoms
 * become deterministic marker classes attached only to matching source elements. ID atoms keep an
 * ID-specific `:is()` branch as well as their marker, preserving cascade specificity after the
 * raw ID disappears from a native block.
 */
export function createSelectorDependencyTransport(): SelectorDependencyTransport {
  const dependencies: SourceSelectorDependency[] = [];
  const markers = new Map<string, string>();
  const usedMarkers = new Set<string>();

  const markerFor = (kind: SourceSelectorDependency['kind'], value: string): string => {
    const key = `${kind}\u0000${value}`;
    const existing = markers.get(key);
    if (existing) {
      return existing;
    }
    const base = `block-runner-selector-${kind}-${fnv1a(value)}`;
    let marker = base;
    let suffix = 1;
    while (usedMarkers.has(marker)) {
      suffix += 1;
      marker = `${base}-${suffix}`;
    }
    usedMarkers.add(marker);
    markers.set(key, marker);
    dependencies.push({ markerClass: marker, kind, value });
    return marker;
  };

  return {
    dependencies,
    rewrite(selector) {
      let output = '';
      let index = 0;
      let quote: string | undefined;

      while (index < selector.length) {
        const char = selector[index];
        if (quote) {
          output += char;
          if (char === '\\') {
            output += selector[index + 1] ?? '';
            index += 2;
            continue;
          }
          if (char === quote) {
            quote = undefined;
          }
          index += 1;
          continue;
        }
        if (char === '"' || char === "'") {
          quote = char;
          output += char;
          index += 1;
          continue;
        }
        if (char === '#') {
          const identifier = readCssIdentifier(selector, index + 1);
          if (identifier) {
            // :is() takes the specificity of its most specific argument. Keep the exact raw ID
            // branch (which also remains correct inside a Custom HTML fallback) while the marker
            // branch makes the selector survive native conversion.
            output += `:is(${selector.slice(index, identifier.end)}, .${markerFor('id', identifier.value)})`;
            index = identifier.end;
            continue;
          }
        }
        if (char === '[') {
          const attribute = readAttributeSelector(selector, index);
          if (!attribute || !isValidAttributeSelector(attribute.value)) {
            throw new Error(`invalid attribute selector ${attribute?.value ?? selector.slice(index)} cannot be transported into generated block CSS`);
          }
          output += `.${markerFor('attribute', attribute.value)}`;
          index = attribute.end;
          continue;
        }
        output += char;
        index += 1;
      }
      return output;
    },
  };
}

/**
 * Accept the portable attribute-selector subset the DOM matcher handles in HTML. Deliberately
 * reject namespaces/comments/exotic forms rather than creating a marker for a selector we cannot
 * prove will match after conversion.
 */
function isValidAttributeSelector(selector: string): boolean {
  if (!selector.startsWith('[') || !selector.endsWith(']')) {
    return false;
  }
  const body = selector.slice(1, -1);
  let index = skipSelectorWhitespace(body, 0);
  const name = readValidCssIdentifier(body, index);
  if (!name) return false;
  index = skipSelectorWhitespace(body, name.end);
  if (index === body.length) return true;

  const operator = /^(?:[~|^$*]?=)/.exec(body.slice(index))?.[0];
  if (!operator) return false;
  index = skipSelectorWhitespace(body, index + operator.length);
  if (index >= body.length) return false;

  if (isSelectorQuote(body[index])) {
    const quote = body[index];
    index += 1;
    while (index < body.length) {
      if (body[index] === '\\') {
        index += 2;
      } else if (body[index] === quote) {
        index += 1;
        break;
      } else {
        index += 1;
      }
    }
    if (body[index - 1] !== quote) return false;
  } else {
    const value = readValidCssIdentifier(body, index);
    if (!value) return false;
    index = value.end;
  }

  index = skipSelectorWhitespace(body, index);
  if (index === body.length) return true;
  if ((body[index] === 'i' || body[index] === 'I' || body[index] === 's' || body[index] === 'S')
    && skipSelectorWhitespace(body, index + 1) === body.length) {
    return true;
  }
  return false;
}

function skipSelectorWhitespace(value: string, start: number): number {
  let index = start;
  while (/\s/.test(value[index] ?? '')) index += 1;
  return index;
}

function isSelectorQuote(value: string | undefined): value is '"' | "'" {
  return value === '"' || value === "'";
}

function readValidCssIdentifier(value: string, start: number): { end: number } | undefined {
  const raw = value[start];
  if (!raw || (raw !== '\\' && !raw.startsWith('-') && !/[A-Za-z_]/.test(raw) && raw.codePointAt(0)! < 0x80)) {
    return undefined;
  }
  if (raw === '-' && /[0-9]/.test(value[start + 1] ?? '')) {
    return undefined;
  }
  const identifier = readCssIdentifier(value, start);
  return identifier ? { end: identifier.end } : undefined;
}

/** Read class names from selectors/CSS with CSS escape semantics (`.\\32xl\\:block` → `2xl:block`). */
export function referencedCssClasses(css: string): string[] {
  const classes = new Set<string>();
  let index = 0;
  let quote: string | undefined;
  let comment = false;

  while (index < css.length) {
    if (comment) {
      if (css[index] === '*' && css[index + 1] === '/') {
        comment = false;
        index += 2;
      } else {
        index += 1;
      }
      continue;
    }
    if (quote) {
      if (css[index] === '\\') {
        index += 2;
      } else {
        if (css[index] === quote) quote = undefined;
        index += 1;
      }
      continue;
    }
    if (css[index] === '/' && css[index + 1] === '*') {
      comment = true;
      index += 2;
      continue;
    }
    if (css[index] === '"' || css[index] === "'") {
      quote = css[index];
      index += 1;
      continue;
    }
    if (css[index] === '.') {
      const identifier = readCssIdentifier(css, index + 1);
      if (identifier) {
        classes.add(identifier.value);
        index = identifier.end;
        continue;
      }
    }
    index += 1;
  }
  return [...classes];
}

function readCssIdentifier(value: string, start: number): { value: string; end: number } | undefined {
  let decoded = '';
  let index = start;
  while (index < value.length) {
    const char = value[index];
    if (char === '\\') {
      const escaped = readCssEscape(value, index + 1);
      if (!escaped) break;
      decoded += escaped.value;
      index = escaped.end;
      continue;
    }
    if (!isCssIdentifierCharacter(char)) {
      break;
    }
    decoded += char;
    index += 1;
  }
  return decoded ? { value: decoded, end: index } : undefined;
}

function readCssEscape(value: string, start: number): { value: string; end: number } | undefined {
  if (start >= value.length) return undefined;
  let end = start;
  while (end < value.length && end - start < 6 && /[0-9a-f]/i.test(value[end])) {
    end += 1;
  }
  if (end > start) {
    const codePoint = Number.parseInt(value.slice(start, end), 16);
    if (/\s/.test(value[end] ?? '')) end += 1;
    return {
      value: codePoint === 0 || codePoint > 0x10ffff ? '\uFFFD' : String.fromCodePoint(codePoint),
      end,
    };
  }
  return { value: value[start], end: start + 1 };
}

function isCssIdentifierCharacter(value: string): boolean {
  return /[-_A-Za-z0-9]/.test(value) || value.codePointAt(0)! >= 0x80;
}

function readAttributeSelector(value: string, start: number): { value: string; end: number } | undefined {
  let index = start + 1;
  let quote: string | undefined;
  while (index < value.length) {
    const char = value[index];
    if (quote) {
      if (char === '\\') {
        index += 2;
        continue;
      }
      if (char === quote) quote = undefined;
      index += 1;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      index += 1;
      continue;
    }
    if (char === '\\') {
      index += 2;
      continue;
    }
    if (char === ']') {
      return { value: value.slice(start, index + 1), end: index + 1 };
    }
    index += 1;
  }
  return undefined;
}

function fnv1a(value: string): string {
  let hash = 0x811c9dc5;
  for (const char of value) {
    hash ^= char.codePointAt(0)!;
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

function validateScopeRoot(root: string): string | undefined {
  const value = root.trim();
  if (!value) {
    return 'generated block root is required for residual CSS';
  }
  if (/[{},;]/.test(value) || value.includes('\n') || value.includes('\r')) {
    return 'generated block root is not a single safe selector';
  }
  return undefined;
}

function unsafeSelectorReason(selector: string): string | undefined {
  const normalized = unescapeCss(selector).toLowerCase();
  if (!normalized) {
    return 'empty selector cannot be scoped';
  }
  if (/^[>+~]/.test(normalized) || /[&]|\/deep\/|>>>/.test(normalized)) {
    return 'selector uses a relative, nested, or deep-combinator form that cannot be safely rooted';
  }
  if (/:global\s*\(|:host(?:-context)?\b|::(?:part|slotted|backdrop)\b|:scope\b/.test(normalized)) {
    return 'selector can escape the generated block subtree';
  }
  if (/(?:^|[\s>+~,(])(?:html|body)(?=$|[\s>+~.#[:])|:root\b/.test(normalized)) {
    return 'global document selector is not safe to scope';
  }
  // A bare element, universal selector, or pseudo-only selector is a foundation/Preflight rule.
  // It can be rendered below a root, but doing so changes the rule from global CSS to component CSS
  // and must not be called semantically equivalent without an explicit foundation policy.
  if (!/[.#\[]/.test(normalized)) {
    return 'global foundation/Preflight selector is not scoped as an equivalent block rule';
  }
  return undefined;
}

function renderRule(rule: CssRule, depth: number): string {
  const indent = '  '.repeat(depth);
  if (rule.kind === 'style') {
    if (rule.declarations.length === 0) {
      return '';
    }
    const body = rule.declarations
      .map((declaration) => `${declaration.property}: ${declaration.value}${declaration.important ? ' !important' : ''};`)
      .join(' ');
    return `${indent}${rule.selector} { ${body} }`;
  }
  if (rule.kind === 'conditional') {
    const body = rule.rules.map((child) => renderRule(child, depth + 1)).filter(Boolean).join('\n');
    return body ? `${indent}@${rule.name} ${rule.prelude} {\n${body}\n${indent}}` : '';
  }
  return '';
}

function forEachDeclaration(rule: CssRule, visit: (declaration: CssDeclaration) => void): void {
  if (rule.kind === 'style' || rule.kind === 'blocked') {
    for (const declaration of rule.declarations) {
      visit(declaration);
    }
  }
  if (rule.kind === 'conditional' || rule.kind === 'blocked') {
    for (const child of rule.rules) {
      forEachDeclaration(child, visit);
    }
  }
}

class StylesheetScanner {
  private readonly css: string;
  private readonly lineStarts: number[];
  private readonly ledger: SourceStyleLedgerEntry[] = [];
  private readonly ruleRecords: CssRuleRecord[] = [];
  private ruleNumber = 0;
  private declarationNumber = 0;

  constructor(css: string) {
    this.css = css;
    this.lineStarts = [0];
    for (let index = 0; index < css.length; index += 1) {
      if (css[index] === '\n') {
        this.lineStarts.push(index + 1);
      }
    }
  }

  scan(): CssStylesheet {
    return { rules: this.parseRules(0, this.css.length, []), ledger: this.ledger, ruleRecords: this.ruleRecords };
  }

  private parseRules(start: number, end: number, atRules: string[]): CssRule[] {
    const rules: CssRule[] = [];
    let cursor = start;

    while (cursor < end) {
      cursor = skipTrivia(this.css, cursor, end);
      if (cursor >= end) {
        break;
      }
      const headerStart = cursor;
      const boundary = findRuleBoundary(this.css, cursor, end);
      if (!boundary) {
        const id = this.nextRuleId();
        const source = this.range(headerStart, end);
        const reason = 'unterminated stylesheet rule';
        const rule: CssBlockedRule = {
          id,
          kind: 'blocked',
          name: 'malformed',
          prelude: this.css.slice(headerStart, end).trim(),
          declarations: [],
          rules: [],
          reason,
          source,
        };
        this.recordRule(rule, 'pending');
        rules.push(rule);
        break;
      }

      const header = this.css.slice(headerStart, boundary.index).trim();
      if (boundary.kind === ';') {
        if (header) {
          rules.push(this.parseStatement(header, headerStart, boundary.index + 1));
        }
        cursor = boundary.index + 1;
        continue;
      }
      if (boundary.kind === '}') {
        // The caller owns this closing brace. At top level it is malformed but is still recorded.
        if (header) {
          const id = this.nextRuleId();
          const source = this.range(headerStart, boundary.index + 1);
          const rule: CssBlockedRule = {
            id,
            kind: 'blocked',
            name: 'malformed',
            prelude: header,
            declarations: [],
            rules: [],
            reason: 'unexpected closing brace in stylesheet',
            source,
          };
          this.recordRule(rule, 'pending');
          rules.push(rule);
        }
        cursor = boundary.index + 1;
        continue;
      }

      const close = findMatchingBrace(this.css, boundary.index, end);
      if (close === -1) {
        const id = this.nextRuleId();
        const source = this.range(headerStart, end);
        const rule: CssBlockedRule = {
          id,
          kind: 'blocked',
          name: header.startsWith('@') ? atRuleName(header) : 'malformed',
          prelude: header,
          declarations: [],
          rules: [],
          reason: 'unterminated stylesheet block',
          source,
        };
        this.recordRule(rule, 'pending');
        rules.push(rule);
        break;
      }

      if (header.startsWith('@')) {
        rules.push(this.parseAtRule(header, headerStart, boundary.index + 1, close, atRules));
      } else if (header) {
        rules.push(this.parseStyleRule(header, headerStart, boundary.index + 1, close, atRules));
      }
      cursor = close + 1;
    }

    return rules;
  }

  private parseStatement(header: string, start: number, end: number): CssBlockedRule {
    const id = this.nextRuleId();
    const name = header.startsWith('@') ? atRuleName(header) : 'statement';
    const reason = name === 'import' ? '@import is a source-graph dependency and is never emitted into a generated block' : 'standalone CSS statement is not safe residual block CSS';
    const rule: CssBlockedRule = {
      id,
      kind: 'blocked',
      name,
      prelude: header,
      declarations: [],
      rules: [],
      reason,
      source: this.range(start, end),
    };
    this.recordRule(rule, 'pending');
    return rule;
  }

  private parseAtRule(header: string, start: number, bodyStart: number, close: number, atRules: string[]): CssRule {
    const id = this.nextRuleId();
    const name = atRuleName(header);
    const prelude = header.slice(name.length + 1).trim();
    const source = this.range(start, close + 1);

    if (name === 'media' || name === 'supports' || name === 'container') {
      const rule: CssConditionalRule = {
        id,
        kind: 'conditional',
        name,
        prelude,
        rules: this.parseRules(bodyStart, close, [...atRules, `@${name} ${prelude}`.trim()]),
        source,
      };
      this.recordRule(rule, 'pending');
      return rule;
    }

    const reason = blockedAtRuleReason(name);
    const descriptors = isDescriptorAtRule(name);
    const declarations = descriptors ? this.parseDeclarations(bodyStart, close, id, [...atRules, header]) : [];
    // Even a blocked at-rule can contain authored selector rules. Parse those children purely for
    // accounting so `@layer { .card { … } }` cannot lose its declarations behind one aggregate
    // "unsupported at-rule" warning. They remain blocked by the parent during scoping.
    const rules = descriptors ? [] : this.parseRules(bodyStart, close, [...atRules, header]);
    const rule: CssBlockedRule = { id, kind: 'blocked', name, prelude, declarations, rules, reason, source };
    this.recordRule(rule, 'pending');
    return rule;
  }

  private parseStyleRule(
    selector: string,
    start: number,
    bodyStart: number,
    close: number,
    atRules: string[],
    nestedIn?: string,
  ): CssStyleRule {
    const id = this.nextRuleId();
    const rule: CssStyleRule = {
      id,
      kind: 'style',
      selector,
      declarations: this.parseDeclarations(bodyStart, close, id, atRules),
      source: this.range(start, close + 1),
      ...(nestedIn ? { nestedIn } : {}),
    };
    this.recordRule(rule, 'pending');
    return rule;
  }

  /** Parse declaration statements, retaining every authored declaration rather than expanding it. */
  private parseDeclarations(start: number, end: number, ruleId: string, atRules: string[]): CssDeclaration[] {
    const declarations: CssDeclaration[] = [];
    let cursor = start;

    while (cursor < end) {
      cursor = skipTrivia(this.css, cursor, end);
      if (cursor >= end) {
        break;
      }
      const segmentStart = cursor;
      const boundary = findRuleBoundary(this.css, cursor, end);
      if (!boundary || boundary.kind === '}') {
        const declaration = this.parseDeclaration(segmentStart, end, ruleId, atRules);
        if (declaration) {
          declarations.push(declaration);
        }
        break;
      }
      if (boundary.kind === ';') {
        const declaration = this.parseDeclaration(segmentStart, boundary.index, ruleId, atRules);
        if (declaration) {
          declarations.push(declaration);
        }
        cursor = boundary.index + 1;
        continue;
      }

      // A block in a declaration body is CSS nesting or an at-rule. Its declarations still need
      // ledger entries, so parse it as a nested selector and leave it for the scoper to block.
      const close = findMatchingBrace(this.css, boundary.index, end);
      if (close === -1) {
        break;
      }
      const nestedHeader = this.css.slice(segmentStart, boundary.index).trim();
      if (nestedHeader.startsWith('@')) {
        const nested = this.parseAtRule(nestedHeader, segmentStart, boundary.index + 1, close, atRules);
        this.markNestedRuleBlocked(nested);
      } else if (nestedHeader) {
        const nested = this.parseStyleRule(nestedHeader, segmentStart, boundary.index + 1, close, atRules, ruleId);
        this.markNestedRuleBlocked(nested);
      }
      cursor = close + 1;
    }
    return declarations;
  }

  private parseDeclaration(start: number, end: number, ruleId: string, atRules: string[]): CssDeclaration | undefined {
    const raw = stripComments(this.css.slice(start, end)).trim();
    if (!raw) {
      return undefined;
    }
    const colon = indexOfTopLevel(raw, ':');
    if (colon === -1) {
      this.recordMalformedDeclaration(raw, start, end, ruleId, atRules, 'not a parseable CSS declaration');
      return undefined;
    }
    const property = raw.slice(0, colon).trim();
    const rawValue = raw.slice(colon + 1).trim();
    if (!property || !rawValue) {
      this.recordMalformedDeclaration(raw, start, end, ruleId, atRules, 'CSS declaration needs both a property and a value');
      return undefined;
    }
    const importantMatch = /^(.*?)\s*!\s*important\s*$/is.exec(rawValue);
    const value = (importantMatch?.[1] ?? rawValue).trim();
    if (!value) {
      return undefined;
    }
    const declaration: CssDeclaration = {
      id: this.nextDeclarationId(),
      property,
      value,
      important: Boolean(importantMatch),
      source: this.range(start, end),
    };
    this.ledger.push({
      declarationId: declaration.id,
      ruleId,
      property,
      value,
      important: declaration.important,
      source: declaration.source,
      atRules: [...atRules],
      outcome: 'pending',
    });
    return declaration;
  }

  private recordMalformedDeclaration(
    raw: string,
    start: number,
    end: number,
    ruleId: string,
    atRules: string[],
    reason: string,
  ): void {
    const colon = indexOfTopLevel(raw, ':');
    this.ledger.push({
      declarationId: this.nextDeclarationId(),
      ruleId,
      property: (colon === -1 ? raw : raw.slice(0, colon)).trim() || '<empty>',
      value: colon === -1 ? '' : raw.slice(colon + 1).trim(),
      important: false,
      source: this.range(start, end),
      atRules: [...atRules],
      outcome: 'warned',
      reason,
    });
  }

  private nextRuleId(): string {
    this.ruleNumber += 1;
    return `rule-${this.ruleNumber}`;
  }

  private nextDeclarationId(): string {
    this.declarationNumber += 1;
    return `declaration-${this.declarationNumber}`;
  }

  private recordRule(rule: CssRule, outcome: CssRuleRecord['outcome']): void {
    this.ruleRecords.push({
      ruleId: rule.id,
      kind: rule.kind,
      prelude: rule.kind === 'style' ? rule.selector : `@${rule.name} ${rule.prelude}`.trim(),
      source: rule.source,
      outcome,
      ...(rule.kind === 'blocked' ? { reason: rule.reason } : {}),
    });
  }

  /**
   * CSS nesting needs a nesting compiler to combine `&` and parent selectors. We still scan every
   * nested declaration, then mark it now because the nested rule is not a standalone CSS rule that
   * can safely be emitted later.
   */
  private markNestedRuleBlocked(rule: CssRule): void {
    const reason = 'nested CSS requires a nesting compiler before it can be safely block-scoped';
    const record = this.ruleRecords.find((entry) => entry.ruleId === rule.id);
    if (record) {
      record.outcome = 'blocked';
      record.reason = reason;
    }
    forEachDeclaration(rule, (declaration) => {
      const ledger = this.ledger.find((entry) => entry.declarationId === declaration.id);
      if (ledger) {
        ledger.outcome = 'blocked';
        ledger.reason = reason;
      }
    });
  }

  private range(start: number, end: number): CssSourceRange {
    return { start: this.position(start), end: this.position(end) };
  }

  private position(offset: number): CssPosition {
    let low = 0;
    let high = this.lineStarts.length;
    while (low + 1 < high) {
      const middle = Math.floor((low + high) / 2);
      if (this.lineStarts[middle] <= offset) {
        low = middle;
      } else {
        high = middle;
      }
    }
    return { offset, line: low + 1, column: offset - this.lineStarts[low] + 1 };
  }
}

function blockedAtRuleReason(name: string): string {
  if (name === 'import') {
    return '@import is a source-graph dependency and is never emitted into a generated block';
  }
  if (name === 'font-face') {
    return '@font-face is global and font licensing/asset handling must be decided separately';
  }
  if (isKeyframes(name)) {
    return '@keyframes are global identifiers and require collision-safe renaming before they can be emitted';
  }
  return `@${name} is not a safe, block-scoped residual CSS construct`;
}

function isKeyframes(name: string): boolean {
  return /(?:^|-)keyframes$/i.test(name);
}

/** At-rules whose bodies are descriptor declarations rather than nested selector rules. */
function isDescriptorAtRule(name: string): boolean {
  return name === 'font-face' || name === 'property' || name === 'counter-style' || name === 'page';
}

function atRuleName(header: string): string {
  return /^@([\w-]+)/.exec(header)?.[1].toLowerCase() ?? 'unknown';
}

function skipTrivia(css: string, start: number, end: number): number {
  let cursor = start;
  while (cursor < end) {
    if (/\s/.test(css[cursor])) {
      cursor += 1;
      continue;
    }
    if (css[cursor] === '/' && css[cursor + 1] === '*') {
      const close = css.indexOf('*/', cursor + 2);
      cursor = close === -1 || close >= end ? end : close + 2;
      continue;
    }
    break;
  }
  return cursor;
}

type RuleBoundary = { index: number; kind: '{' | ';' | '}' };

function findRuleBoundary(css: string, start: number, end: number): RuleBoundary | undefined {
  let quote: string | undefined;
  let escaped = false;
  let parens = 0;
  let brackets = 0;

  for (let index = start; index < end; index += 1) {
    const char = css[index];
    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === quote) {
        quote = undefined;
      }
      continue;
    }
    if (char === '/' && css[index + 1] === '*') {
      const close = css.indexOf('*/', index + 2);
      if (close === -1 || close >= end) {
        return undefined;
      }
      index = close + 1;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === '(') {
      parens += 1;
    } else if (char === ')') {
      parens = Math.max(0, parens - 1);
    } else if (char === '[') {
      brackets += 1;
    } else if (char === ']') {
      brackets = Math.max(0, brackets - 1);
    } else if (parens === 0 && brackets === 0 && (char === '{' || char === ';' || char === '}')) {
      return { index, kind: char };
    }
  }
  return undefined;
}

function findMatchingBrace(css: string, open: number, end: number): number {
  let quote: string | undefined;
  let escaped = false;
  let depth = 0;

  for (let index = open; index < end; index += 1) {
    const char = css[index];
    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === quote) {
        quote = undefined;
      }
      continue;
    }
    if (char === '/' && css[index + 1] === '*') {
      const close = css.indexOf('*/', index + 2);
      if (close === -1 || close >= end) {
        return -1;
      }
      index = close + 1;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === '{') {
      depth += 1;
    } else if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        return index;
      }
    }
  }
  return -1;
}

function splitTopLevel(value: string, separator: string): string[] {
  const out: string[] = [];
  let start = 0;
  let quote: string | undefined;
  let escaped = false;
  let parens = 0;
  let brackets = 0;

  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === quote) {
        quote = undefined;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === '(') {
      parens += 1;
    } else if (char === ')') {
      parens = Math.max(0, parens - 1);
    } else if (char === '[') {
      brackets += 1;
    } else if (char === ']') {
      brackets = Math.max(0, brackets - 1);
    } else if (char === separator && parens === 0 && brackets === 0) {
      out.push(value.slice(start, index));
      start = index + 1;
    }
  }
  out.push(value.slice(start));
  return out;
}

function indexOfTopLevel(value: string, separator: string): number {
  let quote: string | undefined;
  let escaped = false;
  let parens = 0;
  let brackets = 0;

  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === quote) {
        quote = undefined;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === '(') {
      parens += 1;
    } else if (char === ')') {
      parens = Math.max(0, parens - 1);
    } else if (char === '[') {
      brackets += 1;
    } else if (char === ']') {
      brackets = Math.max(0, brackets - 1);
    } else if (char === separator && parens === 0 && brackets === 0) {
      return index;
    }
  }
  return -1;
}

function stripComments(value: string): string {
  let out = '';
  let quote: string | undefined;
  let escaped = false;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (quote) {
      out += char;
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === quote) {
        quote = undefined;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      out += char;
      continue;
    }
    if (char === '/' && value[index + 1] === '*') {
      const close = value.indexOf('*/', index + 2);
      if (close === -1) {
        break;
      }
      index = close + 1;
      continue;
    }
    out += char;
  }
  return out;
}

/** Decode enough CSS escapes to stop escaped `body`/`:root` spellings bypassing the safety gate. */
function unescapeCss(value: string): string {
  return value.replace(/\\([0-9a-f]{1,6}\s?|.)/gi, (_, escaped: string) => {
    const hex = escaped.trim();
    if (/^[0-9a-f]{1,6}$/i.test(hex)) {
      const point = Number.parseInt(hex, 16);
      return Number.isSafeInteger(point) ? String.fromCodePoint(point) : '';
    }
    return escaped;
  });
}
import type { SourceSelectorDependency } from '../types.js';
