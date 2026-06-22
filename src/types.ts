export type CommandName = 'validate' | 'fix' | 'convert';

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
  output?: string;
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

export interface TokenConfig {
  colors?: Record<string, string>;
  fonts?: Record<string, string>;
  spacing?: string[];
}

export interface RuleConfig {
  disabledDefaults?: string[];
  order?: string[];
  custom?: unknown[];
}

export interface BlockRunnerConfig {
  strict?: boolean;
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
}

export interface ConvertOptions extends CommonOptions {
  config?: BlockRunnerConfig;
}

export interface ValidateOptions extends CommonOptions {
  config?: BlockRunnerConfig;
}

export interface CanonicalizeOptions extends CommonOptions {
  config?: BlockRunnerConfig;
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
}

export class HeadlessBootError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'HeadlessBootError';
  }
}
