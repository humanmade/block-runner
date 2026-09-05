import type { StyleLedgerEntry } from './styles/apply.js';
import type { Declaration } from './styles/parse.js';
import type { FontLicenseDecision } from './author/assets.js';

export type CommandName = 'validate' | 'fix' | 'convert' | 'assemble' | 'author';

export type ReportStatus = 'valid' | 'invalid' | 'warning';

export interface SourceLocation {
  path?: string;
  selector?: string;
  htmlLine?: number;
  htmlColumn?: number;
  offset?: number;
}

/**
 * A selector condition rewritten to a transport class before native conversion removes arbitrary
 * source IDs/attributes. It is internal to the registered-block authoring handoff.
 */
export interface SourceSelectorDependency {
  markerClass: string;
  kind: 'id' | 'attribute';
  /** Decoded id value, or the complete attribute selector such as `[data-state="open"]`. */
  value: string;
}

export interface ReportItem {
  block?: string;
  status: ReportStatus;
  reason: string;
  source?: SourceLocation;
  rule?: string;
  details?: unknown;
}

export interface ReportSummary {
  blocks: number;
  valid: number;
  invalid: number;
  warnings: number;
}

export interface BlockRunnerReport {
  ok: boolean;
  command: CommandName;
  summary: ReportSummary;
  items: ReportItem[];
  /** Exact source identity for the registered-block HTML authoring pass, when available. */
  source?: import('./authoring/schema.js').AuthoringSource;
  /**
   * Deterministic observations made at the input edge. This is deliberately available even when
   * the optional HTML-to-block rules proposal cannot represent the source.
   */
  evidence?: AuthorSourceEvidence;
  /** Advisory guidance only; never affects `ok` or summary counts. */
  hint?: string;
  output?: string;
  /**
   * CSS the block model cannot express, emitted by the `open` styling rung. Present only when that
   * rung rescued something. The caller must ship this alongside the content — the rung is only
   * honest if it does, which is why `open` requires an explicit sink.
   */
  sidecarCss?: string;
  /**
   * Every asset observed while authoring a registered block.  This is deliberately separate from
   * Gutenberg media IDs: static block assets do not need (and must never invent) media-library
   * records.
   */
  assets?: AssetLedgerEntry[];
  /** One terminal disposition for every declaration in an authored stylesheet graph. */
  styleLedger?: AuthoredStyleLedgerEntry[];
  /** Files that make up an authored registered block, keyed by their package-relative path. */
  package?: GeneratedBlockPackage;
}

/** A source element observed without assigning it a Gutenberg meaning. */
export interface AuthorSourceElement {
  tag: string;
  attributes: Record<string, string>;
  source?: SourceLocation;
}

/**
 * Evidence separated from a proposed native tree. Consumers may use it to construct a plan, but
 * must carry its source and coverage records into that plan before compiling it.
 */
export interface AuthorSourceEvidence {
  source: import('./authoring/schema.js').AuthoringSource;
  structure: AuthorSourceElement[];
  dependencies: Array<{ kind: 'stylesheet' | 'tailwind-build'; reference: string; source?: SourceLocation }>;
  /** Input-edge diagnostics. They never instruct a caller to rewrite otherwise safe markup. */
  diagnostics: ReportItem[];
  /** Present once CSS/assets have been scanned, including unresolved dispositions. */
  coverage?: import('./authoring/schema.js').AuthoringCoverage;
}

export type AuthoredStyleOutcome = 'native' | 'preset' | 'literal' | 'scoped-css' | 'warned' | 'blocked';

export interface AuthoredStyleLedgerEntry {
  property: string;
  value: string;
  outcome: AuthoredStyleOutcome;
  reason?: string;
  atRules: string[];
  source?: SourceLocation;
}

/** The terminal disposition of a source asset. */
export type AssetOutcome = 'prepared' | 'copied' | 'uploaded' | 'reused' | 'external' | 'unresolved' | 'blocked';

export interface AssetLedgerEntry {
  /** The source spelling, before any package-relative rewrite. */
  reference: string;
  /** The package-relative replacement, where a local asset was copied. */
  rewritten?: string;
  /** How the asset was encountered. */
  kind: 'image' | 'font' | 'stylesheet' | 'media' | 'other';
  outcome: AssetOutcome;
  reason?: string;
  source?: SourceLocation;
}

