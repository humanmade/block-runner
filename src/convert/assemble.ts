import { loadConfig } from '../config/load.js';
import { getWp } from '../headless/wp.js';
import { effectiveTokens } from '../tokens/apply.js';
import { buildTokenInverseMap } from '../tokens/repair.js';
import {
  StyleLedgerEntry,
  applyElementStyles,
  isCarryable,
  richTextDescendantStyles,
  sourceDeclarationKey,
  unattributableStyles,
} from '../styles/apply.js';
import { SidecarCollector, addClassName } from '../styles/sidecar.js';
import { createCapabilitySource } from '../styles/capabilities.js';
import {
  BlockRunnerReport,
  ConvertOptions,
  HeadlessBootError,
  ReportItem,
  Rule,
  RuleContext,
  StylingRung,
  WpBlock,
} from '../types.js';
import {
  contextHtml,
  contextText,
  cssBackgroundsFromRules,
  isElementNode,
  makeContextWarning,
  prepareDom,
  retainSelectorDependencies,
  sourceForNode,
} from './dom.js';
import { defaultRules } from './defaults.js';
import { finalizeBlocks } from './finalize.js';
import { walkChildren } from './walk.js';

export async function convert(input: string, options: ConvertOptions = {}): Promise<BlockRunnerReport> {
  try {
    // Config loading is inside the guard: a rejected `styling` ceiling or an unreadable site
    // context is a reported error like any other, not an unhandled throw from a function whose
    // contract is to return a report.
    const config = await loadConfig(options);
    const wp = await getWp();
    return await runConvert(input, options, config, wp);
  } catch (error) {
    // The per-node walker contains rule throws already; this is the last-resort guard so a
    // failure in assembly/serialize/parse/validate is a reported error, never an unhandled
    // throw with zero output. Boot failures keep their own exit path.
    if (error instanceof HeadlessBootError || (error instanceof Error && error.name === 'HeadlessBootError')) {
      throw error;
    }
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      command: 'convert',
      summary: { blocks: 0, valid: 0, invalid: 0, warnings: 1 },
      items: [
        {
          block: 'input',
          status: 'invalid',
          reason: `conversion failed: ${message}`,
          source: options.sourcePath ? { path: options.sourcePath } : undefined,
        },
      ],
      output: '',
    };
  }
}

