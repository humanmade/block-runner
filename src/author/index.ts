import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { JSDOM } from 'jsdom';
import { loadConfig } from '../config/load.js';
import { convert } from '../convert/assemble.js';
import { parseMarkup } from '../headless/wp.js';
import {
  AssetLedgerEntry,
  AuthoredStyleLedgerEntry,
  AuthorConfig,
  AuthorOptions,
  BlockRunnerReport,
  GeneratedBlockPackage,
  ReportItem,
  WpBlock,
} from '../types.js';
import { classifyCssUrlReference, rewriteCssAssets, scanCssUrlReferences } from './assets.js';
import {
  createSelectorDependencyTransport,
  referencedCssClasses,
  scanStylesheet,
  scopeStylesheet,
  validateCssBuildGraph,
} from './styles.js';
import type { StyleLedgerEntry } from '../styles/apply.js';

/**
 * Produce the small, static source package for one registered block.
 *
 * This is deliberately an authoring path rather than a variation on `convert`: conversion emits
 * post content, while this function creates a block root which owns its CSS/assets.  It accepts
 * compiled CSS only.  It never runs Tailwind, guesses utility classes, downloads a remote asset,
 * or manufactures a media ID.
 */
export async function author(input: string, options: AuthorOptions = {}): Promise<BlockRunnerReport> {
  const config = await loadConfig(options);
  const definition = mergeAuthorConfig(config.author, options.author);
  const name = definition.name;
  if (!name || !isBlockName(name)) {
    return authorFailure('author.name must be a registered block name such as "acme/hero"');
  }
  const behaviour = unsupportedBehaviour(input);
  if (behaviour) {
    return authorFailure(behaviour);
  }
  if (!definition.styles?.css && linkedStylesheets(input).length > 0) {
    return authorFailure(
      'external stylesheet input requires compiled CSS in author.styles.css; remote stylesheet fetching and implicit import graphs are disabled',
    );
  }

  const rootSelector = `.wp-block-${name.replace('/', '-')}`;
  const styleInput = definition.styles?.css ?? stylesFromHtml(input);
  const buildGraph = validateCssBuildGraph(definition.styles?.tailwind, { css: styleInput });
  const stylesheet = scanStylesheet(styleInput);
  const selectorTransport = createSelectorDependencyTransport();
  const safetyScopedStyles = scopeStylesheet(stylesheet, {
    root: rootSelector,
    disposition: (declaration) => unsafeResidualDeclaration(declaration.property, declaration.value),
    selectorTransform: selectorTransport.rewrite,
  });
  const safetyLedger = safetyScopedStyles.ledger.map(toAuthoredStyleLedgerEntry(options.sourcePath));
  const hardSafetyStyleFailure = safetyScopedStyles.ledger.some((entry) => entry.outcome === 'blocked' || entry.outcome === 'warned')
    || safetyScopedStyles.ruleRecords.some((record) => record.outcome === 'blocked');
  const graphItems: ReportItem[] = [
    ...(buildGraph.tailwindDetected ? buildGraph.issues : []).map((issue) => ({
      block: name,
      status: 'warning' as const,
      reason: issue.reason,
      details: { outcome: issue.status, field: issue.field },
    })),
    ...safetyScopedStyles.ledger
      .filter((entry) => entry.outcome === 'warned' || entry.outcome === 'blocked')
      .map<ReportItem>((entry) => ({
      block: name,
      status: 'warning',
      reason: `${entry.property}: ${entry.value}${entry.reason ? ` — ${entry.reason}` : ''}`,
      details: {
        outcome: entry.outcome,
        property: entry.property,
        value: entry.value,
        atRules: entry.atRules,
      },
      })),
    ...safetyScopedStyles.ruleRecords
      .filter((record) => record.outcome === 'blocked' && !safetyScopedStyles.ledger.some((entry) => entry.ruleId === record.ruleId))
      .map<ReportItem>((record) => ({
        block: name,
        status: 'warning',
        reason: `${record.prelude}${record.reason ? ` — ${record.reason}` : ''}`,
        details: { outcome: 'blocked', rule: record.ruleId },
      })),
  ];

  // A missing build input is not a recoverable fidelity loss.  Stop before generating a package
  // that looks successful but contains an incomplete Tailwind transport layer.
  if (buildGraph.blocked) {
    return {
      ok: false,
      command: 'author',
      summary: { blocks: 0, valid: 0, invalid: 0, warnings: graphItems.length },
      items: graphItems,
      styleLedger: safetyLedger,
    };
  }
  // Scoping deliberately removes selectors/declarations that cannot retain their source meaning.
  // That is not a successful partial package: stop before any CSS asset copying or package file
  // write can leave output on disk that looks ready to use.
  if (hardSafetyStyleFailure) {
    return {
      ok: false,
      command: 'author',
      summary: { blocks: 0, valid: 0, invalid: 0, warnings: graphItems.length },
      items: graphItems,
      styleLedger: safetyLedger,
    };
  }
  const nativeSource = await collectNativeSourceDeclarations(input, options, config);
  const preflightStyleLedger = [...safetyLedger, ...nativeSource.inlineLedger];
  const preflightInlineFailure = nativeSource.inlineLedger.some(
    (entry) => entry.outcome === 'blocked' || entry.outcome === 'warned',
  );
  if (!nativeSource.conversion.ok || preflightInlineFailure) {
    return {
      ...nativeSource.conversion,
      ok: false,
      command: 'author',
      summary: {
        ...nativeSource.conversion.summary,
        warnings: nativeSource.conversion.summary.warnings + graphItems.length,
      },
      items: [...nativeSource.conversion.items, ...graphItems],
      styleLedger: preflightStyleLedger,
    };
  }
  const scopedStyles = scopeStylesheet(stylesheet, {
    root: rootSelector,
    selectorTransform: selectorTransport.rewrite,
    disposition: (declaration, rule) =>
      unsafeResidualDeclaration(declaration.property, declaration.value)
      ?? (nativeSource.declarations.has(sourceDeclarationKey(rule.selector, declaration.property, declaration.value))
        ? {
            outcome: 'native' as const,
            reason: 'mapped through the destination block support; omitted from residual CSS',
          }
        : undefined),
  });
  const stylesheetLedger = scopedStyles.ledger.map(toAuthoredStyleLedgerEntry(options.sourcePath));
  const hardStyleFailure = scopedStyles.ledger.some((entry) => entry.outcome === 'blocked' || entry.outcome === 'warned')
    || scopedStyles.ruleRecords.some((record) => record.outcome === 'blocked');
  let css = scopedStyles.css;
  // The source ledger includes URLs from rules we intentionally block (notably @font-face and
  // Preflight). Those assets still need a terminal outcome even though their declarations will
  // not reach style.css.
  const sourceAssets = scanCssUrlReferences(styleInput, options.sourcePath).map((reference) =>
    toAssetLedgerEntry(
      classifyCssUrlReference(reference, {
        sourcePath: options.sourcePath,
        allowFontLicense: false,
      }),
    ),
  );
  const destinationAssetDir = options.outDir
    ? path.join(options.outDir, 'assets')
    : path.join(process.cwd(), '.block-runner-unwritten-assets');
  // Copy/account from the complete source stylesheet, not merely residual CSS. A declaration can
  // quite correctly become native (for example a class background becoming a Cover) while its URL
  // still needs a package asset and a terminal ledger outcome.
  const processedSource = await rewriteCssAssets({
    sourceCss: styleInput,
    sourcePath: options.outDir ? options.sourcePath : undefined,
    destinationAssetDir,
    allowFontLicense: false,
  });
  let assets: AssetLedgerEntry[] = mergeAssetLedgers(sourceAssets, processedSource.assets.map(toAssetLedgerEntry));
  if (css) {
    const processed = await rewriteCssAssets({
      sourceCss: css,
      sourcePath: options.outDir ? options.sourcePath : undefined,
      destinationAssetDir,
      allowFontLicense: false,
    });
    css = processed.css;
  }

  // Rewrite every concrete source asset before conversion. That makes assets inside Custom HTML
  // fallbacks just as accountable as assets that happen to map to a native media block.
  const rewrittenMarkup = await rewriteMarkupAssets(input, {
      sourcePath: options.sourcePath,
    destinationAssetDir,
    write: Boolean(options.outDir),
    stylesheetAssetsAlreadyAccounted: definition.styles?.css === undefined,
  });
  assets = [...assets, ...rewrittenMarkup.assets];

  const inlineStyleLedger: AuthoredStyleLedgerEntry[] = [];
  const conversion = await convert(rewrittenMarkup.input, {
    ...options,
    // The author package carries any unsupported authored selector/property in style.css; the
    // legacy open sidecar would duplicate it as a global post stylesheet.
    styling: 'relaxed',
    config,
    preserveSourceClasses: referencedCssClasses(scopedStyles.css),
    preserveSourceSelectorDependencies: selectorTransport.dependencies,
    preserveAssetForms: true,
    styleLedgerObserver(entries, source) {
      for (const entry of entries) {
        // The author stylesheet is accounted for by the CSS scanner. With source class styles
        // disabled above, everything reaching this observer is an inline declaration or an
        // inline parse problem, which otherwise had no authored-package ledger at all.
        if (!entry.origin) {
          inlineStyleLedger.push(toInlineStyleLedgerEntry(entry, source));
        }
      }
    },
  });
  const blocks = conversion.output ? await parseMarkup(conversion.output) : [];
  const styleLedger = [...stylesheetLedger, ...inlineStyleLedger];
  const hardInlineStyleFailure = inlineStyleLedger.some((entry) => entry.outcome === 'blocked' || entry.outcome === 'warned');
  const packageSource = buildPackage({
    definition,
    name,
    rootSelector,
    css,
    template: blocks.map(toTemplateNode),
  });

  const assetItems = assets
    .filter((asset) => asset.outcome === 'unresolved' || asset.outcome === 'blocked')
    .map<ReportItem>((asset) => ({
      block: name,
      status: 'warning',
      reason: `${asset.kind} asset ${asset.reference} ${asset.outcome}${asset.reason ? ` — ${asset.reason}` : ''}`,
      source: asset.source,
      details: { outcome: asset.outcome, rewritten: asset.rewritten },
    }));
  const hardAssetFailure = assets.some((asset) => asset.outcome === 'unresolved' || asset.outcome === 'blocked');

  // Do not leave a seemingly usable package on disk when a local asset/font could not be carried
  // legally or safely. The in-memory package remains in the report for diagnosis.
  if (options.outDir && !hardAssetFailure && !hardStyleFailure && !hardInlineStyleFailure && conversion.ok) {
    await writePackage(options.outDir, packageSource);
  }

  return {
    ...conversion,
    ok: conversion.ok && !hardAssetFailure && !hardStyleFailure && !hardInlineStyleFailure,
    command: 'author',
    summary: {
      ...conversion.summary,
      warnings: conversion.summary.warnings + graphItems.length + assetItems.length,
    },
    items: [...conversion.items, ...graphItems, ...assetItems],
    assets: assets.length > 0 ? assets : undefined,
    styleLedger,
    package: packageSource,
  };
}

