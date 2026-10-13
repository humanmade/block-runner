import path from 'node:path';
import { parseMarkup } from '../headless/wp.js';
import { parseThemeJsonSettings } from '../tokens/resolver.js';
import type { ReportItem, WpBlock } from '../types.js';
import type { ThemeMarkupFile } from './folders.js';

type PresetKind = 'color' | 'gradient' | 'font-family' | 'font-size' | 'spacing';

interface PresetRegistry {
  slugs: Record<PresetKind, Set<string>>;
  defaults: Record<PresetKind, boolean>;
}

/** Check block references using only files and presets from the discovered theme folder. */
export async function findThemeReferenceIssues(
  themeRoot: string,
  files: ThemeMarkupFile[],
  themeJson: unknown,
): Promise<ReportItem[]> {
  const references: ReportItem[] = [];
  const skippedKinds = new Set<PresetKind>();
  const presetRegistries = new Map<string, PresetRegistry>();

  for (const entry of templateParts(themeJson)) {
    if (!hasPartFile(files, entry.name)) {
      references.push({
        status: 'warning',
        reason: `theme.json templateParts entry "${entry.name}" has no matching parts/${entry.name}.html file.`,
        source: { path: path.join(themeRoot, 'theme.json') },
        details: { templatePart: entry.name },
        code: 'unresolved-template-part',
      });
    }
  }

  const themeSlug = path.basename(path.resolve(themeRoot));
  for (const file of files) {
    if (file.skipReason) continue;
    const blocks = await parseMarkup(file.markup);
    const visit = (nodes: WpBlock[], parent: string): void => {
      nodes.forEach((block, index) => {
        const blockPath = `${parent}[${index}]`;
        const attributes = isRecord(block.attributes) ? block.attributes : {};
        let registry = presetRegistries.get(block.name);
        if (!registry) {
          registry = presetRegistry(themeJson, block.name);
          presetRegistries.set(block.name, registry);
        }
        const warn = (code: string, reason: string, details: Record<string, unknown>): void => {
          references.push({
            block: block.name,
            status: 'warning',
            reason,
            source: { path: file.path },
            details: { blockPath, ...details },
            code,
          });
        };
        const checkPreset = (kind: PresetKind, slug: unknown): void => {
          if (typeof slug !== 'string' || !slug) return;
          if (registry.defaults[kind]) {
            if (!skippedKinds.has(kind)) {
              skippedKinds.add(kind);
              references.push({
                block: block.name,
                status: 'warning',
                severity: 'info',
                reason: `Skipped ${kind} preset checks because core defaults are enabled in theme.json.`,
                source: { path: file.path },
                details: { blockPath, kind },
                code: 'preset-check-skipped',
              });
            }
            return;
          }
          if (!registry.slugs[kind].has(slug)) {
            warn('undeclared-preset', `Undeclared ${kind} preset "${slug}".`, { kind, slug });
          }
        };

        if (block.name === 'core/template-part' && typeof attributes.slug === 'string') {
          const referencedTheme = attributes.theme;
          if (typeof referencedTheme === 'string' && referencedTheme && referencedTheme !== themeSlug) {
            warn('unresolved-template-part', `Template part "${attributes.slug}" references theme "${referencedTheme}", not this theme "${themeSlug}".`, {
              slug: attributes.slug,
              theme: referencedTheme,
            });
          } else if (!hasPartFile(files, attributes.slug)) {
            warn('unresolved-template-part', `Template part "${attributes.slug}" has no matching parts/${attributes.slug}.html file.`, {
              slug: attributes.slug,
            });
          }
        } else if (block.name === 'core/pattern' && typeof attributes.slug === 'string'
          && !hasPatternFile(files, attributes.slug)) {
          warn('unresolved-pattern', `Pattern "${attributes.slug}" has no matching Slug header in patterns/*.php.`, {
            slug: attributes.slug,
          });
        }

        checkPreset('color', attributes.backgroundColor);
        checkPreset('color', attributes.textColor);
        checkPreset('gradient', attributes.gradient);
        checkPreset('font-size', attributes.fontSize);
        checkPreset('font-family', attributes.fontFamily);
        scanStrings(attributes.style, (value) => {
          const expression = /var:preset\|([^|\s)]+)\|([^|\s)]+)/g;
          for (const match of value.matchAll(expression)) {
            const kind = match[1] as PresetKind;
            if (kind === 'color' || kind === 'gradient' || kind === 'font-family'
              || kind === 'font-size' || kind === 'spacing') {
              checkPreset(kind, match[2]);
            }
          }
        });
        visit(block.innerBlocks ?? [], `${blockPath}.innerBlocks`);
      });
    };
    visit(blocks, 'blocks');
  }

  return references;
}

