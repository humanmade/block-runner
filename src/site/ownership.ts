import type { SiteEntity, SiteSnapshot } from './plan-types.js';

/** Index agreement only; callers must also prove unique ownership and the managed baseline. */
export function siteRecordIndexesEntity(snapshot: SiteSnapshot, siteId: string, entity: SiteEntity): boolean {
  const record = snapshot.siteRecord;
  const owner = entity.ownership.length === 1 ? entity.ownership[0] : undefined;
  if (!record || record.version !== 1 || record.siteId !== siteId || !owner || owner.siteId !== siteId || owner.kind !== entity.kind) return false;
  if (entity.kind !== 'attachment') return record.entities[`${owner.kind}:${owner.entityId}`] === entity.id;
  const sha256 = owner.assetSha256;
  if (typeof sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(sha256)) return false;
  return record.entities[`attachment:${owner.entityId}@${sha256}`] === entity.id;
}