function mergeAuthorConfig(configured: AuthorConfig | undefined, explicit: AuthorConfig | undefined): AuthorConfig {
  return {
    ...configured,
    ...explicit,
    styles: { ...configured?.styles, ...explicit?.styles },
  };
}

/**
 * Prove a stylesheet declaration has exactly one native destination before omitting it from
 * style.css. The existing converter is the capability oracle: it only reports `mapped` when the
 * concrete emitted Core block declares the relevant support in the pinned/target registry.
 */
interface NativeSourceCollection {
  declarations: Set<string>;
  inlineLedger: AuthoredStyleLedgerEntry[];
  conversion: BlockRunnerReport;
}

async function collectNativeSourceDeclarations(
  input: string,
  options: AuthorOptions,
  config: Awaited<ReturnType<typeof loadConfig>>,
): Promise<NativeSourceCollection> {
  const outcomes = new Map<string, { native: boolean; other: boolean }>();
  const inlineLedger: AuthoredStyleLedgerEntry[] = [];
  const conversion = await convert(input, {
    ...options,
    config,
    styling: 'relaxed',
    preserveAssetForms: true,
    styleLedgerObserver(entries, source) {
      for (const entry of entries) {
        if (!entry.origin) {
          inlineLedger.push(toInlineStyleLedgerEntry(entry, source));
          continue;
        }
        const key = sourceDeclarationKey(entry.origin, entry.property, entry.value);
        const state = outcomes.get(key) ?? { native: false, other: false };
        if (entry.outcome === 'mapped' || (entry.outcome === 'consumed' && entry.reason === 'read by the structural rules')) {
          state.native = true;
        } else {
          state.other = true;
        }
        outcomes.set(key, state);
      }
    },
  });
  return {
    declarations: new Set([...outcomes].filter(([, state]) => state.native && !state.other).map(([key]) => key)),
    inlineLedger,
    conversion,
  };
}

