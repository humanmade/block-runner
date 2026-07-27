import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { BlockRunnerConfig, CommonOptions, WpModules } from '../types.js';
import { SupportsQuery } from './declarations.js';

export interface CapabilitySource {
  kind: 'pin' | 'context';
  /** Whether the target honours this style feature *and* gives the user a control for it. */
  supports(blockName: string, query: SupportsQuery): boolean;
  /** Whether the block type declares this top-level attribute at all. */
  declaresAttribute(blockName: string, attribute: string): boolean;
  /** Set when the requested source could not be used in full; reported once per run. */
  note?: string;
}

type Supports = Record<string, unknown> | undefined;

interface RegisteredBlockType {
  supports?: Record<string, unknown>;
  attributes?: Record<string, unknown>;
}

/**
 * Build the capability source that gates style mapping.
 *
 * Two backends, and the distinction matters: the **pin** answers "will the serializer we validate
 * against write this, and does the block opt in", which is all we can know offline. A wesper
 * **context** manifest answers the better question — "does the *actual target site* honour this"
 * — because it carries that site's real block registry, collected per block with its supports.
 *
 * The context backend intersects with the pin rather than replacing it. Union would be unsafe in
 * the direction that bites: a site newer than our pin can expect CSS our pinned `save()` won't
 * generate, and stored markup missing that CSS fails validation with "Expected attributes …,
 * instead saw …". Intersection degrades safely both ways and needs no WordPress version table.
 */
export function createCapabilitySource(
  wp: WpModules,
  config: BlockRunnerConfig,
  options: CommonOptions,
): CapabilitySource {
  const pin = createPinSource(wp);
  const manifestPath = options.context ?? config.tokens?.context;
  if (!manifestPath) {
    return pin;
  }

  const manifest = readManifest(manifestPath);
  // An explicitly-supplied context that cannot be read is a mistake worth failing on, not a
  // reason to quietly widen capabilities back to the pin — that would emit styling the target
  // may not support, which is the opposite of what asking for a context means.
  if (!manifest) {
    throw new Error(
      `site context ${manifestPath} could not be read as JSON — fix the path or drop --context (styling capabilities would otherwise silently widen to the pinned block library)`,
    );
  }

  // No `blocks` key at all is a legitimate manifest shape (a theme-only collection), so fall back
  // to the pin with a warning. A `blocks` key that yields no usable registry is a broken
  // collection, and widening capabilities off the back of it would be exactly the wrong failure
  // direction — so that fails closed.
  const siteSupports = manifestSupports(manifest);
  if (!siteSupports) {
    if (manifest.blocks !== undefined) {
      throw new Error(
        `site context ${manifestPath} has a blocks key with no usable block registry — re-collect it or drop --context (styling capabilities must not silently widen to the pinned block library)`,
      );
    }
    return {
      ...pin,
      note: `site context ${manifestPath} carries no blocks.types registry — styling capabilities fall back to the pinned block library`,
    };
  }

  return {
    kind: 'context',
    supports(blockName, query) {
      if (!pin.supports(blockName, query)) {
        return false;
      }
      const site = siteSupports.get(blockName);
      // A block the target site doesn't register at all can't honour anything. That is a real
      // finding, not a reason to fall back to the pin.
      return site ? querySupports(site, query) : false;
    },
    declaresAttribute: pin.declaresAttribute,
  };
}

function createPinSource(wp: WpModules): CapabilitySource {
  return {
    kind: 'pin',
    supports(blockName, query) {
      const blockType = wp.getBlockType(blockName) as RegisteredBlockType | undefined;
      return querySupports(blockType?.supports, query);
    },
    declaresAttribute(blockName, attribute) {
      const blockType = wp.getBlockType(blockName) as RegisteredBlockType | undefined;
      return Boolean(blockType?.attributes && attribute in blockType.attributes);
    },
  };
}

/**
 * Resolve a supports query against a raw `supports` object, honouring the three shapes core
 * actually uses: a bare boolean, a per-side array (`spacing.margin: ["top","bottom"]`), and the
 * `__experimental*` aliases that most typography and border features still carry.
 */
export function querySupports(supports: Supports, query: SupportsQuery): boolean {
  if (!supports || typeof supports !== 'object') {
    return false;
  }

  switch (query.feature) {
    case 'spacing': {
      // `spacing: true` enables the whole feature; otherwise a per-key boolean or side list.
      if (supports.spacing === true) {
        return true;
      }
      const spacing = asObject(supports.spacing);
      const value = spacing?.[query.key];
      if (Array.isArray(value)) {
        return value.includes(query.side);
      }
      return value === true;
    }

    case 'color': {
      // `color: true` enables everything; an object enables text and background unless the key
      // is explicitly false (core omits them when they're on).
      const color = supports.color;
      if (color === true) {
        return true;
      }
      const asRecord = asObject(color);
      return Boolean(asRecord) && asRecord?.[query.key] !== false;
    }

    case 'gradient': {
      // Gradients are opt-in, not on-by-default like text/background.
      const color = supports.color;
      return color === true || asObject(color)?.gradients === true;
    }

    case 'typography':
      return featureEnabled(supports, 'typography', query.key);

    case 'border':
      return featureEnabled(supports, 'border', query.key);

    case 'dimensions':
      return featureEnabled(supports, 'dimensions', query.key);

    default:
      return false;
  }
}

/**
 * Resolve `feature.key`, accepting a feature-level boolean (`typography: true` enables everything
 * under it) and the `__experimental*` aliases that most typography and border features carry on
 * both the feature and the key.
 */
function featureEnabled(supports: Record<string, unknown>, feature: string, key: string): boolean {
  const experimentalFeature = `__experimental${capitalize(feature)}`;
  if (supports[feature] === true || supports[experimentalFeature] === true) {
    return true;
  }

  const direct = asObject(supports[feature]);
  const experimental = asObject(supports[experimentalFeature]);
  const experimentalKey = `__experimental${capitalize(key)}`;

  const value =
    direct?.[key] ??
    direct?.[experimentalKey] ??
    experimental?.[key] ??
    experimental?.[experimentalKey];

  return value === true;
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

interface Manifest {
  blocks?: { types?: Array<{ name?: unknown; supports?: unknown }> };
}

/** Read and parse the manifest. Undefined means unreadable/invalid — a hard error for the caller. */
function readManifest(manifestPath: string): Manifest | undefined {
  const resolved = path.resolve(manifestPath);
  if (!existsSync(resolved)) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(readFileSync(resolved, 'utf8'));
    return parsed && typeof parsed === 'object' ? (parsed as Manifest) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Pull `blocks.types[] → { name, supports }` out of a wesper manifest. Returns undefined when the
 * manifest carries no registry, so the caller can say so rather than silently trusting the pin.
 */
function manifestSupports(manifest: Manifest): Map<string, Record<string, unknown>> | undefined {
  const types = manifest.blocks?.types;
  if (!Array.isArray(types) || types.length === 0) {
    return undefined;
  }

  const map = new Map<string, Record<string, unknown>>();
  for (const type of types) {
    if (typeof type?.name === 'string') {
      map.set(type.name, asObject(type.supports) ?? {});
    }
  }
  return map.size > 0 ? map : undefined;
}