/** The materialized inputs handed to the project's pinned Tailwind compiler. */
export interface TailwindCompilerInput {
  /** Each declared entry after Block Runner has read it from the supplied style graph. */
  cssEntries: ReadonlyArray<{ path: string; css: string }>;
  /** Resolved local imports supplied as part of the graph. */
  imports: ReadonlyArray<{ path: string; css: string }>;
  directives: readonly string[];
  sources: readonly string[];
  safelist: readonly string[];
  plugins: readonly string[];
  environment: Readonly<Record<string, string | number | boolean | null | undefined>>;
  browserTarget: string | readonly string[];
}

/**
 * A compiler deliberately comes from the calling project, where its Tailwind version and plugins
 * are pinned.  Block Runner invokes it during authoring and never ships it with the generated
 * block.  The name/version fields make that provenance visible in configuration and reports.
 */
export interface TailwindCompiler {
  name: string;
  version: string;
  compile(input: TailwindCompilerInput): string | Promise<string>;
}

/**
 * Inputs required to make a Tailwind fidelity claim.  Empty arrays/objects are meaningful: they
 * say that a project has explicitly supplied no plugins/safelist/etc.  An omitted field is not
 * equivalent to an empty one and is reported as missing.
 */
export interface TailwindBuildGraph {
  cssEntries?: readonly string[];
  imports?: readonly string[];
  directives?: readonly string[];
  sources?: readonly string[];
  safelist?: readonly string[];
  plugins?: readonly string[];
  environment?: Readonly<Record<string, string | number | boolean | null | undefined>>;
  browserTarget?: string | readonly string[];
  /** The pinned compiler that must produce the stylesheet used for authoring. */
  compiler?: TailwindCompiler;
}

export interface AuthorStyleConfig {
  /**
   * Declares how the stylesheet was produced. CSS provenance cannot be recovered from compiled
   * declarations, so this is required whenever authoring receives non-empty stylesheet input.
   */
  mode?: 'css' | 'tailwind';
  /** Actual compiled CSS. In Tailwind mode it must match the pinned compiler output. */
  css?: string;
  /** Required for Tailwind source or runtime output; its compiler is run during authoring. */
  tailwind?: TailwindBuildGraph;
  /** Explicitly supplied editor-only affordances. Parity CSS is always emitted through `style`. */
  editorCss?: string;
  /** Reference-bound local WOFF/WOFF2 decisions; a boolean cannot establish redistribution rights. */
  fontLicenses?: readonly FontLicenseDecision[];
  /** Optional destination-approved fallback stack for fonts which cannot be redistributed. */
  fallbackStack?: string;
  /** Target facts used for ownership decisions; copied into the hash-bound plan coverage. */
  context?: { theme?: { slug?: string; version?: string; settings?: Record<string, unknown> }; viewports?: Partial<Record<'mobile' | 'tablet', { min?: string; max?: string }>> };
}

export interface AuthorConfig {
  /** Namespace/slug, for example `acme/hero`. Must name exactly one registered block. */
  name?: string;
  title?: string;
  category?: string;
  /** Optional known supports of the generated block. Values are never assumed from a slug. */
  supports?: Record<string, unknown>;
  /** Proposed native structure policy, exposed in the returned canonical plan. */
  locking?: import('./authoring/schema.js').AuthoringLocking;
  styles?: AuthorStyleConfig;
}

export interface GeneratedBlockPackage {
  name: string;
  rootSelector: string;
  files: Record<string, string>;
  /** Review or modify this plan through author preview/write before publishing source. */
  canonicalPlan?: import('./authoring/schema.js').AuthoringPlan;
  manifest?: import('./authoring/generate.js').GeneratedSourceManifest;
  /** Hash-bound local files prepared without writing; executable source remains separate. */
  assets?: Array<{ source: string; path: string; sha256: string }>;
}

export type ResolverKind = 'noop' | 'map' | 'wpcli' | 'rest';

export interface MediaConfig {
  resolver?: ResolverKind;
  mapFile?: string;
  map?: Record<string, MediaMapEntry>;
  allowRemote?: boolean;
  reuse?: boolean;
  wpUrl?: string;
  wpUser?: string;
  wpAppPassword?: string;
}

export interface MediaMapEntry {
  id?: number | null;
  url?: string;
}

export interface MediaResult {
  url: string;
  id: number | null;
  resolved: boolean;
  reason?: string;
}

export interface MediaResolveInput {
  urlOrPath: string;
  source?: SourceLocation;
  kind: 'cover' | 'image';
}

export interface MediaResolver {
  kind: ResolverKind;
  resolve(input: MediaResolveInput): Promise<MediaResult>;
}