function presetRegistry(themeJson: unknown, blockName: string): PresetRegistry {
  const root = isRecord(themeJson) ? themeJson : {};
  const settings = isRecord(root.settings) ? root.settings : {};
  const blocks = isRecord(settings.blocks) ? settings.blocks : {};
  const blockSettings = isRecord(blocks[blockName]) ? blocks[blockName] : {};
  const color = { ...(isRecord(settings.color) ? settings.color : {}), ...(isRecord(blockSettings.color) ? blockSettings.color : {}) };
  const typography = { ...(isRecord(settings.typography) ? settings.typography : {}), ...(isRecord(blockSettings.typography) ? blockSettings.typography : {}) };
  const spacing = { ...(isRecord(settings.spacing) ? settings.spacing : {}), ...(isRecord(blockSettings.spacing) ? blockSettings.spacing : {}) };
  const parsed = parseThemeJsonSettings(settings as Parameters<typeof parseThemeJsonSettings>[0]);
  const scoped = parseThemeJsonSettings(blockSettings as Parameters<typeof parseThemeJsonSettings>[0]);
  return {
    slugs: {
      color: new Set([...Object.keys(parsed.colors), ...Object.keys(scoped.colors)]),
      gradient: new Set([...Object.keys(parsed.gradients ?? {}), ...Object.keys(scoped.gradients ?? {})]),
      'font-family': new Set([...Object.keys(parsed.fonts), ...Object.keys(scoped.fonts)]),
      'font-size': new Set([...Object.keys(parsed.fontSizes), ...Object.keys(scoped.fontSizes)]),
      spacing: new Set([...Object.keys(parsed.spacing), ...Object.keys(scoped.spacing)]),
    },
    defaults: {
      color: color.defaultPalette !== false,
      gradient: color.defaultGradients !== false,
      'font-family': false,
      'font-size': typography.defaultFontSizes !== false,
      spacing: spacing.defaultSpacingSizes !== false,
    },
  };
}

function hasPartFile(files: ThemeMarkupFile[], slug: string): boolean {
  const expected = `parts/${slug}.html`;
  return files.some((file) => file.kind === 'part' && !file.skipReason && file.file === expected);
}

function hasPatternFile(files: ThemeMarkupFile[], slug: string): boolean {
  return files.some((file) => file.kind === 'pattern'
    && file.skipReason !== 'theme-unsafe-target'
    && file.header?.slug === slug);
}

function templateParts(themeJson: unknown): Array<{ name: string }> {
  if (!isRecord(themeJson) || !Array.isArray(themeJson.templateParts)) return [];
  return themeJson.templateParts.flatMap((entry) =>
    isRecord(entry) && typeof entry.name === 'string' ? [{ name: entry.name }] : []);
}

function scanStrings(value: unknown, visit: (value: string) => void): void {
  if (typeof value === 'string') {
    visit(value);
  } else if (Array.isArray(value)) {
    for (const entry of value) scanStrings(entry, visit);
  } else if (isRecord(value)) {
    for (const entry of Object.values(value)) scanStrings(entry, visit);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
