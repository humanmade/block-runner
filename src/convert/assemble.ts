import { loadConfig } from '../config/load.js';
import { getWp } from '../headless/wp.js';
import { validate } from '../gate/validate.js';
import { applyMedia } from '../media/apply.js';
import { createMediaResolver } from '../media/resolver.js';
import { BlockRunnerReport, ConvertOptions, ReportItem, Rule, RuleContext, WpBlock } from '../types.js';
import { contextHtml, contextText, makeContextWarning, prepareDom, sourceForNode } from './dom.js';
import { defaultRules } from './defaults.js';
import { walkChildren } from './walk.js';

export async function convert(input: string, options: ConvertOptions = {}): Promise<BlockRunnerReport> {
  const config = await loadConfig(options);
  const wp = await getWp();
  const prepared = prepareDom(input, options.sourcePath);
  const warnings: ReportItem[] = [...prepared.warnings];
  const explainItems: ReportItem[] = [];
  const rules = buildRules(config);

  const context: RuleContext = {
    wp,
    config,
    rules,
    sourcePath: options.sourcePath,
    explain: options.explain === true,
    cssBackgrounds: prepared.cssBackgrounds,
    warn(reason, node, block, rule, details) {
      warnings.push(makeContextWarning(context, reason, node, block, rule, details));
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

  const blocks = await walkChildren(prepared.dom.window.document.body, context);
  const mediaWarnings = await applyMedia(blocks, createMediaResolver(config, options), config);
  warnings.push(...mediaWarnings);

  const output = wp.serialize(blocks);
  const gate = await validate(output, {
    ...options,
    strict: config.strict,
  });

  const hardWarnings = warnings.filter((item) => isStrictFailureWarning(item));
  const ok = gate.summary.invalid === 0 && !(config.strict && hardWarnings.length > 0);

  return {
    ok,
    command: 'convert',
    summary: {
      blocks: gate.summary.blocks,
      valid: gate.summary.valid,
      invalid: gate.summary.invalid,
      warnings: warnings.length,
    },
    items: [...warnings, ...gate.items, ...explainItems],
    output,
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

function isStrictFailureWarning(item: ReportItem): boolean {
  return /Custom HTML fallback|unresolved media|no ID|media map has no ID|sideload is disabled|file not found/i.test(
    item.reason,
  );
}

export function annotateSource(block: WpBlock, source: ReportItem['source']): WpBlock {
  block.__blockRunnerSource = source;
  return block;
}