export type TokenMatchMode = 'exact' | 'nearest';
export type TokenResolverKind = 'noop' | 'file' | 'wpcli' | 'rest' | 'context';

export interface TokenConfig {
  colors?: Record<string, string>;
  fonts?: Record<string, string>;
  fontSizes?: Record<string, string>;
  spacing?: string[] | Record<string, string>;
  match?: TokenMatchMode;
  resolver?: TokenResolverKind;
  themeJson?: string;
  context?: string;
}

export interface ResolvedTokens {
  colors: Record<string, string>;
  fonts: Record<string, string>;
  fontSizes: Record<string, string>;
  spacing: Record<string, string>;
}

export interface TokenResolver {
  kind: TokenResolverKind;
  resolve(): Promise<ResolvedTokens>;
}

export interface RuleConfig {
  disabledDefaults?: string[];
  order?: string[];
  custom?: unknown[];
}

/**
 * The styling ceiling, from safest (cleanest, most editable) to most faithful. Per element the
 * converter uses the strictest rung that still captures the design, never exceeding this ceiling.
 *
 * - `strict` — the theme's vocabulary only; off-system values are dropped and reported.
 * - `relaxed` — keep exact values on the block's `style` attribute. The default.
 * - `open` — also keep CSS no block attribute can express, as sidecar CSS the caller must ship.
 *
 * A `source` rung (keep the original markup as Custom HTML) is designed but not built, and is
 * deliberately absent here rather than exported as an option every runtime path rejects.
 */
export type StylingRung = 'strict' | 'relaxed' | 'open';

export interface BlockRunnerConfig {
  strict?: boolean;
  styling?: StylingRung;
  media?: MediaConfig;
  tokens?: TokenConfig;
  rules?: RuleConfig | unknown[];
  /** Registered-block authoring options. Kept separate from the legacy post-content converter. */
  author?: AuthorConfig;
}

export interface CommonOptions {
  configPath?: string;
  sourcePath?: string;
  strict?: boolean;
  explain?: boolean;
  resolver?: ResolverKind;
  wpUrl?: string;
  wpUser?: string;
  wpAppPassword?: string;
  tokenResolver?: TokenResolverKind;
  themeJson?: string;
  tokenMatch?: TokenMatchMode;
  context?: string;
  styling?: StylingRung;
}

export interface ConvertOptions extends CommonOptions {
  config?: BlockRunnerConfig;
  /**
   * Internal authoring hook: retain only source classes referenced by generated scoped CSS on the
   * native block that claimed the source element. Undefined preserves legacy conversion output.
   */
  preserveSourceClasses?: readonly string[];
  /** Internal authoring handoff for IDs/attributes referenced by the generated scoped CSS. */
  preserveSourceSelectorDependencies?: readonly SourceSelectorDependency[];
  /**
   * Source class declarations retained by the authored stylesheet. They are excluded from the
   * native styling pass so one declaration never lands both as scoped CSS and as a block style.
   */
  suppressSourceDeclarations?: readonly string[];
  /** Internal authoring boundary for asset forms a native Core block cannot faithfully retain. */
  preserveAssetForms?: boolean;
  /** Internal observer used by registered-block authoring to account for inline declarations. */
  styleLedgerObserver?: (entries: readonly StyleLedgerEntry[], source: SourceLocation, block?: string) => void;
}

export interface AuthorOptions extends ConvertOptions {
  /** Directory to write the generated package. Omit to inspect `report.package` without writing. */
  outDir?: string;
  /** Per-run author settings, which override `config.author`. */
  author?: AuthorConfig;
  /**
   * A caller-authored native proposal. It is validated by the same registered-block compiler as a
   * rules proposal and must retain the exact source/coverage evidence observed in this run.
   */
  plan?: import('./authoring/schema.js').AuthoringPlan;
}

export interface AssembleOptions extends CommonOptions {
  config?: BlockRunnerConfig;
}

export interface ValidateOptions extends CommonOptions {
  config?: BlockRunnerConfig;
}

export interface CanonicalizeOptions extends CommonOptions {
  config?: BlockRunnerConfig;
}

/**
 * A deliberately permissive block-intent node. The small field set gives producers a stable
 * envelope while `attrs` passes block-specific attributes through to Gutenberg. Unknown
 * attribute keys are intentionally accepted and left for the registered block type to sanitize.
 */
