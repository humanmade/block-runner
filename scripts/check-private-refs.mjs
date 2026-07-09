import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

// `--ignore-scripts` + env: `npm pack` would otherwise run `prepare` → tsup, whose
// banner can land on stdout and corrupt `--json` (observed on stock GHA npm).
// The packed file list is read from the filesystem (dist/ already built by the
// prior verify step), so skipping lifecycle scripts yields the same result.
//
// npm pack --json shapes differ by major:
//   npm ≤11: [ { name, files: [...] } ]
//   npm ≥12: { "<pkg>": { name, files: [...] } }
// Always extract the first complete JSON value, then normalise to a files list.
const output = execFileSync(
  'npm',
  ['pack', '--dry-run', '--json', '--ignore-scripts'],
  {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, npm_config_ignore_scripts: 'true' },
  },
);

const files = packFilePaths(output);
const forbiddenPaths = [/^md\//, /^AGENTS\.md$/, /^CLAUDE\.md$/, /^\.env/];
const forbiddenTerms = [
  'dogfood',
  'internal generation',
  'thunderdome',
  'Aphelion',
  'Noel',
  'AGENTS.md',
  'CLAUDE.md',
  'md/',
];

const badPaths = files.filter((file) => forbiddenPaths.some((pattern) => pattern.test(file)));
if (badPaths.length > 0) {
  console.error(`Private files would be packed:\n${badPaths.join('\n')}`);
  process.exit(1);
}

const textFiles = files.filter((file) => /\.(md|js|mjs|cjs|ts|json|html|txt|yml|yaml)$/.test(file));
const forbiddenPattern = new RegExp(forbiddenTerms.map(escapeRegExp).join('|'), 'i');
const hits = [];

for (const file of textFiles) {
  const lines = readFileSync(file, 'utf8').split(/\r\n|\r|\n/);
  lines.forEach((line, index) => {
    if (forbiddenPattern.test(line)) {
      hits.push(`${file}:${index + 1}: ${line.trim()}`);
    }
  });
}

if (hits.length > 0) {
  console.error(`Private terms found in packable files:\n${hits.join('\n')}`);
  process.exit(1);
}

/** File paths that npm pack would include. */
function packFilePaths(stdout) {
  const value = parseFirstJsonValue(stdout);
  const pack = normalisePack(value);
  if (!pack?.files || !Array.isArray(pack.files)) {
    throw new Error(
      `npm pack --json did not include a files list.\n--- stdout (first 500 chars) ---\n${stdout.slice(0, 500)}`,
    );
  }
  return pack.files.map((file) => file.path);
}

/** npm ≤11 array form or npm ≥12 name-keyed object → one pack entry. */
function normalisePack(value) {
  if (Array.isArray(value)) {
    return value[0];
  }
  if (value && typeof value === 'object') {
    // Single pack object with files, or map of package-name → pack object.
    if (Array.isArray(value.files)) {
      return value;
    }
    const first = Object.values(value)[0];
    if (first && typeof first === 'object') {
      return first;
    }
  }
  return undefined;
}

/** Extract and parse the first complete JSON value (`{...}` or `[...]`) from stdout. */
function parseFirstJsonValue(stdout) {
  const objectStart = stdout.indexOf('{');
  const arrayStart = stdout.indexOf('[');
  const candidates = [objectStart, arrayStart].filter((index) => index >= 0);
  if (candidates.length === 0) {
    throw new Error(
      `npm pack --json produced no JSON.\n--- stdout (first 500 chars) ---\n${stdout.slice(0, 500)}`,
    );
  }
  const start = Math.min(...candidates);
  const open = stdout[start];
  const close = open === '{' ? '}' : ']';

  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < stdout.length; i++) {
    const char = stdout[i];
    if (inString) {
      if (escape) {
        escape = false;
      } else if (char === '\\') {
        escape = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
    } else if (char === open) {
      depth += 1;
    } else if (char === close) {
      depth -= 1;
      if (depth === 0) {
        return JSON.parse(stdout.slice(start, i + 1));
      }
    }
  }

  throw new Error(
    `npm pack --json produced unclosed JSON.\n--- stdout (first 500 chars) ---\n${stdout.slice(0, 500)}`,
  );
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