function sourceDeclarationKey(selector: string, property: string, value: string): string {
  return `${selector.trim()}\u0000${property.trim().toLowerCase()}\u0000${value.trim()}`;
}

function authorFailure(reason: string): BlockRunnerReport {
  return {
    ok: false,
    command: 'author',
    summary: { blocks: 0, valid: 0, invalid: 0, warnings: 1 },
    items: [{ block: 'input', status: 'warning', reason }],
  };
}

function isBlockName(value: string): boolean {
  return /^[a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9-]*$/.test(value);
}

function stylesFromHtml(input: string): string {
  // The style compiler does its own CSS parsing.  This small extractor only joins the actual style
  // graph supplied with an HTML design; it does not infer CSS from Tailwind class names.
  return [...input.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style\s*>/gi)].map((match) => match[1]).join('\n');
}

function linkedStylesheets(input: string): string[] {
  return [...input.matchAll(/<link\b[^>]*\brel\s*=\s*(['"]?)[^'"\s>]*stylesheet[^'"\s>]*\1[^>]*>/gi)].map(
    (match) => match[0],
  );
}

function unsupportedBehaviour(input: string): string | undefined {
  if (/<script\b/i.test(input)) {
    return 'script behaviour is not authorized in a generated static block';
  }
  if (/\son[a-z][\w-]*\s*=/i.test(input)) {
    return 'event-handler behaviour is not authorized in a generated static block';
  }
  return undefined;
}

function unsafeResidualDeclaration(property: string, value: string): { outcome: 'blocked'; reason: string } | undefined {
  if (/^(?:behavior|-moz-binding)$/i.test(property.trim())) {
    return { outcome: 'blocked', reason: `${property} can require executable browser behaviour` };
  }
  if (/\burl\(\s*(['"]?)\s*(?:javascript|vbscript)\s*:/i.test(value)) {
    return { outcome: 'blocked', reason: 'unsafe executable CSS URL scheme' };
  }
  return undefined;
}

function mergeAssetLedgers(
  sourceAssets: AssetLedgerEntry[],
  processedAssets: AssetLedgerEntry[],
): AssetLedgerEntry[] {
  const processedByReference = new Map<string, AssetLedgerEntry[]>();
  for (const asset of processedAssets) {
    const entries = processedByReference.get(asset.reference) ?? [];
    entries.push(asset);
    processedByReference.set(asset.reference, entries);
  }

  return sourceAssets.map((source) => {
    const match = processedByReference.get(source.reference)?.shift();
    if (!match) {
      return source;
    }
    return {
      ...source,
      outcome: match.outcome,
      rewritten: match.rewritten,
      reason: match.reason,
    };
  });
}

interface RewriteMarkupAssetsOptions {
  sourcePath?: string;
  destinationAssetDir: string;
  write: boolean;
  /** True when styleInput already supplied ledger entries for every inline <style> URL. */
  stylesheetAssetsAlreadyAccounted: boolean;
}

interface SrcsetCandidate {
  url: string;
  start: number;
  end: number;
}

/**
 * Account for every concrete URL in the design markup before the walker can turn it into native
 * blocks or Custom HTML. Scanning the post-conversion block tree misses raw fallback content and
 * is too late to preserve `srcset`/inline image-set candidates.
 */
async function rewriteMarkupAssets(input: string, options: RewriteMarkupAssetsOptions): Promise<{
  input: string;
  assets: AssetLedgerEntry[];
}> {
  const dom = new JSDOM(input, { contentType: 'text/html' });
  const assets: AssetLedgerEntry[] = [];
  const document = dom.window.document;

  const processReference = async (
    reference: string,
    kind: AssetLedgerEntry['kind'],
  ): Promise<string | undefined> => {
    const processed = await rewriteCssAssets({
      sourceCss: `x{background-image:url(${JSON.stringify(reference)})}`,
      sourcePath: options.write ? options.sourcePath : undefined,
      destinationAssetDir: options.destinationAssetDir,
      allowFontLicense: false,
    });
    const entry = processed.assets[0];
    if (!entry) {
      assets.push({ reference, kind, outcome: 'unresolved', reason: 'asset reference could not be classified' });
      return undefined;
    }
    const record = toAssetLedgerEntry(entry);
    record.kind = kind;
    assets.push(record);
    return entry.outcome === 'copied' ? entry.rewrittenUrl : undefined;
  };

  for (const element of [...document.querySelectorAll('*')]) {
    if (element.tagName.toLowerCase() === 'style') {
      // Keep the rewritten stylesheet in the conversion DOM as well: a declaration that maps to
      // native media reads this URL before residual CSS is emitted. Its ledger was already built
      // from styleInput unless explicit configured CSS superseded the document styles.
      const sourceCss = element.textContent ?? '';
      const processed = await rewriteCssAssets({
        sourceCss,
        sourcePath: options.write ? options.sourcePath : undefined,
        destinationAssetDir: options.destinationAssetDir,
        allowFontLicense: false,
      });
      if (!options.stylesheetAssetsAlreadyAccounted) {
        assets.push(...processed.assets.map(toAssetLedgerEntry));
      }
      if (processed.css !== sourceCss) {
        element.textContent = processed.css;
      }
      continue;
    }

    const style = element.getAttribute('style');
    if (style?.trim()) {
      const processed = await rewriteCssAssets({
        sourceCss: style,
        sourcePath: options.write ? options.sourcePath : undefined,
        destinationAssetDir: options.destinationAssetDir,
        allowFontLicense: false,
      });
      assets.push(...processed.assets.map(toAssetLedgerEntry));
      if (processed.css !== style) {
        element.setAttribute('style', processed.css);
      }
    }

    for (const attribute of ['src', 'poster'] as const) {
      const value = element.getAttribute(attribute);
      if (!value?.trim()) continue;
      const rewritten = await processReference(value, assetKindFor(element, attribute));
      if (rewritten) {
        element.setAttribute(attribute, rewritten);
      }
    }

    const srcset = element.getAttribute('srcset');
    if (!srcset?.trim()) continue;
    let rewrittenSrcset = srcset;
    for (const candidate of [...srcsetCandidates(srcset)].sort((left, right) => right.start - left.start)) {
      const rewritten = await processReference(candidate.url, 'image');
      if (rewritten) {
        rewrittenSrcset = `${rewrittenSrcset.slice(0, candidate.start)}${rewritten}${rewrittenSrcset.slice(candidate.end)}`;
      }
    }
    if (rewrittenSrcset !== srcset) {
      element.setAttribute('srcset', rewrittenSrcset);
    }
  }

  // Keep head-owned `<style>` elements as well as body markup. JSDOM correctly relocates a
  // leading stylesheet into `<head>`; returning body.innerHTML would make the final conversion
  // forget declarations the preflight proved native, recreating the very ledger mismatch here.
  return { input: dom.serialize(), assets };
}

function assetKindFor(element: Element, attribute: 'src' | 'poster'): AssetLedgerEntry['kind'] {
  if (attribute === 'poster' || element.tagName.toLowerCase() === 'img') return 'image';
  if (/^(audio|video|track|source)$/i.test(element.tagName)) return 'media';
  return 'other';
}

/** Extract URL tokens only; descriptors are retained byte-for-byte when a candidate is rewritten. */
function srcsetCandidates(value: string): SrcsetCandidate[] {
  const candidates: SrcsetCandidate[] = [];
  let index = 0;
  while (index < value.length) {
    while (index < value.length && /[\s,]/.test(value[index])) index += 1;
    const start = index;
    if (start >= value.length) break;

    // Data URLs legitimately contain commas. They end at the candidate's first whitespace, not
    // its first comma; external classification keeps them intact without a filesystem lookup.
    const data = /^data:/i.test(value.slice(start));
    while (index < value.length && !(data ? /\s/.test(value[index]) : /[\s,]/.test(value[index]))) index += 1;
    const end = index;
    const url = value.slice(start, end);
    if (url) candidates.push({ url, start, end });

    let quote: string | undefined;
    while (index < value.length) {
      const char = value[index];
      if (quote) {
        if (char === '\\') index += 2;
        else {
          if (char === quote) quote = undefined;
          index += 1;
        }
        continue;
      }
      if (char === '"' || char === "'") {
        quote = char;
      } else if (char === ',') {
        index += 1;
        break;
      }
      index += 1;
    }
  }
  return candidates;
}

interface BuildPackageInput {
  definition: AuthorConfig;
  name: string;
  rootSelector: string;
  css: string;
  template: unknown[];
}

function buildPackage(input: BuildPackageInput): GeneratedBlockPackage {
  const { definition, name, rootSelector, css, template } = input;
  const namespace = name.split('/')[0];
  const title = definition.title ?? titleFromSlug(name.split('/')[1]);
  const editorCss = definition.styles?.editorCss?.trim();
  const blockJson: Record<string, unknown> = {
    $schema: 'https://schemas.wp.org/trunk/block.json',
    apiVersion: 3,
    name,
    title,
    category: definition.category ?? 'widgets',
    textdomain: namespace,
    editorScript: 'file:./index.js',
    // CSS which affects parity is deliberately registered here. WordPress loads `style` in both
    // the editor and on the frontend; `editorStyle` is only for explicitly supplied affordances.
    ...(css ? { style: 'file:./style.css' } : {}),
    ...(editorCss ? { editorStyle: 'file:./editor.css' } : {}),
    supports: { html: false, ...(definition.supports ?? {}) },
  };

  const files: Record<string, string> = {
    'block.json': `${JSON.stringify(blockJson, null, 2)}\n`,
    'index.js': renderIndexModule(template),
  };
  if (css) {
    files['style.css'] = ensureTrailingNewline(css);
  }
  if (editorCss) {
    files['editor.css'] = ensureTrailingNewline(editorCss);
  }
  return { name, rootSelector, files };
}

function renderIndexModule(template: unknown[]): string {
  // No JSX means this file can be consumed by the ordinary @wordpress/scripts build without a
  // transform-specific source dependency. The template is data, not runtime source CSS/classes.
  return `import { createElement } from '@wordpress/element';
import { registerBlockType } from '@wordpress/blocks';
import { InnerBlocks, useBlockProps } from '@wordpress/block-editor';
import metadata from './block.json';

const TEMPLATE = ${JSON.stringify(template, null, 2)};

function Edit() {
  return createElement('div', useBlockProps(), createElement(InnerBlocks, { template: TEMPLATE }));
}

function Save() {
  return createElement('div', useBlockProps.save(), createElement(InnerBlocks.Content));
}

registerBlockType(metadata.name, { edit: Edit, save: Save });
`;
}

function toTemplateNode(block: WpBlock): unknown[] {
  return [
    block.name,
    block.name === 'core/html' && typeof block.originalContent === 'string'
      ? { ...cleanAttributes(block.attributes), content: block.originalContent }
      : cleanAttributes(block.attributes),
    block.innerBlocks.map(toTemplateNode),
  ];
}

function cleanAttributes(attributes: Record<string, unknown>): Record<string, unknown> {
  // Sources are diagnostic data for this process, not serialized attributes of an authored block.
  return Object.fromEntries(Object.entries(attributes).filter(([key]) => !key.startsWith('__blockRunner')));
}

function titleFromSlug(slug: string): string {
  return slug.replace(/[-_]+/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function ensureTrailingNewline(value: string): string {
  return value.endsWith('\n') ? value : `${value}\n`;
}

async function writePackage(outDir: string, packageSource: GeneratedBlockPackage): Promise<void> {
  const destination = path.resolve(outDir);
  await mkdir(destination, { recursive: true });
  // Individual, declared files only. We never clean the output directory or overwrite copied
  // assets as a side effect of authoring; files are written atomically by the caller's explicit
  // destination choice.
  await Promise.all(
    Object.entries(packageSource.files).map(async ([relativePath, content]) => {
      const target = path.resolve(destination, relativePath);
      if (!target.startsWith(`${destination}${path.sep}`)) {
        throw new Error(`invalid generated package path: ${relativePath}`);
      }
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, content, { encoding: 'utf8', flag: 'wx' });
    }),
  );
}

function toAssetLedgerEntry(asset: {
  url: string;
  kind: 'asset' | 'font';
  outcome: AssetLedgerEntry['outcome'];
  reason: string;
  rewrittenUrl?: string;
  location: { path?: string; offset: number; line: number; column: number };
}): AssetLedgerEntry {
  return {
    reference: asset.url,
    rewritten: asset.rewrittenUrl,
    kind: asset.kind === 'font' ? 'font' : 'image',
    outcome: asset.outcome,
    reason: asset.reason,
    source: {
      path: asset.location.path,
      htmlLine: asset.location.line,
      htmlColumn: asset.location.column,
      offset: asset.location.offset,
    },
  };
}

function toAuthoredStyleLedgerEntry(
  sourcePath: string | undefined,
): (entry: {
  property: string;
  value: string;
  outcome: string;
  reason?: string;
  atRules: string[];
  source: { start: { offset: number; line: number; column: number } };
}) => AuthoredStyleLedgerEntry {
  return (entry) => ({
    property: entry.property,
    value: entry.value,
    outcome: normalizeStyleOutcome(entry.outcome),
    reason: entry.reason,
    atRules: entry.atRules,
    source: {
      path: sourcePath,
      offset: entry.source.start.offset,
      htmlLine: entry.source.start.line,
      htmlColumn: entry.source.start.column,
    },
  });
}

function normalizeStyleOutcome(value: string): AuthoredStyleLedgerEntry['outcome'] {
  return value === 'native' || value === 'preset' || value === 'literal' || value === 'scoped-css' || value === 'blocked'
    ? value
    : 'warned';
}

function toInlineStyleLedgerEntry(entry: StyleLedgerEntry, source: AuthoredStyleLedgerEntry['source']): AuthoredStyleLedgerEntry {
  // The legacy styling mapper calls this `mapped`/`consumed`; package reports use the more useful
  // authoring vocabulary. A declaration preserved verbatim inside rich text or Custom HTML is a
  // literal, while anything the mapper cannot carry is blocking parity loss.
  const outcome: AuthoredStyleLedgerEntry['outcome'] =
    entry.outcome === 'mapped'
      ? 'native'
      : entry.outcome === 'consumed' || entry.outcome === 'overridden'
        ? 'literal'
        : 'blocked';
  return {
    property: entry.shorthand ?? entry.property,
    value: entry.value,
    outcome,
    reason: entry.reason,
    atRules: [],
    source,
  };
}
