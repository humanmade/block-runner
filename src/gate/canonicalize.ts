import { loadConfig } from '../config/load.js';
import { getWp } from '../headless/wp.js';
import { repairTokens } from '../tokens/apply.js';
import { buildTokenInverseMap } from '../tokens/repair.js';
import { BlockRunnerReport, CanonicalizeOptions } from '../types.js';
import { validate } from './validate.js';

export async function canonicalize(markup: string, options: CanonicalizeOptions = {}): Promise<BlockRunnerReport> {
  const wp = await getWp();
  const config = await loadConfig(options);

  let repairs: BlockRunnerReport['items'] = [];
  let output: string;
  if (buildTokenInverseMap(config.tokens).isEmpty && (config.tokens?.resolver ?? 'noop') === 'noop') {
    output = wp.serialize(wp.parse(markup, { __unstableSkipMigrationLogs: true }));
  } else {
    const parsed = wp.parse(markup, { __unstableSkipMigrationLogs: true });
    const result = await repairTokens(parsed, config, options);
    repairs = result.items;
    output = wp.serialize(result.blocks);
  }

  const report = await validate(output, options);

  return {
    ...report,
    ok: report.summary.invalid === 0,
    command: 'fix',
    items: [...repairs, ...report.items],
    output,
  };
}
