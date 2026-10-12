import type { IntentNode } from '../types.js';
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
