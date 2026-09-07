import { createHash } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { JSDOM } from 'jsdom';
import { loadConfig } from '../config/load.js';
import { convert } from '../convert/assemble.js';
import { parseMarkup } from '../headless/wp.js';
import {
  AssetLedgerEntry,
  AuthoredStyleLedgerEntry,
  AuthorConfig,
  AuthorSourceEvidence,
  AuthorOptions,
  BlockRunnerReport,
  ConvertOptions,
  GeneratedBlockPackage,
  ReportItem,
} from '../types.js';
import {
  fallbackUnlicensedFonts,
  classifyCssUrlReference,
  rewriteCssAssets,
  scanCssUrlReferences,
  scanFontFaces,
  type FontAssetWarning,
  type FontLicenseDecision,
  type PreparedCssAsset,
} from './assets.js';
import { writeGeneratedRegisteredBlock } from '../authoring/destination.js';
import {
  compileAnalyzedDesign,
  coverageCssRuleSelectors,
  createAnalyzedDesignCoverage,
  hasNativeCoverageTransport,
  namespaceAuthoringFontReferences,
  UnresolvedNativeStyleMappingError,
  prepareAuthoringFonts,
  validateCoverageFulfillment,
} from './plan.js';
import { validateSourceContent } from './content.js';
import { bindAuthoringProposal, normalizeAuthoringProposal, validateProposalSourceContent } from './proposal.js';
import { compileRegisteredBlock } from '../authoring/generate.js';
import { COMPONENT_FOUNDATION_WARNING, validateAuthoringPlan } from '../authoring/schema.js';
import { authoringRulesFromStylesheet } from '../authoring/styles.js';
import {
  compileTailwindBuildGraph,
  createSelectorDependencyTransport,
  hasTailwindSignal,
  referencedCssClasses,
  scanStylesheet,
  splitCssTopLevel,
  scopeStylesheet,
  validateCssBuildGraph,
  type CssRule,
} from './styles.js';
import { sourceDeclarationKey, type StyleLedgerEntry } from '../styles/apply.js';
import { exactThemePresetTransport, themePresetTokens } from './style-context.js';
import { baseStyleDeclarationIdsRequiringScopedCss } from './cascade.js';

/**
 * Produce the small, static source package for one registered block.
 *
 * This is deliberately an authoring path rather than a variation on `convert`: conversion emits
 * post content, while this function creates a block root which owns its CSS/assets.  It accepts
 * plain CSS directly, or Tailwind only through the caller's pinned compiler. It never guesses
 * utility classes, downloads a remote asset, or manufactures a media ID.
 */
