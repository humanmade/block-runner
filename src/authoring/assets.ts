import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readlinkSync } from 'node:fs';
import path from 'node:path';
import type { AuthoringPlan } from './schema.js';
import type { AuthoringAsset } from './schema.js';
import type { CssAssetKind } from '../author/assets.js';
import { confirmedStylesheetAssets } from './styles.js';
import { assertStaticSvg } from './svg.js';

export interface GeneratedAssetFile {
  path: string;
  kind: 'asset';
  /** Image/font is kept separate from the manifest's generic file kind for the generator seam. */
  assetKind?: Exclude<CssAssetKind, 'asset'> | 'image';
  content: Buffer;
  hash: string;
  operation: 'create' | 'replace';
}

/** Human decision required before a font can be redistributed in a generated plugin. */
export interface FontOwnershipDecision {
  ownership: string;
  license: string;
  /** Optional supplied redistribution notice; preserved as provenance, not interpreted. */
  notice?: string;
}

type AuthoringAssetWithFontDecision = AuthoringAsset & {
  /** Canonical spelling reserved for the 0.9 plan seam. */
  fontLicense?: FontOwnershipDecision;
};

/** Read-only: preview and compile both verify the bytes the person confirmed. */
export function collectConfirmedAssets(plan: AuthoringPlan): GeneratedAssetFile[] {
  const outputs = new Set<string>();
  const stylesheetAssets = confirmedStylesheetAssets(plan.styles, plan.target.name, plan.assets);
  const confirmedFontAssetIds = new Set((plan.styles.fonts ?? []).map(({ assetId }) => assetId));
  return plan.assets.flatMap((asset, index) => {
    const at = `assets[${index}]`;
    const typedAsset = asset as AuthoringAssetWithFontDecision;
    const assetKind = typedAsset.kind?.toLowerCase() === 'font' ? 'font' : 'image';
    if (asset.status === 'external') {
      if (!/^https?:\/\//.test(asset.source) || asset.destination || asset.uses?.length) {
        throw new Error(`${at}: external assets must remain explicit HTTP(S) references without copied destinations`);
      }
      return [];
    }
    if (asset.status !== 'ready' || !asset.sha256?.match(/^[a-f0-9]{64}$/)) {
      throw new Error(`${at}: a local asset needs ready status and its confirmed SHA-256`);
    }
    if (!path.isAbsolute(asset.source)) throw new Error(`${at}: local source must be an explicit absolute file path`);
    const destinationPattern = assetKind === 'font'
      ? /^assets\/[a-zA-Z0-9][a-zA-Z0-9._-]*\.woff2?$/i
      : /^assets\/[a-zA-Z0-9][a-zA-Z0-9._-]*\.(png|jpe?g|gif|webp|svg)$/i;
    if (!asset.destination?.match(destinationPattern)) {
      throw new Error(`${at}: ${assetKind === 'font' ? 'licensed fonts must be .woff or .woff2' : 'this compiler accepts bundled raster images and static SVG'} under assets/; other asset types need an explicit supported transport`);
    }
    if (outputs.has(asset.destination)) throw new Error(`${at}: duplicate asset destination`);
    outputs.add(asset.destination);
    if (assetKind === 'font') {
      const decision = fontOwnershipDecision(typedAsset);
      if (!decision) throw new Error(`${at}: a bundled font requires an explicit ownership and license decision`);
      if (asset.uses?.length) throw new Error(`${at}: fonts cannot declare native image uses`);
      if (!confirmedFontAssetIds.has(asset.id)) throw new Error(`${at}: a bundled font must be referenced by a confirmed styles.fonts face`);
    } else if (!asset.uses?.length && !stylesheetAssets.has(asset.id)) {
      throw new Error(`${at}: a bundled image must declare its native image uses or be referenced in confirmed CSS`);
    }
    const source = inspectSource(asset.source);
    const bytes = readFileSync(source);
    const hash = createHash('sha256').update(bytes).digest('hex');
    if (hash !== asset.sha256) throw new Error(`${at}: source asset changed since confirmation`);
    if (bytes.length === 0 || bytes.length > 20 * 1024 * 1024) throw new Error(`${at}: source asset is empty or exceeds 20 MiB`);
    const extension = path.extname(asset.destination).toLowerCase();
    if (assetKind === 'font') {
      if (!isFont(bytes, extension)) throw new Error(`${at}: source bytes do not match the declared WOFF container`);
    } else if (extension === '.svg') assertStaticSvg(bytes, at);
    else if (!isRaster(bytes, extension)) {
      throw new Error(`${at}: source bytes do not match the declared raster image type`);
    }
    return [{ path: asset.destination, kind: 'asset' as const, assetKind, content: bytes, hash,
      operation: plan.files.find((file) => file.path === asset.destination)?.operation ?? 'create' }];
  });
}

/**
 * Read the 0.9 font decision without making the plan schema depend on this implementation module.
 * The canonical schema uses `fontLicense`; no scalar ownership/license aliases are accepted.
 */
export function fontOwnershipDecision(asset: AuthoringAssetWithFontDecision): FontOwnershipDecision | undefined {
  const decision = asset.fontLicense;
  if (decision && typeof decision.ownership === 'string' && decision.ownership.trim()
    && typeof decision.license === 'string' && decision.license.trim()) {
    return {
      ownership: decision.ownership.trim(),
      license: decision.license.trim(),
      ...(typeof decision.notice === 'string' ? { notice: decision.notice } : {}),
    };
  }
  return undefined;
}

function inspectSource(input: string): string {
  let source = path.resolve(input);
  // Fixed macOS compatibility links are not user-owned source indirection.
  for (const [alias, physical] of [['/tmp', '/private/tmp'], ['/var', '/private/var']] as const) {
    if (source.startsWith(`${alias}/`) && lstatSync(alias).isSymbolicLink() && path.resolve(path.dirname(alias), readlinkSync(alias)) === physical) {
      source = physical + source.slice(alias.length);
    }
  }
  let current = path.parse(source).root;
  const parts = source.slice(current.length).split(path.sep);
  for (const [index, part] of parts.entries()) {
    current = path.join(current, part);
    const stat = lstatSync(current);
    if (stat.isSymbolicLink() || (index === parts.length - 1 ? !stat.isFile() : !stat.isDirectory())) {
      throw new Error(`source asset must use regular files and directories, not links: ${current}`);
    }
    if (index === parts.length - 1 && stat.size > 20 * 1024 * 1024) throw new Error('source asset exceeds 20 MiB');
  }
  return source;
}

function isRaster(bytes: Buffer, extension: string): boolean {
  if (extension === '.png') return bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'));
  if (extension === '.jpg' || extension === '.jpeg') return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (extension === '.gif') return /^GIF8[79]a$/.test(bytes.subarray(0, 6).toString('ascii'));
  if (extension === '.webp') return bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP';
  return bytes.subarray(4, 8).toString('ascii') === 'ftyp' && /^(?:avif|avis)$/.test(bytes.subarray(8, 12).toString('ascii'));
}

function isFont(bytes: Buffer, extension: string): boolean {
  const signature = bytes.subarray(0, 4).toString('ascii');
  return (extension === '.woff' && signature === 'wOFF') || (extension === '.woff2' && signature === 'wOF2');
}
