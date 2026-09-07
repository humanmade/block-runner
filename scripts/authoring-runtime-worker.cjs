#!/usr/bin/env node
/*
 * Execute a frozen registered-block candidate against a configured disposable
 * WordPress runtime. This worker makes no model calls and never edits the
 * candidate source recorded by the runner.
 *
 * Set BLOCK_RUNNER_AUTHORING_RUNTIME_CONFIG to an absolute JSON config file.
 * See scripts/authoring-runtime.config.example.json for the required shape.
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const cp = require('node:child_process');
const { createRequire } = require('node:module');
const http = require('node:http');

function emittedStyleValueMatches(property, emittedValue, coverageValue) {
  if (emittedValue === coverageValue) return true;
  return /^--[a-zA-Z_][a-zA-Z0-9_-]*$/.test(property) && coverageValue === '' && emittedValue.trim() === '';
}

// Focused contract for the production comparator; it deliberately bypasses runtime configuration.
if (process.argv.length === 3 && process.argv[2] === '--style-value-contract') {
  const cases = [
    { property: '--tw-pan-x', emitted: ' ', coverage: '', expected: true },
    { property: '--tw-pan-x', emitted: '\t', coverage: '', expected: true },
    { property: 'color', emitted: ' ', coverage: '', expected: false },
    { property: '-- invalid', emitted: ' ', coverage: '', expected: false },
    { property: '--brand', emitted: ' red ', coverage: 'red', expected: false },
    { property: 'color', emitted: 'red', coverage: 'red', expected: true },
  ].map((entry) => ({ ...entry, actual: emittedStyleValueMatches(entry.property, entry.emitted, entry.coverage) }));
  if (!cases.every((entry) => entry.actual === entry.expected)) process.exit(1);
  process.stdout.write(`${JSON.stringify({ cases })}\n`);
  process.exit(0);
}

function failPreflight(message) {
  process.stderr.write(`authoring runtime worker preflight failed: ${message}\n`);
  process.exit(2);
}

function readConfig() {
  const configFile = process.env.BLOCK_RUNNER_AUTHORING_RUNTIME_CONFIG;
  if (!configFile) failPreflight('BLOCK_RUNNER_AUTHORING_RUNTIME_CONFIG is required; point it at a JSON file based on scripts/authoring-runtime.config.example.json.');
  const resolved = path.resolve(configFile);
  let config;
  try { config = JSON.parse(fs.readFileSync(resolved, 'utf8')); } catch (error) {
    failPreflight(`cannot read ${resolved}: ${error.message}`);
  }
  const string = (value, label) => {
    if (typeof value !== 'string' || !value.trim()) failPreflight(`${label} must be a non-empty string.`);
    return value;
  };
  if (!config || typeof config !== 'object' || Array.isArray(config)) failPreflight('config must be a JSON object.');
  const wordpress = config.wordpress;
  if (!wordpress || typeof wordpress !== 'object' || Array.isArray(wordpress)) failPreflight('config.wordpress must be an object.');
  const credentials = wordpress.credentials;
  if (!credentials || typeof credentials !== 'object' || Array.isArray(credentials)) failPreflight('config.wordpress.credentials must be an object.');
  const result = {
    repo: path.resolve(string(config.repo, 'config.repo')),
    cli: path.resolve(string(config.cli, 'config.cli')),
    sharedDependencies: path.resolve(string(config.sharedDependencies, 'config.sharedDependencies')),
    docker: string(config.docker, 'config.docker'),
    wordpress: {
      container: string(wordpress.container, 'config.wordpress.container'),
      url: string(wordpress.url, 'config.wordpress.url').replace(/\/$/, ''),
      username: string(credentials.username, 'config.wordpress.credentials.username'),
      password: string(credentials.password, 'config.wordpress.credentials.password'),
    },
    smokeViewport: config.smokeViewport,
  };
  for (const [label, file, expected] of [
    ['config.repo/package.json', path.join(result.repo, 'package.json'), 'file'],
    ['config.cli', result.cli, 'file'],
    ['config.sharedDependencies', result.sharedDependencies, 'directory'],
  ]) {
    if (!fs.existsSync(file) || (expected === 'file' ? !fs.statSync(file).isFile() : !fs.statSync(file).isDirectory())) {
      failPreflight(`${label} does not exist as a ${expected}: ${file}`);
    }
  }
  if (result.docker.includes(path.sep) && (!fs.existsSync(result.docker) || !fs.statSync(result.docker).isFile())) {
    failPreflight(`config.docker does not exist as a file: ${result.docker}`);
  }
  if (result.smokeViewport !== undefined && (!result.smokeViewport || !Number.isInteger(result.smokeViewport.width)
    || !Number.isInteger(result.smokeViewport.height) || result.smokeViewport.width < 1 || result.smokeViewport.height < 1)) {
    failPreflight('config.smokeViewport must contain positive integer width and height when supplied.');
  }
  return result;
}

const config = readConfig();
const req = createRequire(path.join(config.repo, 'package.json'));
let chromium, postcss;
try {
  ({ chromium } = req('@playwright/test'));
  postcss = req('postcss');
  req.resolve('axe-core/axe.min.js');
} catch (error) {
  failPreflight(`configured repo is missing required runtime dependencies: ${error.message}`);
}

const args = {};
for (let index = 2; index < process.argv.length; index += 2) {
  const flag = process.argv[index];
  const value = process.argv[index + 1];
  if (!flag?.startsWith('--') || value === undefined) failPreflight('worker arguments must be flag/value pairs.');
  (args[flag] ??= []).push(value);
}
const get = (key) => args[key]?.[0];
for (const key of ['--candidate-dir', '--fixture-id', '--candidate-plan', '--source', '--expected-plan', '--result']) {
  if (!get(key)) failPreflight(`${key} is required.`);
}
if (get('--wordpress-version') && get('--wordpress-version') !== '7.1') failPreflight('this worker only accepts the WordPress 7.1 runner contract.');
if (get('--browser') && get('--browser') !== 'chromium') failPreflight('this worker only accepts the Chromium runner contract.');
if (get('--viewport') && get('--viewport') !== '1440x1024') failPreflight('this worker only accepts the 1440x1024 primary viewport contract.');

const candidate = path.resolve(get('--candidate-dir'));
const fixture = get('--fixture-id');
const out = path.join(candidate, 'execution');
const checks = {};
const artifacts = {};
const log = [];
const hash = (bytes) => `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
const json = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const fixtureSpec = json(path.join(config.repo, 'benchmarks', 'authoring', 'fixtures.json')).fixtures.find((value) => value.id === fixture);
if (!fixtureSpec) failPreflight(`fixture ${fixture} is not in ${config.repo}/benchmarks/authoring/fixtures.json.`);
const declaredFidelityViewports = (() => {
  const captures = fixtureSpec.assertions?.fidelity?.viewportCaptures;
  if (!Array.isArray(captures) || captures.length === 0) failPreflight(`fixture ${fixture} must declare at least one fidelity viewport capture.`);
  const seen = new Set();
  return captures.map((capture) => {
    if (typeof capture !== 'string') failPreflight(`fixture ${fixture} has a non-string fidelity viewport capture.`);
    const match = /^(\d+)x(\d+)$/.exec(capture);
    if (!match || Number(match[1]) < 1 || Number(match[2]) < 1) failPreflight(`fixture ${fixture} has an invalid fidelity viewport capture: ${capture}.`);
    if (seen.has(capture)) failPreflight(`fixture ${fixture} declares duplicate fidelity viewport capture: ${capture}.`);
    seen.add(capture);
    return { name: capture, width: Number(match[1]), height: Number(match[2]) };
  });
})();
for (const file of [candidate, get('--candidate-plan'), get('--source'), get('--expected-plan')]) {
  if (!fs.existsSync(file)) failPreflight(`required candidate input does not exist: ${file}`);
}
fs.mkdirSync(out, { recursive: true });

function save(name, value, ext = 'json') {
  const file = path.join(out, `${name}.${ext}`);
  fs.writeFileSync(file, ext === 'json' ? `${JSON.stringify(value, null, 2)}\n` : value);
  artifacts[name] = { path: path.relative(candidate, file) };
  return file;
}
function check(name, pass, detail, evidence) { checks[name] = { pass, detail, evidence }; }
function run(command, argv, cwd = out, timeout = 180000) {
  const result = cp.spawnSync(command, argv, { cwd, encoding: 'utf8', timeout, maxBuffer: 30 * 1024 * 1024, env: process.env });
  log.push({ command, args: argv, cwd, status: result.status, stdout: result.stdout, stderr: result.stderr, error: result.error?.message });
  if (result.status !== 0) throw new Error(`${command} exited ${result.status}: ${(result.stderr || result.error?.message || '').slice(-1200)}`);
  return result.stdout;
}
function wp(argv) { return run(config.docker, ['exec', config.wordpress.container, 'wp', ...argv]); }
function coverageEvidence() {
  const file = path.join(candidate, 'source-coverage.json');
  if (!fs.existsSync(file)) throw new Error('runner-owned source-coverage.json is required before runtime style scoring.');
  const report = json(file);
  if (!report || report.valid !== true || !report.source || !report.coverage || !Array.isArray(report.coverage.styles)) {
    throw new Error('source-coverage.json must report valid:true plus canonical source and coverage.styles.');
  }
  const sourceBytes = fs.readFileSync(get('--source'));
  const expectedHash = typeof report.source.sha256 === 'string' ? report.source.sha256.replace(/^sha256:/, '') : '';
  if (!/^[a-f0-9]{64}$/i.test(expectedHash) || hash(sourceBytes) !== `sha256:${expectedHash}`) {
    throw new Error('source-coverage.json source hash does not bind to the supplied source bytes.');
  }
  const cssFiles = (args['--source-dependency'] || []).filter((file) => /\.css$/i.test(file));
  const css = cssFiles.length ? cssFiles.map((file) => fs.readFileSync(file, 'utf8')).join('')
    : [...sourceBytes.toString('utf8').matchAll(/<style\b[^>]*>([\s\S]*?)<\/style\s*>/gi)].map((match) => match[1]).join('\n');
  const rawStylesheetSha256 = hash(css);
  const declaredInputStylesheetSha256 = report.inputStylesheetSha256;
  const effectiveStylesheetSha256 = report.coverage.stylesheet?.sha256;
  const normalizedHash = (value, label) => {
    if (typeof value !== 'string' || !/^(?:sha256:)?[a-f0-9]{64}$/i.test(value)) throw new Error(`${label} must be a SHA-256 digest.`);
    return `sha256:${value.replace(/^sha256:/i, '').toLowerCase()}`;
  };
  if (declaredInputStylesheetSha256 !== undefined) {
    if (rawStylesheetSha256 !== normalizedHash(declaredInputStylesheetSha256, 'source-coverage inputStylesheetSha256')) {
      throw new Error('inputStylesheetSha256 does not bind to the raw supplied CSS or inline stylesheet bytes.');
    }
  } else if (effectiveStylesheetSha256 && rawStylesheetSha256 !== normalizedHash(effectiveStylesheetSha256, 'source-coverage coverage.stylesheet.sha256')) {
    // Receipts created before raw/effective stylesheet hashes were split used the effective field for raw input.
    throw new Error('validated stylesheet hash does not bind to the supplied CSS bytes.');
  }
  return { ...report, stylesheetHashes: { raw: rawStylesheetSha256, input: declaredInputStylesheetSha256 ?? null, effective: effectiveStylesheetSha256 ?? null, validation: declaredInputStylesheetSha256 === undefined ? 'legacy-effective-as-raw' : 'raw-input' } };
}
function sourceDeclarations(files) {
  const declarations = [];
  for (const file of files) {
    const text = fs.readFileSync(file, 'utf8');
    const styles = file.endsWith('.css') ? [text] : [...text.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)].map((match) => match[1]);
    for (const css of styles) {
      postcss.parse(css, { from: file }).walkDecls((declaration) => declarations.push({
        selector: declaration.parent.selector || declaration.parent.name || 'inline', property: declaration.prop, value: declaration.value,
      }));
    }
  }
  return declarations;
}
function scopedStyleSelectors(report, styles) {
  const root = `.wp-block-${report.canonicalPlan.target.name.replace('/', '-')}`;
  const eligible = styles.map((style, index) => ({ style, index })).filter(({ style }) => ['literal', 'scoped-css'].includes(style?.outcome));
  if (eligible.length === 0) return new Map();
  const input = { root, foundation: report.canonicalPlan.styles?.foundation, styles: eligible.map(({ style, index }) => ({ index, transportSelector: style.transportSelector, source: style.source })) };
  const inputFile = path.join(out, 'style-scoper-input.json');
  fs.writeFileSync(inputFile, `${JSON.stringify(input, null, 2)}\n`);
  const helper = path.join(config.repo, 'scripts', 'authoring-runtime-style-contract.ts');
  if (!fs.existsSync(helper)) throw new Error('production runtime style-contract helper is missing.');
  const result = JSON.parse(run(process.execPath, ['--import', 'tsx', helper, inputFile], config.repo));
  if (!Array.isArray(result.entries) || result.entries.length !== eligible.length) throw new Error('production runtime style-contract returned incomplete selector evidence.');
  const selectors = new Map();
  for (const entry of result.entries) {
    if (!Number.isInteger(entry?.index) || typeof entry.renderedSelector !== 'string' || selectors.has(entry.index)) {
      throw new Error('production runtime style-contract returned invalid selector evidence.');
    }
    selectors.set(entry.index, entry.renderedSelector);
  }
  if (eligible.some(({ index }) => !selectors.has(index))) throw new Error('production runtime style-contract omitted a CSS coverage selector.');
  save('styleScoperContract', { input, entries: result.entries, implementation: 'src/author/styles.ts scopeLocalSelectorList via node --import tsx' });
  return selectors;
}
function sourceStyleLedger(report) {
  const sourceFiles = [get('--source'), ...(args['--source-dependency'] || [])].filter((file) => /\.(?:css|html?)$/i.test(file));
  const declarations = sourceDeclarations(sourceFiles);
  const styles = report.coverage.styles;
  if (declarations.length > 0 && styles.length === 0) {
    throw new Error('source contains stylesheet or inline declarations but validated canonical coverage.styles is empty.');
  }
  const expectedSelectors = scopedStyleSelectors(report, styles);
  const emitted = [];
  for (const cssFile of ['style.scss', 'editor.scss']) {
    const file = path.join(candidate, cssFile);
    if (!fs.existsSync(file)) throw new Error(`generated stylesheet is missing: ${cssFile}`);
    postcss.parse(fs.readFileSync(file, 'utf8'), { from: file }).walkDecls((declaration) => emitted.push({
      selector: declaration.parent.selector, property: declaration.prop, value: declaration.value,
      scope: cssFile === 'editor.scss' ? 'editor' : 'shared',
      atRules: (() => { const rules = []; for (let parent = declaration.parent.parent; parent; parent = parent.parent) if (parent.type === 'atrule') rules.unshift(`@${parent.name}${parent.params ? ' ' + parent.params : ''}`); return rules; })(),
    }));
  }
  const owners = { native: 'block', preset: 'theme', literal: 'block', 'scoped-css': 'block', warned: 'unsupported', blocked: 'unsupported' };
  const entries = styles.map((style, index) => {
    const outcome = style?.outcome;
    const owner = owners[outcome] || 'unsupported';
    const expectedSelector = expectedSelectors.get(index);
    const cssFulfilled = ['literal', 'scoped-css'].includes(outcome)
      ? emitted.some((value) => value.property === style.property && emittedStyleValueMatches(style.property, value.value, style.value)
        && value.scope === style.scope && JSON.stringify(value.atRules) === JSON.stringify(style.atRules || [])
        && value.selector === expectedSelector)
      : null;
    const fulfilled = ['native', 'preset'].includes(outcome) ? true : cssFulfilled === true;
    return {
      selector: style?.source?.selector || 'source coverage', property: style?.property ?? 'unknown', value: style?.value ?? 'unknown', owner,
      transportSelector: style?.transportSelector, expectedRenderedSelector: expectedSelector,
      editorControl: owner === 'unsupported' ? 'unverified; not credited as preserved' : outcome === 'native' ? 'validated canonical native target' : outcome === 'preset' ? 'validated canonical theme preset' : 'validated emitted block CSS',
      source: style?.source || { entry: report.source.entry, sha256: report.source.sha256 }, outcome, fulfilled,
      detail: style?.reason || 'source-bound canonical coverage validated before runtime execution',
    };
  });
  fs.writeFileSync(path.join(candidate, 'style-ledger.json'), `${JSON.stringify({ version: 1, entries }, null, 2)}\n`);
  const unverified = entries.filter((entry) => entry.owner === 'unsupported' || !entry.fulfilled);
  save('styleReport', {
    sourceCoverage: { source: report.source, validated: report.valid, sourceDeclarationCount: declarations.length, coverageEntryCount: entries.length, stylesheetHashes: report.stylesheetHashes },
    entries, emitted, remainingUnverified: unverified,
    limitation: 'Coverage fulfillment is bound to runner-validated canonical analysis; unsupported or unverified entries are recorded and are never credited as preserved.',
  });
  return { entries, unverified };
}
function authoredInteractionSelectors(coverage) {
  const selectors = { hover: [], focus: [] };
  for (const style of coverage?.styles || []) {
    const source = style?.source?.selector;
    if (typeof source !== 'string') continue;
    const states = { hover: /:hover\b/i.test(source), focus: /:focus(?:-visible|-within)?\b/i.test(source) };
    if (!states.hover && !states.focus) continue;
    const local = source.replace(/:(?:hover|focus(?:-visible|-within)?|active)\b(?:\([^)]*\))?/gi, '').trim() || '*';
    if (states.hover) selectors.hover.push(local);
    if (states.focus) selectors.focus.push(local);
  }
  return selectors;
}
async function interactionStates(root, applicability) {
  const selector = 'a[href],button,input,select,textarea';
  const selectors = Array.isArray(applicability) ? null : authoredInteractionSelectors(applicability);
  const read = (index) => root.evaluate((element, { selector: value, index: target }) => {
    const node = [...element.querySelectorAll(value)][target];
    if (!node) return null;
    const style = getComputedStyle(node);
    return {
      tag: node.tagName, text: (node.textContent || '').trim(), href: node.getAttribute('href'), rect: (() => { const box = node.getBoundingClientRect().toJSON(); return { ...box, x: box.x + scrollX, y: box.y + scrollY }; })(),
      style: { color: style.color, backgroundColor: style.backgroundColor, outlineStyle: style.outlineStyle, outlineWidth: style.outlineWidth, outlineOffset: style.outlineOffset, outlineColor: style.outlineColor, boxShadow: style.boxShadow, transform: style.transform, textDecorationLine: style.textDecorationLine },
    };
  }, { selector, index });
  const locator = root.locator(selector);
  const page = root.page();
  const settle = async (target) => {
    const milliseconds = await target.evaluate((node) => {
      const style = getComputedStyle(node);
      const ms = (value) => parseFloat(value) * (value.trim().endsWith('ms') ? 1 : 1000);
      const durations = style.transitionDuration.split(',').map(ms), delays = style.transitionDelay.split(',').map(ms);
      return Math.min(1500, Math.max(0, ...durations.map((duration, index) => duration + (delays[index % delays.length] || 0))) + 50);
    });
    await page.waitForTimeout(milliseconds);
  };
  const reset = async (target) => { await page.mouse.move(0, 0); await page.evaluate(() => document.activeElement?.blur()); await settle(target); };
  const count = await locator.count();
  const result = [];
  for (let index = 0; index < count; index += 1) {
    const target = locator.nth(index);
    const states = selectors ? await target.evaluate((node, source) => {
      const matches = (values) => values.some((value) => { try { return node.matches(value); } catch { return false; } });
      return { hover: matches(source.hover), focus: matches(source.focus) };
    }, selectors) : applicability[index] || { hover: false, focus: false };
    await reset(target);
    const base = await read(index);
    let hover = null; let focus = null; let hoverError = null; let focusError = null;
    if (states.hover) try { await target.hover(); await settle(target); hover = await read(index); } catch (error) { hoverError = String(error); }
    if (states.focus) try { await reset(target); await page.keyboard.press('Tab'); await target.focus(); await settle(target); focus = await read(index); } catch (error) { focusError = String(error); }
    const changed = (before, after) => before && after && Object.keys(before.style).filter((key) => before.style[key] !== after.style[key]);
    result.push({ index, states, base, hover, focus, hoverChanged: changed(base, hover) || [], focusChanged: changed(base, focus) || [], hoverError, focusError });
    await reset(target);
  }
  return result;
}
function interactionAgreement(source, actual) {
  const results = source.map((entry, index) => {
    const candidate = actual[index];
    const applicable = Boolean(entry.states?.hover || entry.states?.focus);
    const identity = !!candidate && entry.base?.tag === candidate.base?.tag && entry.base?.text === candidate.base?.text && entry.base?.href === candidate.base?.href;
    const hover = !entry.states?.hover || (!entry.hoverError && !candidate?.hoverError && entry.hoverChanged.every((key) => candidate?.hover?.style[key] === entry.hover?.style[key]));
    const focus = !entry.states?.focus || (!entry.focusError && !candidate?.focusError && entry.focusChanged.every((key) => candidate?.focus?.style[key] === entry.focus?.style[key]));
    const displacement = !entry.states?.hover || ['x', 'y'].every((axis) => Math.abs(((entry.hover?.rect[axis] || 0) - (entry.base?.rect[axis] || 0)) - ((candidate?.hover?.rect[axis] || 0) - (candidate?.base?.rect[axis] || 0))) <= 1);
    return { index, applicable, identity, displacement, sourceHoverChanged: entry.hoverChanged, candidateHoverChanged: candidate?.hoverChanged || [], sourceFocusChanged: entry.focusChanged, candidateFocusChanged: candidate?.focusChanged || [], pass: !applicable || (identity && hover && focus && displacement) };
  });
  const applicable = results.some((result) => result.applicable);
  return { applicable, pass: source.length === actual.length && results.every((result) => result.pass), results };
}
function patternOverrideName(node) {
  const source = String(node); const normalized = source.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'field';
  let value = 0x811c9dc5;
  for (let index = 0; index < source.length; index += 1) { value ^= source.charCodeAt(index); value = Math.imul(value, 0x01000193); }
  return `block-runner-${normalized.slice(0, 48)}-${(value >>> 0).toString(36).padStart(7, '0')}`;
}
function patternRequirement(name) {
  return {
    'heading.content': { block: 'core/heading', attribute: 'content' },
    'body.content': { block: 'core/paragraph', attribute: 'content' },
    background: { block: 'core/group', attribute: 'style' },
    'button.text': { block: 'core/button', attribute: 'text' },
    'button.url': { block: 'core/button', attribute: 'url' },
    'button.linkTarget': { block: 'core/button', attribute: 'linkTarget' },
    'button.rel': { block: 'core/button', attribute: 'rel' },
  }[name];
}
async function exerciseNamedPattern(page, canonicalPlan, originalPost) {
  const expected = fixtureSpec.assertions.pattern || {};
  if (expected.expected === 'not-used') return { ready: Boolean(canonicalPlan?.pattern?.ready), exercised: false, pass: !canonicalPlan?.pattern?.ready, reason: 'Fixture explicitly requires no pattern.' };
  if (expected.expected !== 'named-pattern-used-with-whitelisted-overrides') return { ready: Boolean(canonicalPlan?.pattern?.ready), exercised: false, pass: false, reason: `No runtime evaluator for ${JSON.stringify(expected.expected)}.` };
  const blocksByNode = new Map();
  const visit = (nodes) => nodes.forEach((node) => { if (node.id) blocksByNode.set(node.id, node.block); visit(node.children || []); });
  visit(canonicalPlan?.structure || []);
  const declared = new Set((canonicalPlan?.pattern?.overrides || []).map((override) => override.field));
  const actual = (canonicalPlan?.fields || []).filter((field) => field.mode === 'override').map((field) => ({ id: field.id, node: field.node, block: blocksByNode.get(field.node), attribute: field.attribute, declared: declared.has(field.id) }));
  const allowed = Array.isArray(expected.allowed) ? expected.allowed : [];
  const required = allowed.map((name) => {
    const requirement = patternRequirement(name);
    const fields = requirement ? actual.filter((field) => field.block === requirement.block && field.attribute === requirement.attribute && field.declared).map((field) => field.id) : [];
    return { name, requirement, fields, present: fields.length > 0 };
  });
  const unexpected = actual.filter((field) => field.declared && !allowed.some((name) => { const requirement = patternRequirement(name); return requirement?.block === field.block && requirement.attribute === field.attribute; }));
  const contractPass = canonicalPlan?.pattern?.ready === true && required.every((item) => item.present) && unexpected.length === 0 && actual.every((field) => field.declared);
  const background = required.find((item) => item.name === 'background');
  const evidence = { expected, canonical: { ready: canonicalPlan?.pattern?.ready, required, actual, unexpected }, originalContractGap: background && !background.present ? 'The fixture requests per-instance background, but core/pattern-overrides has no core/group style binding; background is exercised only as a canonical pattern update.' : null, overrideEditing: { method: 'Block-editor API: find each bound descendant’s enclosing core/block and update its content override map. This is native API evidence, not a UI-interaction claim.' }, registration: null, insertion: null, edits: [], persisted: null, canonicalUpdate: null, structural: null, pass: false };
  try {
    const canonicalMarkup = await page.evaluate((name) => {
      const root = wp.data.select('core/block-editor').getBlocks().find((block) => block.name === name);
      return root ? wp.blocks.serialize([root]) : null;
    }, canonicalPlan.target.name);
    if (!canonicalMarkup) throw new Error('The compiled block was unavailable to serialize as synced-pattern content.');
    const title = `Block Runner runtime ${fixture}`;
    const registration = await page.evaluate(async ({ title: patternTitle, content }) => {
      try { const saved = await wp.apiFetch({ path: '/wp/v2/blocks', method: 'POST', data: { title: patternTitle, status: 'publish', content } }); return { id: Number(saved?.id), title: saved?.title?.raw, content: saved?.content?.raw }; } catch (error) { return { error: String(error) }; }
    }, { title, content: canonicalMarkup });
    evidence.registration = registration;
    if (!Number.isInteger(registration.id) || registration.id <= 0 || registration.title !== title || typeof registration.content !== 'string') throw new Error('WordPress did not register a named synced wp_block through its REST API.');
    const patternPost = Number(wp(['post', 'create', `--post_title=Pattern runtime ${fixture}`, '--post_status=publish', '--post_content=', '--porcelain']).trim());
    await page.goto(`${config.wordpress.url}/wp-admin/post.php?post=${patternPost}&action=edit`); await page.waitForFunction(() => window.wp?.data?.select('core/block-editor')?.getBlocks);
    await page.evaluate((ref) => {
      const dispatch = wp.data.dispatch('core/block-editor');
      dispatch.insertBlocks(wp.blocks.createBlock('core/block', { ref }));
      dispatch.insertBlocks(wp.blocks.createBlock('core/block', { ref }));
    }, registration.id);
    await page.waitForFunction((ref) => wp.data.select('core/block-editor').getBlocks().filter((block) => block.name === 'core/block' && Number(block.attributes?.ref) === ref).length === 2, registration.id);
    await page.waitForFunction((ref) => {
      const select = wp.data.select('core/block-editor');
      const roots = select.getBlocks().filter((block) => block.name === 'core/block' && Number(block.attributes?.ref) === ref);
      return roots.length === 2 && roots.every((root) => select.getBlocks(root.clientId).length > 0);
    }, registration.id);
    const insertion = await page.evaluate((ref) => {
      const select = wp.data.select('core/block-editor');
      const roots = select.getBlocks().filter((block) => block.name === 'core/block' && Number(block.attributes?.ref) === ref);
      return roots.map((root) => ({ clientId: root.clientId, ref: root.attributes.ref, children: select.getBlocks(root.clientId).map((block) => block.name) }));
    }, registration.id);
    evidence.insertion = insertion;
    if (insertion.length !== 2 || insertion.some((instance) => !instance.clientId)) throw new Error('Named synced pattern insertion did not create exactly two core/block references.');
    const bound = await page.evaluate((ids) => {
      const select = wp.data.select('core/block-editor'); const descend = (blocks) => blocks.flatMap((block) => [block, ...descend(select.getBlocks(block.clientId) || [])]);
      return ids.map((id) => { const root = select.getBlock(id); return root ? descend(select.getBlocks(id) || []).map((block) => ({ clientId: block.clientId, block: block.name, name: block.attributes?.metadata?.name })) : []; });
    }, insertion.map((instance) => instance.clientId));
    const editable = actual.filter((field) => field.declared && field.node && ['content', 'text', 'url', 'linkTarget', 'rel'].includes(field.attribute));
    for (const [instanceIndex, instance] of insertion.entries()) for (const field of editable) {
      const name = patternOverrideName(field.node); const target = bound[instanceIndex].find((item) => item.name === name && item.block === field.block); const value = field.attribute === 'url' ? `/pattern-runtime-${instanceIndex}-${field.id}` : field.attribute === 'linkTarget' ? instanceIndex === 0 ? '_blank' : '_self' : field.attribute === 'rel' ? instanceIndex === 0 ? 'noopener' : 'noreferrer' : `Pattern runtime ${instanceIndex} ${field.id}`;
      if (!target) { evidence.edits.push({ instanceIndex, field, name, ok: false, reason: 'Bound native target is absent from inserted core/block.' }); continue; }
      const update = await page.evaluate(({ descendantId, expectedRootId, metadataName, attribute, value: next }) => {
        const select = wp.data.select('core/block-editor'); const dispatch = wp.data.dispatch('core/block-editor');
        const [rootId] = select.getBlockParentsByBlockName(descendantId, 'core/block', true);
        if (!rootId || rootId !== expectedRootId) return { ok: false, rootId: rootId || null, reason: 'Bound descendant does not resolve to its expected core/block instance.' };
        const current = select.getBlockAttributes(rootId)?.content;
        const overrides = current && typeof current === 'object' && !Array.isArray(current) ? current : {};
        const entry = overrides[metadataName] && typeof overrides[metadataName] === 'object' && !Array.isArray(overrides[metadataName]) ? overrides[metadataName] : {};
        const content = { ...overrides, [metadataName]: { ...entry, [attribute]: next } };
        dispatch.updateBlockAttributes(rootId, { content });
        return { ok: true, rootId, content };
      }, { descendantId: target.clientId, expectedRootId: instance.clientId, metadataName: name, attribute: field.attribute, value });
      const stored = update.ok && await page.waitForFunction(({ rootId, metadataName, attribute, value: next }) => JSON.stringify(wp.data.select('core/block-editor').getBlock(rootId)?.attributes?.content?.[metadataName]?.[attribute]) === JSON.stringify(next), { rootId: instance.clientId, metadataName: name, attribute: field.attribute, value }).then(() => true).catch(() => false);
      evidence.edits.push({ instanceIndex, field, name, target, value, update, ok: stored });
    }
    await page.evaluate(() => wp.data.dispatch('core/editor').savePost()); await page.waitForFunction(() => !wp.data.select('core/editor').isSavingPost() && !wp.data.select('core/editor').isEditedPostDirty());
    await page.reload(); await page.waitForFunction(() => window.wp?.data?.select('core/block-editor')?.getBlocks?.().length);
    await page.waitForFunction((ref) => {
      const select = wp.data.select('core/block-editor'); const roots = select.getBlocks().filter((block) => block.name === 'core/block' && Number(block.attributes?.ref) === ref);
      return roots.length === 2 && roots.every((root) => select.getBlocks(root.clientId).length > 0);
    }, registration.id);
    const persisted = await page.evaluate((ref) => { const select = wp.data.select('core/block-editor'); return select.getBlocks().filter((block) => block.name === 'core/block' && Number(block.attributes?.ref) === ref).map((root) => ({ clientId: root.clientId, content: JSON.parse(JSON.stringify(root.attributes?.content || {})), children: select.getBlocks(root.clientId).map((block) => block.name) })); }, registration.id);
    evidence.persisted = persisted;
    const canonicalUpdate = await page.evaluate(async ({ ref, content }) => {
      try {
        const blocks = wp.blocks.parse(content); const visit = (nodes) => nodes.flatMap((block) => [block, ...visit(block.innerBlocks || [])]); const group = visit(blocks).find((block) => block.name === 'core/group');
        if (!group) return { ok: false, error: 'Compiled synced pattern has no core/group for its canonical background update.', content: '' };
        group.attributes.style = { ...(group.attributes.style || {}), color: { ...(group.attributes.style?.color || {}), background: '#123456' } };
        const updated = wp.blocks.serialize(blocks); const saved = await wp.apiFetch({ path: `/wp/v2/blocks/${ref}`, method: 'POST', data: { content: updated } });
        return { ok: saved?.content?.raw === updated, content: saved?.content?.raw ?? '', background: '#123456' };
      } catch (error) { return { ok: false, error: String(error), content: '' }; }
    }, { ref: registration.id, content: canonicalMarkup });
    if (canonicalUpdate.ok) {
      await page.reload(); await page.waitForFunction(() => window.wp?.data?.select('core/block-editor')?.getBlocks?.().length);
      await page.waitForFunction((ref) => { const select = wp.data.select('core/block-editor'); const roots = select.getBlocks().filter((block) => block.name === 'core/block' && Number(block.attributes?.ref) === ref); return roots.length === 2 && roots.every((root) => select.getBlocks(root.clientId).length > 0); }, registration.id);
    }
    const afterUpdate = canonicalUpdate.ok ? await page.evaluate((ref) => { const select = wp.data.select('core/block-editor'); const roots = select.getBlocks().filter((block) => block.name === 'core/block' && Number(block.attributes?.ref) === ref); const visit = (nodes) => nodes.flatMap((block) => [block, ...visit(select.getBlocks(block.clientId) || [])]); return roots.map((root) => ({ content: JSON.parse(JSON.stringify(root.attributes?.content || {})), background: visit(select.getBlocks(root.clientId) || []).find((block) => block.name === 'core/group')?.attributes?.style?.color?.background, structure: visit(select.getBlocks(root.clientId) || []).map((block) => block.name) })); }, registration.id) : null;
    evidence.canonicalUpdate = { ...canonicalUpdate, afterUpdate };
    const structural = await page.evaluate(({ ref, marker: attempted }) => {
      const select = wp.data.select('core/block-editor'); const roots = select.getBlocks().filter((block) => block.name === 'core/block' && Number(block.attributes?.ref) === ref); if (roots.length !== 2) return { attempted: false, rejected: false, reason: 'Expected two core/block instances after reload.' };
      const before = roots.map((root) => select.getBlocks(root.clientId).map((block) => block.name)); wp.data.dispatch('core/block-editor').insertBlocks(wp.blocks.createBlock('core/paragraph', { content: attempted }), undefined, roots[0].clientId); const after = roots.map((root) => select.getBlocks(root.clientId).map((block) => block.name));
      return { attempted: 'insert core/paragraph into first core/block', before, after, rejected: JSON.stringify(before) === JSON.stringify(after) };
    }, { ref: registration.id, marker: 'Structural override must be rejected.' });
    evidence.structural = structural;
    const editsPass = evidence.edits.length === editable.length * 2 && evidence.edits.every((item) => item.ok);
    const persistedPass = editsPass && persisted.length === 2 && evidence.edits.every((item) => JSON.stringify(persisted[item.instanceIndex]?.content?.[item.name]?.[item.field.attribute]) === JSON.stringify(item.value));
    const distinctPass = editable.every((field) => { const values = evidence.edits.filter((item) => item.field.id === field.id).map((item) => item.value); return values.length === 2 && values[0] !== values[1]; });
    const canonicalPass = canonicalUpdate.ok && afterUpdate?.length === 2 && afterUpdate.every((instance, index) => instance.background === canonicalUpdate.background && JSON.stringify(instance.content) === JSON.stringify(persisted[index]?.content));
    const frontend = await page.goto(`${config.wordpress.url}/?p=${patternPost}`).then(() => page.locator('body').evaluate((body, entries) => ({ text: body.innerText, links: [...body.querySelectorAll('a')].map((link) => ({ text: link.textContent?.trim(), href: link.getAttribute('href'), target: link.getAttribute('target'), rel: link.getAttribute('rel') })), entries }), evidence.edits)).catch((error) => ({ error: String(error) }));
    const frontendPass = !frontend.error && evidence.edits.every((item) => item.field.attribute === 'url' ? frontend.links.some((link) => link.href === item.value) : item.field.attribute === 'linkTarget' ? frontend.links.some((link) => link.target === item.value) : item.field.attribute === 'rel' ? frontend.links.some((link) => link.rel === item.value) : frontend.text.includes(item.value));
    evidence.frontend = { ...frontend, pass: frontendPass };
    evidence.pass = contractPass && editsPass && persistedPass && distinctPass && canonicalPass && structural.rejected && frontendPass;
  } catch (error) { evidence.error = error.message; } finally {
    await page.goto(`${config.wordpress.url}/wp-admin/post.php?post=${originalPost}&action=edit`).catch(() => {}); await page.waitForFunction(() => window.wp?.data?.select('core/block-editor')?.getBlocks).catch(() => {});
  }
  return evidence;
}
function repeatedPlanGroup(nodes, parentPath = []) {
  const candidates = [];
  const visit = (siblings, path) => {
    const names = siblings.map((node) => node.block || node.name);
    for (const name of new Set(names)) {
      const indices = names.map((candidate, index) => candidate === name ? index : -1).filter((index) => index >= 0);
      if (indices.length < 2) continue;
      const children = indices.reduce((total, index) => total + (siblings[index].children || []).length, 0);
      // Reorder a repeated component, never coincidental flat text siblings in a section preamble.
      candidates.push({ parentPath: path, block: name, indices, score: (children > 0 ? 100000 : 0) + indices.length * 100 + children * 10 + path.length });
    }
    siblings.forEach((node, index) => visit(node.children || [], path.concat(index)));
  };
  visit(nodes, parentPath);
  const selected = candidates.sort((first, second) => second.score - first.score)[0];
  return selected && { parentPath: selected.parentPath, block: selected.block, indices: selected.indices };
}
async function exerciseCollectionWorkflow(page, canonicalPlan, blockName) {
  if (!['cards', 'repeater'].includes(fixtureSpec.family)) return { applicable: false, pass: true };
  if (canonicalPlan?.locking?.mode !== 'none') return { applicable: true, pass: false, reason: `Fixture requires structural collection operations but canonical locking is ${canonicalPlan?.locking?.mode || 'unspecified'}.` };
  const planned = repeatedPlanGroup(canonicalPlan?.structure || []);
  if (!planned) return { applicable: true, pass: false, reason: 'Canonical plan contains no repeated sibling native blocks to exercise.' };
  const operation = await page.evaluate(({ name, plan, family }) => {
    const select = wp.data.select('core/block-editor'); const dispatch = wp.data.dispatch('core/block-editor');
    const root = select.getBlocks().find((block) => block.name === name); if (!root) return { pass: false, reason: 'Compiled root block is absent.' };
    let parent = root; for (const index of plan.parentPath) parent = parent?.innerBlocks?.[index];
    if (!parent?.clientId) return { pass: false, reason: 'Plan repeated-sibling parent is absent from the native tree.', plan };
    const fingerprint = (block) => JSON.stringify({ name: block.name, attributes: block.attributes, innerBlocks: (block.innerBlocks || []).map(fingerprint) });
    const repeated = (parent.innerBlocks || []).filter((block) => block.name === plan.block);
    if (repeated.length < 2) return { pass: false, reason: 'Live native tree does not contain the planned repeated sibling group.', plan, repeated: repeated.map(fingerprint) };
    const parentId = parent.clientId; const before = repeated.map(fingerprint); let add = { attempted: false, accepted: false, beforeCount: repeated.length, afterCount: repeated.length };
    if (family === 'repeater') {
      add.attempted = true; const clone = wp.blocks.cloneBlock(repeated[0]); dispatch.insertBlocks(clone, undefined, parentId);
      const afterAdd = (select.getBlock(parentId)?.innerBlocks || []).filter((block) => block.name === plan.block); add = { ...add, afterCount: afterAdd.length, accepted: afterAdd.length === repeated.length + 1 };
    }
    const candidates = (select.getBlock(parentId)?.innerBlocks || []).filter((block) => block.name === plan.block);
    const beforeReorder = candidates.map(fingerprint); const moving = candidates[candidates.length - 1];
    dispatch.moveBlocksToPosition([moving.clientId], parentId, parentId, (select.getBlock(parentId)?.innerBlocks || []).indexOf(candidates[0]));
    const after = (select.getBlock(parentId)?.innerBlocks || []).filter((block) => block.name === plan.block).map(fingerprint);
    return { pass: (family !== 'repeater' || add.accepted) && JSON.stringify(beforeReorder) !== JSON.stringify(after), plan, parentId, before, add, beforeReorder, after };
  }, { name: blockName, plan: planned, family: fixtureSpec.family });
  if (!operation.pass) return { applicable: true, ...operation, persisted: null };
  await page.evaluate(() => wp.data.dispatch('core/editor').savePost());
  await page.waitForFunction(() => !wp.data.select('core/editor').isSavingPost() && !wp.data.select('core/editor').isEditedPostDirty());
  await page.reload(); await page.waitForFunction(() => window.wp?.data?.select('core/block-editor')?.getBlocks?.().length);
  const persisted = await page.evaluate(({ name, plan }) => {
    const root = wp.data.select('core/block-editor').getBlocks().find((block) => block.name === name); let parent = root; for (const index of plan.parentPath) parent = parent?.innerBlocks?.[index];
    const fingerprint = (block) => JSON.stringify({ name: block.name, attributes: block.attributes, innerBlocks: (block.innerBlocks || []).map(fingerprint) });
    return parent ? (parent.innerBlocks || []).filter((block) => block.name === plan.block).map(fingerprint) : null;
  }, { name: blockName, plan: planned });
  const countPass = fixtureSpec.family !== 'repeater' || persisted?.length === operation.add.afterCount;
  return { applicable: true, ...operation, persisted, pass: countPass && JSON.stringify(persisted) === JSON.stringify(operation.after) };
}
async function pseudoStyles(root, coverage) {
  const selectors = [...new Set(coverage.styles.map((style) => style.source?.selector).filter((selector) => /::(?:before|after)$/.test(selector || '')))];
  return root.evaluate((element, selectors) => selectors.map((selector) => {
    const match = selector.match(/^(.*)(::(?:before|after))$/);
    const node = element.matches(match[1]) ? element : element.querySelector(match[1]);
    if (!node) return { selector, missing: true };
    const style = getComputedStyle(node, match[2]);
    return { selector, content: style.content, display: style.display, width: style.width, height: style.height, backgroundColor: style.backgroundColor };
  }), selectors);
}

let referenceServer;
async function serveReference() {
  const sourceRoot = fs.realpathSync(path.join(candidate, 'source'));
  referenceServer = http.createServer((request, response) => {
    try {
      const relative = decodeURIComponent(new URL(request.url, 'http://localhost').pathname).replace(/^\/+/, '');
      const file = fs.realpathSync(path.resolve(sourceRoot, relative));
      if (!file.startsWith(sourceRoot + path.sep) || !fs.statSync(file).isFile()) { response.writeHead(404); response.end(); return; }
      const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' };
      response.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
      fs.createReadStream(file).pipe(response);
    } catch { response.writeHead(404); response.end(); }
  });
  await new Promise((resolve, reject) => { referenceServer.once('error', reject); referenceServer.listen(0, '127.0.0.1', resolve); });
  const origin = `http://127.0.0.1:${referenceServer.address().port}`;
  return (file) => origin + '/' + path.relative(sourceRoot, file).split(path.sep).map(encodeURIComponent).join('/');
}
let browser;
let pageRef;
let pluginSlug;
let runtimeComplete = false;
async function main() {
  const available = Number(run('df', ['-Pk', candidate]).trim().split('\n').at(-1).trim().split(/\s+/)[3]);
  if (available < 5 * 1024 * 1024) throw new Error('Disk low-water guard: less than 5GiB available.');
  run(config.docker, ['exec', config.wordpress.container, 'wp', 'core', 'version']);
  const plan = json(get('--candidate-plan'));
  const manifest = json(path.join(candidate, 'compiler-manifest.json'));
  const sourceCoverage = coverageEvidence();
  const input = path.join(out, 'package-source');
  fs.mkdirSync(input);
  for (const item of manifest.files) {
    const destination = path.join(input, item.path);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(path.join(candidate, item.path), destination);
  }
  for (const directory of ['assets', 'fonts']) if (fs.existsSync(path.join(candidate, directory))) fs.cpSync(path.join(candidate, directory), path.join(input, directory), { recursive: true });
  const plugin = path.join(out, 'plugin');
  const preview = JSON.parse(run(config.cli, ['plugin', 'preview', input, '--standalone', plugin, '--json']));
  save('pluginPreview', { fingerprint: preview.fingerprint, notes: preview.notes });
  run(config.cli, ['plugin', 'write', input, '--standalone', plugin, '--confirm', preview.fingerprint, '--json']);
  fs.symlinkSync(config.sharedDependencies, path.join(plugin, 'node_modules'), 'dir');
  run('npm', ['run', 'zip'], plugin, 220000);
  run('npm', ['run', 'test:zip'], plugin, 30000);
  const pluginPackage = json(path.join(plugin, 'package.json'));
  pluginSlug = pluginPackage.name;
  const zip = path.join(plugin, `${pluginSlug}.zip`);
  fs.copyFileSync(zip, path.join(out, 'plugin.zip'));
  artifacts.pluginZip = { path: 'execution/plugin.zip' };
  const lockBytes = fs.readFileSync(path.join(plugin, 'package-lock.json'));
  fs.writeFileSync(path.join(out, 'dependencyLock.json'), lockBytes);
  artifacts.dependencyLock = { path: 'execution/dependencyLock.json' };
  const lock = JSON.parse(lockBytes); const packages = [];
  for (const relative of Object.keys(lock.packages)) {
    if (!relative) continue;
    const installed = path.join(plugin, relative, 'package.json');
    if (fs.existsSync(installed)) { const observed = json(installed); packages.push({ name: observed.name, version: observed.version }); }
  }
  save('dependencyInventory', { lockSha256: hash(lockBytes), packages, reusedInstallation: 'configured shared dependencies' });
  check('build', true, 'Production plugin preview/write, build, ZIP and ZIP policy executed successfully.', 'buildLog');
  run(config.docker, ['cp', zip, `${config.wordpress.container}:/tmp/block-runner-${fixture}.zip`]);
  wp(['plugin', 'install', `/tmp/block-runner-${fixture}.zip`, '--activate', '--force']);
  const coreFiles = wp(['eval', ' $files=array_merge(glob(ABSPATH."*.php"),iterator_to_array(new RecursiveIteratorIterator(new RecursiveDirectoryIterator(ABSPATH."wp-includes",FilesystemIterator::SKIP_DOTS))),iterator_to_array(new RecursiveIteratorIterator(new RecursiveDirectoryIterator(ABSPATH."wp-admin",FilesystemIterator::SKIP_DOTS)))); $out=[]; foreach($files as $f){$f=(string)$f;if(is_file($f))$out[str_replace(ABSPATH,"",$f)]=hash_file("sha256",$f);}ksort($out);echo json_encode($out);']);
  save('coreFiles', JSON.parse(coreFiles));
  save('wordpressInventory', { version: wp(['core', 'version']).trim(), coreHash: hash(coreFiles), plugins: JSON.parse(wp(['plugin', 'list', '--format=json'])) });
  const theme = JSON.parse(wp(['theme', 'get', 'twentytwentyfive', '--format=json']));
  const themeConfig = JSON.parse(wp(['eval', 'echo file_get_contents(get_theme_file_path("theme.json"));']));
  save('themeInventory', { slug: wp(['option', 'get', 'stylesheet']).trim(), version: theme.version, configuration: themeConfig });

  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1024 }, deviceScaleFactor: 1 });
  await context.tracing.start({ screenshots: true, snapshots: true, sources: true });
  save('browserInventory', { name: 'chromium', version: browser.version(), viewport: { width: 1440, height: 1024 }, deviceScaleFactor: 1 });
  const page = await context.newPage(); pageRef = page; page.setDefaultTimeout(18000);
  const errors = []; page.on('pageerror', (error) => errors.push(String(error)));
  await page.goto(`${config.wordpress.url}/wp-login.php`); await page.waitForLoadState('networkidle');
  await page.locator('#user_login').fill(config.wordpress.username); await page.locator('#user_pass').fill(config.wordpress.password);
  await Promise.all([page.waitForURL('**/wp-admin/**'), page.locator('#loginform').evaluate((form) => form.requestSubmit())]);
  const post = Number(wp(['post', 'create', `--post_title=Runtime ${fixture}`, '--post_status=publish', '--post_content=', '--porcelain']).trim());
  await page.goto(`${config.wordpress.url}/wp-admin/post.php?post=${post}&action=edit`);
  await page.waitForFunction(() => window.wp?.data?.select('core/block-editor')?.getBlocks);
  await page.evaluate((name) => wp.data.dispatch('core/block-editor').insertBlocks(wp.blocks.createBlock(name)), plan.target.name);
  await page.waitForFunction((name) => wp.data.select('core/block-editor').getBlocks().some((block) => block.name === name && block.innerBlocks.length), plan.target.name);
  const tree = await page.evaluate(() => wp.data.select('core/block-editor').getBlocks());
  const positions = {}; function walk(nodes, indices = []) { nodes.forEach((node, index) => { positions[node.id] = indices.concat(index); walk(node.children || [], indices.concat(index)); }); } walk(plan.structure);
  const mediaNodes = new Set(plan.fields.filter((field) => field.mode === 'editable' && field.attribute === 'id').map((field) => field.node));
  let runtimeMedia = null;
  if (mediaNodes.size) {
    const mediaFile = path.join(out, `runtime-media-${process.pid}.png`);
    fs.writeFileSync(mediaFile, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL0NwAAAABJRU5ErkJggg==', 'base64'));
    const containerFile = `/tmp/block-runner-runtime-media-${fixture}-${process.pid}.png`;
    run(config.docker, ['cp', mediaFile, `${config.wordpress.container}:${containerFile}`]);
    const id = Number(wp(['media', 'import', containerFile, '--porcelain']).trim());
    const url = wp(['eval', `echo wp_get_attachment_url(${id});`]).trim();
    if (!Number.isInteger(id) || id < 1 || !url) throw new Error('Could not create a valid disposable media attachment for editable core/image fields.');
    runtimeMedia = { id, url };
  }
  const edits = plan.fields.filter((field) => field.mode === 'editable').map((field, index) => ({ id: field.id, path: positions[field.node], attribute: field.attribute, value: mediaNodes.has(field.node) && field.attribute === 'id' ? runtimeMedia.id : mediaNodes.has(field.node) && field.attribute === 'url' ? runtimeMedia.url : field.type === 'number' ? index + 2 : field.attribute === 'url' ? `/runtime-${index}` : typeof field.default === 'boolean' ? !field.default : `Runtime edit ${fixture} ${index}` }));
  const editResults = await page.evaluate(({ name, edits: values }) => { const root = wp.data.select('core/block-editor').getBlocks().find((block) => block.name === name); return values.map((edit) => { let node = root; for (const index of edit.path || []) node = node?.innerBlocks[index]; if (!node || !edit.path) return { ...edit, error: 'native node missing' }; wp.data.dispatch('core/block-editor').updateBlockAttributes(node.clientId, { [edit.attribute]: edit.value }); return edit; }); }, { name: plan.target.name, edits });
  await page.evaluate(() => wp.data.dispatch('core/editor').savePost()); await page.reload(); await page.waitForFunction(() => window.wp?.data?.select('core/block-editor')?.getBlocks?.().length);
  const persisted = await page.evaluate(({ name, edits: values }) => { const root = wp.data.select('core/block-editor').getBlocks().find((block) => block.name === name); return values.map((edit) => { let node = root; for (const index of edit.path || []) node = node?.innerBlocks[index]; return { ...edit, observed: node?.attributes[edit.attribute], pass: !!node && JSON.stringify(node.attributes[edit.attribute]) === JSON.stringify(edit.value), valid: node?.isValid }; }); }, { name: plan.target.name, edits });
  const collectionWorkflow = await exerciseCollectionWorkflow(page, sourceCoverage.canonicalPlan, plan.target.name);
  save('editorReport', { post, tree, runtimeMedia, editResults, persisted, collectionWorkflow, method: 'native editor insertion and attribute updates; media id fields use a disposable WordPress attachment with its matching URL; save and reload; structural collection operations run only when plan locking permits them; not an owner editing-feel review', errors });
  check('editor', persisted.length === edits.length && persisted.every((entry) => entry.pass && entry.valid !== false) && collectionWorkflow.pass, 'Native editable fields updated, saved and compared after reload; applicable collection add/reorder workflow also persisted.', 'editorReport');
  // The named pattern is derived from the compiler's actual serialized block, not fixture markup.
  await page.evaluate(async (original) => { wp.data.dispatch('core/block-editor').resetBlocks(original); await wp.data.dispatch('core/editor').savePost(); }, tree);
  const patternEvidence = await exerciseNamedPattern(page, sourceCoverage.canonicalPlan, post);
  await page.screenshot({ path: path.join(out, 'editor.png'), fullPage: true }); artifacts.editorScreenshot = { path: 'execution/editor.png' };
  await page.addScriptTag({ path: req.resolve('axe-core/axe.min.js') });
  const editorAxe = await page.evaluate(() => axe.run(document));
  const editorFrames = [];
  for (const frame of page.frames().filter((frame) => frame !== page.mainFrame())) {
    try { await frame.addScriptTag({ path: req.resolve('axe-core/axe.min.js') }); editorFrames.push(await frame.evaluate(() => axe.run(document))); } catch (error) { editorFrames.push({ error: String(error) }); }
  }
  save('editorAxe', editorAxe);
  await page.evaluate(async (original) => { wp.data.dispatch('core/block-editor').resetBlocks(original); await wp.data.dispatch('core/editor').savePost(); }, tree);
  await page.goto(`${config.wordpress.url}/?p=${post}`); await page.waitForLoadState('networkidle');
  const selector = `.wp-block-${plan.target.name.replace('/', '-')}`; const root = page.locator(selector).first();
  const frontend = await root.evaluate((element) => ({ text: element.textContent, html: element.outerHTML, width: element.getBoundingClientRect().width, overflow: element.scrollWidth > element.clientWidth + 1, images: [...element.querySelectorAll('img')].map((image) => ({ src: image.currentSrc, loaded: image.complete && image.naturalWidth > 0, alt: image.alt })), links: [...element.querySelectorAll('a')].map((link) => ({ text: link.textContent, href: link.getAttribute('href') })) }));
  save('frontendReport', { post, url: page.url(), ...frontend, errors });
  check('frontend', !!frontend.text.trim() && !frontend.overflow && frontend.images.every((image) => image.loaded) && errors.length === 0, 'Saved candidate rendered; image loading, overflow and JavaScript errors observed.', 'frontendReport');
  await root.screenshot({ path: path.join(out, 'frontend.png') }); artifacts.frontendScreenshot = { path: 'execution/frontend.png' };
  await page.addScriptTag({ path: req.resolve('axe-core/axe.min.js') });
  const frontendAxe = await page.evaluate((value) => axe.run(document.querySelector(value)), selector);
  const actions = await root.locator('a[href],button,input,select,textarea').count(); const focus = [];
  await page.locator('body').click({ position: { x: 1, y: 1 } });
  for (let index = 0; index < 70; index += 1) { await page.keyboard.press('Tab'); const active = await page.evaluate((value) => { const element = document.activeElement; if (!document.querySelector(value)?.contains(element)) return null; const style = getComputedStyle(element); return { tag: element.tagName, text: element.textContent, href: element.getAttribute('href'), outline: style.outlineStyle, outlineWidth: style.outlineWidth, boxShadow: style.boxShadow, rect: element.getBoundingClientRect().toJSON() }; }, selector); if (active && !focus.some((entry) => JSON.stringify(entry) === JSON.stringify(active))) focus.push(active); if (focus.length >= actions && actions > 0) break; }
  const semantics = await root.evaluate((element) => { const levels = [...element.querySelectorAll('h1,h2,h3,h4,h5,h6')].map((heading) => Number(heading.tagName[1])); const pseudo = [element, ...element.querySelectorAll('*')].flatMap((node, index) => ['::before', '::after'].map((which) => { const style = getComputedStyle(node, which); return { tag: node.tagName, index, pseudo: which, content: style.content, width: style.width, height: style.height, display: style.display, pointerEvents: style.pointerEvents }; })).filter((value) => !['none', 'normal'].includes(value.content)); const textualPseudo = pseudo.filter((value) => value.content.replace(/^['"]|['"]$/g, '').trim().length > 0); return { levels, hierarchy: levels.every((level, index) => index === 0 || level <= levels[index - 1] + 1), images: [...element.querySelectorAll('img')].map((image) => ({ alt: image.getAttribute('alt'), decorative: image.getAttribute('role') === 'presentation' || image.getAttribute('alt') === '' })), pseudo, textualPseudo }; });
  const focusVisible = focus.every((entry) => (entry.outline !== 'none' && parseFloat(entry.outlineWidth) > 0) || entry.boxShadow !== 'none');
  const requested = fixtureSpec.assertions.accessibility?.checks || [];
  const frontendAriaSnapshot = await root.ariaSnapshot().catch((error) => ({ error: String(error) }));

  const semanticLandmarks = (element, geometry) => [...element.querySelectorAll('h1,h2,h3,p,a,img,figcaption,cite')]
    // Native core/paragraph wraps a source <cite>; compare the citation once rather than treating that wrapper as added prose.
    .filter((node) => !(node.tagName === 'P' && node.children.length === 1 && node.firstElementChild?.tagName === 'CITE' && node.textContent.trim() === node.firstElementChild.textContent.trim()))
    .map((node) => ({ tag: node.tagName, text: (node.textContent || '').trim(), ...(geometry ? { box: node.getBoundingClientRect().toJSON() } : { alt: node.getAttribute('alt') }) }));
  const originalSource = fs.readFileSync(get('--source'));
  const originalHash = hash(originalSource);
  const nativeSource = /<!--\s*wp:[\s\S]*?-->/i.test(originalSource.toString('utf8'));
  const reference = await context.newPage();
  let referenceRoot;
  let referenceMetadata;
  let referenceUrl;
  let referenceFileUrl;
  if (nativeSource) {
    const sourceBase64 = originalSource.toString('base64');
    const referencePost = Number(wp(['eval', `$source=base64_decode('${sourceBase64}');$post=wp_insert_post(['post_title'=>'Block Runner runtime reference','post_status'=>'publish','post_content'=>$source],true);if(is_wp_error($post)){fwrite(STDERR,$post->get_error_message());exit(1);}echo $post;`]).trim());
    if (!Number.isInteger(referencePost) || referencePost < 1) throw new Error('Could not create a disposable WordPress reference post from the original source bytes.');
    const storedHash = `sha256:${wp(['eval', `echo hash('sha256',get_post_field('post_content',${referencePost}));`]).trim()}`;
    if (storedHash !== originalHash) throw new Error('Disposable WordPress reference post content does not match the original source bytes.');
    referenceUrl = wp(['post', 'url', String(referencePost)]).trim();
    referenceMetadata = { mode: 'wordpress-post', postId: referencePost, originalHash, storedHash, permalink: referenceUrl, referenceRoot: '.wp-block-post-content' };
    await reference.goto(referenceUrl); await reference.waitForLoadState('networkidle');
    referenceRoot = reference.locator(referenceMetadata.referenceRoot).first();
    if (await referenceRoot.count() !== 1 || !await referenceRoot.isVisible()) throw new Error('Disposable WordPress reference post did not render one visible post-content root.');
  } else {
    referenceFileUrl = await serveReference();
    referenceUrl = referenceFileUrl(get('--source'));
    referenceMetadata = { mode: 'loopback-html', originalHash, permalink: referenceUrl, referenceRoot: 'body' };
    await reference.goto(referenceUrl); await reference.waitForLoadState('networkidle');
    referenceRoot = reference.locator(referenceMetadata.referenceRoot);
  }
  const referenceAvailability = await reference.evaluate((selector) => {
    const root = document.querySelector(selector);
    return {
      styles: [...document.querySelectorAll('link[rel~="stylesheet"]')].map((link) => { let rules = false; let error = null; try { rules = !!link.sheet && link.sheet.cssRules.length >= 0; } catch (value) { error = String(value); } return { href: link.href, rules, error }; }),
      images: [...(root?.querySelectorAll('img') || [])].map((image) => ({ src: image.currentSrc || image.src, loaded: image.complete && image.naturalWidth > 0, naturalWidth: image.naturalWidth })),
    };
  }, referenceMetadata.referenceRoot);
  const dependencyFiles = nativeSource ? [] : args['--source-dependency'] || [];
  const expectedCss = dependencyFiles.filter((file) => /\.css$/i.test(file)).map((file) => referenceFileUrl(file));
  const expectedImages = dependencyFiles.filter((file) => /\.(?:avif|gif|jpe?g|png|svg|webp)$/i.test(file)).map((file) => referenceFileUrl(file));
  const referenceAvailable = referenceAvailability.styles.every((style) => style.rules) && referenceAvailability.images.every((image) => image.loaded) && expectedCss.every((href) => referenceAvailability.styles.some((style) => style.href === href && style.rules)) && expectedImages.every((href) => referenceAvailability.images.some((image) => image.src === href && image.loaded));
  save('referenceAvailability', { ...referenceAvailability, expectedCss, expectedImages, metadata: referenceMetadata, pass: referenceAvailable });
  if (!referenceAvailable) throw new Error('Reference stylesheet or image unavailable: not a valid product measurement.');
  const sourceTags = await referenceRoot.evaluate(semanticLandmarks, false);
  const sourceGeometry = await referenceRoot.evaluate(semanticLandmarks, true);
  const actualTags = await root.evaluate(semanticLandmarks, false);
  const actualGeometry = await root.evaluate(semanticLandmarks, true);
  const sourceLayout = await referenceRoot.evaluate((element) => ({ width: element.getBoundingClientRect().width, overflow: element.scrollWidth > element.clientWidth + 1, headings: [...element.querySelectorAll('h1,h2,h3')].map((node) => ({ tag: node.tagName, text: node.textContent.trim(), width: node.getBoundingClientRect().width })) }));
  const sourceInteractions = await interactionStates(referenceRoot, sourceCoverage.coverage);
  const candidateInteractions = await interactionStates(root, sourceInteractions.map((entry) => entry.states));
  const interaction = interactionAgreement(sourceInteractions, candidateInteractions);
  const sourcePseudos = await pseudoStyles(referenceRoot, sourceCoverage.coverage);
  const candidatePseudos = await pseudoStyles(root, sourceCoverage.coverage);
  const pseudoAgreement = !sourcePseudos.some((entry) => entry.missing) && JSON.stringify(sourcePseudos) === JSON.stringify(candidatePseudos);
  save('pseudoReport', { source: sourcePseudos, candidate: candidatePseudos, pass: pseudoAgreement, method: 'Declared before/after content, display, size, and background computed styles.' });
  const sourceActions = sourceInteractions.length;
  const keyboardApplicability = { sourceActions, candidateActions: actions, applicable: sourceActions > 0, countMatches: actions === sourceActions };
  const keyboardReachable = keyboardApplicability.countMatches && (!keyboardApplicability.applicable || focus.length >= actions);
  const visibleKeyboardFocus = !keyboardApplicability.applicable || focusVisible;
  const accessibilityPass = semantics.hierarchy && semantics.images.every((image) => image.decorative || !!image.alt?.trim()) && (!requested.includes('keyboard reachable action') || keyboardReachable) && (!requested.includes('visible keyboard focus') || visibleKeyboardFocus) && (!requested.includes('decorative pseudo-element excluded from accessibility tree') || semantics.textualPseudo.length === 0) && interaction.pass && pseudoAgreement && frontendAxe.violations.length === 0;
  save('accessibilityReport', { editor: { rawAxe: editorAxe, frames: editorFrames, limitation: 'Raw automated editor/frame observations only; iframe coverage is best-effort and is not editor accessibility certification.' }, frontend: { rawAxe: frontendAxe, keyboard: { actions, focus, focusVisible, applicability: keyboardApplicability, reachable: keyboardReachable, visibleFocusPass: visibleKeyboardFocus }, semantics, accessibilitySnapshot: frontendAriaSnapshot }, interaction: { source: sourceInteractions, candidate: candidateInteractions, agreement: interaction, limitation: 'Observed hover/focus state changes for ordered matching controls; no pixel comparison or owner interaction review.' }, limitations: ['Empty generated pseudo content with geometry is recorded as decorative evidence. Textual generated pseudo content never automatically passes the decorative requirement; the accessibility snapshot is retained for review.', 'Keyboard action checks require the candidate action count to match the source. Zero source and candidate actions are valid and recorded as not applicable.', 'Automated browser checks only; this is not owner acceptance or manual accessibility certification.'] });
  check('accessibility', accessibilityPass, 'Observed frontend semantic/keyboard and source-matched hover/focus checks; raw editor and frontend Axe output is retained with explicit scope limits.', 'accessibilityReport');
  const distanceMatches = (a, b, c, d, key) => Math.abs((a.box[key] - b.box[key]) - (c.box[key] - d.box[key])) <= 12;
  const measureFidelityViewport = async ({ viewport, candidateRoot, sourceRoot, candidateOverflow }) => {
    const [viewportSourceTags, viewportSourceGeometry, viewportActualTags, viewportActualGeometry] = await Promise.all([
      sourceRoot.evaluate(semanticLandmarks, false), sourceRoot.evaluate(semanticLandmarks, true),
      candidateRoot.evaluate(semanticLandmarks, false), candidateRoot.evaluate(semanticLandmarks, true),
    ]);
    const tagsMatch = JSON.stringify(viewportSourceTags) === JSON.stringify(viewportActualTags);
    let pairs = 0; let agreements = 0;
    if (tagsMatch) for (let first = 0; first < viewportSourceGeometry.length; first += 1) for (let second = first + 1; second < viewportSourceGeometry.length; second += 1) for (const axis of ['left', 'top']) { pairs += 1; if (distanceMatches(viewportSourceGeometry[first], viewportSourceGeometry[second], viewportActualGeometry[first], viewportActualGeometry[second], axis)) agreements += 1; }
    const layoutAgreement = pairs ? agreements / pairs : 0;
    return { viewport: { width: viewport.width, height: viewport.height }, tagsMatch, layoutAgreement, pairs, agreements, sourceTags: viewportSourceTags, actualTags: viewportActualTags, sourceGeometry: viewportSourceGeometry, actualGeometry: viewportActualGeometry, candidateOverflow, pass: tagsMatch && layoutAgreement >= 0.95 && !candidateOverflow };
  };
  const captureFidelityViewport = async ({ viewport, candidateRoot, sourceRoot, candidateOverflow }) => {
    const key = viewport.name.replace(/[^a-z0-9]+/gi, '-');
    const candidateFile = path.join(out, `fidelity-${key}-candidate.png`);
    const sourceFile = path.join(out, `fidelity-${key}-reference.png`);
    await Promise.all([candidateRoot.screenshot({ path: candidateFile }), sourceRoot.screenshot({ path: sourceFile })]);
    artifacts[`fidelity${key}CandidateScreenshot`] = { path: path.relative(candidate, candidateFile) };
    artifacts[`fidelity${key}ReferenceScreenshot`] = { path: path.relative(candidate, sourceFile) };
    return measureFidelityViewport({ viewport, candidateRoot, sourceRoot, candidateOverflow });
  };
  const fidelityViewports = [];
  for (const viewport of declaredFidelityViewports) {
    if (viewport.name === '1440x1024') {
      fidelityViewports.push(await captureFidelityViewport({ viewport, candidateRoot: root, sourceRoot: referenceRoot, candidateOverflow: frontend.overflow }));
      // Retain the established artifact names while the viewport-qualified captures prove the declared contract.
      await referenceRoot.screenshot({ path: path.join(out, 'reference.png') }); artifacts.referenceScreenshot = { path: 'execution/reference.png' };
      continue;
    }
    const viewportContext = await browser.newContext({ viewport: { width: viewport.width, height: viewport.height }, deviceScaleFactor: 1 });
    try {
      const [candidatePage, sourcePage] = await Promise.all([viewportContext.newPage(), viewportContext.newPage()]);
      await Promise.all([candidatePage.goto(page.url()), sourcePage.goto(referenceUrl)]);
      await Promise.all([candidatePage.waitForLoadState('networkidle'), sourcePage.waitForLoadState('networkidle')]);
      const viewportCandidateRoot = candidatePage.locator(selector).first();
      const viewportSourceRoot = sourcePage.locator(referenceMetadata.referenceRoot).first();
      await Promise.all([viewportCandidateRoot.waitFor({ state: 'visible' }), viewportSourceRoot.waitFor({ state: 'visible' })]);
      const candidateOverflow = await viewportCandidateRoot.evaluate((element) => element.scrollWidth > element.clientWidth + 1);
      fidelityViewports.push(await captureFidelityViewport({ viewport, candidateRoot: viewportCandidateRoot, sourceRoot: viewportSourceRoot, candidateOverflow }));
    } finally {
      await viewportContext.close();
    }
  }
  const primaryFidelity = fidelityViewports.find((entry) => entry.viewport.width === 1440 && entry.viewport.height === 1024);
  const allViewportPass = fidelityViewports.length === declaredFidelityViewports.length && fidelityViewports.every((entry) => entry.pass);
  save('fidelityReport', { comparison: 'Every fixture-declared viewport captures both loaded source and candidate roots. Each compares ordered semantic landmarks (including figcaption and cite, with a native paragraph-only cite wrapper normalized to one citation) and pairwise left/top distances within 12px at a fixed 95% agreement threshold.', threshold: 0.95, referenceAvailability: { ...referenceAvailability, expectedCss, expectedImages, pass: referenceAvailable }, viewports: fidelityViewports, allViewportPass, layoutAgreement: primaryFidelity?.layoutAgreement ?? null, pairs: primaryFidelity?.pairs ?? null, agreements: primaryFidelity?.agreements ?? null, sourceTags: primaryFidelity?.sourceTags ?? null, actualTags: primaryFidelity?.actualTags ?? null, sourceGeometry: primaryFidelity?.sourceGeometry ?? null, actualGeometry: primaryFidelity?.actualGeometry ?? null, sourceLayout, candidateOverflow: primaryFidelity?.candidateOverflow ?? null, limitation: 'DOM arrangement metric bound to loaded references at every declared viewport; it is not pixel similarity or owner visual acceptance.' });
  check('fidelity', referenceAvailable && allViewportPass, 'Every fixture-declared viewport captured loaded source and candidate roots and met the fixed DOM-layout fidelity threshold.', 'fidelityReport');
  const names = []; function namesWalk(nodes) { for (const node of nodes) { names.push(node.name); namesWalk(node.innerBlocks || []); } } namesWalk(tree);
  const required = fixtureSpec.assertions.native?.mustInclude || []; save('nativeReport', { names, required }); check('native', required.every((name) => names.includes(name)) && !names.includes('core/html'), 'Observed registered native block tree against fixture requirements.', 'nativeReport');
  save('planReport', { expectedContract: json(get('--expected-plan')), candidate: plan }); check('plan', plan.fields.every((field) => positions[field.node]), 'Candidate typed compiler succeeded; every declared field targets a native node.', 'planReport');
  save('sourceReport', { manifest, sourceCoverage: { valid: sourceCoverage.valid, source: sourceCoverage.source } }); check('source', true, 'Production compiler source packaged without changing original candidate bytes.', 'sourceReport');
  const styles = sourceStyleLedger(sourceCoverage);
  check('style', styles.unverified.length === 0, 'Validated source-bound canonical coverage was fulfilled; unsupported or unverified declarations are not credited as preserved.', 'styleReport');
  const requiredWarnings = fixtureSpec.assertions.warnings?.expectedCodes || []; const warningCodes = (plan.warnings || []).map((warning) => typeof warning === 'string' ? warning : warning.code);
  save('warningReport', { warnings: plan.warnings, requiredWarnings, remainingUnverified: styles.unverified }); check('warnings', styles.unverified.length === 0 && requiredWarnings.every((code) => warningCodes.includes(code)), 'Warning codes and every remaining unverified source declaration were checked.', 'warningReport');
  save('patternReport', patternEvidence); check('pattern', patternEvidence.pass === true, patternEvidence.pass ? 'Named synced pattern inserted, edited through bound native fields, saved/reloaded, canonically updated, and structurally rejected.' : 'Named synced-pattern lifecycle did not prove every required runtime contract; inspect patternReport.', 'patternReport');
  if (config.smokeViewport) {
    const smoke = await browser.newContext({ viewport: config.smokeViewport, deviceScaleFactor: 1 }); const smokePage = await smoke.newPage(); await smokePage.goto(page.url()); await smokePage.waitForLoadState('networkidle'); const smokeRoot = smokePage.locator(selector).first(); const observation = await smokeRoot.evaluate((element) => ({ width: element.getBoundingClientRect().width, overflow: element.scrollWidth > element.clientWidth + 1 })); await smokeRoot.screenshot({ path: path.join(out, 'frontend-smoke.png') }); artifacts.frontendSmokeScreenshot = { path: 'execution/frontend-smoke.png' }; save('smokeViewportReport', { viewport: config.smokeViewport, ...observation, limitation: 'Single narrow viewport overflow observation only; it is not a responsive fidelity or accessibility suite.' }); await smoke.close();
  }
  await context.tracing.stop({ path: path.join(out, 'browser-trace.zip') }); artifacts.editorTrace = { path: 'execution/browser-trace.zip' }; artifacts.frontendTrace = { path: 'execution/browser-trace.zip' };
  runtimeComplete = true;
}

main().catch(async (error) => {
  save('executionError', { message: error.message, stack: error.stack }); check('execution', false, error.message, 'executionError');
  if (pageRef) { save('browserFailure', { url: pageRef.url(), text: await pageRef.locator('body').innerText().catch(() => ''), state: await pageRef.evaluate(() => ({ registered: Object.keys(window.wp?.blocks?.getBlockTypes?.() || {}).length, blocks: window.wp?.data?.select('core/block-editor')?.getBlocks?.() })).catch(() => null) }); await pageRef.screenshot({ path: path.join(out, 'failure.png') }).catch(() => {}); }
}).finally(async () => {
  if (browser) await browser.close().catch(() => {});
  if (referenceServer) await new Promise((resolve) => referenceServer.close(resolve));
  if (pluginSlug) { try { wp(['plugin', 'deactivate', pluginSlug]); } catch {} }
  save('buildLog', log);
  fs.writeFileSync(get('--result'), `${JSON.stringify({ status: runtimeComplete ? 'scored' : 'blocked', checks, artifacts, environment: { worker: 'authoring-runtime-worker-v1', runtimeComplete, runtimeConfig: 'configured through BLOCK_RUNNER_AUTHORING_RUNTIME_CONFIG' } }, null, 2)}\n`);
});