export interface IntentNode {
  block: string;
  text?: string;
  url?: string;
  alt?: string;
  level?: number;
  citation?: string;
  items?: string[];
  rows?: string[][];
  attrs?: Record<string, unknown>;
  children?: IntentNode[];
}

export interface IntentTree {
  blocks: IntentNode[];
}

/**
 * The lock applied to the one InnerBlocks area a generated block owns.
 *
 * `false` is intentional rather than an omitted value: it prevents an inherited template lock
 * from leaking into an otherwise editable generated block.
 */
export type InnerBlocksLock = false | 'insert' | 'all' | 'contentOnly';
/** Alias for callers that use the WordPress `templateLock` terminology. */
export type TemplateLock = InnerBlocksLock;

/**
 * Semantic roles used by the registered-block authoring path.  Roles are deliberately about the
 * editor surface, not the source HTML tag.  For example, a visual eyebrow is still a paragraph
 * unless it has document-outline meaning and should be a heading.
 */
export type AuthoringRole =
  | 'wrapper'
  | 'group'
  | 'columns'
  | 'column'
  | 'cover'
  | 'heading'
  | 'paragraph'
  | 'image'
  | 'list'
  | 'list-item'
  | 'buttons'
  | 'button'
  | 'quote'
  | 'custom';

/**
 * A typed description of one node in a generated registered block.
 *
 * `path` is a producer-owned stable identifier, not an array index invented while emitting
 * source. It lets previews, review UIs, and diagnostics point at exactly the same authoring
 * decision after a template has been compiled. Ordinary values intentionally live on the native
 * child (`content`, `url`, `alt`, and so on), never on the wrapper block.
 */
export interface AuthoringNode {
  /** A stable, unique path within the plan, e.g. `hero.content.title`. */
  path: string;
  /** The editor-facing semantic role. */
  role: AuthoringRole;
  /**
   * Explicitly select a block implementation. This is required for `custom`, optional for native
   * roles (where the compiler supplies the matching core block).
   */
  block?: string;
  /** Initial Gutenberg attributes for this child block. */
  attributes?: Record<string, unknown>;
  /** Initial rich-text value for heading, paragraph, list item, button, or a quote's generated paragraph child. */
  content?: string;
  /** Initial image or button URL. */
  url?: string;
  /** Initial image alternative text. */
  alt?: string;
  /** Initial heading level. */
  level?: number;
  /** Nested native block template. */
  children?: AuthoringNode[];
  /** Enable native pattern overrides for supported content fields. */
  patternOverrides?: boolean;
  /**
   * A custom child that needs its own InnerBlocks region is allowed only with an explicit reason.
   * This keeps the generated wrapper at exactly one InnerBlocks region by default.
   */
  justification?: string;
  /** Whether this custom child requires a separately implemented InnerBlocks region. */
  requiresOwnInnerBlocks?: boolean;
}

/** A generated package is one custom wrapper around this native child template. */
export interface AuthoringPlan {
  /** Fully-qualified registered block name, such as `acme/hero`. */
  name: string;
  title: string;
  description?: string;
  category?: string;
  icon?: string;
  textdomain?: string;
  /** The semantic wrapper. Its children are the direct InnerBlocks children. */
  root: AuthoringNode;
  /** Default: `false`, so a post or pattern lock is not inherited accidentally. */
  templateLock?: InnerBlocksLock;
  /**
   * Optional explicit direct-child allowlist. When absent it is inferred only from
   * `root.children`; nested children do not leak into this list.
   */
  allowedBlocks?: string[];
}

/** A concrete native editor field rendered by a child block. */
export interface AuthoringEditableField {
  /** Stable plan path of the node that owns this surface. */
  path: string;
  role: AuthoringRole;
  block: string;
  attribute: string;
  /** The native WordPress editor surface that owns the field. */
  surface: 'richText' | 'media' | 'link' | 'altText';
  /** Stable native pattern override name. */
  overrideName?: string;
}

export interface AuthoringDiagnostic {
  level: 'warning' | 'error';
  code:
    | 'duplicate-path'
    | 'missing-path'
    | 'invalid-root'
    | 'unsupported-role'
    | 'unsupported-pattern-override'
    | 'duplicate-override-name'
    | 'custom-child-justification-required'
    | 'multiple-innerblocks-regions'
    | 'gutenberg-76794';
  message: string;
  path?: string;
}

/** Gutenberg's `[ name, attributes, children? ]` InnerBlocks template tuple. */
export type AuthoringTemplate = Array<[string, Record<string, unknown>, AuthoringTemplate?]>;