export async function author(input: string, options: AuthorOptions = {}): Promise<BlockRunnerReport> {
  const config = await loadConfig(options);
  const definition = mergeAuthorConfig(config.author, options.author);
  // A supplied target snapshot is evidence, not writable theme configuration. Its preset values
  // do, however, become the only authoritative token values for this authoring pass: a slug is
  // eligible only because the category and literal value came from that snapshot.
  const themeSettings = definition.styles?.context?.theme?.settings;
  const contextTokens = themePresetTokens(themeSettings);
  const authorConfig = themeSettings
    ? {
        ...config,
        // Do not let an unverified local token slug stand in for a missing target preset. Other
        // token settings (resolver/match/context) remain intact, while each preset category comes
        // exclusively from the hash-bound target snapshot.
        tokens: {
          ...config.tokens,
          match: 'exact' as const,
          colors: contextTokens.colors,
          fonts: contextTokens.fonts,
          fontSizes: contextTokens.fontSizes,
          spacing: contextTokens.spacing,
        },
      }
    : config;
  const source = { entry: options.sourcePath ?? '<inline>', sha256: createHash('sha256').update(input, 'utf8').digest('hex'), format: 'html' as const };
  const evidence = collectSourceEvidence(input, source, options.sourcePath);
  if (options.assetRoot !== undefined && (typeof options.assetRoot !== 'string' || !options.assetRoot.trim())) {
    return authorFailure('author.assetRoot must be a non-empty path when supplied', source, evidence);
  }
  const assetRoot = options.assetRoot === undefined ? undefined : path.resolve(options.assetRoot);
  if (options.plan && options.proposal) return authorFailure('author.plan and author.proposal cannot be supplied together', source, evidence);
  let proposal: ReturnType<typeof normalizeAuthoringProposal> | undefined;
  if (options.proposal) {
    try { proposal = normalizeAuthoringProposal(options.proposal); }
    catch (error) { return authorFailure(error instanceof Error ? error.message : String(error), source, evidence); }
  }
  const name = definition.name;
  if (!name || !isBlockName(name)) {
    return authorFailure('author.name must be a registered block name such as "acme/hero"', source, evidence);
  }
  const behaviour = unsupportedBehaviour(input);
  if (behaviour) {
    return authorFailure(behaviour, source, evidence);
  }
  if (!definition.styles?.css && linkedStylesheets(input).length > 0) {
    return authorFailure(
      'external stylesheet input is evidence only until its compiled CSS is supplied in author.styles.css; remote fetching and implicit import graphs are disabled',
      source, evidence,
    );
  }

  const rootSelector = `.wp-block-${name.replace('/', '-')}`;
  const configuredStylesheet = definition.styles?.css;
  let styleInput = configuredStylesheet ?? stylesFromHtml(input);
  const styleMode = definition.styles?.mode;
  if (styleInput.trim() && styleMode !== 'css' && styleMode !== 'tailwind') {
    return authorFailure(
      'author.styles.mode must explicitly be "css" or "tailwind" whenever stylesheet input is supplied',
      source, evidence,
    );
  }
  if (styleMode !== undefined && styleMode !== 'css' && styleMode !== 'tailwind') {
    return authorFailure('author.styles.mode must be "css" or "tailwind"', source, evidence);
  }
  if (styleMode === 'css' && definition.styles?.tailwind) {
    return authorFailure('author.styles.tailwind requires author.styles.mode to be "tailwind"', source, evidence);
  }
  // Vendor signals are advisory. A caller may intentionally provide already-compiled CSS from a
  // Tailwind project; without a request to validate its build graph we retain it as CSS instead
  // of guessing utility semantics or running project configuration.
  const tailwindSignal = hasTailwindSignal(styleInput) || hasTailwindRuntimeSignal(styleInput);
  let buildGraph = validateCssBuildGraph(definition.styles?.tailwind, {
    css: styleInput,
    tailwindDetected: styleMode === 'tailwind',
  });
  let compilerIssues: ReportItem[] = [];

  if (buildGraph.tailwindDetected) {
    // Do not treat a field-complete graph as proof. First materialize and run its own pinned
    // compiler, then either use that result (Tailwind source in the design) or compare it with
    // separately supplied output.
    if (buildGraph.missing.length === 0 && definition.styles?.tailwind) {
      const expectedCss = definition.styles?.css !== undefined || (buildGraph.compiled && styleInput.trim())
        ? styleInput
        : undefined;
      const compiled = await compileTailwindBuildGraph(definition.styles.tailwind, {
        sourcePath: options.sourcePath,
        expectedCss,
      });
      compilerIssues = compiled.issues.map((issue) => ({
        block: name,
        status: 'warning' as const,
        reason: issue.reason,
        details: { outcome: issue.status, field: issue.field },
      }));
      if (compiled.css) {
        // In source mode this is the CSS that is scanned, scoped, and made available to the
        // converter. In output mode the equality check above proves it is the same CSS.
        styleInput = compiled.css;
      }
      buildGraph = validateCssBuildGraph(definition.styles.tailwind, {
        css: styleInput,
        tailwindDetected: true,
        provenanceVerified: compiled.verified,
      });
    }
  }
  const destinationAssetDir = options.outDir
    ? path.join(options.outDir, 'assets')
    : path.join(process.cwd(), '.block-runner-unwritten-assets');
  const preparedAssets = new Map<string, PreparedCssAsset>();
  const prepareAsset = (asset: PreparedCssAsset): void => {
    const existing = preparedAssets.get(asset.destination);
    if (existing && existing.sha256 !== asset.sha256) throw new Error('Prepared asset destination collision');
    preparedAssets.set(asset.destination, asset);
  };
  const fontLicenses = definition.styles?.fontLicenses ?? [];
  const destinationFontFamilies = destinationFontFamilyNames(authorConfig.tokens?.fonts);
  const licensedFamilies = licensedFontFamilies(styleInput, fontLicenses, options.sourcePath);
  const sharedFallback = fallbackUnlicensedFonts(styleInput, {
    sourcePath: options.sourcePath,
    licensedFamilies,
    destinationFamilies: destinationFontFamilies,
    fallbackStack: definition.styles?.fallbackStack,
  });
  styleInput = sharedFallback.css;
  const fontWarnings: Array<{ warning: FontAssetWarning; scope: 'shared' | 'editor' }> = sharedFallback.warnings
    .map((warning) => ({ warning, scope: 'shared' as const }));
  let editorStyleInput = definition.styles?.editorCss;
  if (editorStyleInput !== undefined) {
    const editorFallback = fallbackUnlicensedFonts(editorStyleInput, {
      sourcePath: options.sourcePath,
      licensedFamilies,
      destinationFamilies: destinationFontFamilies,
      fallbackStack: definition.styles?.fallbackStack,
    });
    editorStyleInput = editorFallback.css;
    fontWarnings.push(...editorFallback.warnings.map((warning) => ({ warning, scope: 'editor' as const })));
  }

  // Rewriting is part of source identity: the native probe, declaration suppression, residual
  // stylesheet, and final conversion must all read the same values. Preparation is in-memory and
  // therefore safe before the report has crossed the explicit write boundary.
  const processedSource = await rewriteCssAssets({
    sourceCss: styleInput,
    sourcePath: options.sourcePath,
    // This is extracted from markup only when no separately configured shared stylesheet
    // supersedes it. Markup-owned <style> nodes have the same explicit asset authorization as
    // markup attributes; configured shared/editor CSS retains its established source-directory
    // boundary.
    assetRoot: configuredStylesheet === undefined ? assetRoot : undefined,
    destinationAssetDir,
    assetUrlPrefix: './assets/',
    prepareAsset,
    allowFontLicense: false,
    fontLicenses,
  });
  fontWarnings.push(...processedSource.warnings.map((warning) => ({ warning, scope: 'shared' as const })));
  styleInput = processedSource.css;
  const processedEditor = editorStyleInput === undefined ? undefined : await rewriteCssAssets({
    sourceCss: editorStyleInput,
    sourcePath: options.sourcePath,
    destinationAssetDir,
    assetUrlPrefix: './assets/',
    prepareAsset,
    allowFontLicense: false,
    fontLicenses,
  });
  if (processedEditor) {
    fontWarnings.push(...processedEditor.warnings.map((warning) => ({ warning, scope: 'editor' as const })));
  }
  editorStyleInput = processedEditor?.css;
  let assets: AssetLedgerEntry[] = [
    ...processedSource.assets.map(toAssetLedgerEntry),
    ...(processedEditor?.assets.map(toAssetLedgerEntry) ?? []),
  ];
  let sharedFonts: ReturnType<typeof prepareAuthoringFonts>;
  try {
    // prepareAuthoringFonts reads the effective stylesheet after URL rewriting. Keep the public
    // ledger's original reference for provenance, but give the binder a rewritten-reference view
    // so it can join the CSS URL to the same prepared bytes without losing source identity.
    const fontBindingAssets = assets.map((asset) => asset.kind === 'font' && asset.rewritten
      ? { ...asset, reference: asset.rewritten }
      : asset);
    sharedFonts = prepareAuthoringFonts(styleInput, name, [...preparedAssets.values()], fontBindingAssets, scanStylesheet(styleInput));
  } catch (error) {
    return authorFailure(error instanceof Error ? error.message : String(error), source);
  }
  styleInput = sharedFonts.css;
  if (editorStyleInput !== undefined) {
    // A font face is shared by the editor and frontend. Keeping it in editor.scss would make the
    // generated package depend on editor-only loading order, so require it in the shared CSS.
    if (scanFontFaces(editorStyleInput, options.sourcePath).length > 0) {
      return authorFailure(
        'Editor-only CSS must not declare @font-face; put licensed font faces in the shared stylesheet so style.scss serves both editor and frontend',
        source,
      );
    }
    editorStyleInput = namespaceAuthoringFontReferences(editorStyleInput, sharedFonts.familyNames);
  }

  // This effective CSS version is parsed once and its facts feed safety scoping, native/cascade
  // decisions, and the canonical-plan responsive pass. Residual rules remain a distinct view.
  const stylesheet = scanStylesheet(styleInput);
  const selectorTransport = createSelectorDependencyTransport();
  const safetyScopedStyles = scopeStylesheet(stylesheet, {
    root: rootSelector,
    foundation: definition.styles?.foundation,
    disposition: (declaration) => unsafeResidualDeclaration(declaration.property, declaration.value),
    selectorTransform: selectorTransport.rewrite,
  });
  const safetyLedger = safetyScopedStyles.ledger.map(toAuthoredStyleLedgerEntry(
    options.sourcePath, selectorsByRule(stylesheet.rules), selectorsByRule(safetyScopedStyles.localRules),
  ));
  const hardSafetyStyleFailure = safetyScopedStyles.ledger.some((entry) => entry.outcome === 'blocked' || entry.outcome === 'warned')
    || safetyScopedStyles.ruleRecords.some((record) => record.outcome === 'blocked');
  const fontItems: ReportItem[] = fontWarnings.map(({ warning, scope }) => ({
    block: name,
    status: 'warning',
    reason: `${scope} font: ${warning.reason}`,
    ...(warning.source ? {
      source: {
        path: warning.source.path,
        offset: warning.source.offset,
        htmlLine: warning.source.line,
        htmlColumn: warning.source.column,
      },
    } : {}),
    details: {
      kind: 'font',
      scope,
      family: warning.family,
      reference: warning.reference,
    },
  }));
  const graphItems: ReportItem[] = [
    ...(styleMode === 'css' && tailwindSignal ? [{
      block: name,
      status: 'warning' as const,
      reason: 'Tailwind-like CSS was treated as supplied compiled CSS; no utility semantics or build configuration were inferred',
      details: { outcome: 'advisory', field: 'vendor-detection' },
    }] : []),
    ...(buildGraph.tailwindDetected ? buildGraph.issues : []).map((issue) => ({
      block: name,
      status: 'warning' as const,
      reason: issue.reason,
      details: { outcome: issue.status, field: issue.field },
    })),
    ...compilerIssues,
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

  // Markup assets are source evidence, not a by-product of a successful CSS graph or rules
  // proposal. Gather them before either optional analysis can stop package generation.
  const rewrittenMarkup = await rewriteMarkupAssets(input, {
    sourcePath: options.sourcePath,
    assetRoot,
    destinationAssetDir,
    prepareAsset,
    fontLicenses,
    configuredStylesheet,
    stylesheetAssetsAlreadyAccounted: definition.styles?.css === undefined,
  });
  assets = [...assets, ...rewrittenMarkup.assets];

  // A missing build input is not a recoverable fidelity loss.  Stop before generating a package
  // that looks successful but contains an incomplete Tailwind transport layer.
  if (buildGraph.blocked) {
    return {
      ok: false,
      command: 'author',
      source,
      summary: { blocks: 0, valid: 0, invalid: 0, warnings: graphItems.length + fontItems.length },
      items: [...fontItems, ...graphItems],
      styleLedger: safetyLedger,
      assets: assets.length > 0 ? assets : undefined,
      evidence: { ...evidence, dependencies: [...evidence.dependencies, { kind: 'tailwind-build', reference: 'pinned compiler/build graph' }], coverage: sourceCoverage(safetyLedger, assets, [...preparedAssets.values()], styleInput, editorStyleInput, definition, options, fontWarnings) },
    };
  }
  // Scoping deliberately removes selectors/declarations that cannot retain their source meaning.
  // That is not a successful partial package: stop before any CSS asset copying or package file
  // write can leave output on disk that looks ready to use.
  if (hardSafetyStyleFailure) {
    return {
      ok: false,
      command: 'author',
      source,
      summary: { blocks: 0, valid: 0, invalid: 0, warnings: graphItems.length + fontItems.length },
      items: [...fontItems, ...graphItems],
      styleLedger: safetyLedger,
      assets: assets.length > 0 ? assets : undefined,
      evidence: { ...evidence, coverage: sourceCoverage(safetyLedger, assets, [...preparedAssets.values()], styleInput, editorStyleInput, definition, options, fontWarnings) },
    };
  }
  const cascadeSensitiveDeclarations = nativeCascadeSensitiveDeclarations(input, stylesheet.rules);
  // The converter's native-mapping probe must see the same compiled stylesheet as the CSS
  // scanner, including the final local-asset rewrites. A configured stylesheet otherwise has no
  // `<style>` node for its class rules, and Tailwind source would be incorrectly treated as an
  // empty stylesheet.
  const sourceStyledInput = withAuthorStyles(input, styleInput);
  const nativeSource = await collectNativeSourceDeclarations(sourceStyledInput, authorAnalysisOptions(options), authorConfig);
  const preflightStyleLedger = [...safetyLedger, ...nativeSource.inlineLedger];
  const preflightInlineFailure = nativeSource.inlineLedger.some(
    (entry) => entry.outcome === 'blocked' || entry.outcome === 'warned',
  );
  if (preflightInlineFailure) {
    return {
      ...nativeSource.conversion,
      ok: false,
      command: 'author',
      source,
      summary: {
        ...nativeSource.conversion.summary,
        warnings: nativeSource.conversion.summary.warnings + graphItems.length + fontItems.length,
      },
      items: [...nativeSource.conversion.items, ...fontItems, ...graphItems],
      styleLedger: preflightStyleLedger,
      assets: assets.length > 0 ? assets : undefined,
      evidence: { ...evidence, coverage: sourceCoverage(preflightStyleLedger, assets, [...preparedAssets.values()], styleInput, editorStyleInput, definition, options, fontWarnings) },
    };
  }
  const scopedStyles = scopeStylesheet(stylesheet, {
    root: rootSelector,
    foundation: definition.styles?.foundation,
    selectorTransform: selectorTransport.rewrite,
    disposition: (declaration, rule) =>
      unsafeResidualDeclaration(declaration.property, declaration.value)
      // Native block attributes cannot encode priority. Retain !important source CSS exactly;
      // silently strengthening or weakening its cascade would be a fidelity regression.
      ?? (!proposal && !declaration.important && !cascadeSensitiveDeclarations.has(sourceDeclarationKey(rule.selector, declaration.property, declaration.value, rule.id)) && nativeSource.declarations.has(sourceDeclarationKey(rule.selector, declaration.property, declaration.value, rule.id))
        ? {
            outcome: 'native' as const,
            reason: 'mapped through the destination block support; omitted from residual CSS',
          }
        : undefined),
  });
  // Retain source selectors even when native promotion emptied their residual CSS rule; coverage
  // provenance must identify the original element, not fall back to any matching output node.
  const stylesheetLedger = scopedStyles.ledger.map(toAuthoredStyleLedgerEntry(
    options.sourcePath, selectorsByRule(stylesheet.rules), selectorsByRule(scopedStyles.localRules),
  ));
  const hardStyleFailure = scopedStyles.ledger.some((entry) => entry.outcome === 'blocked' || entry.outcome === 'warned')
    || scopedStyles.ruleRecords.some((record) => record.outcome === 'blocked');

  const inlineStyleLedger: AuthoredStyleLedgerEntry[] = [];
  const conversion = await convert(withAuthorStyles(rewrittenMarkup.input, styleInput), {
    ...authorAnalysisOptions(options),
    // The author package carries residual authored selectors/properties in style.scss; the
    // legacy open sidecar would duplicate it as a global post stylesheet.
    styling: 'relaxed',
    config: authorConfig,
    // Keep source classes referenced by any authored rule, including rules promoted to native
    // supports. They bind coverage evidence to the actual emitted node; retaining a class alone
    // carries no stylesheet/global behaviour.
    preserveSourceClasses: [...new Set([
      ...referencedCssClasses(scopedStyles.css),
      // Native-only simple class rules need provenance too. Do not reparse arbitrary escaped or
      // compound selector syntax here: selectorTransport remains its single authority.
      ...referencedCssClasses(styleInput).filter((name) => /^[_a-zA-Z][-_a-zA-Z0-9]*$/.test(name)),
    ])],
    preserveSourceSelectorDependencies: selectorTransport.dependencies,
    suppressSourceDeclarations: [...nativeSource.suppressedDeclarations, ...cascadeSensitiveDeclarations],
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
  let proposalBound: ReturnType<typeof bindAuthoringProposal> | undefined;
  if (proposal && !hardAssetFailure && !hardStyleFailure && !hardInlineStyleFailure) {
    try {
      proposalBound = bindAuthoringProposal({
        proposal, sourceHtml: input, sourceHash: source.sha256, sourcePath: options.sourcePath,
        base: { structure: [], fields: [], assets: [], files: [], warnings: [] } as unknown as import('../authoring/schema.js').AuthoringPlan,
        retainedCssClasses: referencedCssClasses(styleInput),
        selectorDependencies: selectorTransport.dependencies,
      });
    } catch (error) {
      return authorFailure(error instanceof Error ? error.message : String(error), source, evidence);
    }
  }
  let compiled: ReturnType<typeof compileAnalyzedDesign> | undefined;
  const generationItems: ReportItem[] = [];
  if (!hardAssetFailure && !hardStyleFailure && !hardInlineStyleFailure && options.plan) {
    try {
      const supplied = validateAuthoringPlan(options.plan);
      // Both sides must take the schema's optional-field normalization path. In particular,
      // source locations legitimately omit path/line data for inline input.
      const expectedCoverageInput = sourceCoverage(
        styleLedger, assets, [...preparedAssets.values()], styleInput, editorStyleInput, definition, options, fontWarnings,
      );
      // The scan observes source literals; the canonical plan proves whether an exact target
      // preset carries that same declaration. Reapply that deterministic ownership classification
      // before equality, rather than accepting a caller's altered ledger.
      classifyConfirmedPresetCoverage(expectedCoverageInput, supplied, definition.styles?.context?.theme?.settings);
      classifyConfirmedResponsiveCoverage(expectedCoverageInput, supplied);
      classifyConfirmedStructuredCssCoverage(expectedCoverageInput, supplied);
      reconcileVerifiedNativeTargets(expectedCoverageInput, supplied.coverage);
      const expectedCoverage = validateAuthoringPlan({ ...supplied, coverage: expectedCoverageInput }).coverage!;
      if (supplied.source?.entry !== source.entry || supplied.source.sha256 !== source.sha256 || supplied.source.format !== 'html') {
        throw new Error('Supplied authoring plan is not bound to this exact HTML source hash.');
      }
      if (supplied.target.name !== name) {
        throw new Error(`Supplied authoring plan target ${supplied.target.name} does not match requested block ${name}.`);
      }
      if (!supplied.coverage || stableJson(supplied.coverage) !== stableJson(expectedCoverage)) {
        throw new Error('Supplied authoring plan does not retain the complete source declaration and asset coverage.');
      }
      validateCoverageFulfillment(supplied, input, assetRoot);
      compiled = {
        plan: supplied,
        generated: compileRegisteredBlock(supplied),
        editorStyleLedger: [],
      } as ReturnType<typeof compileAnalyzedDesign>;
    } catch (error) {
      generationItems.push(authoringFailureItem(name, error));
      compiled = undefined;
    }
  } else if (!hardAssetFailure && !hardStyleFailure && !hardInlineStyleFailure && (conversion.ok || proposal)) {
    try {
      compiled = compileAnalyzedDesign({
        definition,
        name,
        source: input,
        sourcePath: options.sourcePath,
        blocks,
        ...(proposalBound ? {
          structureOverride: proposalBound.structure,
          sourceDecisions: proposalBound.sourceDecisions,
          sourceRefToNode: proposalBound.sourceRefToNode,
          cascadeSensitiveDeclarations,
          proposalChoices: {
            fields: proposalBound.fields,
            locking: proposalBound.locking,
            ...(proposalBound.allowedBlocks === undefined ? {} : { allowedBlocks: proposalBound.allowedBlocks }),
            pattern: proposalBound.pattern,
          },
        } : {}),
        rules: scopedStyles.localRules,
        preparedAssets: [...preparedAssets.values()],
        assets,
        styleLedger,
        stylesheet: styleInput,
        stylesheetFacts: stylesheet,
        editorStylesheet: editorStyleInput,
        fonts: sharedFonts.fonts,
        fontWarnings,
        fontLicenses,
      });
      if (proposal && compiled) {
        const plan = validateAuthoringPlan(compiled.plan);
        validateCoverageFulfillment(plan, input, assetRoot);
        validateProposalSourceContent(input, proposalBound!, plan);
        compiled = { ...compiled, plan, generated: compileRegisteredBlock(plan) };
      }
    } catch (error) {
      generationItems.push(authoringFailureItem(name, error));
      // Compilation may have produced a tentative package before canonical coverage/content
      // fulfillment runs. Never return that tentative package after a fail-closed validation.
      compiled = undefined;
    }
  }
  if (compiled && !proposal && !options.plan) {
    try {
      validateSourceContent(input, compiled.generated.template);
    } catch (error) {
      generationItems.push({ block: name, status: 'warning', reason: error instanceof Error ? error.message : String(error) });
      compiled = undefined;
    }
  }
  const packageSource: GeneratedBlockPackage | undefined = compiled ? {
    name, rootSelector, canonicalPlan: compiled.plan, manifest: compiled.generated.manifest,
    files: Object.fromEntries(compiled.generated.files.map((file) => [file.path, file.content])),
    assets: [...preparedAssets.values()].map(({ source, destination, sha256 }) => ({
      source, path: `assets/${path.basename(destination)}`, sha256,
    })),
  } : undefined;

  // Do not leave a seemingly usable package on disk when a local asset/font could not be carried
  // legally or safely. Failed analysis retains its ledgers, not executable source.
  if (options.outDir && compiled) {
    await writeGeneratedRegisteredBlock(options.outDir, compiled.generated);
    assets = assets.map((asset) => asset.outcome === 'prepared'
      ? { ...asset, outcome: 'copied', reason: 'prepared asset published with the validated source package' }
      : asset);
  }

  return {
      ...conversion,
      ok: Boolean(compiled),
    command: 'author',
    source,
    summary: {
      ...conversion.summary,
      warnings: conversion.summary.warnings + fontItems.length + graphItems.length + assetItems.length + generationItems.length,
    },
    items: [...conversion.items, ...fontItems, ...graphItems, ...assetItems, ...generationItems],
    assets: assets.length > 0 ? assets : undefined,
    styleLedger: compiled ? [...styleLedger, ...compiled.editorStyleLedger] : styleLedger,
    package: packageSource,
    evidence: {
      ...evidence,
      coverage: sourceCoverage(styleLedger, assets, [...preparedAssets.values()], styleInput, editorStyleInput, definition, options, fontWarnings),
      transport: {
        styles: {
          strategy: scopedStyles.localRules.length ? 'mixed' : 'native',
          outcomes: [],
          ...(definition.styles?.foundation ? { foundation: definition.styles.foundation } : {}),
          // The transport view preserves every safely scoped source declaration, including the
          // ones automatic compilation promotes to native attributes. A plan author can therefore
          // choose CSS ownership without reconstructing source CSS; compilation still uses only
          // `scopedStyles` and never emits duplicate native declarations by itself.
          rules: authoringRulesFromStylesheet(safetyScopedStyles.localRules),
          editorRules: authoringRulesFromStylesheet(scopeStylesheet(scanStylesheet(editorStyleInput ?? ''), {
            root: rootSelector, foundation: definition.styles?.foundation,
          }).localRules),
          ...(sharedFonts.fonts.length ? { fonts: [...sharedFonts.fonts] } : {}),
        },
        assets: [...preparedAssets.values()].map((asset, index) => {
          const license = fontLicenses.find((item) => path.resolve(item.source) === path.resolve(asset.source) && item.sha256 === asset.sha256);
          return {
            id: `asset.${index}`, source: asset.source, kind: asset.kind === 'font' ? 'font' : 'image',
            destination: `assets/${path.basename(asset.destination)}`, status: 'ready', sha256: asset.sha256,
            ...(license ? { fontLicense: { ownership: license.ownership, license: license.license, ...(license.notice === undefined ? {} : { notice: license.notice }) } } : {}),
          };
        }),
        warnings: [
          ...(definition.styles?.foundation === 'component' ? [COMPONENT_FOUNDATION_WARNING] : []),
          ...fontWarnings.map(({ warning }) => warning.reason),
        ],
      },
    },
  };
}

/**
 * The two conversion passes in HTML authoring are capability probes, not a delivery step.  They
 * must retain the source URL and report unresolved media, but may never search, sideload, or
 * import it through the destination configured by a caller.  `resolver` has precedence over the
 * merged config, so this also protects callers that supplied the resolver as an option.
 */
function authorAnalysisOptions(options: AuthorOptions): ConvertOptions {
  return { ...options, resolver: 'noop' };
}

function mergeAuthorConfig(configured: AuthorConfig | undefined, explicit: AuthorConfig | undefined): AuthorConfig {
  return {
    ...configured,
    ...explicit,
    styles: { ...configured?.styles, ...explicit?.styles },
  };
}

/** Keep an unconditional native support out of the inline cascade when source CSS has a competing
 * conditional/pseudo/other-selector declaration that WordPress's state !important would distort. */
function nativeCascadeSensitiveDeclarations(source: string, rules: readonly CssRule[]): Set<string> {
  const dom = new JSDOM(source);
  const ids = baseStyleDeclarationIdsRequiringScopedCss({ document: dom.window.document, rules });
  dom.window.close();
  const entries: Array<{ selector: string; property: string; value: string; id: string; ruleId: string; conditional: boolean }> = [];
  const visit = (items: readonly CssRule[], conditional = false): void => {
    for (const rule of items) {
      if (rule.kind === 'conditional') visit(rule.rules, true);
      else if (rule.kind === 'style') for (const declaration of rule.declarations) {
        entries.push({ selector: rule.selector, property: declaration.property, value: declaration.value, id: declaration.id, ruleId: rule.id, conditional });
      }
    }
  };
  visit(rules);
  return new Set(entries.filter((entry) => ids.has(entry.id)).map((entry) => sourceDeclarationKey(entry.selector, entry.property, entry.value, entry.ruleId)));
}

/**
 * Prove a stylesheet declaration has exactly one native destination before omitting it from
 * residual CSS. The existing converter is the capability oracle: it only reports `mapped` when the
 * concrete emitted Core block declares the relevant support in the pinned/target registry.
 */
interface NativeSourceCollection {
  declarations: Set<string>;
  /** Observed stylesheet declarations that must stay in parity CSS for at least one match. */
  suppressedDeclarations: Set<string>;
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
        const key = sourceDeclarationKey(entry.origin, entry.property, entry.value, entry.originId);
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
    suppressedDeclarations: new Set(
      [...outcomes].filter(([, state]) => !state.native || state.other).map(([key]) => key),
    ),
    inlineLedger,
    conversion,
  };
}

function authorFailure(
  reason: string,
  source?: BlockRunnerReport['source'],
  evidence?: AuthorSourceEvidence,
): BlockRunnerReport {
  return {
    ok: false,
    command: 'author',
    ...(source ? { source } : {}),
    ...(evidence ? { evidence } : {}),
    summary: { blocks: 0, valid: 0, invalid: 0, warnings: 1 },
    items: [{ block: 'input', status: 'warning', reason }],
  };
}

/**
 * Read source facts without applying the rules engine. Locations refer to the original HTML and
 * unknown elements are intentionally recorded rather than classified as invalid markup.
 */
export function collectSourceEvidence(
  input: string,
  source: NonNullable<BlockRunnerReport['source']> = {
    entry: '<inline>', sha256: createHash('sha256').update(input, 'utf8').digest('hex'), format: 'html',
  },
  sourcePath?: string,
): AuthorSourceEvidence {
  const dom = new JSDOM(input, { contentType: 'text/html', includeNodeLocations: true });
  const structure = [...dom.window.document.querySelectorAll('*')].map((element) => {
    const location = dom.nodeLocation(element);
    return {
      tag: element.tagName.toLowerCase(),
      attributes: Object.fromEntries([...element.attributes].map((attribute) => [attribute.name, attribute.value])),
      source: {
        path: sourcePath,
        htmlLine: location?.startLine,
        htmlColumn: location?.startCol,
        offset: location?.startOffset,
      },
      ...(location?.startOffset !== undefined && location.endOffset !== undefined
        ? { sourceRef: `${source.sha256}:${location.startOffset}-${location.endOffset}` }
        : {}),
    };
  });
  const dependencies = [...dom.window.document.querySelectorAll('link[rel~="stylesheet"]')].map((element) => ({
    kind: 'stylesheet' as const,
    reference: element.getAttribute('href') ?? '<missing href>',
    source: sourceLocation(dom, element, sourcePath),
  }));
  const diagnostics: ReportItem[] = [];
  for (const element of [...dom.window.document.querySelectorAll('script')]) {
    diagnostics.push({ block: 'input', status: 'warning', reason: 'script behaviour is not authorized in a generated static block', source: sourceLocation(dom, element, sourcePath) });
  }
  for (const element of [...dom.window.document.querySelectorAll('*')]) {
    for (const attribute of [...element.attributes]) {
      if (/^on[a-z][\w-]*$/i.test(attribute.name)) {
        diagnostics.push({ block: 'input', status: 'warning', reason: 'event-handler behaviour is not authorized in a generated static block', source: sourceLocation(dom, element, sourcePath) });
      }
    }
  }
  return { source, structure, dependencies, diagnostics };
}

function sourceLocation(dom: JSDOM, node: Node, sourcePath?: string) {
  const location = dom.nodeLocation(node);
  return { path: sourcePath, htmlLine: location?.startLine, htmlColumn: location?.startCol, offset: location?.startOffset };
}

function sourceCoverage(
  styleLedger: readonly AuthoredStyleLedgerEntry[],
  assets: readonly AssetLedgerEntry[],
  preparedAssets: readonly PreparedCssAsset[],
  stylesheet: string | undefined,
  editorStylesheet: string | undefined,
  definition: AuthorConfig,
  options: AuthorOptions,
  fontWarnings: ReadonlyArray<{ warning: FontAssetWarning; scope: 'shared' | 'editor' }>,
) {
  const editor = scopeStylesheet(scanStylesheet(editorStylesheet ?? ''), {
    root: `.wp-block-${definition.name?.replace('/', '-') ?? 'unknown'}`,
    foundation: definition.styles?.foundation,
  });
  const editorStyleLedger = editor.ledger.map(toAuthoredStyleLedgerEntry(options.sourcePath, selectorsByRule(editor.localRules)));
  return createAnalyzedDesignCoverage({
    definition,
    source: '',
    sourcePath: options.sourcePath,
    styleLedger,
    assets,
    preparedAssets,
    stylesheet,
    editorStylesheet,
    editorStyleLedger,
    fontWarnings,
  });
}

function classifyConfirmedPresetCoverage(
  coverage: NonNullable<AuthorSourceEvidence['coverage']>,
  plan: import('../authoring/schema.js').AuthoringPlan,
  settings: unknown,
): void {
  const nodes = (items: readonly import('../authoring/schema.js').AuthoringStructureNode[]): import('../authoring/schema.js').AuthoringStructureNode[] =>
    items.flatMap((item) => [item, ...nodes(item.children ?? [])]);
  const structure = nodes(plan.structure);
  for (const entry of coverage.styles) {
    if (entry.outcome !== 'native' || entry.atRules.length) continue;
    const transport = exactThemePresetTransport(settings, entry.property, entry.value);
    if (!transport) continue;
    const { preset } = transport;
    const classMatch = entry.source?.selector && /^\.([_a-zA-Z][-_a-zA-Z0-9]*)$/.exec(entry.source.selector);
    const node = structure.find((candidate) => candidate.id && ('attribute' in transport
      ? candidate.attributes?.[transport.attribute] === preset.slug : JSON.stringify(candidate.attributes?.style).includes(transport.value))
      && (!classMatch || (typeof candidate.attributes?.className === 'string' && candidate.attributes.className.split(/\s+/).includes(classMatch[1]!))));
    if (preset && node?.id) {
      entry.outcome = 'preset';
      entry.reason = `exact target theme ${preset.category} preset "${preset.slug}"`;
      entry.node = node.id;
      entry.preset = { category: preset.category, slug: preset.slug };
    }
  }
}

/** Reconcile only source-identical conditional entries to a plan's already-validated WP state. */
function classifyConfirmedResponsiveCoverage(
  coverage: NonNullable<AuthorSourceEvidence['coverage']>,
  plan: import('../authoring/schema.js').AuthoringPlan,
): void {
  for (const entry of coverage.styles) {
    if (entry.outcome !== 'scoped-css' || entry.atRules.length === 0) continue;
    const confirmed = plan.coverage?.styles.find((candidate) => candidate.outcome === 'native' && candidate.responsive
      && candidate.property === entry.property && candidate.value === entry.value && candidate.scope === entry.scope
      && stableJson(candidate.atRules) === stableJson(entry.atRules) && candidate.source?.selector === entry.source?.selector);
    if (!confirmed) continue;
    entry.outcome = 'native';
    entry.reason = confirmed.reason;
    entry.node = confirmed.node;
    entry.responsive = confirmed.responsive;
  }
}

/**
 * Static capability analysis may recognize a declaration as WordPress-native even though the
 * reviewed plan deliberately retains its exact CSS rule and carries no native block attribute.
 * Reclassify only that fully evidenced case. This preserves the source ledger while requiring the
 * plan's structured rule and final structure to agree before coverage equality can succeed.
 */
function classifyConfirmedStructuredCssCoverage(
  coverage: NonNullable<AuthorSourceEvidence['coverage']>,
  plan: import('../authoring/schema.js').AuthoringPlan,
): void {
  for (const entry of coverage.styles) {
    if (entry.outcome !== 'native' || hasNativeCoverageTransport(plan, entry)) continue;
    const rules = entry.scope === 'editor' ? plan.styles.editorRules ?? [] : plan.styles.rules ?? [];
    const selector = entry.transportSelector ?? entry.source?.selector;
    if (coverageCssRuleSelectors(rules, entry.property, entry.value, entry.atRules, selector).length === 0) continue;
    entry.outcome = 'scoped-css';
    delete entry.reason;
    delete entry.node;
    delete entry.responsive;
    delete entry.preset;
  }
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function isBlockName(value: string): boolean {
  return /^[a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9-]*$/.test(value);
}

function stylesFromHtml(input: string): string {
  // The style compiler does its own CSS parsing.  This small extractor only joins the actual style
  // graph supplied with an HTML design; it does not infer CSS from Tailwind class names.
  return [...input.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style\s*>/gi)].map((match) => match[1]).join('\n');
}

function hasTailwindRuntimeSignal(css: string): boolean {
  return /--tw-[\w-]+\s*:|var\(\s*--tw-[\w-]+/i.test(css);
}

/**
 * Conversion reads class rules from `<style>` nodes before it sanitizes the design. Keep exactly
 * one node containing the stylesheet that authoring actually vetted, rather than allowing stale
 * source directives or an independently supplied stylesheet to influence native mapping.
 */
function withAuthorStyles(input: string, css: string): string {
  const dom = new JSDOM(input, { contentType: 'text/html' });
  const document = dom.window.document;
  for (const style of [...document.querySelectorAll('style')]) {
    style.remove();
  }
  if (css.trim()) {
    const style = document.createElement('style');
    style.textContent = css;
    (document.head ?? document.documentElement).append(style);
  }
  return dom.serialize();
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
  /** Markup may reference a sibling asset directory beneath the authored source root. */
  assetRoot?: string;
  destinationAssetDir: string;
  prepareAsset: (asset: PreparedCssAsset) => void;
  fontLicenses: readonly FontLicenseDecision[];
  /** Exact compiled CSS supplied through author.styles.css, when present. */
  configuredStylesheet?: string;
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
  const assetRoot = options.assetRoot;

  const processReference = async (
    reference: string,
    kind: AssetLedgerEntry['kind'],
  ): Promise<string | undefined> => {
    // Legacy SVG font-face-uri references do not necessarily carry a modern font extension. Put
    // those through a synthetic @font-face so the shared classifier preserves its font-license
    // rules rather than mistaking one for a generic image asset.
    const processed = await rewriteCssAssets({
      sourceCss: kind === 'font'
        ? `@font-face{src:url(${JSON.stringify(reference)})}`
        : `x{background-image:url(${JSON.stringify(reference)})}`,
      sourcePath: options.sourcePath,
      assetRoot,
      destinationAssetDir: options.destinationAssetDir,
      assetUrlPrefix: './assets/',
      prepareAsset: options.prepareAsset,
      allowFontLicense: false,
      fontLicenses: options.fontLicenses,
    });
    const entry = processed.assets[0];
    if (!entry) {
      assets.push({ reference, kind, outcome: 'unresolved', reason: 'asset reference could not be classified' });
      return undefined;
    }
    const record = toAssetLedgerEntry(entry);
    record.kind = kind;
    assets.push(record);
    return entry.outcome === 'prepared' || entry.outcome === 'copied' ? entry.rewrittenUrl : undefined;
  };

  const processCssValue = async (
    value: string,
    kind: AssetLedgerEntry['kind'],
  ): Promise<string> => {
    // The CSS asset lexer deliberately works on source fragments too. That lets SVG presentation
    // attributes such as `fill="url(texture.svg#paint)"` retain their full value while every
    // concrete URL gets the same copy/classification/ledger treatment as a stylesheet value.
    const processed = await rewriteCssAssets({
      sourceCss: value,
      sourcePath: options.sourcePath,
      assetRoot,
      destinationAssetDir: options.destinationAssetDir,
      assetUrlPrefix: './assets/',
      prepareAsset: options.prepareAsset,
      allowFontLicense: false,
      fontLicenses: options.fontLicenses,
    });
    for (const asset of processed.assets) {
      const record = toAssetLedgerEntry(asset);
      record.kind = kind;
      assets.push(record);
    }
    return processed.css;
  };

  for (const element of [...document.querySelectorAll('*')]) {
    if (element.tagName.toLowerCase() === 'style') {
      // Keep the rewritten stylesheet in the conversion DOM as well: a declaration that maps to
      // native media reads this URL before residual CSS is emitted. Its ledger was already built
      // from styleInput unless explicit configured CSS superseded the document styles.
      const sourceCss = element.textContent ?? '';
      const processed = await rewriteCssAssets({
        sourceCss,
        sourcePath: options.sourcePath,
        assetRoot,
        destinationAssetDir: options.destinationAssetDir,
        assetUrlPrefix: './assets/',
        prepareAsset: options.prepareAsset,
        allowFontLicense: false,
        fontLicenses: options.fontLicenses,
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
        sourcePath: options.sourcePath,
        assetRoot,
        destinationAssetDir: options.destinationAssetDir,
        assetUrlPrefix: './assets/',
        prepareAsset: options.prepareAsset,
        allowFontLicense: false,
        fontLicenses: options.fontLicenses,
      });
      assets.push(...processed.assets.map(toAssetLedgerEntry));
      if (processed.css !== style) {
        element.setAttribute('style', processed.css);
      }
    }

    const assetAttributes = assetAttributesFor(element);
    if (element.namespaceURI === 'http://www.w3.org/2000/svg') {
      const knownAssetAttributes = new Set(assetAttributes.map(({ name }) => name.toLowerCase()));
      for (const attribute of [...element.attributes]) {
        const name = attribute.name.toLowerCase();
        // SVG links are not all assets: `<a>` remains a normal navigational link. Every other
        // element must be in the semantic table below before its href can pass through. This is
        // deliberately fail-closed because an unknown link could otherwise leave a source-relative
        // dependency in the generated package with no ledger outcome.
        if (isSvgHrefAttribute(name) && element.localName.toLowerCase() !== 'a' && !knownAssetAttributes.has(name)) {
          assets.push({
            reference: attribute.value,
            kind: 'other',
            outcome: 'blocked',
            reason: `SVG <${element.localName}> ${attribute.name} is not a recognized asset/reference attribute`,
          });
        }
      }
    }

    for (const { name: attribute, kind } of assetAttributes) {
      const value = element.getAttribute(attribute);
      if (value === null) continue;
      // A linked stylesheet remains source evidence in collectSourceEvidence. When the caller
      // supplied its exact local compiled bytes through author.styles.css, it is already the
      // stylesheet the package will scope and emit; copying that CSS as an image-like package
      // asset would both duplicate the source of truth and violate the static asset contract.
      // Do not generalize this to every stylesheet link: unmatched, remote, escaped, unreadable,
      // or symlinked links keep their existing explicit asset outcome.
      if (kind === 'stylesheet' && await matchesConfiguredStylesheet(value, options)) continue;
      const rewritten = await processReference(value, kind);
      if (rewritten) {
        element.setAttribute(attribute, rewritten);
      }
    }

    if (element.namespaceURI === 'http://www.w3.org/2000/svg') {
      for (const attribute of [...element.attributes]) {
        const name = attribute.name.toLowerCase();
        // `style` above and concrete href forms above each have their own handling. Any other
        // SVG presentation value can legally contain `url()`, including fill, filter, clip-path,
        // mask, marker, and cursor; account for the URL rather than maintaining a lossy list.
        if (name === 'style' || name === 'href' || name === 'xlink:href' || !/\burl\s*\(/i.test(attribute.value)) {
          continue;
        }
        const rewritten = await processCssValue(attribute.value, 'image');
        if (rewritten !== attribute.value) {
          element.setAttribute(attribute.name, rewritten);
        }
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

/**
 * A configured stylesheet can replace a linked source sheet only when it proves it is that exact
 * local file. The link itself stays in source evidence, while all other links continue through the
 * regular asset ledger rather than disappearing from the authoring contract.
 */
async function matchesConfiguredStylesheet(reference: string, options: RewriteMarkupAssetsOptions): Promise<boolean> {
  if (options.configuredStylesheet === undefined || !options.sourcePath) return false;
  if (/^(?:[a-z][a-z0-9+.-]*:|\/\/|\/)/i.test(reference)) return false;
  const pathname = reference.split(/[?#]/, 1)[0];
  if (!pathname) return false;
  const sourceDirectory = path.dirname(path.resolve(options.sourcePath));
  const candidate = path.resolve(sourceDirectory, pathname);
  const relative = path.relative(sourceDirectory, candidate);
  if (!relative || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return false;
  try {
    if (await hasSymlinkedAncestor(sourceDirectory, candidate)) return false;
    const [info, realRoot, realCandidate] = await Promise.all([
      lstat(candidate), realpath(sourceDirectory), realpath(candidate),
    ]);
    if (!info.isFile() || info.isSymbolicLink() || !isWithinPath(realRoot, realCandidate)) return false;
    return await readFile(candidate, 'utf8') === options.configuredStylesheet;
  } catch {
    return false;
  }
}

/** Check descendants only: the source directory itself may be a platform-owned /tmp alias. */
async function hasSymlinkedAncestor(root: string, target: string): Promise<boolean> {
  const relative = path.relative(root, target);
  if (!relative || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return true;
  let current = root;
  for (const segment of relative.split(path.sep)) {
    current = path.join(current, segment);
    if ((await lstat(current)).isSymbolicLink()) return true;
  }
  return false;
}

function isWithinPath(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}

interface AssetAttribute {
  name: string;
  kind: AssetLedgerEntry['kind'];
}

const SVG_HREF_ASSET_KINDS: Readonly<Record<string, AssetLedgerEntry['kind']>> = {
  // External image resources.
  image: 'image',
  feimage: 'image',
  // SVG 2 reference attributes. These can point at an external SVG document as well as an
  // element in this document, so they must receive the same classification/copy treatment as an
  // ordinary asset reference instead of being inferred from a class or left source-relative.
  animate: 'other',
  animatecolor: 'other',
  animatemotion: 'other',
  animatetransform: 'other',
  discard: 'other',
  lineargradient: 'other',
  mpath: 'other',
  pattern: 'other',
  radialgradient: 'other',
  set: 'other',
  textpath: 'other',
  use: 'other',
  // SVG 1.1/XLink forms remain in authored assets. Keep their kinds explicit rather than
  // silently downgrading a legacy cursor/font/reference into an untracked string attribute.
  altglyph: 'other',
  'color-profile': 'other',
  cursor: 'image',
  'definition-src': 'font',
  filter: 'other',
  'font-face-uri': 'font',
  tref: 'other',
  glyphref: 'other',
};

function isSvgHrefAttribute(name: string): boolean {
  return name === 'href' || name === 'xlink:href';
}

/**
 * Asset-bearing attributes are not interchangeable: HTML anchors use `href` for navigation while
 * SVG `<image href>` is a concrete image dependency. Keep the table element/namespace-aware so
 * every actual asset form reaches the same copy/classify ledger without turning ordinary links
 * into package assets.
 */
function assetAttributesFor(element: Element): AssetAttribute[] {
  const tag = element.localName.toLowerCase();
  if (element.namespaceURI === 'http://www.w3.org/2000/svg') {
    const kind = SVG_HREF_ASSET_KINDS[tag];
    return kind ? [{ name: 'href', kind }, { name: 'xlink:href', kind }] : [];
  }

  switch (tag) {
    case 'img':
      return [{ name: 'src', kind: 'image' }];
    case 'video':
      return [{ name: 'src', kind: 'media' }, { name: 'poster', kind: 'image' }];
    case 'audio':
    case 'track':
    case 'embed':
      return [{ name: 'src', kind: 'media' }];
    case 'source':
      // A source nested in picture is an image; audio/video source remains media.
      return [{ name: 'src', kind: element.parentElement?.localName.toLowerCase() === 'picture' ? 'image' : 'media' }];
    case 'object':
      return [{ name: 'data', kind: 'other' }];
    case 'iframe':
      return [{ name: 'src', kind: 'other' }];
    case 'input':
      return [{ name: 'src', kind: 'image' }];
    case 'link': {
      const rel = (element.getAttribute('rel') ?? '').toLowerCase().split(/\s+/);
      if (rel.includes('icon') || rel.includes('apple-touch-icon') || rel.includes('mask-icon')) {
        return [{ name: 'href', kind: 'image' }];
      }
      if (rel.includes('stylesheet')) return [{ name: 'href', kind: 'stylesheet' }];
      if (rel.includes('manifest') || rel.includes('modulepreload')) return [{ name: 'href', kind: 'other' }];
      if (rel.includes('preload')) {
        const as = (element.getAttribute('as') ?? '').toLowerCase();
        if (as === 'font') return [{ name: 'href', kind: 'font' }];
        if (as === 'image') return [{ name: 'href', kind: 'image' }];
        if (as === 'video' || as === 'audio') return [{ name: 'href', kind: 'media' }];
        if (as === 'style') return [{ name: 'href', kind: 'stylesheet' }];
        return [{ name: 'href', kind: 'other' }];
      }
      if (rel.includes('prefetch')) return [{ name: 'href', kind: 'other' }];
      return [];
    }
    default:
      return [];
  }
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

/**
 * Return only the family names for faces whose every source URL has a complete, local decision.
 * The low-level asset pass still verifies bytes and the WOFF container; this preflight merely
 * decides which faces may survive the fallback pass. In particular, a token family does not make
 * a source-owned @font-face redistributable by itself.
 */
function licensedFontFamilies(
  stylesheet: string,
  decisions: readonly FontLicenseDecision[],
  sourcePath?: string,
): string[] {
  if (!decisions.length || !sourcePath || sourcePath === '-' || /^<.*>$/.test(sourcePath)) return [];
  const sourceDirectory = path.dirname(path.resolve(sourcePath));
  const familyStatus = new Map<string, { name: string; complete: boolean }>();
  for (const face of scanFontFaces(stylesheet, sourcePath)) {
    const complete = face.families.length > 0 && face.sourceUrls.length > 0 && face.sourceUrls.every((reference) => {
      const decision = decisions.find((candidate) => candidate.reference === reference);
      if (!decision || !path.isAbsolute(decision.source)
        || !/^[a-f0-9]{64}$/.test(decision.sha256)
        || typeof decision.ownership !== 'string' || !decision.ownership.trim()
        || typeof decision.license !== 'string' || !decision.license.trim()) return false;
      const value = reference.trim();
      if (!value || value.startsWith('#') || /^data:/i.test(value) || /^https?:\/\//i.test(value)
        || value.startsWith('//') || /^blob:/i.test(value) || /^[A-Za-z][A-Za-z0-9+.-]*:/.test(value)
        || value.startsWith('/') || value.startsWith('\\') || /^[A-Za-z]:[\\/]/.test(value)) return false;
      const pathname = value.split(/[?#]/, 1)[0]!;
      const extension = path.extname(pathname).toLowerCase();
      if (extension !== '.woff' && extension !== '.woff2') return false;
      return path.resolve(sourceDirectory, pathname) === path.resolve(decision.source);
    });
    for (const family of face.families) {
      const key = family.replace(/\s+/g, ' ').trim().toLowerCase();
      const previous = familyStatus.get(key);
      familyStatus.set(key, { name: previous?.name ?? family, complete: (previous?.complete ?? true) && complete });
    }
  }
  return [...familyStatus.values()].filter(({ complete }) => complete).map(({ name }) => name);
}

/** Flatten destination token stacks for declaration fallback without treating the whole stack as a family. */
function destinationFontFamilyNames(tokens: Record<string, string> | undefined): string[] {
  return Object.values(tokens ?? {}).flatMap((value) => splitFontFamilyNames(value));
}

function splitFontFamilyNames(value: string): string[] {
  return splitCssTopLevel(value, ',').map((family) => family.trim()).filter(Boolean).map((family) =>
    (family.startsWith('"') && family.endsWith('"')) || (family.startsWith("'") && family.endsWith("'"))
      ? family.slice(1, -1)
      : family,
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
  sourceSelectors: ReadonlyMap<string, string> = new Map(),
  transportSelectors: ReadonlyMap<string, string> = sourceSelectors,
): (entry: {
  declarationId: string;
  ruleId: string;
  property: string;
  value: string;
  outcome: string;
  reason?: string;
  atRules: string[];
  source: { start: { offset: number; line: number; column: number } };
}) => AuthoredStyleLedgerEntry {
  return (entry) => {
    const selector = sourceSelectors.get(entry.ruleId);
    const transportSelector = transportSelectors.get(entry.ruleId);
    return {
    declarationId: entry.declarationId,
    ruleId: entry.ruleId,
    property: entry.property,
    value: entry.value,
    outcome: normalizeStyleOutcome(entry.outcome),
    reason: entry.reason,
    atRules: entry.atRules,
    source: {
      path: sourcePath,
      selector,
      offset: entry.source.start.offset,
      htmlLine: entry.source.start.line,
      htmlColumn: entry.source.start.column,
    },
    ...(selector && transportSelector && selector !== transportSelector ? { transportSelector } : {}),
  };
  };
}

function selectorsByRule(rules: readonly import('./styles.js').CssRule[], output = new Map<string, string>()): Map<string, string> {
  for (const rule of rules) {
    if (rule.kind === 'conditional') selectorsByRule(rule.rules, output);
    else if (rule.kind === 'style') output.set(rule.id, rule.selector);
  }
  return output;
}

function normalizeStyleOutcome(value: string): AuthoredStyleLedgerEntry['outcome'] {
  return value === 'native' || value === 'preset' || value === 'literal' || value === 'scoped-css' || value === 'blocked'
    ? value
    : 'warned';
}

/** Preserve the native-mapping category for callers instead of flattening it into a warning. */
function authoringFailureItem(block: string, error: unknown): ReportItem {
  if (error instanceof UnresolvedNativeStyleMappingError) {
    const mapping = error.mapping;
    return {
      block, status: 'warning', code: error.code, reason: error.message,
      ...(mapping.css ? { source: { selector: mapping.selector, offset: mapping.css.offset, htmlLine: mapping.css.line, htmlColumn: mapping.css.column } } : {}),
      details: mapping,
    };
  }
  const reason = error instanceof Error ? error.message : String(error);
  const mapping = reason.match(/^unresolved-native-style-mapping:\s*(.*)$/);
  return mapping
    ? { block, status: 'warning', code: 'unresolved-native-style-mapping', reason, details: { mapping: mapping[1] } }
    : { block, status: 'warning', reason };
}

/** Carry compiler-owned adapter destinations across a fresh source scan only by full identity. */
function reconcileVerifiedNativeTargets(
  scanned: import('../authoring/schema.js').AuthoringCoverage,
  submitted: import('../authoring/schema.js').AuthoringCoverage | undefined,
): void {
  if (!submitted) return;
  for (const entry of scanned.styles) {
    const matching = submitted.styles.filter((candidate) => candidate.declarationId === entry.declarationId
      && candidate.ruleId === entry.ruleId && candidate.scope === entry.scope
      && candidate.property === entry.property && candidate.value === entry.value
      && candidate.atRules.join('\u0000') === entry.atRules.join('\u0000')
      && candidate.source?.selector === entry.source?.selector && candidate.source?.offset === entry.source?.offset);
    if (matching.length === 1 && matching[0]!.nativeTargets?.length) entry.nativeTargets = matching[0]!.nativeTargets!.map((target) => ({ ...target }));
  }
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
