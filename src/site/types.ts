import type { IntentTree, ReportItem } from '../types.js';

export interface SiteThemeIntent {
  slug: string;
  title: string;
  themeJson: Record<string, unknown>;
}

/** A named native block document. Every body is later sent through `realize`. */
export interface SiteDocumentIntent {
  body: IntentTree;
}

export interface SitePatternIntent {
  title: string;
  slug: string;
  body: IntentTree;
}

export interface SitePageIntent {
  /** Stable logical identity within `siteId`; independent of route and content. */
  id: string;
  route: string;
  title: string;
  parentId?: string;
  template: string;
  body: IntentTree;
  /** Omitted input defaults to draft during source preparation. */
  status?: SitePageStatus;
}

export type SitePageStatus = 'draft' | 'publish' | 'private' | 'pending';

export interface SiteAssetIntent {
  /** Stable logical identity independent of the source filename. */
  id: string;
  /** Safe path relative to the explicit asset root. */
  path: string;
  kind: 'image' | 'font' | 'stylesheet' | 'other';
  /** Attachments require a later WordPress binding; theme files are copied as files. */
  role: 'theme-file' | 'attachment';
  /** Human-supplied redistribution decision for a theme font. */
  fontLicense?: { ownership: string; license: string; notice?: string };
  /** Exact CSS url() token values declared by a stylesheet and their local theme-file assets. */
  cssUrls?: Array<{ url: string; assetId: string }>;
}

export type SiteAssetAttribute = 'url' | 'attrs.url' | 'attrs.src' | 'attrs.id';

export interface SiteAssetUse {
  /** `page:<id>`, `template:<name>`, `part:<name>`, or `pattern:<name>`. */
  documentId: string;
  /** Child indices from the document's `blocks` array, for example `[0, 1]`. */
  nodePath: number[];
  attribute: SiteAssetAttribute;
  assetId: string;
}

/** Caller-authored whole-site input. All collections are explicit, including empty collections. */
export interface SiteIntent {
  version: 1;
  siteId: string;
  /** Explicit logical identity of the page at `/`. */
  homePageId: string;
  theme: SiteThemeIntent;
  templates: Record<string, SiteDocumentIntent>;
  parts: Record<string, SiteDocumentIntent>;
  /** Keys are safe stable file keys used when a pattern file is emitted. */
  patterns: Record<string, SitePatternIntent>;
  pages: SitePageIntent[];
  assets: SiteAssetIntent[];
  assetUses: SiteAssetUse[];
}

export interface PreparedSiteAsset {
  id: string;
  path: string;
  kind: SiteAssetIntent['kind'];
  role: SiteAssetIntent['role'];
  sha256: string;
  bytes: Uint8Array;
}

/** Validated source with stable local bytes, still unbound to WordPress entities. */
export interface PreparedSiteSource {
  sourceIntent: SiteIntent;
  assetRoot: string;
  assets: PreparedSiteAsset[];
  sourceIdentity: string;
  unresolvedAssetUses: SiteAssetUse[];
}

export interface SiteInputDiagnostic {
  path: string;
  code: string;
  message: string;
}

export type PreparedSiteSourceResult =
  | { ok: true; source: PreparedSiteSource; diagnostics: [] }
  | { ok: false; diagnostics: SiteInputDiagnostic[] };

export interface CompiledSitePage {
  id: string;
  route: string;
  title: string;
  parentId?: string;
  template: string;
  /** Finalized Gutenberg serialization produced from the source page body. */
  content: string;
  status: SitePageStatus;
  diagnostics: ReportItem[];
}

export interface SiteFile {
  path: string;
  bytes: Uint8Array;
  sha256: string;
}

export interface SiteAttachmentBinding {
  /** WordPress attachment ID supplied by the caller or an adapter. */
  id: number;
  url: string;
  attachmentPageUrl?: string;
  observedSize?: { width?: number; height?: number; bytes?: number };
  /** Image variants observed from WordPress attachment metadata, keyed by native size slug. */
  imageSizes?: Readonly<Record<string, { url: string; width: number; height: number }>>;
}

/** Successful, fully bound result of compiling the complete site. */
export interface CompiledSite {
  sourceIntent: SiteIntent;
  sourceAssets: PreparedSiteAsset[];
  targetBindings: Record<string, SiteAttachmentBinding>;
  targetBindingFingerprint: string;
  themeAssetBaseUrl?: string;
  themeFiles: SiteFile[];
  pages: CompiledSitePage[];
  assets: SiteFile[];
  diagnostics: ReportItem[];
  inventory: Array<{ path: string; sha256: string; size: number }>;
  artifactIdentity: string;
}

/** Fully compiled theme component when page-owned bindings are still pending. */
export interface ThemeArtifact {
  sourceIntent: SiteIntent;
  sourceAssets: PreparedSiteAsset[];
  targetBindings: Record<string, SiteAttachmentBinding>;
  targetBindingFingerprint: string;
  themeAssetBaseUrl?: string;
  themeFiles: SiteFile[];
  pendingPageBindings: SiteAssetUse[];
  diagnostics: ReportItem[];
  inventory: Array<{ path: string; sha256: string; size: number }>;
  artifactIdentity: string;
}
