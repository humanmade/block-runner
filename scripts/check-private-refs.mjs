import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// `--ignore-scripts` + env: `npm pack` would otherwise run `prepare` → tsup, whose
// banner can land on stdout and corrupt `--json` (observed on stock GHA npm).
// The packed file list is read from the filesystem (dist/ already built by the
// prior verify step), so skipping lifecycle scripts yields the same result.
//
// npm pack --json shapes differ by major:
//   npm ≤11: [ { name, files: [...] } ]
//   npm ≥12: { "<pkg>": { name, files: [...] } }
// Scan complete JSON values until one is a real npm pack record.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}

function main() {
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
  const requiredPaths = [
    'skills/block-runner/SKILL.md',
    'skills/block-runner/references/GUIDE.md',
  ];
  const missingPaths = requiredPaths.filter((file) => !files.includes(file));
  if (missingPaths.length > 0) {
    console.error(`Required public files are missing from the package:\n${missingPaths.join('\n')}`);
    process.exit(1);
  }
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
  // `md/` identifies the repository's private top-level directory. Require a path boundary so
  // public package names such as `transform-modules-amd` and arbitrary integrity hashes in a
  // bundled npm lock cannot be mistaken for that directory.
  const forbiddenPattern = new RegExp([
    ...forbiddenTerms.filter((term) => term !== 'md/').map(escapeRegExp),
    String.raw`(?:^|[^A-Za-z0-9_])md/`,
  ].join('|'), 'i');
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
}

/** File paths that npm pack would include. */
export function packFilePaths(stdout) {
  for (const value of jsonValues(stdout)) {
    const pack = normalisePack(value);
    if (isPackRecord(pack)) {
      return pack.files.map((file) => file.path);
    }
  }
  throw new Error(
    `npm pack --json did not include a files list.\n--- stdout (first 500 chars) ---\n${stdout.slice(0, 500)}`,
  );
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
    const entries = Object.entries(value);
    if (entries.length === 1) {
      const [packageName, pack] = entries[0];
      if (pack && typeof pack === 'object' && pack.name === packageName) {
        return pack;
      }
    }
  }
  return undefined;
}

function isPackRecord(value) {
  return value
    && typeof value.name === 'string'
    && Array.isArray(value.files)
    && value.files.every((file) => file && typeof file.path === 'string');
}

/** Parse complete JSON values from noisy `npm pack --json` stdout. */
function* jsonValues(stdout) {
  for (let start = 0; start < stdout.length; start += 1) {
    if (stdout[start] !== '{' && stdout[start] !== '[') continue;

    const stack = [];
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
      } else if (char === '{' || char === '[') {
        stack.push(char === '{' ? '}' : ']');
      } else if (char === '}' || char === ']') {
        if (stack.at(-1) !== char) break;
        stack.pop();
        if (stack.length === 0) {
          try {
            const value = JSON.parse(stdout.slice(start, i + 1));
            yield value;
            start = i;
          } catch {
            // Other tools may print JSON-like text before npm's record.
          }
          break;
        }
      }
    }
  }
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
