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
 * The lock applied to the single InnerBlocks region a generated wrapper owns.
 * It deliberately controls structure independently from content overrides.
 */
export type InnerBlocksLock = false | 'insert' | 'all' | 'contentOnly';
export type TemplateLock = InnerBlocksLock;

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
 * A stable semantic node in one generated registered block. Its values remain
 * native child-block attributes rather than wrapper attributes.
 */
export interface AuthoringNode {
  path: string;
  role: AuthoringRole;
  block?: string;
  attributes?: Record<string, unknown>;
  content?: string;
  url?: string;
  alt?: string;
  level?: number;
  /**
   * Defaults to enabled for supported native content attributes. Set false
   * only when this content region must remain canonical in every pattern.
   */
  patternOverrides?: boolean;
  children?: AuthoringNode[];
  justification?: string;
  requiresOwnInnerBlocks?: boolean;
}

export interface AuthoringPlan {
  name: string;
  title: string;
  description?: string;
  category?: string;
  icon?: string;
  textdomain?: string;
  root: AuthoringNode;
  templateLock?: InnerBlocksLock;
  allowedBlocks?: string[];
}

export interface AuthoringEditableField {
  /** Stable plan path of the native node that owns this surface. */
  path: string;
  role: AuthoringRole;
  block: string;
  attribute: string;
  surface: 'richText' | 'media' | 'link' | 'altText';
  /**
   * Stable unique key used by WordPress core/pattern-overrides. Omitted only
   * for an explicitly non-overrideable field.
   */
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

export type AuthoringTemplate = Array<[string, Record<string, unknown>, AuthoringTemplate?]>;

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
