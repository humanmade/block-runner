import type { IntentTree, ReportItem } from '../types.js';
import type { SiteAssetUse, SiteInputDiagnostic, SiteSyncedPatternUse } from './types.js';

export interface SiteTarget { homeUrl: string; siteUrl: string; blogId: number }
export interface SiteOwnership {
  version: 1;
  siteId: string;
  entityId: string;
  kind: SiteEntity['kind'];
  lastAppliedHash: string;
  /** Exact original bytes for one owned attachment version. Omitted on legacy records. */
  assetSha256?: string;
}
export interface SiteEntity {
  id: number;
  kind: 'page' | 'attachment' | 'pattern';
  route: string | null;
  state: Record<string, unknown>;
  attachment?: {
    url: string | null;
    linkUrl?: string | null;
    currentFileSha256: string | null;
    width: number | null;
    height: number | null;
    sizes?: Record<string, { url: string; width: number; height: number }>;
  };
  ownership: SiteOwnership[];
}
export interface SiteSnapshot {
  target: SiteTarget;
  runtime: { wordpress: string; php: string };
  principal: { userId: number; capabilities: Record<string, boolean> };
  theme: { slug: string; assetBaseUrl: string; inventory: Array<{ path: string; sha256: string; size: number }> };
  routing: { permalinkStructure: string; rewriteRulesHash: string | null; unsupportedReason?: string; routes: Array<{ route: string; kind: 'available' | 'singular' | 'reserved' | 'unsupported'; postId?: number; postType?: string; matchedRule: string | null; queryFingerprint: string; reason?: string }> };
  entities: SiteEntity[];
  overrides: Array<{ id: number; kind: string; theme: string[]; content: string }>;
  navigation: Array<{ id: number; content: string; status: string }>;
  options: Record<string, unknown>;
  siteRecord: { version: 1; siteId: string; entities: Record<string, number>; options: Record<string, { lastAppliedValue: unknown }>; operation: { token: string; planHash: string; status: 'started' | 'outcome_unknown' | 'completed' } | null } | null;
}
export interface SitePlanOperation {
  action: 'create' | 'update' | 'retain' | 'set-option';
  kind: SiteEntity['kind'] | 'option';
  entityId: string;
  id?: number;
  beforeFingerprint?: string;
  desired?: Record<string, unknown>;
  pendingBindings?: SiteAssetUse[];
  pendingPatternUses?: SiteSyncedPatternUse[];
  body?: IntentTree;
  requiresFinalization?: boolean;
  externalBinding?: boolean;
}
export interface SitePlan {
  version: 1;
  siteId: string;
  sourceIdentity: string;
  artifactIdentity: string;
  assets: Array<{ id: string; path: string; sha256: string }>;
  snapshot: SiteSnapshot;
  snapshotFingerprint: string;
  operations: SitePlanOperation[];
  conflicts: SiteInputDiagnostic[];
  diagnostics: ReportItem[];
  executable: boolean;
  confirmationHash: string;
}
