import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

// `--ignore-scripts`: `npm pack` would otherwise run the `prepare` build, whose
// tsup banner prints to stdout and corrupts the `--json` payload we parse below.
// The packed file list is read from the filesystem (dist/ already built by the
// prior verify step), so skipping lifecycle scripts yields the same result.
const output = execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'pipe'],
});

const [pack] = JSON.parse(output);
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

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