async function runConvert(
  input: string,
  options: ConvertOptions,
  config: Awaited<ReturnType<typeof loadConfig>>,
  wp: Awaited<ReturnType<typeof getWp>>,
): Promise<BlockRunnerReport> {
  const prepared = prepareDom(input, options.sourcePath);
  retainSelectorDependencies(
    prepared.dom.window.document,
    options.preserveSourceSelectorDependencies ?? [],
  );
  // A registered-block stylesheet owns declarations that could not be mapped natively for every
  // matching element. Remove exactly those source declarations before structural/style mapping so
  // a mixed result cannot emit both a native value and the residual rule.
  const suppressed = new Set(options.suppressSourceDeclarations ?? []);
  const cssClassRules = suppressed.size === 0
    ? prepared.cssClassRules
    : prepared.cssClassRules.map((rule) => ({
        ...rule,
        declarations: rule.declarations.filter(
          (declaration) => !declaration.origin || !suppressed.has(
            sourceDeclarationKey(declaration.origin, declaration.property, declaration.value, declaration.originId),
          ),
        ),
      }));
  const cssBackgrounds = cssBackgroundsFromRules(cssClassRules);
  const warnings: ReportItem[] = [...prepared.warnings];
  const explainItems: ReportItem[] = [];
  const rules = buildRules(config);

  // Tokens are resolved once, up front: the styling layer needs them during the walk (to snap
  // values onto presets under `strict`) and token repair needs the same set afterwards.
  const tokens = await effectiveTokens(config, options);
  const tokenInvMap = buildTokenInverseMap(tokens);
  const capabilities = createCapabilitySource(wp, config, options);
  const styling = (config.styling ?? 'relaxed') as StylingRung;
  const sidecar = new SidecarCollector();

  if (capabilities.note) {
    warnings.push({ block: 'input', status: 'warning', reason: capabilities.note });
  }

  const context: RuleContext = {
    wp,
    config,
    rules,
    sourcePath: options.sourcePath,
    explain: options.explain === true,
    cssBackgrounds,
    cssClassRules,
    preserveAssetForms: options.preserveAssetForms === true,
    warn(reason, node, block, rule, details) {
      warnings.push(makeContextWarning(context, reason, node, block, rule, details));
    },
    applyStyles(node, blocks) {
      // No `style`-attribute precondition: an element's CSS can come from a matching `<style>`
      // class rule with no inline styles at all. applyElementStyles returns nothing when there is
      // genuinely nothing to account for.
      if (!isElementNode(node)) {
        return;
      }
      const element = node as Element;

      // One element, one block is the only unambiguous attribution. A rule that fans a node out
      // into several blocks gives us no honest place to put its CSS — but the ledger still owes an
      // outcome per declaration, not one aggregate note.
      const block = blocks.length === 1 ? blocks[0] : undefined;
      const ledger = block
        ? applyElementStyles({
            element,
            block,
            styling,
            capabilities,
            tokens: tokenInvMap,
            classRules: cssClassRules,
          })
        : unattributableStyles(element, blocks.length, cssClassRules);

      // Registered-block authoring owns a stylesheet rooted at its generated wrapper. Retain only
      // the source classes that stylesheet actually references, and only on the one native block
      // that claimed this source element. The ordinary convert path deliberately keeps its prior
      // no-source-class output, so a transport class can never leak accidentally into post content.
      if (block && options.preserveSourceClasses) {
        const retained = new Set(options.preserveSourceClasses);
        for (const className of element.classList) {
          if (retained.has(className)) {
            addClassName(block, className);
          }
        }
      }

      reportLedger(carryToSidecar(ledger, block), element, block?.name, 'styles');
    },
    noteRichTextStyles(node, block, rule) {
      if (!isElementNode(node)) {
        return;
      }
      // Rich-text descendants have no block of their own, so only author-selector rules can be
      // rescued — passing the enclosing block would put the class in the wrong place.
      const ledger = richTextDescendantStyles(node as Element, styling, cssClassRules);
      reportLedger(carryToSidecar(ledger, undefined), node as Element, block, rule ?? 'styles');
    },
    explainRule(node, rule, reason, details) {
      if (!context.explain) {
        return;
      }
      explainItems.push({
        status: 'valid',
        reason,
        rule,
        source: context.sourceFor(node),
        details: {
          explainOnly: true,
          ...((details && typeof details === 'object') ? details : {}),
        },
      });
    },
    sourceFor(node) {
      return sourceForNode(prepared.dom, node, options.sourcePath);
    },
    recurse(node, skip) {
      return walkChildren(node, context, skip);
    },
    text: contextText,
    html: contextHtml,
  };

  /**
   * At the `open` rung, rescue the declarations no block attribute can hold into sidecar CSS.
   *
   * Rules authored as a class keep the author's own selector — the class already rides on the
   * element, so recreating it under a generated name would be redundant. Everything else gets a
   * generated class added to the block. Entries marked `carryable: false` are broken input or have no
   * single block to attach to, and still drop.
   */
  function carryToSidecar(ledger: StyleLedgerEntry[], block: WpBlock | undefined): StyleLedgerEntry[] {
    if (styling !== 'open') {
      return ledger;
    }

    // A generated class needs a block to attach to; an author's selector does not, which is what
    // lets rich-text descendant rules be rescued too.
    const generated = block ? ledger.filter((entry) => isCarryable(entry) && !entry.origin) : [];
    const authored = ledger.filter((entry) => isCarryable(entry) && entry.origin);
    if (generated.length === 0 && authored.length === 0) {
      return ledger;
    }

    const rescued = new Map<StyleLedgerEntry, string>();
    if (generated.length > 0 && block) {
      const className = sidecar.add(generated);
      addClassName(block, className);
      for (const entry of generated) {
        rescued.set(entry, `.${className}`);
      }
    }
    // Grouped per originating RULE, not per selector: a selector can appear more than once in a
    // stylesheet, and each occurrence keeps its own position.
    for (const [, { selector, order, entries }] of groupByRule(authored)) {
      sidecar.addVerbatim(selector, entries, order);
      // The converter does not carry input classes onto blocks, so a verbatim rule would select
      // nothing. Re-attach just the class whose rule we carried — precise, and it keeps the author's
      // selector meaningful. Rich-text descendants need no such help: the class is already inside
      // the block's content, which is why they arrive here with no block.
      if (block) {
        addClassName(block, selector.replace(/^\./, ''));
      }
      for (const entry of entries) {
        rescued.set(entry, selector);
      }
    }

    return ledger.map((entry) => {
      const selector = rescued.get(entry);
      return selector
        ? { ...entry, outcome: 'consumed' as const, reason: `carried in sidecar CSS as ${selector}` }
        : entry;
    });
  }

  function groupByRule(
    entries: StyleLedgerEntry[],
  ): Map<string, { selector: string; order: number; entries: StyleLedgerEntry[] }> {
    const grouped = new Map<string, { selector: string; order: number; entries: StyleLedgerEntry[] }>();
    for (const entry of entries) {
      const selector = entry.origin!;
      const order = entry.originIndex ?? Number.MAX_SAFE_INTEGER;
      const key = `${selector} ${order}`;
      const existing = grouped.get(key);
      grouped.set(key, { selector, order, entries: [...(existing?.entries ?? []), entry] });
    }
    return grouped;
  }

  // Turn ledger entries into report items. Only `dropped` and deviations warn: `consumed`,
  // `overridden` and clean `mapped` outcomes are accounted for under --explain, because warning on
  // them would bury the entries that need action.
  function reportLedger(ledger: StyleLedgerEntry[], element: Element, block: string | undefined, rule: string): void {
    options.styleLedgerObserver?.(ledger, context.sourceFor(element), block);
    for (const entry of ledger) {
      const authored = entry.shorthand ? `${entry.shorthand} (${entry.property})` : entry.property;
      // An unparseable chunk has no value to quote — it *is* the quoted text. Name the rule a
      // class-authored declaration came from, so the fix lands upstream and not on the element.
      const where = entry.origin ? ` in ${entry.origin}` : '';
      const described = entry.value ? `${authored}: ${entry.value}${where}` : `"${authored}"${where}`;
      if (entry.outcome === 'dropped' || entry.deviation) {
        const summary = entry.outcome === 'dropped' ? `dropped — ${entry.reason}` : entry.deviation;
        context.warn(`${described} ${summary}`, element, block, rule, {
          property: entry.property,
          value: entry.value,
          shorthand: entry.shorthand,
          outcome: entry.outcome,
        });
        continue;
      }
      context.explainRule(
        element,
        rule,
        entry.outcome === 'mapped' ? `${described} → ${entry.target}` : `${described} ${entry.reason}`,
        { property: entry.property, outcome: entry.outcome },
      );
    }
  }

  const blocks = await walkChildren(prepared.dom.window.document.body, context);
  const report = await finalizeBlocks(blocks, options, config, wp, {
    command: 'convert',
    warnings,
    tokens,
  });

  return {
    ...report,
    items: [...report.items, ...explainItems],
    ...(sidecar.empty ? {} : { sidecarCss: sidecar.css() }),
  };
}

function buildRules(config: Awaited<ReturnType<typeof loadConfig>>): Rule[] {
  const custom = Array.isArray(config.rules) ? config.rules : config.rules?.custom ?? [];
  const customRules = custom.filter(isRule);
  return [...customRules, ...defaultRules(config)];
}

function isRule(value: unknown): value is Rule {
  return (
    Boolean(value) &&
    typeof value === 'object' &&
    typeof (value as Rule).id === 'string' &&
    typeof (value as Rule).match === 'function' &&
    typeof (value as Rule).emit === 'function'
  );
}

export function annotateSource(block: WpBlock, source: ReportItem['source']): WpBlock {
  block.__blockRunnerSource = source;
  return block;
}