/** The deterministic source package emitted from an AuthoringPlan. */
export interface CompiledAuthoringBlock {
  /** The actual versioned plan used by the shared source compiler and CLI confirmation flow. */
  canonicalPlan?: import('./authoring/schema.js').AuthoringPlan;
  files: Record<string, string>;
  template: AuthoringTemplate;
  allowedBlocks: string[];
  templateLock: InnerBlocksLock;
  editableFields: AuthoringEditableField[];
  diagnostics: AuthoringDiagnostic[];
}

export type WpBlock = {
  name: string;
  attributes: Record<string, unknown>;
  innerBlocks: WpBlock[];
  originalContent?: string;
  isValid?: boolean;
  validationIssues?: unknown[];
  __blockRunnerSource?: SourceLocation;
};

export interface RuleMatch {
  matched: boolean;
  reason?: string;
}

export interface RuleContext {
  wp: WpModules;
  config: BlockRunnerConfig;
  rules: Rule[];
  sourcePath?: string;
  explain: boolean;
  cssBackgrounds: Map<string, string>;
  /**
   * Single-class `<style>` rules in document order. Rules that need an element's *effective* CSS
   * should resolve it from these plus the inline attribute, never from either alone.
   */
  cssClassRules: Array<{ className: string; declarations: Declaration[]; problems: string[] }>;
  /** Preserve asset-bearing source markup as Custom HTML when a native block would drop it. */
  preserveAssetForms?: boolean;
  /**
   * Carry an element's inline CSS onto the block a rule just claimed. Called by the walker for
   * every claimed node; rules never need to invoke it.
   */
  applyStyles: (node: Node, blocks: WpBlock[]) => void;
  /**
   * Account for inline CSS on elements inside a block's rich text. Those descendants never pass
   * through the walker, so without this their style attributes reach the output unledgered.
   */
  noteRichTextStyles: (node: Node, block?: string, rule?: string) => void;
  warn: (reason: string, node: Node, block?: string, rule?: string, details?: unknown) => void;
  explainRule: (node: Node, rule: string, reason: string, details?: unknown) => void;
  sourceFor: (node: Node) => SourceLocation;
  recurse: (node: Node, skip?: Set<Node>) => Promise<WpBlock[]>;
  text: (node: Node) => string;
  html: (node: Element) => string;
}

export interface Rule {
  id: string;
  match: (node: Element, context: RuleContext) => boolean | RuleMatch;
  emit: (node: Element, context: RuleContext) => Promise<WpBlock | WpBlock[] | null>;
}

export interface WpModules {
  createBlock: (name: string, attributes?: Record<string, unknown>, innerBlocks?: WpBlock[]) => WpBlock;
  parse: (markup: string, options?: Record<string, unknown>) => WpBlock[];
  serialize: (blocks: WpBlock[] | WpBlock) => string;
  validateBlock: (block: WpBlock) => [boolean, unknown[]?];
  getBlockType: (name: string) => unknown;
  registerBlockType: (nameOrMetadata: string | Record<string, unknown>, settings?: Record<string, unknown>) => unknown;
  unregisterBlockType: (name: string) => unknown;
}

export class HeadlessBootError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'HeadlessBootError';
  }
}

// The real-WordPress proof ladder is kept in focused modules, but its public
// contracts are also reachable from this conventional central type surface.
export type {
  ProofEditableField,
  ProofEditableSurface,
  ProofEnvironment,
  ProofFilePin,
  ProofFixture,
  ProofGateContext,
  ProofGateResult,
  ProofGateRunner,
  ProofCommandResult,
  ProofCommandRunner,
  ProofReceiptDocument,
  ProofRunOptions,
  ProofRunResult,
  WordPressPackagePin,
  ProofPatternInstance,
  ProofPatternRequiredBinding,
  PatternOverrideContent,
} from './proof/runner.js';
export type {
  GateId,
  GateRecord,
  GateStatus,
  ProfileName,
  ProofGateId,
  ProofGateOutcome,
  ProofGateRecord,
  ProofGateRecords,
  ProofGateStatus,
  ProofProfile,
  ProofProfileEvaluation,
  ProofProfileName,
  ProofProfileReport,
} from './proof/profiles.js';
export type {
  CanonicalJsonValue,
  ContentAddressedReference,
  EvidencePutOptions,
  EvidenceReference,
  HashInput,
  ProofReceipt,
  ReceiptReference,
  ReceiptWriteResult,
  Sha256,
} from './proof/receipt.js';
