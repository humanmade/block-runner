import type { ReportItem } from '../types.js';

/** Mark validation findings produced from serialized output, not authored input. */
export function generatedMarkupItems(items: readonly ReportItem[], inputPath?: string): ReportItem[] {
  return items.map((item) => {
    const source = { ...item.source };
    delete source.path;
    const details = item.details && typeof item.details === 'object' && !Array.isArray(item.details)
      ? item.details as Record<string, unknown>
      : {};

    return {
      ...item,
      ...(item.source ? { source } : {}),
      details: {
        ...details,
        locationKind: 'generated-markup',
        ...(inputPath ? { inputPath } : {}),
      },
    };
  });
}
