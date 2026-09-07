import { createHash } from 'node:crypto';
import path from 'node:path';
import { JSDOM } from 'jsdom';
import { bootHeadlessWordPressSync, withMutedWordPressConsole } from '../headless/env.js';
import { compileRegisteredBlock, registeredBlockFontFamilyPrefix } from '../authoring/generate.js';
import { supportedPatternOverrideAttributes } from '../authoring/overrides.js';
import type {
  AuthoringCoverage,
  AuthoringCoverageAsset,
  AuthoringCoverageStyle,
  AuthoringFontFace,
  AuthoringPlan,
  AuthoringStyleContext,
  AuthoringStructureNode,
  JsonValue,
} from '../authoring/schema.js';
import { COMPONENT_FOUNDATION_WARNING } from '../authoring/schema.js';
import { authoringRulesFromStylesheet } from '../authoring/styles.js';
import { BACKGROUND_COLOR_TARGET, GRADIENT_TARGET, classifyBackground, lookupDeclaration } from '../styles/declarations.js';
import { querySupports } from '../styles/capabilities.js';
import type { AssetLedgerEntry, AuthoredStyleLedgerEntry, AuthorConfig, WpBlock } from '../types.js';
import { scanCssUrlReferences, type FontAssetWarning, type FontLicenseDecision, type PreparedCssAsset } from './assets.js';
import { decodeCssEscapes, fontFaceRules, forEachCssRule, nativeSelectorSubjects, scanStylesheet, scopeLocalSelectorList, scopeStylesheet, splitCssTopLevel, type CssDeclaration, type CssRule, type CssStylesheet } from './styles.js';
import { exactThemePresetTransport, styleContextFrom } from './style-context.js';
import { mapExactWordPressResponsiveMedia, resolveWordPressViewportRanges } from './responsive.js';
import { hasUnsafeResponsiveNativeCascade } from './cascade.js';
import { sourceDeclarationKey } from '../styles/apply.js';

export interface PreparedAuthoringFonts {
  /** CSS after removing global @font-face rules and namespacing their owned families. */
  css: string;
  /** Shared editor/frontend faces; each points at one confirmed plan asset. */
  fonts: AuthoringFontFace[];
  /** Original-family to block-owned-family mapping for editor-only declarations. */
  familyNames: ReadonlyMap<string, string>;
}

/**
 * Extract the global font transport from the effective stylesheet. Font bytes are already prepared
 * by the adapter at this point; this step only binds each face to the deterministic plan asset ID,
 * gives its family a block-owned name, and leaves ordinary component CSS for the scoped-rule gate.
 * `style.scss` is loaded in both contexts, so these faces never enter editor.scss.
 */
