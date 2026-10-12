import Ajv, { type ErrorObject } from 'ajv';
import WORDPRESS_THEME_SCHEMA_7_1 from './vendor/wordpress-theme.schema.7.1.json';
import type { BlockRunnerReport, CommandName, ReportItem } from '../types.js';

export const WORDPRESS_THEME_SCHEMA_VERSION = '7.1' as const;
export const WORDPRESS_THEME_SCHEMA_URL = `https://schemas.wp.org/wp/${WORDPRESS_THEME_SCHEMA_VERSION}/theme.json`;

const validateThemeSchema = new Ajv({ allErrors: true, strict: false }).compile(WORDPRESS_THEME_SCHEMA_7_1);

/** Validate one theme.json against the vendored WordPress schema, returning parsed JSON for reuse. */
export function validateThemeJson(content: string, file: string, command: CommandName = 'validate'):
  { report: BlockRunnerReport; parsed?: unknown } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return {
      report: {
        ok: false,
        command,
        summary: { blocks: 0, valid: 0, invalid: 1, warnings: 0 },
        items: [{
          status: 'invalid',
          reason: `theme.json is malformed JSON: ${reason}`,
          source: { path: file },
          code: 'theme-json-schema',
        }],
      },
    };
  }

  const items: ReportItem[] = [];
  const valid = validateThemeSchema(parsed);
  if (!valid) {
    for (const error of validateThemeSchema.errors ?? []) {
      const pointer = errorPointer(error);
      items.push({
        status: 'invalid',
        reason: `JSON pointer ${pointer || '/'} ${error.message ?? 'is invalid'}`,
        source: { path: file, selector: pointer },
        details: { pointer, keyword: error.keyword },
        code: 'theme-json-schema',
      });
    }
  }

  if (isRecord(parsed) && typeof parsed.$schema === 'string' && parsed.$schema !== WORDPRESS_THEME_SCHEMA_URL) {
    items.push({
      status: 'warning',
      severity: 'info',
      reason: `$schema points to ${parsed.$schema}; validation uses the pinned WordPress ${WORDPRESS_THEME_SCHEMA_VERSION} schema.`,
      source: { path: file, selector: '/$schema' },
      code: 'theme-json-schema-version',
    });
  }

  const invalid = items.filter((item) => item.status === 'invalid').length;
  const warnings = items.filter((item) => item.status === 'warning' && item.severity !== 'info').length;
  return {
    parsed,
    report: {
      ok: invalid === 0,
      command,
      summary: { blocks: 0, valid: 0, invalid, warnings },
      items,
    },
  };
}

function errorPointer(error: ErrorObject): string {
  let pointer = error.instancePath;
  if (error.keyword === 'additionalProperties') {
    const property = error.params.additionalProperty;
    if (typeof property === 'string') {
      pointer += `/${property.replaceAll('~', '~0').replaceAll('/', '~1')}`;
    }
  }
  return pointer;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
