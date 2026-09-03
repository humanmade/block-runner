import type { Declaration } from './styles/parse.js';

export type CommandName = 'validate' | 'fix' | 'convert' | 'assemble';

export type ReportStatus = 'valid' | 'invalid' | 'warning';

export interface SourceLocation {
  path?: string;
  selector?: string;
  htmlLine?: number;
  htmlColumn?: number;
  offset?: number;
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
  /** Advisory guidance only; never affects `ok` or summary counts. */
  hint?: string;
  output?: string;
  /**
   * CSS the block model cannot express, emitted by the `open` styling rung. Present only when that
   * rung rescued something. The caller must ship this alongside the content — the rung is only
   * honest if it does, which is why `open` requires an explicit sink.
   */
  sidecarCss?: string;
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
}

export interface AuthoringDiagnostic {
  level: 'warning' | 'error';
  code:
    | 'duplicate-path'
    | 'missing-path'
    | 'invalid-root'
    | 'unsupported-role'
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
