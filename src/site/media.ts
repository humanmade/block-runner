import type { IntentNode } from '../types.js';
import { hashCanonicalJson } from '../proof/receipt.js';
import type { SiteSnapshot } from './plan-types.js';
import type { SiteAttachmentBinding } from './types.js';

export interface ImageBindingResult {
  url: string;
  sizeSlug: string;
  width?: number;
  height?: number;
  error?: string;
}

/** Stable ownership/index key for one exact source version of a logical attachment. */
export function attachmentVersionKey(entityId: string, sha256: string): string {
  return `attachment:${entityId}@${sha256}`;
}

/** Prove one available attachment against exact ownership, complete baseline and site index. */
export function verifiedOwnedAttachment(
  snapshot: SiteSnapshot,
  siteId: string,
  entityId: string,
  originalSha256: string,
  wpId: number,
): boolean {
  if (!/^[a-f0-9]{64}$/.test(originalSha256) || !Number.isSafeInteger(wpId) || wpId < 1) return false;
  const numericIds = snapshot.entities.map(candidate => candidate.id);
  if (numericIds.some(id => !Number.isSafeInteger(id) || id < 1) || new Set(numericIds).size !== numericIds.length) return false;
  const ids = snapshot.entities.filter(entity => entity.id === wpId);
  if (ids.length !== 1) return false;
  const entity = ids[0]!;
  if (entity.kind !== 'attachment' || entity.ownership.length !== 1 || entity.postStatus !== 'inherit'
    || !/^[a-f0-9]{64}$/.test(entity.attachment?.currentFileSha256 ?? '')) return false;
  const owner = entity.ownership[0]!;
  if (owner.version !== 1 || owner.siteId !== siteId || owner.entityId !== entityId || owner.kind !== 'attachment'
    || !/^sha256:[a-f0-9]{64}$/.test(owner.lastAppliedHash) || owner.lastAppliedHash !== hashCanonicalJson(entity.state)) return false;
  const ownerSha = owner.assetSha256 ?? (typeof entity.state.sha256 === 'string' ? entity.state.sha256 : undefined);
  if (ownerSha !== originalSha256 || entity.state.sha256 !== originalSha256) return false;
  const exactVersions = snapshot.entities.filter(candidate => candidate.kind === 'attachment'
    && candidate.ownership.length === 1
    && candidate.ownership[0]!.version === 1
    && candidate.ownership[0]!.siteId === siteId
    && candidate.ownership[0]!.entityId === entityId
    && candidate.ownership[0]!.kind === 'attachment'
    && candidate.ownership[0]!.lastAppliedHash === hashCanonicalJson(candidate.state)
    && (candidate.ownership[0]!.assetSha256 ?? (typeof candidate.state.sha256 === 'string' ? candidate.state.sha256 : undefined)) === originalSha256
    && candidate.state.sha256 === originalSha256);
  if (exactVersions.length !== 1 || exactVersions[0]!.id !== wpId) return false;
  const record = snapshot.siteRecord;
  if (!record || record.version !== 1 || record.siteId !== siteId) return false;
  const versionId = record.entities[attachmentVersionKey(entityId, originalSha256)];
  const legacyId = owner.assetSha256 === undefined ? record.entities[`attachment:${entityId}`] : undefined;
  if (versionId !== undefined && legacyId !== undefined && versionId !== legacyId) return false;
  return versionId === wpId || legacyId === wpId;
}

/**
 * Apply the destination's observed native image metadata before shared finalization.
 * Covers deliberately keep their separate schema and are not changed here.
 */
export function bindNativeImage(node: IntentNode, binding: SiteAttachmentBinding): ImageBindingResult | undefined {
  if (node.block !== 'core/image') return undefined;
  const attrs = node.attrs ?? (node.attrs = {});
  const explicitSize = attrs.sizeSlug;
  if (explicitSize !== undefined && (typeof explicitSize !== 'string' || explicitSize.length === 0)) {
    return { url: binding.url, sizeSlug: 'full', error: 'image sizeSlug must be a non-empty native size name' };
  }
  const sizeSlug = typeof explicitSize === 'string' ? explicitSize : 'full';
  const imageSize = binding.imageSizes?.[sizeSlug];
  if (binding.imageSizes && !imageSize) {
    return { url: binding.url, sizeSlug, error: `destination attachment has no observed ${sizeSlug} image size` };
  }
  const url = imageSize?.url ?? binding.url;
  if (explicitSize === undefined) attrs.sizeSlug = sizeSlug;
  const linkDestination = attrs.linkDestination;
  if (linkDestination !== undefined && !['none', 'media', 'attachment', 'custom'].includes(String(linkDestination))) {
    return { url, sizeSlug, error: 'image linkDestination is unsupported by the native image block' };
  }
  const destination = linkDestination ?? 'none';
  if (destination === 'none' && typeof attrs.href === 'string' && attrs.href.length > 0) {
    return { url, sizeSlug, error: 'image href contradicts linkDestination none' };
  }
  if (destination === 'media' || destination === 'attachment') {
    const target = destination === 'media' ? binding.url : binding.attachmentPageUrl;
    if (!target) return { url, sizeSlug, error: `destination attachment has no observed ${destination} link URL` };
    if (typeof attrs.href === 'string' && attrs.href !== target) return { url, sizeSlug, error: `image href contradicts observed ${destination} link URL` };
    attrs.href = target;
  }
  if (destination === 'custom') {
    if (typeof attrs.href !== 'string') return { url, sizeSlug, error: 'custom image linkDestination requires an explicit href' };
    try { const href = new URL(attrs.href); if (!['http:', 'https:'].includes(href.protocol) || href.username || href.password) throw new Error(); }
    catch { return { url, sizeSlug, error: 'custom image href must be an HTTP(S) URL without credentials' }; }
  }
  if (linkDestination === undefined) attrs.linkDestination = destination;
  return { url, sizeSlug, ...(imageSize ? { width: imageSize.width, height: imageSize.height } : {}) };
}

/** A declared embed ratio is the only offline ratio source accepted by site compilation. */
export function declaredEmbedAspectRatio(node: IntentNode): string | undefined {
  if (node.block !== 'core/embed') return undefined;
  const value = node.attrs?.aspectRatio;
  if (typeof value !== 'string' || !/^\d+(?:\.\d+)?\s*\/\s*\d+(?:\.\d+)?$/.test(value)) return undefined;
  const [width, height] = value.split('/').map(part => Number(part.trim()));
  return Number.isFinite(width) && Number.isFinite(height) && width! > 0 && height! > 0 ? `${width} / ${height}` : undefined;
}
