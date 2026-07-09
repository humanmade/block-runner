import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

// `--ignore-scripts` + env: `npm pack` would otherwise run `prepare` → tsup, whose
// banner can land on stdout and corrupt `--json` (observed on stock GHA npm).
// The packed file list is read from the filesystem (dist/ already built by the
// prior verify step), so skipping lifecycle scripts yields the same result.
// We also slice to the JSON array so residual stdout never breaks the gate.
const output = execFileSync(
  'npm',
  ['pack', '--dry-run', '--json', '--ignore-scripts'],
  {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, npm_config_ignore_scripts: 'true' },
  },
);

const [pack] = parsePackJson(output);
const files = pack.files.map((file) => file.path);
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

/** Extract and parse the first top-level JSON array from npm pack --json stdout. */
function parsePackJson(stdout) {
  const start = stdout.indexOf('[');
  const end = stdout.lastIndexOf(']');
  if (start === -1 || end === -1 || end < start) {
    throw new Error(
      `npm pack --json produced no JSON array.\n--- stdout (first 500 chars) ---\n${stdout.slice(0, 500)}`,
    );
  }
  return JSON.parse(stdout.slice(start, end + 1));
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
