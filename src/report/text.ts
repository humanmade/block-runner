import type { BlockRunnerReport, ReportItem } from '../types.js';

export function formatTextReport(report: BlockRunnerReport): string {
  const status = report.ok ? 'ok' : 'problems found';
  const lines = [
    `${report.command}: ${status}`,
    `blocks=${report.summary.blocks} valid=${report.summary.valid} invalid=${report.summary.invalid} warnings=${report.summary.warnings}`,
  ];
  const coverageNotices = new Set<string>();

  for (const item of report.items) {
    lines.push(`- ${item.status}: ${item.block ?? 'input'}: ${item.reason}${formatLocation(item)}`);
    const details = record(item.details);
    add(lines, 'code', item.code);
    add(lines, 'rule', item.rule);
    add(lines, 'stage', string(details?.stage));
    add(lines, 'phase', string(details?.phase));
    add(lines, 'action', string(details?.action));
    const truncated = number(details?.truncated);
    if (truncated !== undefined && truncated > 0) {
      const total = number(details?.total);
      const notice = `  coverage: ${total === undefined ? '' : `${total} total; `}${truncated} omitted`;
      const key = coverageKey(details, notice);
      if (!key || !coverageNotices.has(key)) {
        lines.push(notice);
        if (key) coverageNotices.add(key);
      }
    }
  }

  return lines.join('\n');
}

function formatLocation(item: ReportItem): string {
  if (!item.source) return '';
  const details = record(item.details);
  const generated = details?.locationKind === 'generated-markup';
  const location = [
    item.source.path,
    item.source.selector,
    item.source.htmlLine ? `line ${item.source.htmlLine}` : undefined,
  ].filter(Boolean).join(' ');
  const inputPath = string(details?.inputPath);
  if (generated) {
    return ` (${['generated markup', location, inputPath ? `input ${inputPath}` : undefined].filter(Boolean).join('; ')})`;
  }
  return location ? ` (${location})` : '';
}

function add(lines: string[], label: string, value: string | undefined): void {
  if (value) lines.push(`  ${label}: ${value}`);
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function string(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function number(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function coverageKey(details: Record<string, unknown> | undefined, notice: string): string | undefined {
  const categories = details?.categories;
  return Array.isArray(categories) && categories.every((category) => typeof category === 'string')
    ? `${notice}:${categories.join(',')}`
    : undefined;
}
