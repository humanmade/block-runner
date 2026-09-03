export { canonicalize } from './gate/canonicalize.js';
export { validate } from './gate/validate.js';
export { convert } from './convert/assemble.js';
export { author } from './author/index.js';
export {
  compileTailwindBuildGraph,
  hasTailwindSignal,
  renderResidualCss,
  scanStylesheet,
  scopeLocalSelectorList,
  scopeStylesheet,
  validateCssBuildGraph,
} from './author/styles.js';
export type { CssBuildGraph, TailwindCompilation, TailwindCompilationOptions } from './author/styles.js';
export {
  classifyCssUrlReference,
  processCssAssets,
  rewriteCssAssets,
  scanCssUrlReferences,
} from './author/assets.js';
export { assemble, extractIntent, realize } from './intent/index.js';
export { compileAuthoringBlock, compileAuthoringPlan } from './authoring/compile.js';
export { collectSiteContext } from './context/run.js';
export {
  AUTHORING_PLAN_VERSION,
  AuthoringPlanValidationError,
  canonicalAuthoringPlanHash,
  canonicalAuthoringPlanJson,
  canonicalizeAuthoringPlan,
  hashAuthoringPlan,
  isSafeAuthoringRelativePath,
  serializeAuthoringPlan,
  validateAuthoringPlan,
} from './authoring/schema.js';
export { previewAuthoringPlan, renderAuthoringPreview } from './authoring/preview.js';
export { hashAuthoringConfirmation, inspectAuthoringDestination, writeAuthoringPlan } from './authoring/destination.js';
export type { SiteContextOptions } from './context/run.js';
export type {
  AuthoringAsset,
  AuthoringAssetStatus,
  AuthoringField,
  AuthoringFieldMode,
  AuthoringFile,
  AuthoringFileOperation,
  AuthoringLocking,
  AuthoringLockMode,
  AuthoringNodeLock,
  AuthoringPattern,
  AuthoringPatternOverride,
  AuthoringPlan,
  AuthoringStructureNode,
  AuthoringStyleOutcome,
  AuthoringStyleOutcomeKind,
  AuthoringStyleStrategy,
  AuthoringStyles,
  AuthoringTarget,
  JsonPrimitive,
  JsonValue,
} from './authoring/schema.js';
export type { AuthoringPreviewContext, AuthoringPreviewOptions } from './authoring/preview.js';
export type { AuthoringDestinationApproval, DestinationEntry, DestinationInspection } from './authoring/destination.js';
export type {
  AssembleOptions,
  AuthoringDiagnostic,
  AuthoringEditableField,
  AuthoringNode,
  AuthoringPlan,
  AuthoringRole,
  AuthoringTemplate,
  AssetLedgerEntry,
  AssetOutcome,
  AuthoredStyleLedgerEntry,
  AuthoredStyleOutcome,
  AuthorConfig,
  AuthorOptions,
  AuthorStyleConfig,
  BlockRunnerConfig,
  BlockRunnerReport,
  CanonicalizeOptions,
  CommandName,
  CommonOptions,
  CompiledAuthoringBlock,
  ConvertOptions,
  IntentNode,
  IntentTree,
  InnerBlocksLock,
  GeneratedBlockPackage,
  MediaConfig,
  MediaMapEntry,
  MediaResult,
  MediaResolver,
  ReportItem,
  ReportStatus,
  ReportSummary,
  ResolvedTokens,
  ResolverKind,
  Rule,
  RuleContext,
  SourceLocation,
  StylingRung,
  TemplateLock,
  TokenConfig,
  TokenMatchMode,
  TokenResolver,
  TokenResolverKind,
  TailwindBuildGraph,
  TailwindCompiler,
  TailwindCompilerInput,
  ValidateOptions,
  WpBlock,
} from './types.js';