export function prepareAuthoringFonts(
  stylesheet: string,
  blockName: string,
  preparedAssets: readonly PreparedCssAsset[],
  assets: readonly AssetLedgerEntry[],
  stylesheetFacts: CssStylesheet = scanStylesheet(stylesheet),
): PreparedAuthoringFonts {
  const faces = fontFaceRules(stylesheetFacts).map((rule) => ({
    rule,
    declarations: new Map(rule.declarations.map((declaration) => [declaration.property.toLowerCase(), declaration.value])),
  }));
  if (faces.length === 0) {
    return { css: stylesheet, fonts: [], familyNames: new Map() };
  }

  const familyNames = new Map<string, string>();
  const fonts: AuthoringFontFace[] = [];
  const namespace = registeredBlockFontFamilyPrefix(blockName).slice(0, -1);

  for (const [faceIndex, face] of faces.entries()) {
    const familyValue = face.declarations.get('font-family');
    const sourceValue = face.declarations.get('src');
    const families = familyValue ? splitFontFamilyList(familyValue) : [];
    if (families.length !== 1) {
      throw new Error(`@font-face ${faceIndex + 1} must declare exactly one font-family for registered-block authoring`);
    }
    const originalFamily = families[0]!;
    const familyKey = normalizeFontFamily(originalFamily);
    const ownedFamily = familyNames.get(familyKey) ?? `${namespace}-${safeCssSlug(originalFamily)}`;
    familyNames.set(familyKey, ownedFamily);

    const references = sourceValue
      ? scanCssUrlReferences(sourceValue).filter((reference) => reference.kind === 'font')
      : [];
    if (references.length === 0) {
      throw new Error(`@font-face for ${originalFamily} must reference a local, confirmed WOFF or WOFF2 asset`);
    }
    for (const reference of references) {
      const ledger = assets.find((entry) => entry.kind === 'font'
        // The adapter passes the effective stylesheet after the asset gate. A confirmed local
        // face therefore names its package-relative rewrite here, while a direct helper caller
        // may still supply the original URL; accept either spelling but keep the ledger as the
        // source of truth for the prepared bytes.
        && (entry.reference === reference.url || entry.rewritten === reference.url)
        && (entry.outcome === 'prepared' || entry.outcome === 'copied'));
      const rewrittenName = ledger?.rewritten?.split(/[?#]/, 1)[0]?.replace(/^\.\/assets\//, '');
      const preparedIndex = rewrittenName
        ? preparedAssets.findIndex((asset) => path.basename(asset.destination) === path.basename(rewrittenName))
        : -1;
      if (!ledger || preparedIndex < 0) {
        throw new Error(`@font-face for ${originalFamily} is not bound to a prepared local font asset (${reference.url})`);
      }
      const assetId = `asset.${preparedIndex}`;
      const descriptor = (property: string): string | undefined => {
        const value = face.declarations.get(property);
        return value === undefined ? undefined : value;
      };
      fonts.push({
        assetId,
        family: ownedFamily,
        ...(descriptor('font-style') === undefined ? {} : { fontStyle: descriptor('font-style') }),
        ...(descriptor('font-weight') === undefined ? {} : { fontWeight: descriptor('font-weight') }),
        ...(descriptor('font-stretch') === undefined ? {} : { fontStretch: descriptor('font-stretch') }),
        ...(descriptor('font-display') === undefined ? {} : { fontDisplay: descriptor('font-display') }),
        ...(descriptor('unicode-range') === undefined ? {} : { unicodeRange: descriptor('unicode-range') }),
      });
    }
  }

  // Remove each global face using the scanner's exact source range. Removing before the second
  // scan keeps all component declaration coordinates internally consistent and prevents the
  // generic stylesheet gate from treating a deliberately handled face as an unsafe global rule.
  let css = stylesheet;
  for (const face of [...faces].sort((first, second) => second.rule.source.start.offset - first.rule.source.start.offset)) {
    css = `${css.slice(0, face.rule.source.start.offset)}${css.slice(face.rule.source.end.offset)}`;
  }
  css = namespaceFontDeclarations(css, familyNames);
  return { css, fonts, familyNames };
}

/** Apply an already-established block-owned family mapping to editor-only declarations. */
export function namespaceAuthoringFontReferences(
  stylesheet: string,
  familyNames: ReadonlyMap<string, string>,
): string {
  return namespaceFontDeclarations(stylesheet, familyNames);
}

/** Adapt analyzed HTML to the same data-only compiler used by author preview/write. */
export function compileAnalyzedDesign(input: {
  definition: AuthorConfig;
  name: string;
  /** The exact HTML string already read and analysed by `author`; never a caller-supplied hash. */
  source: string;
  sourcePath?: string;
  blocks: WpBlock[];
  /** Proposal-bound structure, after source content has been resolved by the author adapter. */
  structureOverride?: AuthoringStructureNode[];
  /** Internal proposal binding identity; never serialized into the canonical plan. */
  sourceRefToNode?: ReadonlyMap<string, string>;
  /** Source declarations whose existing cascade makes native ownership unsafe. */
  cascadeSensitiveDeclarations?: ReadonlySet<string>;
  sourceDecisions?: AuthoringPlan['sourceDecisions'];
  /** Design-owned choices from a normalized proposal (never source bookkeeping). */
  proposalChoices?: Pick<AuthoringPlan, 'fields' | 'locking' | 'allowedBlocks' | 'pattern'>;
  rules: readonly CssRule[];
  preparedAssets: readonly PreparedCssAsset[];
  assets: readonly AssetLedgerEntry[];
  /** Complete shared-style ledger produced by the analysis pass. */
  styleLedger: readonly AuthoredStyleLedgerEntry[];
  /** Effective stylesheet bytes used for conversion, after deterministic asset rewrites. */
  stylesheet?: string;
  /** Original effective source facts, retained separately from residual rules for cascade checks. */
  stylesheetFacts?: CssStylesheet;
  /** Effective editor-only stylesheet after the same deterministic asset gate. */
  editorStylesheet?: string;
  /** Shared editor/frontend faces extracted from the effective stylesheet. */
  fonts?: readonly AuthoringFontFace[];
  /** Safe fallback decisions made while analysing shared/editor CSS. */
  fontWarnings?: ReadonlyArray<{ warning: FontAssetWarning; scope: 'shared' | 'editor' }>;
  /** Exact decisions used to prepare local font assets. */
  fontLicenses?: readonly FontLicenseDecision[];
}) {
  const { definition, name } = input;
  if (Object.entries(definition.supports ?? {}).some(([key, value]) => key !== 'html' || value !== false)) {
    throw new Error('Wrapper supports require an explicit supported authoring-plan contract; no arbitrary supports are emitted.');
  }
  const nodes: AuthoringStructureNode[] = [];
  const convert = (block: WpBlock, id: string): AuthoringStructureNode => {
    if (block.name === 'core/html') throw new Error(`Unresolved native structure at ${id}: describe this region as native blocks before authoring source; Custom HTML is not a registered-block substitute.`);
    // Gutenberg parses rich-text attributes as RichTextData instances. They stringify to the
    // authored HTML, but copying their enumerable properties produces `{}` and loses text when
    // the plan crosses the JSON-only compiler boundary.
    const attributes = JSON.parse(JSON.stringify(
      Object.fromEntries(Object.entries(block.attributes).filter(([key]) => !key.startsWith('__blockRunner'))),
    )) as Record<string, JsonValue>;
    const node: AuthoringStructureNode = { id, block: block.name,
      attributes,
      children: block.innerBlocks.map((child, index) => convert(child, `${id}.${index}`)) };
    nodes.push(node);
    return node;
  };
  const structure = input.structureOverride ?? input.blocks.map((block, index) => convert(block, `source.${index}`));
  const reconciled = input.structureOverride && input.sourceRefToNode
    ? reconcileProposalStyleOwnership(
      structure, input.rules, input.styleLedger, input.source, input.sourceRefToNode,
      input.stylesheetFacts?.rules ?? input.rules, input.cascadeSensitiveDeclarations ?? new Set(),
    )
    : { rules: input.rules, styleLedger: input.styleLedger };
  const responsive = liftExactResponsiveStyles({
    structure,
    rules: reconciled.rules,
    styleLedger: reconciled.styleLedger,
    definition,
    source: input.source,
    sourceRules: input.stylesheetFacts?.rules ?? input.rules,
  });
  const sourceEntry = input.sourcePath ?? '<inline>';
  // Proposal binding reads exact source attributes.  The asset adapter, rather than the model,
  // owns the package-relative rewrite used by the final native image node.
  const rewrittenAssets = new Map(input.assets
    .filter((asset) => asset.rewritten && (asset.outcome === 'prepared' || asset.outcome === 'copied'))
    .map((asset) => [asset.reference, asset.rewritten!]));
  for (const node of flattenNodes(structure)) {
    if (node.block === 'core/image' && typeof node.attributes?.url === 'string') {
      const rewritten = rewrittenAssets.get(node.attributes.url);
      if (rewritten) node.attributes.url = rewritten;
    }
  }
  const finalNodes = flattenNodes(structure);
  const assets: AuthoringPlan['assets'] = input.preparedAssets.map((asset, index) => {
    const destination = `assets/${path.basename(asset.destination)}`;
    const license = asset.kind === 'font'
      ? input.fontLicenses?.find((candidate) => path.resolve(candidate.source) === path.resolve(asset.source)
        && candidate.sha256 === asset.sha256)
      : undefined;
    return { id: `asset.${index}`, source: asset.source, kind: asset.kind === 'font' ? 'font' : 'image', destination, status: 'ready', sha256: asset.sha256,
      ...(license ? {
        fontLicense: {
          ownership: license.ownership,
          license: license.license,
          ...(license.notice === undefined ? {} : { notice: license.notice }),
        },
      } : {}),
      uses: finalNodes.filter((node) => node.block === 'core/image' && node.attributes?.url === `./${destination}`)
        .map((node) => ({ node: node.id!, attribute: 'url' as const })) };
  });
  for (const reference of new Set(input.assets.filter((asset) => asset.outcome === 'external' && /^https?:\/\//.test(asset.reference)).map((asset) => asset.reference))) {
    assets.push({ id: `external.${createHash('sha256').update(reference).digest('hex').slice(0, 16)}`, source: reference, status: 'external' });
  }
  const editorCss = input.editorStylesheet ?? definition.styles?.editorCss;
  const editor = scopeStylesheet(scanStylesheet(editorCss ?? ''), {
    root: `.wp-block-${name.replace('/', '-')}`,
    foundation: definition.styles?.foundation,
  });
  const editorSelectors = cssRuleSelectors(editor.localRules);
  if (editor.ledger.some((entry) => entry.outcome === 'blocked' || entry.outcome === 'warned') || editor.ruleRecords.some((rule) => rule.outcome === 'blocked')) {
    throw new Error('Editor-only CSS must use supported component-local rules; global or unsupported rules cannot be emitted.');
  }
  const editorStyleLedger: AuthoredStyleLedgerEntry[] = editor.ledger.map((entry) => ({
    property: entry.property,
    value: entry.value,
    outcome: entry.outcome === 'native' || entry.outcome === 'preset' || entry.outcome === 'literal'
      || entry.outcome === 'scoped-css' || entry.outcome === 'blocked' ? entry.outcome : 'warned',
    reason: entry.reason,
    atRules: entry.atRules,
    source: {
      path: input.sourcePath,
      selector: editorSelectors.get(entry.ruleId),
      offset: entry.source.start.offset,
      htmlLine: entry.source.start.line,
      htmlColumn: entry.source.start.column,
    },
  }));
  const coverage = createAnalyzedDesignCoverage({
    definition,
    source: input.source,
    sourcePath: input.sourcePath,
    styleLedger: responsive.styleLedger,
    assets: input.assets,
    preparedAssets: input.preparedAssets,
    stylesheet: input.stylesheet,
    editorStylesheet: editorCss,
    editorStyleLedger,
    fontWarnings: input.fontWarnings,
  });
  annotatePresetCoverage(coverage, structure, definition.styles?.context?.theme?.settings);
  const plan: AuthoringPlan = {
    version: 1, generatorVersion: '0.9.0', target: { name,
      title: definition.title ?? name.split('/')[1]!.replace(/[-_]+/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase()),
      category: definition.category ?? 'widgets', wordpress: '7.1' },
    source: { entry: sourceEntry, sha256: sha256(input.source), format: 'html' },
    coverage,
    structure, ...(input.sourceDecisions?.length ? { sourceDecisions: input.sourceDecisions } : {}),
    fields: input.proposalChoices?.fields ?? (input.structureOverride ? flattenNodes(structure) : nodes).flatMap((node) => supportedPatternOverrideAttributes(node.block).map((attribute) => ({
      id: `${node.id}.${attribute}`, label: `${node.block} ${attribute}`, mode: 'editable' as const, node: node.id, attribute,
    }))),
    // Analysis proposes the legacy unrestricted policy; the returned plan exposes it for review.
    locking: input.proposalChoices?.locking ?? definition.locking ?? { mode: 'none' },
    styles: { strategy: responsive.rules.length ? 'mixed' : 'native', outcomes: [],
      ...(definition.styles?.foundation ? { foundation: definition.styles.foundation } : {}),
      rules: authoringRulesFromStylesheet(responsive.rules), editorRules: authoringRulesFromStylesheet(editor.localRules),
      ...(input.fonts?.length ? { fonts: [...input.fonts] } : {}) },
    ...(input.proposalChoices?.allowedBlocks === undefined ? {} : { allowedBlocks: input.proposalChoices.allowedBlocks }),
    pattern: input.proposalChoices?.pattern ?? { ready: false, overrides: [] }, assets, files: [],
    warnings: [
      ...(definition.styles?.foundation === 'component' ? [COMPONENT_FOUNDATION_WARNING] : []),
      ...(input.fontWarnings ?? []).map(({ warning }) => warning.reason),
    ],
  };
  return { plan, generated: compileRegisteredBlock(plan), editorStyleLedger };
}

/**
 * A proposal replaces the converter tree, so source classes alone are not proof of native
 * ownership. Promote exactly one mapped source declaration only when its final native attribute
 * is already present; leave every other declaration in the scoped stylesheet.
 */
function reconcileProposalStyleOwnership(
  structure: AuthoringStructureNode[],
  rules: readonly CssRule[],
  ledger: readonly AuthoredStyleLedgerEntry[],
  source: string,
  bindings: ReadonlyMap<string, string>,
  sourceRules: readonly CssRule[],
  cascadeSensitiveDeclarations: ReadonlySet<string>,
): { rules: readonly CssRule[]; styleLedger: readonly AuthoredStyleLedgerEntry[] } {
  const dom = new JSDOM(source, { includeNodeLocations: true });
  try {
    const hash = sha256(source);
    const sourceNode = new Map<string, Element>();
    for (const element of [...dom.window.document.querySelectorAll('*')]) {
      const loc = dom.nodeLocation(element);
      if (loc) sourceNode.set(`${hash}:${loc.startOffset}-${loc.endOffset}`, element);
    }
    const promoted = new Set<string>();
    const nextLedger = ledger.map((entry) => ({ ...entry, source: entry.source ? { ...entry.source } : undefined }));
    for (const entry of nextLedger) {
      if (entry.outcome !== 'scoped-css' || entry.atRules.length || !entry.source?.selector) continue;
      const declarations = sourceDeclarations(sourceRules).filter((candidate) =>
        candidate.selector.trim() === entry.source!.selector!.trim()
        && candidate.declaration.property === entry.property
        && candidate.declaration.value === entry.value,
      );
      // Do not synthesize native ownership for an important declaration or any declaration
      // already protected by the same base-cascade analysis used by automatic conversion.
      if (declarations.length !== 1 || declarations[0]!.declaration.important
        || cascadeSensitiveDeclarations.has(sourceDeclarationKey(
          declarations[0]!.selector, entry.property, entry.value, declarations[0]!.ruleId,
        ))) continue;
      const matching = [...bindings.entries()].filter(([ref]) => {
        const element = sourceNode.get(ref);
        if (!element) return false;
        try { return element.matches(entry.source!.selector!); } catch { return false; }
      });
      if (matching.length !== 1) continue;
      const node = matching[0]![1];
      if (!hasNativeAttribute(structure, entry.property, entry.value, node)) continue;
      entry.outcome = 'native';
      entry.node = node;
      entry.reason = 'exact mapped source declaration is emitted by the final native block attribute';
      for (const selector of [entry.source.selector, entry.transportSelector]) {
        if (selector) promoted.add(`${selector}\u0000${entry.property}\u0000${entry.value}\u0000${entry.atRules.join('\u0000')}`);
      }
    }
    const removePromoted = (items: readonly CssRule[]): CssRule[] => items.reduce<CssRule[]>((output, rule) => {
      if (rule.kind === 'conditional') {
        const nested = removePromoted(rule.rules);
        if (nested.length) output.push({ ...rule, rules: nested });
        return output;
      }
      if (rule.kind !== 'style') { output.push(rule); return output; }
      const declarations = rule.declarations.filter((declaration) => !promoted.has(`${rule.selector}\u0000${declaration.property}\u0000${declaration.value}\u0000`));
      if (declarations.length) output.push({ ...rule, declarations });
      return output;
    }, []);
    const residual = removePromoted(rules);
    return adaptNativeSourceStyles(structure, residual, nextLedger, sourceNode, bindings);
  } finally { dom.window.close(); }
}

const BUTTON_WRAPPER_RESET = new Map<string, string>([
  ['padding', '0'], ['padding-top', '0'], ['padding-right', '0'], ['padding-bottom', '0'], ['padding-left', '0'], ['display', 'block'], ['background', 'transparent'], ['background-color', 'transparent'],
  ['border', '0'], ['border-top', '0'], ['border-right', '0'], ['border-bottom', '0'], ['border-left', '0'], ['border-radius', '0'], ['border-top-left-radius', '0'], ['border-top-right-radius', '0'], ['border-bottom-left-radius', '0'], ['border-bottom-right-radius', '0'], ['box-shadow', 'none'], ['opacity', '1'], ['transform', 'none'],
  ['translate', 'none'], ['rotate', 'none'], ['scale', 'none'], ['filter', 'none'], ['transition', 'none'],
  ['transition-property', 'none'], ['transition-duration', '0s'], ['transition-delay', '0s'],
]);
const BUTTON_TARGET_PROPERTIES = new Set(`color background background-color background-image border border-color border-width border-style border-radius box-shadow
  padding padding-top padding-right padding-bottom padding-left margin margin-top margin-right margin-bottom margin-left display width height min-width max-width min-height max-height
  font font-family font-size font-weight font-style line-height letter-spacing text-align text-decoration text-transform white-space opacity transform translate rotate scale filter
  transition transition-property transition-duration transition-delay transition-timing-function outline outline-color outline-width outline-style outline-offset cursor`.split(/\s+/));

/** Insert narrowly-qualified native rules beside their exact source rule, preserving nesting/order. */
function adaptNativeSourceStyles(
  structure: AuthoringStructureNode[], rules: readonly CssRule[], ledger: AuthoredStyleLedgerEntry[],
  sourceNodes: ReadonlyMap<string, Element>, bindings: ReadonlyMap<string, string>,
): { rules: CssRule[]; styleLedger: AuthoredStyleLedgerEntry[] } {
  const nodes = flattenNodes(structure);
  const targetFor = (selector: string): Array<{ node: string; target: string; reset?: string }> | undefined => {
    const subjects = nativeSelectorSubjects(selector);
    const staticSelector = selector.replace(/:(?:hover|focus-visible|focus|active)\b/gi, '');
    const matched = [...bindings.entries()].filter(([ref]) => {
      const element = sourceNodes.get(ref);
      return !!element && (() => { try { return element.matches(staticSelector); } catch { return false; } })();
    });
    const bound = matched.map(([, id]) => nodes.find((candidate) => candidate.id === id)).filter((node): node is AuthoringStructureNode => !!node);
    if (!subjects) {
      if (bound.some((node) => ['core/button', 'core/image', 'core/group', 'core/columns'].includes(node.block))) {
        throw new Error(`unresolved-native-style-mapping: ${selector} is not a supported single-subject native selector`);
      }
      return undefined;
    }
    const state = subjects[0]?.state ? `:${subjects[0].state}` : '';
    return bound.flatMap((node) => {
      if (node.block === 'core/button') {
        if (!findParent(structure, node.id!) || findParent(structure, node.id!)!.block !== 'core/buttons') throw new Error(`unresolved-native-style-mapping: ${selector} binds core/button without core/buttons wrapper`);
        const marker = `block-runner-native-${node.id!.replace(/[^a-zA-Z0-9_-]/g, '-')}`;
        // core/button serializes className on its own div.wp-block-button, never core/buttons.
        node.attributes = { ...(node.attributes ?? {}), className: joinClass(node.attributes?.className, marker) };
        return [{ node: node.id!, target: `.${marker} > .wp-block-button__link${state}`, reset: `.${marker}${state}` }];
      }
      if (node.block === 'core/image') return [{ node: node.id!, target: `figure.wp-block-image${selector} img` }];
      if (node.block === 'core/group' || node.block === 'core/columns') return [{ node: node.id!, target: `${selector}.${node.block === 'core/group' ? 'wp-block-group' : 'wp-block-columns'}` }];
      return [];
    });
  };
  const visit = (items: readonly CssRule[], conditional = false): CssRule[] => items.flatMap((rule): CssRule[] => {
    if (rule.kind === 'conditional') return [{ ...rule, rules: visit(rule.rules, true) }];
    if (rule.kind !== 'style') return [rule];
    const targets = targetFor(rule.selector);
    if (!targets?.length) return [rule];
    if (targets.some((target) => nodes.find((node) => node.id === target.node)?.block === 'core/columns')
      && rule.declarations.some((declaration) => declaration.property === 'display' && declaration.value.trim() === 'grid')) {
      throw new Error(`unresolved-native-style-mapping: ${rule.selector} cannot use core/columns for an authored grid`);
    }
    if (targets.some((target) => nodes.find((node) => node.id === target.node)?.block === 'core/button')
      && rule.declarations.some((declaration) => !BUTTON_TARGET_PROPERTIES.has(declaration.property))) {
      throw new Error(`unresolved-native-style-mapping: ${rule.selector} contains a property outside the supported core/button adapter`);
    }
    if (!conditional && targets.some((target) => nodes.find((node) => node.id === target.node)?.block === 'core/group')
      && rule.declarations.some((declaration) => declaration.property === 'display' && declaration.value.trim() === 'grid')) {
      const group = nodes.find((node) => node.id === targets[0]!.node)!;
      const layout = group.attributes?.layout;
      if (layout && (typeof layout !== 'object' || Array.isArray(layout) || (layout as Record<string, unknown>).type !== 'grid')) {
        throw new Error(`unresolved-native-style-mapping: ${rule.selector} requires a compatible core/group grid layout`);
      }
      group.attributes = { ...(group.attributes ?? {}), layout: { ...(layout as Record<string, JsonValue> ?? {}), type: 'grid' } };
    }
    const extras: CssRule[] = targets.flatMap((target, targetIndex) => {
      const targetRule: CssRule = { ...rule, id: `${rule.id}.native-target.${targetIndex}`, selector: target.target, generated: 'native-adapter-target' };
      const resets = target.reset ? rule.declarations.filter((declaration) => BUTTON_WRAPPER_RESET.has(declaration.property)).map((declaration) => ({ ...declaration, id: `${declaration.id}.native-reset.${targetIndex}`, value: BUTTON_WRAPPER_RESET.get(declaration.property)! })) : [];
      return resets.length ? [targetRule, { ...rule, id: `${rule.id}.native-reset.${targetIndex}`, selector: target.reset!, declarations: resets, generated: 'native-adapter-wrapper-reset' } as CssRule] : [targetRule];
    });
    for (const declaration of rule.declarations) {
      const entry = ledger.find((candidate) => candidate.source?.selector === rule.selector && candidate.property === declaration.property && candidate.value === declaration.value);
      if (entry) {
        for (const target of targets) {
          const role = target.reset ? 'button-link' : nodes.find((node) => node.id === target.node)?.block === 'core/image' ? 'image' : 'grid-container';
          entry.nativeTargets = [...(entry.nativeTargets ?? []), { node: target.node, role, selector: target.target }];
          if (target.reset && BUTTON_WRAPPER_RESET.has(declaration.property)) entry.nativeTargets.push({ node: target.node, role: 'button-wrapper-reset', selector: target.reset });
        }
      }
    }
    return [rule, ...extras];
  });
  return { rules: visit(rules), styleLedger: ledger };
}

function findParent(nodes: AuthoringStructureNode[], id: string): AuthoringStructureNode | undefined {
  for (const node of nodes) { if (node.children?.some((child) => child.id === id)) return node; const nested = findParent(node.children ?? [], id); if (nested) return nested; } return undefined;
}
function joinClass(value: JsonValue | undefined, marker: string): string { return [...new Set([...(typeof value === 'string' ? value.split(/\s+/) : []), marker])].filter(Boolean).join(' '); }

function sourceDeclarations(rules: readonly CssRule[]): Array<{ selector: string; ruleId: string; declaration: import('./styles.js').CssDeclaration }> {
  return rules.flatMap((rule) => {
    if (rule.kind === 'conditional') return sourceDeclarations(rule.rules);
    if (rule.kind !== 'style') return [];
    return rule.declarations.map((declaration) => ({ selector: rule.selector, ruleId: rule.id, declaration }));
  });
}

function cssRuleSelectors(rules: readonly CssRule[], output = new Map<string, string>()): Map<string, string> {
  for (const rule of rules) {
    if (rule.kind === 'conditional') cssRuleSelectors(rule.rules, output);
    else if (rule.kind === 'style') output.set(rule.id, rule.selector);
  }
  return output;
}

/** Mark only a preset that is both an exact target-snapshot value and the emitted native attribute. */
function annotatePresetCoverage(coverage: AuthoringCoverage, structure: readonly AuthoringStructureNode[], settings: unknown): void {
  for (const entry of coverage.styles) {
    if (entry.outcome !== 'native' || entry.atRules.length) continue;
    const transport = exactThemePresetTransport(settings, entry.property, entry.value);
    if (!transport) continue;
    const { preset } = transport;
    const sourceClass = entry.source?.selector ? simpleClassSelector(entry.source.selector) : undefined;
    const node = structure.find((candidate) => candidate.id && structureNodeHasPreset(candidate, transport)
      && (sourceClass === undefined || classList(candidate).includes(sourceClass)));
    if (!node?.id) continue;
    entry.outcome = 'preset';
    entry.reason = `exact target theme ${preset.category} preset "${preset.slug}"`;
    entry.node = node.id;
    entry.preset = { category: preset.category, slug: preset.slug };
  }
}

function structureNodeHasPreset(node: AuthoringStructureNode, transport: NonNullable<ReturnType<typeof exactThemePresetTransport>>): boolean {
  if (!transport) return false;
  if ('attribute' in transport) return node.attributes?.[transport.attribute] === transport.preset.slug;
  let value: unknown = node.attributes?.style;
  for (const key of transport.stylePath) value = value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>)[key] : undefined;
  return value === transport.value;
}

interface ResponsiveCandidate {
  declarationId: string;
  selector: string;
  property: string;
  value: string;
  atRule: string;
  state: 'mobile' | 'tablet';
  node: AuthoringStructureNode;
  path: readonly string[];
}

/**
 * Lift only the narrow WP 7.1 case we can prove: an exact target viewport interval, a single
 * local class resolving to one emitted Core block, a supported longhand, and no competing source
 * selector/condition/priority. Everything even slightly less direct remains authored CSS.
 */
function liftExactResponsiveStyles(input: {
  structure: readonly AuthoringStructureNode[];
  rules: readonly CssRule[];
  styleLedger: readonly AuthoredStyleLedgerEntry[];
  definition: AuthorConfig;
  source: string;
  sourceRules: readonly CssRule[];
}): { rules: CssRule[]; styleLedger: AuthoredStyleLedgerEntry[] } {
  const context = input.definition.styles?.context;
  const themeViewport = context?.theme?.settings && typeof context.theme.settings === 'object' && !Array.isArray(context.theme.settings)
    ? (context.theme.settings as Record<string, unknown>).viewport
    : undefined;
  const settings = themeViewport && typeof themeViewport === 'object' && !Array.isArray(themeViewport)
    ? themeViewport
    : context?.viewports
      ? { ...(context.viewports.mobile?.max ? { mobile: context.viewports.mobile.max } : {}), ...(context.viewports.tablet?.max ? { tablet: context.viewports.tablet.max } : {}) }
      : undefined;
  // Missing target context is a fidelity limitation, never a licence to use WP defaults.
  if (!settings) return { rules: [...input.rules], styleLedger: [...input.styleLedger] };

  const nodes = flattenNodes(input.structure);
  const declarations = flattenStyleDeclarations(input.rules);
  const candidates: ResponsiveCandidate[] = [];
  for (const item of declarations) {
    if (item.conditions.length !== 1 || item.conditions[0]!.name !== 'media' || item.declaration.important) continue;
    const state = mapExactWordPressResponsiveMedia(item.conditions[0]!.prelude, settings);
    const className = simpleClassSelector(item.rule.selector);
    const target = lookupDeclaration(item.declaration.property);
    if (!state || !className || target?.kind !== 'style') continue;
    const matching = nodes.filter((node) => node.block.startsWith('core/') && classList(node).includes(className));
    if (matching.length !== 1 || !matching[0]!.id || !supportsNativeStyle(matching[0]!.block, target.supports)) continue;
    // Any pseudo, compound, competing interval, specificity, or priority could change the
    // browser cascade. The native state renderer intentionally uses !important, so preserve CSS.
    if (hasUnsafeCandidateCascade(input.source, input.sourceRules, item)) continue;
    candidates.push({ declarationId: item.declaration.id, selector: item.rule.selector, property: item.declaration.property,
      value: item.declaration.value, atRule: `@media ${item.conditions[0]!.prelude}`, state, node: matching[0]!, path: target.path });
  }
  if (!candidates.length) return { rules: [...input.rules], styleLedger: [...input.styleLedger] };

  for (const candidate of candidates) setResponsiveStyle(candidate.node, candidate.state, candidate.path, candidate.value);
  const lifted = new Map(candidates.map((candidate) => [candidate.declarationId, candidate]));
  return {
    rules: removeLiftedDeclarations(input.rules, lifted),
    styleLedger: input.styleLedger.map((entry) => {
      const candidate = candidates.find((item) => item.selector === entry.source?.selector && item.property === entry.property
        && item.value === entry.value && entry.atRules.length === 1 && entry.atRules[0] === item.atRule);
      return candidate ? { ...entry, outcome: 'native', reason: `mapped to WordPress @${candidate.state} on ${candidate.node.id}`,
        node: candidate.node.id, responsive: candidate.state } : entry;
    }),
  };
}

function hasUnsafeCandidateCascade(
  source: string,
  rules: readonly CssRule[],
  item: ReturnType<typeof flattenStyleDeclarations>[number],
): boolean {
  const dom = new JSDOM(source);
  try {
    return hasUnsafeResponsiveNativeCascade({ document: dom.window.document, rules,
      candidate: { selector: item.rule.selector, declarationId: item.declaration.id, property: item.declaration.property } });
  } finally {
    dom.window.close();
  }
}

function flattenNodes(nodes: readonly AuthoringStructureNode[]): AuthoringStructureNode[] {
  return nodes.flatMap((node) => [node, ...flattenNodes(node.children ?? [])]);
}

function classList(node: AuthoringStructureNode): string[] {
  const value = node.attributes?.className;
  return typeof value === 'string' ? value.split(/\s+/).filter(Boolean) : [];
}

function simpleClassSelector(selector: string): string | undefined {
  const match = /^\.([_a-zA-Z][-_a-zA-Z0-9]*)$/.exec(selector.trim());
  return match?.[1];
}

function supportsNativeStyle(block: string, query: Parameters<typeof querySupports>[1]): boolean {
  const wp = bootHeadlessWordPressSync();
  return querySupports((wp.getBlockType(block) as { supports?: Record<string, unknown> } | undefined)?.supports, query);
}

function flattenStyleDeclarations(rules: readonly CssRule[], conditions: Array<Extract<CssRule, { kind: 'conditional' }>> = []): Array<{ rule: Extract<CssRule, { kind: 'style' }>; declaration: Extract<CssRule, { kind: 'style' }>['declarations'][number]; conditions: Array<Extract<CssRule, { kind: 'conditional' }>> }> {
  return rules.flatMap((rule) => {
    if (rule.kind === 'conditional') return flattenStyleDeclarations(rule.rules, [...conditions, rule]);
    if (rule.kind !== 'style') return [];
    return rule.declarations.map((declaration) => ({ rule, declaration, conditions }));
  });
}

function setResponsiveStyle(node: AuthoringStructureNode, state: 'mobile' | 'tablet', path: readonly string[], value: string): void {
  const attributes = node.attributes ?? (node.attributes = {});
  const style = typeof attributes.style === 'object' && attributes.style && !Array.isArray(attributes.style)
    ? attributes.style as Record<string, JsonValue>
    : (attributes.style = {});
  let current = style[`@${state}`] ?? (style[`@${state}`] = {});
  for (const key of path.slice(0, -1)) {
    if (!current || typeof current !== 'object' || Array.isArray(current)) return;
    current = (current as Record<string, JsonValue>)[key] ?? ((current as Record<string, JsonValue>)[key] = {});
  }
  if (current && typeof current === 'object' && !Array.isArray(current)) (current as Record<string, JsonValue>)[path[path.length - 1]!] = value;
}

function removeLiftedDeclarations(rules: readonly CssRule[], lifted: ReadonlyMap<string, ResponsiveCandidate>): CssRule[] {
  return rules.flatMap((rule): CssRule[] => {
    if (rule.kind === 'conditional') {
      const children = removeLiftedDeclarations(rule.rules, lifted);
      return children.length ? [{ ...rule, rules: children }] : [];
    }
    if (rule.kind !== 'style') return [rule];
    const declarations = rule.declarations.filter((declaration) => !lifted.has(declaration.id));
    return declarations.length ? [{ ...rule, declarations }] : [];
  });
}

/** Build the source-bound coverage shared by rules-derived and caller-supplied proposals. */
export function createAnalyzedDesignCoverage(input: {
  definition: AuthorConfig;
  source: string;
  sourcePath?: string;
  styleLedger: readonly AuthoredStyleLedgerEntry[];
  assets: readonly AssetLedgerEntry[];
  preparedAssets: readonly PreparedCssAsset[];
  stylesheet?: string;
  editorStylesheet?: string;
  editorStyleLedger: readonly AuthoredStyleLedgerEntry[];
  fontWarnings?: ReadonlyArray<{ warning: FontAssetWarning; scope: 'shared' | 'editor' }>;
}): AuthoringCoverage {
  const sourceEntry = input.sourcePath ?? '<inline>';
  return {
    ...(input.stylesheet === undefined ? {} : {
      stylesheet: {
        entry: input.definition.styles?.css !== undefined ? '<author.styles.css>' : sourceEntry,
        sha256: sha256(input.stylesheet),
      },
    }),
    ...(input.editorStylesheet === undefined ? {} : {
      editorStylesheet: { entry: '<author.styles.editorCss>', sha256: sha256(input.editorStylesheet) },
    }),
    ...(input.definition.styles?.foundation ? { foundation: input.definition.styles.foundation } : {}),
    styleContext: coverageStyleContext(input.definition, `${input.stylesheet ?? ''}\n${input.editorStylesheet ?? ''}`),
    styles: [
      ...input.styleLedger.map((entry) => toCoverageStyle(entry, 'shared')),
      ...input.editorStyleLedger.map((entry) => toCoverageStyle(entry, 'editor')),
      ...(input.fontWarnings ?? []).map(({ warning, scope }) => toCoverageFontWarning(warning, scope)),
    ],
    assets: input.assets.map((entry) => toCoverageAsset(entry, input.preparedAssets)),
  };
}

/** Keep target inputs reviewable without importing or mutating global theme.json. */
function coverageStyleContext(definition: AuthorConfig, css: string): AuthoringStyleContext {
  const supplied = definition.styles?.context;
  const theme = supplied?.theme;
  const facts = styleContextFrom(theme, css);
  const unresolvedVariables = facts.unresolvedVariables;
  const themeViewport = theme?.settings && typeof theme.settings === 'object' && !Array.isArray(theme.settings)
    ? (theme.settings as Record<string, unknown>).viewport
    : undefined;
  const resolvedThemeViewports = themeViewport && typeof themeViewport === 'object' && !Array.isArray(themeViewport)
    ? resolveWordPressViewportRanges(themeViewport)
    : undefined;
  if (supplied?.viewports && resolvedThemeViewports && stableJson(supplied.viewports) !== stableJson(resolvedThemeViewports)) {
    throw new Error('author.styles.context.viewports conflicts with target theme settings.viewport; use the WordPress-resolved viewport ranges.');
  }
  const viewports = resolvedThemeViewports ?? supplied?.viewports;
  const limitations: string[] = [];
  if (!theme?.settings) limitations.push('No target theme settings snapshot was supplied; native/theme-preset fidelity is not asserted.');
  if (!viewports) limitations.push('No configured WordPress viewport ranges were supplied; responsive source conditions remain exact scoped CSS.');
  if (unresolvedVariables.length) limitations.push('Custom CSS variables are unresolved outside this block stylesheet; their provider and cascade remain a destination assumption.');
  limitations.push(definition.styles?.foundation === 'component'
    ? 'Foundation CSS is contained within the generated component; document-wide equivalence is intentionally not claimed.'
    : 'Global foundation/reset CSS is not injected; source rules requiring it are blocked instead of being approximated.');
  limitations.push(...facts.limitations);
  return {
    ...(theme ? { theme: {
      ...(theme.slug ? { slug: theme.slug } : {}),
      ...(theme.version ? { version: theme.version } : {}),
      ...(facts.settingsSha256 ? { settingsSha256: facts.settingsSha256 } : {}),
    } } : {}),
    ...(viewports ? { viewports } : {}),
    ...(unresolvedVariables.length ? { unresolvedVariables } : {}),
    limitations,
  };
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(',')}}`;
  return JSON.stringify(value);
}

/**
 * Prove that a source-bound proposal carries each successful source disposition into the
 * declarative package it asks the compiler to emit.  Ledger equality alone is provenance, not
 * delivery: CSS and prepared assets must also have a concrete plan transport.
 */
export function validateCoverageFulfillment(plan: AuthoringPlan, sourceHtml?: string, assetRoot?: string): void {
  const coverage = plan.coverage;
  if (!coverage) throw new Error('Supplied authoring plan is missing its source coverage.');
  let serializedTemplate: string | undefined;
  let generatedDom: JSDOM | undefined;
  let sourceDom: JSDOM | undefined;

  try {
    for (const [index, entry] of coverage.styles.entries()) {
      const label = `coverage.styles[${index}] ${entry.property}: ${entry.value}`;
      if (entry.outcome === 'blocked' || entry.outcome === 'warned') {
        throw new Error(`${label} has unresolved source evidence and cannot be claimed as fulfilled.`);
      }
      if (entry.outcome === 'scoped-css') {
        const rules = entry.scope === 'editor' ? plan.styles.editorRules ?? [] : plan.styles.rules ?? [];
        const selectors = coverageCssRuleSelectors(rules, entry.property, entry.value, entry.atRules, entry.transportSelector ?? entry.source?.selector);
        if (selectors.length === 0) {
          throw new Error(`${label} is marked scoped-css but has no matching ${entry.scope} structured CSS rule.`);
        }
        for (const target of entry.nativeTargets ?? []) {
          const expectedValue = target.role === 'button-wrapper-reset' ? BUTTON_WRAPPER_RESET.get(entry.property) : entry.value;
          const emitted = expectedValue === undefined ? [] : coverageCssRuleSelectors(rules, entry.property, expectedValue, entry.atRules, target.selector);
          if (!emitted.includes(target.selector)) throw new Error(`${label} is missing generated native target ${target.role} (${target.selector}).`);
        }
        // This is deliberately the compiler's final template, rather than plan.structure: field
        // defaults and confirmed asset uses can replace attributes before WordPress receives it.
        serializedTemplate ??= serializeCompiledTemplate(compileRegisteredBlock(plan).template);
        generatedDom ??= generatedTemplateDom(plan.target.name, serializedTemplate);
        const generatedMatch = selectors.some((selector) =>
          selectorAppliesToGeneratedTemplate(selector, plan.target.name, generatedDom!.window.document, plan.styles.foundation),
        );
        // A complete stylesheet may carry foundation rules for elements not present in this one
        // design. Retain those exact rules, but require an emitted match when the original source
        // actually used the selector. Without source HTML, preserve the former conservative gate.
        const sourceMatch = sourceHtml !== undefined && entry.source?.selector !== undefined
          ? sourceSelectorApplies(entry.source.selector, (sourceDom ??= new JSDOM(sourceHtml)).window.document)
          : true;
        if (!generatedMatch && sourceMatch) {
          throw new Error(`${label} is marked scoped-css but its selector does not match the generated native template.`);
        }
        continue;
      }
      const nativeAttribute = hasNativeAttribute(plan.structure, entry.property, entry.value, entry.node, entry.responsive);
      if (entry.outcome === 'native') {
        assertResponsiveCoverage(coverage.styleContext, entry, label);
        // A native ledger outcome records intended transport, but structure is compiler input.
        if (!nativeAttribute) throw new Error(`${label} is marked native but has no matching native block attribute.`);
        if (entry.responsive && !hasCompiledResponsiveAttribute(plan, entry)) {
          throw new Error(`${label} is responsive native styling but the final compiled node does not carry it.`);
        }
        continue;
      }
      const explicitDisposition = plan.styles.outcomes.some((outcome) => outcome.property === entry.property
        && outcome.value === entry.value
        && ((entry.outcome === 'preset' && outcome.outcome === 'token')
          || (entry.outcome === 'literal' && outcome.outcome === 'scoped-css')));
      if (entry.outcome === 'preset' && entry.preset && !hasCompiledPresetAttribute(plan, entry)) {
        throw new Error(`${label} is preset-owned but the final compiled node does not carry its bound preset.`);
      }
      if (!explicitDisposition && !nativeAttribute && !(entry.outcome === 'preset' && hasCompiledPresetAttribute(plan, entry))) {
        throw new Error(`${label} has no explicit native or literal plan disposition.`);
      }
    }

    for (const [index, entry] of coverage.assets.entries()) {
      const label = `coverage.assets[${index}] ${entry.reference}`;
      if (entry.outcome === 'unresolved' || entry.outcome === 'blocked') {
        throw new Error(`${label} is unresolved source evidence and cannot be claimed as transported.`);
      }
      if (entry.outcome === 'external') {
        // External records intentionally have no package destination, hash, or native `uses`:
        // the asset compiler forbids pretending it owns remote bytes.  Their only valid
        // transport is byte-for-byte retention in the final image node or authored CSS.
        const retainedByNode = flattenNodes(plan.structure).some((node) => node.block === 'core/image' && node.attributes?.url === entry.reference);
        const retainedByCss = [...plan.styles.rules ?? [], ...plan.styles.editorRules ?? []]
          .some((rule) => cssRuleUsesAsset(rule, entry.reference));
        if (!retainedByNode && !retainedByCss && !isReviewedWholeMediaOmission(plan, sourceHtml, entry.reference)) {
          throw new Error(`${label} external URL is not retained byte-for-byte by the final package.`);
        }
        continue;
      }
      const source = resolvedCoverageAssetSource(plan, entry.reference, assetRoot);
      const asset = source === undefined || entry.destination === undefined || entry.sha256 === undefined
        ? undefined
        : plan.assets.find((candidate) => path.resolve(candidate.source) === source
          && candidate.destination === entry.destination && candidate.sha256 === entry.sha256);
      if (!asset) throw new Error(`${label} has no matching confirmed plan asset record.`);
      if (entry.kind === 'font') {
        if (!plan.styles.fonts?.some((face) => face.assetId === asset.id)) {
          throw new Error(`${label} has no generated font-face transport.`);
        }
      } else if (!asset.uses?.length) {
        // Background/other CSS-only images have no native image attribute. They are fulfilled
        // only when the final structured stylesheet still names the exact package destination.
        const cssUse = [...plan.styles.rules ?? [], ...plan.styles.editorRules ?? []]
          .some((rule) => cssRuleUsesAsset(rule, asset.destination!));
        if (!cssUse) throw new Error(`${label} has no native or confirmed CSS output use.`);
      }
    }
  } finally {
    generatedDom?.window.close();
    sourceDom?.window.close();
  }
}

/** A reviewed whole figure/image omission deliberately has no final media transport. */
function isReviewedWholeMediaOmission(plan: AuthoringPlan, sourceHtml: string | undefined, reference: string): boolean {
  if (sourceHtml === undefined) return false;
  const hash = sha256(sourceHtml);
  const omitted = new Set((plan.sourceDecisions ?? [])
    .filter((decision) => decision.action === 'omit' && !decision.node && !decision.attribute)
    .map((decision) => decision.sourceRef));
  if (!omitted.size) return false;
  const dom = new JSDOM(sourceHtml, { includeNodeLocations: true });
  try {
    return [...dom.window.document.querySelectorAll('figure,img')].some((element) => {
      const image = element.matches('figure') ? element.querySelector('img') : element;
      if (image?.getAttribute('src') !== reference) return false;
      const loc = dom.nodeLocation(element);
      return !!loc && omitted.has(`${hash}:${loc.startOffset}-${loc.endOffset}`);
    });
  } finally { dom.window.close(); }
}

function cssRuleUsesAsset(rule: import('../authoring/schema.js').AuthoringCssRule, destination: string): boolean {
  if (rule.kind === 'conditional') return rule.rules.some((child) => cssRuleUsesAsset(child, destination));
  return rule.declarations.some((declaration) => declaration.value.includes(destination) || declaration.value.includes(`./${destination}`));
}

/** Resolve a source asset only from a relative reference beneath the hash-bound HTML source root. */
function resolvedCoverageAssetSource(plan: AuthoringPlan, reference: string, assetRoot?: string): string | undefined {
  if (!plan.source || plan.source.entry === '<inline>' || /^(?:[a-z][a-z0-9+.-]*:|\/\/|\/)/i.test(reference)) return undefined;
  const pathname = reference.split(/[?#]/, 1)[0];
  if (!pathname) return undefined;
  const sourceDirectory = path.dirname(path.resolve(plan.source.entry));
  const allowedRoot = path.resolve(assetRoot ?? sourceDirectory);
  const resolved = path.resolve(sourceDirectory, pathname);
  const relative = path.relative(allowedRoot, resolved);
  if (!relative || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return undefined;
  return resolved;
}

function hasCompiledPresetAttribute(plan: AuthoringPlan, entry: AuthoringCoverageStyle): boolean {
  if (!entry.node || !entry.preset) return false;
  const attribute = entry.property === 'color' ? 'textColor'
    : entry.property === 'background-color' ? 'backgroundColor'
      : entry.property === 'font-size' ? 'fontSize'
        : entry.property === 'font-family' ? 'fontFamily' : undefined;
  const path = nodeIndexPath(plan.structure, entry.node);
  if (!path) return false;
  let compiled: unknown = compileRegisteredBlock(plan).template;
  for (const [depth, index] of path.entries()) {
    if (!Array.isArray(compiled) || !Array.isArray(compiled[index])) return false;
    const tuple = compiled[index] as unknown[];
    compiled = depth < path.length - 1 ? tuple[2] : tuple;
  }
  if (!Array.isArray(compiled) || !compiled[1] || typeof compiled[1] !== 'object' || Array.isArray(compiled[1])) return false;
  const attributes = compiled[1] as Record<string, unknown>;
  if (attribute) return attributes[attribute] === entry.preset.slug;
  const spacing = /^(margin|padding)-(top|right|bottom|left)$/.exec(entry.property);
  if (!spacing) return false;
  const value = (((attributes.style as Record<string, unknown> | undefined)?.spacing as Record<string, unknown> | undefined)?.[spacing[1]!] as Record<string, unknown> | undefined)?.[spacing[2]!];
  return value === `var:preset|spacing|${entry.preset.slug}`;
}

/** Recheck responsive evidence after compiler defaults/fixed-field handling, not only in the plan. */
function hasCompiledResponsiveAttribute(plan: AuthoringPlan, entry: AuthoringCoverageStyle): boolean {
  if (!entry.node || !entry.responsive) return false;
  const path = nodeIndexPath(plan.structure, entry.node);
  if (!path) return false;
  let compiled: unknown = compileRegisteredBlock(plan).template;
  for (const [depth, index] of path.entries()) {
    if (!Array.isArray(compiled) || !Array.isArray(compiled[index])) return false;
    const tuple = compiled[index] as unknown[];
    compiled = tuple;
    if (depth < path.length - 1) compiled = tuple[2];
  }
  if (!Array.isArray(compiled) || !compiled[1] || typeof compiled[1] !== 'object' || Array.isArray(compiled[1])) return false;
  const target = nativeStyleTarget(entry.property, entry.value);
  if (!target) return false;
  let value: unknown = compiled[1] as Record<string, unknown>;
  for (const key of ['style', `@${entry.responsive}`, ...target]) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    value = (value as Record<string, unknown>)[key];
  }
  return value === entry.value;
}

function nodeIndexPath(nodes: readonly AuthoringStructureNode[], id: string, prefix: number[] = []): number[] | undefined {
  for (const [index, node] of nodes.entries()) {
    const current = [...prefix, index];
    if (node.id === id) return current;
    const nested = nodeIndexPath(node.children ?? [], id, current);
    if (nested) return nested;
  }
  return undefined;
}

/**
 * A responsive block style is only honest when the reviewed source query is one of the exact
 * states WordPress will generate from the same target viewport configuration.  In particular,
 * never treat a default fallback as target proof when the plan did not carry viewport context.
 */
function assertResponsiveCoverage(
  context: AuthoringStyleContext | undefined,
  entry: AuthoringCoverageStyle,
  label: string,
): void {
  if (!entry.responsive) {
    if (entry.atRules.length) throw new Error(`${label} is conditional native styling without a WordPress responsive-state binding.`);
    return;
  }
  if (!entry.node) throw new Error(`${label} is responsive native styling but names no native node.`);
  const viewports = context?.viewports;
  if (!viewports) throw new Error(`${label} is responsive native styling without target viewport context.`);
  const settings = {
    ...(viewports.mobile?.max ? { mobile: viewports.mobile.max } : {}),
    ...(viewports.tablet?.max ? { tablet: viewports.tablet.max } : {}),
  };
  const resolved = resolveWordPressViewportRanges(settings);
  if (stableJson(resolved) !== stableJson(viewports)) {
    throw new Error(`${label} has viewport context that is not the WordPress 7.1 resolved range.`);
  }
  const sourceMedia = entry.atRules[0]?.replace(/^@media\s+/i, '');
  if (entry.atRules.length !== 1 || !sourceMedia || mapExactWordPressResponsiveMedia(sourceMedia, settings) !== entry.responsive) {
    throw new Error(`${label} source media condition is not exactly equivalent to WordPress @${entry.responsive}.`);
  }
}

/** Match a native declaration only where the requested property and value coexist in an emitted
 * block attribute object; a value-only search would allow unrelated text to satisfy coverage. */
function hasNativeAttribute(
  nodes: readonly AuthoringStructureNode[],
  property: string,
  value: string,
  nodeId?: string,
  responsive?: 'mobile' | 'tablet',
): boolean {
  const target = nativeStyleTarget(property, value);
  if (!target) return false;
  const path = ['style', ...(responsive ? [`@${responsive}`] : []), ...target];
  const matches = (node: AuthoringStructureNode): boolean => {
    if (nodeId !== undefined && node.id !== nodeId) return false;
    const attributes = node.attributes;
    let current: unknown = attributes;
    for (const key of path) {
      if (!current || typeof current !== 'object' || Array.isArray(current)) return false;
      current = (current as Record<string, unknown>)[key];
    }
    return current === value;
  };
  return nodes.some((node) => matches(node) || hasNativeAttribute(node.children ?? [], property, value, nodeId, responsive));
}

/**
 * Prove that the generated structure still carries a declaration through a native WordPress
 * attribute. The source-coverage comparison uses this before accepting exact CSS transport for
 * a declaration which static capability analysis had otherwise classified as native.
 */
export function hasNativeCoverageTransport(
  plan: Pick<AuthoringPlan, 'structure'>,
  entry: Pick<AuthoringCoverageStyle, 'property' | 'value' | 'node' | 'responsive'>,
): boolean {
  return hasNativeAttribute(plan.structure, entry.property, entry.value, entry.node, entry.responsive);
}

/** Use the same finite declaration registry as conversion. This proves transport only through
 * actual WordPress style-engine paths, never arbitrary matching metadata. */
function nativeStyleTarget(property: string, value: string): readonly string[] | undefined {
  const target = lookupDeclaration(property);
  if (target?.kind === 'style') return target.path;
  if (property !== 'background') return undefined;
  const kind = classifyBackground(value);
  if (kind === 'color') return BACKGROUND_COLOR_TARGET.path;
  if (kind === 'gradient') return GRADIENT_TARGET.path;
  return undefined;
}

export function coverageCssRuleSelectors(
  rules: readonly import('../authoring/schema.js').AuthoringCssRule[],
  property: string,
  value: string,
  atRules: readonly string[],
  selector: string | undefined,
  conditions: string[] = [],
  output: string[] = [],
): string[] {
  for (const rule of rules) {
    if (rule.kind === 'conditional') {
      coverageCssRuleSelectors(rule.rules, property, value, atRules, selector, [...conditions, `@${rule.name} ${rule.prelude}`], output);
      continue;
    }
    if (conditions.length === atRules.length && conditions.every((condition, index) => condition === atRules[index])
      && (selector === undefined || rule.selector === selector)
      && rule.declarations.some((declaration) => declaration.property === property
        // Older canonical plans encoded priority in the value while current plans use the
        // structured `important` bit. Coverage identifies the source declaration value, not a
        // weaker priority-stripped spelling, so accept either canonical representation.
        && (declaration.value === value || declaration.value === `${value} !important`))) output.push(rule.selector);
  }
  return output;
}

/**
 * A source CSS rule is only fulfilled when its emitted, root-scoped selector can address an
 * element in the final native template. This is an applicability proof, not a cascade or visual
 * fidelity claim: dynamic pseudo states are made statically satisfiable while preserving their
 * element/combinator relationships.
 */
function generatedTemplateDom(targetName: string, serializedTemplate: string): JSDOM {
  const root = `wp-block-${targetName.replace('/', '-')}`;
  return new JSDOM(`<div class="${root}">${serializedTemplate}</div>`);
}

function selectorAppliesToGeneratedTemplate(selector: string, targetName: string, document: Document, foundation?: 'component'): boolean {
  const root = `.wp-block-${targetName.replace('/', '-')}`;
  const scoped = scopeLocalSelectorList(selector, root, { foundation });
  if (!scoped.ok) return false;
  try {
    return document.querySelector(staticSelector(scoped.selector)) !== null;
  } catch {
    // The emitter remains authoritative for accepted CSS. A selector JSDOM cannot prove is
    // applicable must not be used as coverage evidence.
    return false;
  }
}

function sourceSelectorApplies(selectorList: string, document: Document): boolean {
  for (const selector of splitCssTopLevel(selectorList, ',')) {
    try {
      if (document.querySelector(staticSelector(selector.trim())) !== null) return true;
    } catch {
      // The source selector was retained by the checked stylesheet gate but is not statically
      // decidable by JSDOM. Treat it as used so it cannot become an unused-selector bypass.
      return true;
    }
  }
  return false;
}

/** Serialize exactly the compiler-produced template through the pinned WordPress save path. */
function serializeCompiledTemplate(template: readonly unknown[]): string {
  const wp = bootHeadlessWordPressSync();
  const toBlock = (node: unknown): WpBlock => {
    if (!Array.isArray(node) || typeof node[0] !== 'string' || !node[1] || typeof node[1] !== 'object' || Array.isArray(node[1])) {
      throw new Error('Compiled native template has an invalid node.');
    }
    const children = Array.isArray(node[2]) ? node[2].map(toBlock) : [];
    return wp.createBlock(node[0], node[1] as Record<string, unknown>, children) as WpBlock;
  };
  return withMutedWordPressConsole(() => wp.serialize(template.map(toBlock)));
}

/**
 * JSDOM has no active interaction state. Strip only known dynamic pseudo classes; this keeps
 * descendant/sibling relationships intact, and makes :not(:hover) an ordinary satisfiable
 * condition instead of producing the invalid selector :not().
 */
function staticSelector(selector: string): string {
  // `:not(.notice:hover)` can be true for any generated element when the dynamic state is
  // false. Replacing only `:hover` would turn it into `:not(.notice)` and incorrectly reject
  // that valid possibility. Comma-separated negations need a selector engine to reason about,
  // so they retain the conservative normalization below.
  const output = replaceSimpleDynamicNegations(selector);
  return stripPseudoElements(replaceDynamicPseudos(output, ':not(:not(*))'));
}

function replaceSimpleDynamicNegations(selector: string): string {
  let output = '';
  let index = 0;
  let quote: string | undefined;
  let brackets = 0;
  while (index < selector.length) {
    const char = selector[index]!;
    if (char === '\\') {
      output += char + (selector[index + 1] ?? '');
      index += 2;
      continue;
    }
    if (quote) {
      output += char;
      if (char === quote) quote = undefined;
      index += 1;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      output += char;
      index += 1;
      continue;
    }
    if (char === '[') {
      brackets += 1;
      output += char;
      index += 1;
      continue;
    }
    if (char === ']') {
      brackets = Math.max(0, brackets - 1);
      output += char;
      index += 1;
      continue;
    }
    if (brackets > 0 || selector.slice(index, index + 5).toLowerCase() !== ':not(') {
      output += selector[index++]!;
      continue;
    }
    const end = closingParenthesis(selector, index + 4);
    if (end === undefined) return selector;
    const body = selector.slice(index + 5, end);
    if (hasDynamicPseudo(body) && (body.includes(',') || /:(?:not|is|where|has)\s*\(/i.test(body))) {
      throw new Error('dynamic selector logic inside a complex :not() cannot be proven statically');
    }
    output += !body.includes(',') && hasDynamicPseudo(body) ? ':not(:not(*))' : selector.slice(index, end + 1);
    index = end + 1;
  }
  return output;
}

// Firefox's focus-ring and invalid-input selectors are active interaction states. They remain
// literal in emitted CSS; static applicability treats only these named vendor states like the
// standard interaction states because JSDOM cannot query them.
const DYNAMIC_PSEUDOS = new Set(['active', 'focus', 'focus-visible', 'focus-within', 'hover', 'target', 'visited', '-moz-focusring', '-moz-ui-invalid']);

/** CSS-token-aware state replacement: never mistake an escaped class or attribute string for a pseudo. */
function replaceDynamicPseudos(selector: string, replacement: string): string {
  let output = '';
  let quote: string | undefined;
  let brackets = 0;
  for (let index = 0; index < selector.length; index += 1) {
    const char = selector[index]!;
    if (char === '\\') {
      output += char + (selector[index + 1] ?? '');
      index += 1;
      continue;
    }
    if (quote) {
      output += char;
      if (char === quote) quote = undefined;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      output += char;
      continue;
    }
    if (char === '[') {
      brackets += 1;
      output += char;
      continue;
    }
    if (char === ']') {
      brackets = Math.max(0, brackets - 1);
      output += char;
      continue;
    }
    if (brackets === 0 && char === ':') {
      const name = /^[-a-z]+/i.exec(selector.slice(index + 1))?.[0]?.toLowerCase();
      if (name && DYNAMIC_PSEUDOS.has(name)) {
        output += replacement;
        index += name.length;
        continue;
      }
    }
    output += char;
  }
  return output;
}

function hasDynamicPseudo(selector: string): boolean {
  return replaceDynamicPseudos(selector, '') !== selector;
}

// This is the fixed vendor pseudo-element set emitted by the pinned Tailwind Preflight. They are
// stripped only for static source/generated applicability; the authored selector remains intact.
const PSEUDO_ELEMENTS = new Set([
  'after', 'before', 'first-letter', 'first-line', 'marker', 'placeholder', 'selection',
  '-moz-placeholder', '-webkit-file-upload-button', '-webkit-inner-spin-button',
  '-webkit-outer-spin-button', '-webkit-search-decoration',
]);

function stripPseudoElements(selector: string): string {
  let output = '';
  let quote: string | undefined;
  let brackets = 0;
  for (let index = 0; index < selector.length; index += 1) {
    const char = selector[index]!;
    if (char === '\\') {
      output += char + (selector[index + 1] ?? '');
      index += 1;
      continue;
    }
    if (quote) {
      output += char;
      if (char === quote) quote = undefined;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      output += char;
      continue;
    }
    if (char === '[') {
      brackets += 1;
      output += char;
      continue;
    }
    if (char === ']') {
      brackets = Math.max(0, brackets - 1);
      output += char;
      continue;
    }
    if (brackets === 0 && char === ':' && selector[index + 1] === ':') {
      const name = /^[-a-z]+/i.exec(selector.slice(index + 2))?.[0]?.toLowerCase();
      if (name && PSEUDO_ELEMENTS.has(name)) {
        index += name.length + 1;
        continue;
      }
    }
    output += char;
  }
  return output;
}

function closingParenthesis(value: string, open: number): number | undefined {
  let depth = 0;
  let quote: string | undefined;
  for (let index = open; index < value.length; index += 1) {
    const char = value[index]!;
    if (quote) {
      if (char === '\\') index += 1;
      else if (char === quote) quote = undefined;
      continue;
    }
    if (char === '\\') {
      index += 1;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
    } else if (char === '(') {
      depth += 1;
    } else if (char === ')' && --depth === 0) {
      return index;
    }
  }
  return undefined;
}

function splitFontFamilyList(value: string): string[] {
  return splitCssTopLevel(value, ',').map((family) => family.trim()).filter(Boolean).map(stripFontFamilyQuotes);
}

function stripFontFamilyQuotes(value: string): string {
  const trimmed = value.trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return decodeCssEscapes(trimmed.slice(1, -1));
  }
  return trimmed;
}

function normalizeFontFamily(value: string): string {
  return stripFontFamilyQuotes(value).replace(/\s+/g, ' ').trim().toLowerCase();
}

function safeCssSlug(value: string): string {
  const slug = normalizeFontFamily(value).replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
  return slug || 'font';
}

function namespaceFontDeclarations(css: string, families: ReadonlyMap<string, string>): string {
  if (families.size === 0) return css;
  const scanned = scanStylesheet(css);
  const edits: Array<{ start: number; end: number; value: string }> = [];
  const declarations: CssDeclaration[] = [];
  forEachCssRule(scanned.rules, (rule) => {
    if (rule.kind === 'style' || rule.kind === 'blocked') declarations.push(...rule.declarations);
  });
  for (const entry of declarations) {
    const property = entry.property.toLowerCase();
    if (property !== 'font-family' && property !== 'font') continue;
    const valueStart = entry.valueSource.start.offset;
    const valueEnd = entry.valueSource.end.offset;
    const value = css.slice(valueStart, valueEnd);
    const rewritten = rewriteFontValue(value, families);
    if (rewritten !== value) edits.push({ start: valueStart, end: valueEnd, value: rewritten });
  }
  for (const edit of edits.sort((first, second) => second.start - first.start)) {
    css = `${css.slice(0, edit.start)}${edit.value}${css.slice(edit.end)}`;
  }
  return css;
}

function rewriteFontValue(value: string, families: ReadonlyMap<string, string>): string {
  let output = value.replace(/(["'])(.*?)\1/g, (whole, quote: string, family: string) => {
    const owned = families.get(normalizeFontFamily(family));
    return owned ? `${quote}${owned}${quote}` : whole;
  });
  for (const [family, owned] of [...families.entries()].sort((first, second) => second[0].length - first[0].length)) {
    const escaped = family.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    output = output.replace(new RegExp(`(?<![A-Za-z0-9_-])${escaped}(?![A-Za-z0-9_-])`, 'gi'), owned);
  }
  return output;
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function toCoverageStyle(
  entry: Omit<Pick<AuthoredStyleLedgerEntry, 'property' | 'value' | 'outcome' | 'reason' | 'atRules' | 'source' | 'transportSelector' | 'node' | 'responsive' | 'nativeTargets'>, 'outcome'> & { outcome: string },
  scope: AuthoringCoverageStyle['scope'],
): AuthoringCoverageStyle {
  const outcome: AuthoringCoverageStyle['outcome'] = entry.outcome === 'native' || entry.outcome === 'preset'
    || entry.outcome === 'literal' || entry.outcome === 'scoped-css' || entry.outcome === 'blocked'
    ? entry.outcome
    : 'warned';
  return {
    property: entry.property,
    value: entry.value,
    outcome,
    scope,
    ...(entry.reason ? { reason: entry.reason } : {}),
    atRules: [...entry.atRules],
    ...(entry.source ? { source: entry.source } : {}),
    ...(entry.transportSelector ? { transportSelector: entry.transportSelector } : {}),
    ...(entry.node ? { node: entry.node } : {}),
    ...(entry.responsive ? { responsive: entry.responsive } : {}),
    ...(entry.nativeTargets?.length ? { nativeTargets: entry.nativeTargets } : {}),
  };
}

function toCoverageFontWarning(
  warning: FontAssetWarning,
  scope: AuthoringCoverageStyle['scope'],
): AuthoringCoverageStyle {
  return {
    property: '@font-face',
    value: warning.family ?? warning.reference ?? '<unnamed font>',
    outcome: 'warned',
    scope,
    reason: warning.reason,
    atRules: ['@font-face'],
    ...(warning.source ? {
      source: {
        path: warning.source.path,
        offset: warning.source.offset,
        htmlLine: warning.source.line,
        htmlColumn: warning.source.column,
      },
    } : {}),
  };
}

function toCoverageAsset(entry: AssetLedgerEntry, preparedAssets: readonly PreparedCssAsset[]): AuthoringCoverageAsset {
  const rewritten = entry.rewritten;
  const rewrittenName = rewritten?.split(/[?#]/, 1)[0]?.replace(/^\.\/assets\//, '');
  const prepared = rewritten
    ? preparedAssets.find((asset) => path.basename(asset.destination) === rewrittenName)
    : undefined;
  return {
    reference: entry.reference,
    ...(rewritten ? { rewritten } : {}),
    kind: entry.kind,
    outcome: entry.outcome,
    ...(entry.reason ? { reason: entry.reason } : {}),
    ...(prepared ? { sha256: prepared.sha256, destination: `assets/${path.basename(prepared.destination)}` } : {}),
    ...(entry.source ? { source: entry.source } : {}),
  };
}
