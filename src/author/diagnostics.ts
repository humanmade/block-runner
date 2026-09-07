import type { SourceLocation } from '../types.js';

/** Small internal transport for structured authoring failures through the existing Error catches. */
export interface AuthorDiagnostic {
  code: string;
  reason: string;
  source?: SourceLocation;
  details?: unknown;
}

export class AuthorDiagnosticError extends Error {
  constructor(readonly diagnostics: readonly AuthorDiagnostic[]) {
    super(diagnostics[0]?.reason ?? 'authoring diagnostic');
    this.name = 'AuthorDiagnosticError';
  }
}

export function authorDiagnostic(
  code: string,
  reason: string,
  source?: SourceLocation,
  details?: unknown,
): AuthorDiagnosticError {
  return new AuthorDiagnosticError([{ code, reason, ...(source ? { source: reportDiagnosticSource(source) } : {}), ...(details === undefined ? {} : { details }) }]);
}

/** Normalize parser/source records at the report boundary without manufacturing a position. */
export function reportDiagnosticSource(source: SourceLocation): SourceLocation {
  const value = source as SourceLocation & { line?: number; column?: number };
  return {
    ...(value.path === undefined ? {} : { path: value.path }),
    ...(value.selector === undefined ? {} : { selector: value.selector }),
    ...(value.offset === undefined ? {} : { offset: value.offset }),
    ...((value.htmlLine ?? value.line) === undefined ? {} : { htmlLine: value.htmlLine ?? value.line }),
    ...((value.htmlColumn ?? value.column) === undefined ? {} : { htmlColumn: value.htmlColumn ?? value.column }),
  };
}
